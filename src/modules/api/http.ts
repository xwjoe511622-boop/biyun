import { i18n } from '@/i18n/composer'
import { translateForLocale } from '@/i18n/composer'
import { ApiError, type ApiErrorKind, type ApiProduct } from '@/core/errors'
import { parseJsonLossless } from '@/core/lossless-json'
import { readCsrfCookie, session } from '@/core/session'
import { API_PREFIX, ENDPOINTS, walletApiPrefix } from '@/config/endpoints'
import { envelopeSchema, validateData } from './validation'
import { emptyMessageFallback } from './empty-message'
import { normalizeErrorData } from './error-data'

/** Server code meaning "token invalid/expired" (legacy axios cleared the cookie on it). */
const CODE_TOKEN_INVALID = '110009'
/** Server code meaning "not logged in". */
const CODE_NOT_LOGGED_IN = '10002'

/** Futures: the login check itself is down (gateway / spot `login_info` unreachable). NOT a sign-out (2026-10-01). */
const CODE_AUTH_UNAVAILABLE = '200013'

/** Every request gives up after this (the UI then says the result is unconfirmed; 10-01 hardening: 15 s). */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Request routing namespace.
 * - `default` (`/fe-ex-api/`): PublicAct/AccountAct/OrderAct/LoginAct and the legacy `cost`/`addr`/`record`
 *   controllers.
 * - `wallet`: the same-origin configured prefix for the CIAO wallet/signing service
 *   (`VITE_WALLET_API_BASE`). Throws before `fetch` when the operator has not configured a gateway.
 * - `futures` (`VITE_FUTURES_API_BASE`, default `/futures-api/`): futures-web-api (contracts, positions,
 *   futures orders). Nginx strips any client `exchange-user` header; identity comes from the token only.
 * - `otc` (`VITE_OTC_API_BASE`, default `/otc-api/`): exchange-otc-api (C2C adverts, orders, chat).
 *
 * Only the `default` namespace may clear the spot session on an auth rejection: futures/OTC answer
 * "not logged in / not opened" for their own reasons and must never sign the user out of spot.
 * Even then the rejection is confirmed first (`confirmRejectedSession`), because the token is
 * persisted and a single stray 10002 must not sign every tab out.
 */
export type ApiNamespace = 'default' | 'wallet' | 'futures' | 'otc'

/** Backend product of a namespace: codes are looked up per product (spot and futures numbers collide). */
export function productOf(api: ApiNamespace | undefined): ApiProduct {
  return api === 'futures' ? 'futures' : api === 'otc' ? 'otc' : 'spot'
}

export const FUTURES_API_PREFIX: string = import.meta.env.VITE_FUTURES_API_BASE ?? '/futures-api/'
export const OTC_API_PREFIX: string = import.meta.env.VITE_OTC_API_BASE ?? '/otc-api/'

export interface RequestOptions {
  method?: 'POST' | 'GET'
  /** Plain object; serialized as JSON (the current web-api reads `@RequestBody`). */
  body?: unknown
  headers?: Record<string, string>
  /** Wrap the body in the RSA/AES envelope and add `Sign` / `Timestamp` headers. */
  signed?: boolean
  /**
   * Path signed by the envelope (defaults to `/${path}`). The wallet gateway rewrites the request
   * path, so a caller can sign the CIAO service path (e.g. `account/withdraw`) explicitly.
   */
  signedPath?: string
  /** Routing namespace; see `ApiNamespace`. */
  api?: ApiNamespace
  timeoutMs?: number
  signal?: AbortSignal
  /** Registration/recovery never forward an existing signed-in session. */
  anonymous?: boolean
  /** Internal: this request is the session confirmation probe, so its rejection is authoritative. */
  sessionProbe?: boolean
}

let languageProvider: () => string = () => 'zh_CN'

/** Wired by the i18n module so requests always carry the active locale. */
export function setLanguageProvider(provider: () => string): void {
  languageProvider = provider
}

/** The `exchange-language` value the next request will carry (cache keys for localized payloads). */
export function requestLanguage(): string {
  return languageProvider()
}

/**
 * Request headers. Since 10-17 the session is the HttpOnly cookie (sent by the browser, `credentials:
 * 'same-origin'`), never a header: every request says `X-LB-Session: cookie` (the server then answers with cookies
 * instead of tokens) and carries the double-submit `X-CSRF-Token` (Nginx requires it on cookie-authenticated POST /
 * PUT / DELETE). Anonymous requests add `X-LB-Anonymous: 1` so Nginx does not attach the session.
 * Only a pre-10-17 stored session still sends `exchange-token`, until its one-time cookie upgrade.
 */
export function buildHeaders(options: RequestOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=utf-8',
    'exchange-client': 'pc',
    'exchange-language': languageProvider(),
    'X-LB-Session': 'cookie',
  }
  const csrf = readCsrfCookie()
  if (csrf !== '') headers['X-CSRF-Token'] = csrf
  const legacy = session.legacyToken()
  if (options.anonymous !== true && legacy !== null) {
    headers['exchange-token'] = legacy
  }
  if (options.headers !== undefined) {
    Object.assign(headers, options.headers)
  }
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    // the session key is not a credential: an explicit header can only be a pre-10-17 token
    if (lower === 'exchange-token' && (options.anonymous === true || headers[name] !== legacy)) delete headers[name]
    if (lower === 'authorization' && options.anonymous === true) delete headers[name]
  }
  if (options.anonymous === true) headers['X-LB-Anonymous'] = '1'
  return headers
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return String(error)
}

/**
 * Plain words for a request that got no answer. A timeout does NOT mean the action failed (an order may have been
 * accepted), so the text says the result is unconfirmed and warns against resubmitting.
 */
function transportMessage(kind: ApiErrorKind, timeoutMs: number, detail: string): string {
  const transportText = (key: string, values?: Record<string, unknown>) => translateForLocale(languageProvider(), key, values)
  if (kind === 'aborted') return transportText('transport.requestCancelled')
  if (kind === 'timeout') {
    const seconds = Math.round(timeoutMs / 1000)
    return transportText('transport.requestTimedOutSTheResultIsUnconfirmedRefresh', { seconds })
  }
  return transportText('transport.networkErrorCheckYourConnectionAndRetry', { detail })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

const pendingProbes = new Map<string, Promise<void>>()

/**
 * A 10002/110009/401 on an authenticated default-namespace request is confirmed with one
 * `common/user_info` probe on the same token before the persisted session is dropped: some legacy
 * endpoints answer "not logged in" for their own reasons. Only a second auth rejection clears it; a
 * probe that fails in transit (502, timeout, offline) keeps the session. Concurrent rejections for
 * the same token share one probe.
 */
export function confirmRejectedSession(token: string): Promise<void> {
  const existing = pendingProbes.get(token)
  if (existing !== undefined) return existing
  const probe = rawRequest(ENDPOINTS.userInfo, { body: {}, sessionProbe: true })
    .then(() => undefined, () => undefined)
    .finally(() => { pendingProbes.delete(token) })
  pendingProbes.set(token, probe)
  return probe
}

export interface RawRequestResult<T> {
  status: number
  code: string
  message: string
  data: T
}

/**
 * Performs the request and returns the raw successful payload.
 * Never turns a failure into a success: every non-zero code / HTTP / transport problem throws `ApiError`.
 */
export async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<RawRequestResult<T>> {
  // Resolved first so an unconfigured/invalid wallet gateway throws before any network work.
  const url = options.api === 'wallet'
    ? `${walletApiPrefix()}${path}`
    : options.api === 'futures'
      ? `${FUTURES_API_PREFIX}${path}`
      : options.api === 'otc'
        ? `${OTC_API_PREFIX}${path}`
        : `${API_PREFIX}${path}`
  const headers = buildHeaders(options)
  /** Session key the request ran under (`undefined` for anonymous requests). */
  const requestToken = options.anonymous === true ? undefined : (session.getToken() ?? undefined)
  const legacyUpgrade = headers['exchange-token'] !== undefined && path === ENDPOINTS.userInfo
  const clearRejectedSession = async (): Promise<void> => {
    if (options.api === 'futures' || options.api === 'otc') return
    if (!requestToken || session.getToken() !== requestToken) return
    if (options.sessionProbe === true || path === ENDPOINTS.userInfo) {
      session.clear()
      return
    }
    await confirmRejectedSession(requestToken)
  }
  const product = productOf(options.api)
  const method = options.method ?? 'POST'
  let bodyText: string | undefined

  if (method !== 'GET' && options.body !== undefined) {
    if (options.signed === true) {
      // RSA/AES (jsencrypt + noble) only loads for the few signed calls (login, withdraw, …).
      const { buildSignedEnvelope } = await import('./security')
      const signed = buildSignedEnvelope(options.body, options.signedPath ?? `/${path}`)
      headers.Sign = signed.sign
      headers.Timestamp = signed.timestamp
      bodyText = JSON.stringify(signed.envelope)
    } else {
      bodyText = JSON.stringify(options.body)
    }
  }

  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const externalAbort = (): void => controller.abort()
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort()
    } else {
      options.signal.addEventListener('abort', externalAbort, { once: true })
    }
  }

  let response: Response
  let text: string
  try {
    response = await fetch(url, {
      method,
      headers,
      body: bodyText,
      signal: controller.signal,
      // the session cookie (and the Set-Cookie of login / logout) needs same-origin credentials
      credentials: 'same-origin',
    })
    text = await response.text()
  } catch (error) {
    const cancelled = !timedOut && options.signal?.aborted === true
    const kind: ApiErrorKind = cancelled ? 'aborted' : timedOut || isAbortError(error) ? 'timeout' : 'network'
    throw new ApiError({
      kind,
      code: '',
      message: transportMessage(kind, timeoutMs, describeFailure(error)),
      path,
      product,
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', externalAbort)
  }

  let payload: unknown = null
  if (text !== '') {
    try {
      // ids above 2^53 (orders, trades, positions) stay exact strings (core/lossless-json.ts)
      payload = parseJsonLossless(text)
    } catch (error) {
      throw new ApiError({
        kind: 'parse',
        code: '',
        message: i18n.global.t('serviceMessage.invalidJsonResponse', { detail: describeFailure(error) }),
        status: response.status,
        path,
        product,
      })
    }
  }

  const parsed = envelopeSchema.safeParse(payload)
  const result = parsed.success ? parsed.data : null
  const code = result !== null && result.code !== undefined ? String(result.code) : ''
  const message = result !== null && typeof result.msg === 'string' ? result.msg : ''
  // `data.reason` / `data.param` may be a one-element list (web-api Feign map): unwrapped for the error tables.
  const errorData = result !== null ? normalizeErrorData(result.data) : undefined

  if (!response.ok) {
    if ((response.status === 401 && code !== CODE_AUTH_UNAVAILABLE) || code === CODE_NOT_LOGGED_IN || code === CODE_TOKEN_INVALID) {
      await clearRejectedSession()
      throw new ApiError({
        kind: 'unauthorized',
        code: code === '' ? String(response.status) : code,
        message: message !== '' ? message : i18n.global.t('serviceMessage.signInRequiredOrSessionExpiredHttp', { status: response.status }),
        status: response.status,
        path,
        data: errorData,
        product,
      })
    }
    throw new ApiError({
      kind: 'http',
      code: code === '' ? String(response.status) : code,
      message: message !== '' ? message : `HTTP ${response.status} ${response.statusText}`,
      status: response.status,
      path,
      data: errorData,
      product,
    })
  }

  if (result === null || typeof result !== 'object' || result.code === undefined) {
    throw new ApiError({
      kind: 'parse',
      code: '',
      message: i18n.global.t('serviceMessage.theResponseIsMissingTheExchangeCodeField'),
      status: response.status,
      path,
      product,
    })
  }

  if (code !== '0') {
    const unauthorized = code === CODE_NOT_LOGGED_IN || code === CODE_TOKEN_INVALID
    if (unauthorized) {
      await clearRejectedSession()
    }
    throw new ApiError({
      kind: unauthorized ? 'unauthorized' : 'api',
      code,
      message: message !== '' ? message : emptyMessageFallback(options.api, code, languageProvider()),
      status: response.status,
      path,
      data: errorData,
      product,
    })
  }

  if (requestToken) session.noteServerContact(requestToken)
  // a pre-10-17 session answered `user_info` with cookies: the header token is no longer needed
  if (legacyUpgrade && readCsrfCookie() !== '') session.finishLegacyUpgrade()
  return { status: response.status, code, message, data: validateData<T>(path, result.data) }
}

/** Request helper that unwraps the standard envelope. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const result = await rawRequest<T>(path, options)
  return result.data
}

/** Transport-level failures worth retrying: offline/TLS reset, timeout, gateway errors. */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.kind === 'network' || error.kind === 'timeout') return true
  return error.kind === 'http' && (error.status === 502 || error.status === 503 || error.status === 504)
}

export interface RetryPolicy {
  /** Total attempts, including the first one. */
  attempts?: number
  baseDelayMs?: number
  /** Called before each retry (1-based retry number) so the UI can say "retrying". */
  onRetry?: (retry: number, error: ApiError) => void
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Bounded retry with exponential backoff, for idempotent public reads only (public info, contract
 * list, footer). Business errors, auth rejections and parse failures are never retried.
 */
export async function requestWithRetry<T>(path: string, options: RequestOptions = {}, policy: RetryPolicy = {}): Promise<T> {
  const attempts = Math.max(1, policy.attempts ?? 3)
  const baseDelayMs = policy.baseDelayMs ?? 800
  const sleep = policy.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request<T>(path, options)
    } catch (error) {
      if (attempt >= attempts || !isRetryableError(error) || options.signal?.aborted === true) throw error
      policy.onRetry?.(attempt, error as ApiError)
      await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250))
    }
  }
}
