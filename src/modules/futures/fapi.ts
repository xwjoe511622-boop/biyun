import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { buildHeaders, FUTURES_API_PREFIX } from '@/modules/api/http'
import { parseJsonLossless } from '@/core/lossless-json'

/**
 * Binance-style futures REST (`/futures-api/fapi/*`, fgw 0.3.1 → trading-core memory; contract:
 * docs/04-design/futures-user-stream.md). Bare JSON answers (no `{code,data}` envelope), errors `{code:int,msg}` with
 * a 4xx/5xx status. Same web session as the legacy futures API (HttpOnly cookie, `exchange-token` at Nginx; 10-17).
 *
 * One generic `fapiRequest` so later endpoints (Binance-style order entry `POST/DELETE /fapi/v1/order`) are one
 * function each. Large ids (`orderId` / `i` / `t` are > 2^53) are parsed losslessly as strings.
 */

export const FAPI_TIMEOUT_MS = 10_000

/** Server codes the user stream reacts to (doc §5). */
export const FAPI_CODE_INVALID_SESSION = -2015
export const FAPI_CODE_NO_LISTEN_KEY = -1125

/** `JSON.parse` that keeps long integer ids exact (every unsafe integer, any key; core/lossless-json.ts). */
export function parseLosslessJson(text: string): unknown {
  return parseJsonLossless(text)
}

export type FapiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface FapiOptions {
  params?: Record<string, string | number | undefined>
  signal?: AbortSignal
  timeoutMs?: number
  /** Session key the call belongs to (closing the listenKey of a session being logged out); the cookie authenticates. */
  token?: string
}

/** `{code,msg}` (Binance) → `ApiError` with the numeric code as a string (`"-1125"`). */
function fapiError(status: number, body: unknown, path: string): ApiError {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = typeof record.code === 'number' || typeof record.code === 'string' ? String(record.code) : `HTTP${status}`
  const message = typeof record.msg === 'string' && record.msg !== '' ? record.msg : `HTTP ${status}`
  const kind = status === 401 || code === String(FAPI_CODE_INVALID_SESSION) ? 'unauthorized' : 'http'
  // `data` (filter bounds `{filter, minQty, …}`, `{reason, name}`) travels with the error for the texts (`fapi-errors.ts`).
  return new ApiError({ kind, code, message, status, path, data: record.data, product: 'futures' })
}

/** Is this a `-1125 listenKey does not exist` refusal (gateway restarted, key expired)? */
export function isNoListenKey(error: unknown): boolean {
  return error instanceof ApiError && error.code === String(FAPI_CODE_NO_LISTEN_KEY)
}

export async function fapiRequest<T>(method: FapiMethod, path: string, options: FapiOptions = {}): Promise<T> {
  const query = Object.entries(options.params ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const url = `${FUTURES_API_PREFIX}${path}${query === '' ? '' : `?${query}`}`
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? FAPI_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  const token = options.token ?? session.getToken()
  // the session is the HttpOnly cookie (10-17); `options.token` is only the session key the call belongs to
  const headers = buildHeaders()
  let response: Response
  let text: string
  try {
    response = await fetch(url, { method, headers, signal: controller.signal, credentials: 'same-origin' })
    text = await response.text()
  } catch (error_) {
    const kind = timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'network'
    throw new ApiError({ kind, code: '', message: error_ instanceof Error ? error_.message : String(error_), path, product: 'futures' })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  let body: unknown = null
  try {
    body = text === '' ? null : parseLosslessJson(text)
  } catch {
    if (response.ok) throw new ApiError({ kind: 'parse', code: '', message: `Invalid JSON from ${path}`, status: response.status, path })
  }
  if (!response.ok) throw fapiError(response.status, body, path)
  if (token !== null && token !== '') session.noteServerContact(token)
  return body as T
}

/* ------------------------------------------------------------------ listenKey */

function keyOf(body: unknown): string {
  const key = body !== null && typeof body === 'object' ? (body as { listenKey?: unknown }).listenKey : undefined
  if (typeof key !== 'string' || key === '') throw new ApiError({ kind: 'parse', code: '', message: 'listenKey missing', path: 'fapi/v1/listenKey' })
  return key
}

/** Creates (or returns the user's existing) listenKey, valid 60 min. */
export async function createListenKey(): Promise<string> {
  return keyOf(await fapiRequest<unknown>('POST', 'fapi/v1/listenKey'))
}

/** Extends the key by 60 min; `-1125` when the gateway no longer knows it. */
export async function keepAliveListenKey(): Promise<void> {
  await fapiRequest<unknown>('PUT', 'fapi/v1/listenKey')
}

/** Closes the key and its sockets (logout); `token` = the session that opened it. */
export async function closeListenKey(token?: string): Promise<void> {
  await fapiRequest<unknown>('DELETE', 'fapi/v1/listenKey', { token })
}

/* ------------------------------------------------------------------ snapshots */

export interface FapiAccountAsset {
  asset: string
  walletBalance: string
  unrealizedProfit: string
  marginBalance: string
  maintMargin: string
  initialMargin: string
  positionInitialMargin: string
  openOrderInitialMargin: string
  crossWalletBalance: string
  crossUnPnl: string
  availableBalance: string
  maxWithdrawAmount: string
}

export interface FapiAccountPosition {
  symbol: string
  positionSide: string
  positionAmt: string
  notional: string
  isolatedWallet: string
  unrealizedProfit?: string
  maintMargin?: string
  initialMargin?: string
  /** Version-1 account risk snapshot extension; generated with maintMargin in the same core risk calculation. */
  entryPrice?: string
  breakEvenPrice?: string
  markPrice?: string
  liquidationPrice?: string
  leverage?: string
  marginType?: string
}

export interface FapiAccount {
  assets: FapiAccountAsset[]
  positions: FapiAccountPosition[]
  totalOpenOrderInitialMargin?: string
  /** Present only when the account position risk-card fields share the account's calculation. */
  riskSnapshotVersion?: 1
}

export interface FapiPositionRisk {
  symbol: string
  positionSide: string
  positionAmt: string
  entryPrice: string
  breakEvenPrice?: string
  markPrice: string
  unRealizedProfit: string
  liquidationPrice: string
  leverage: string
  marginType: string
  isolatedMargin?: string
  isolatedWallet: string
  notional: string
  maintMargin?: string
  initialMargin?: string
}

export interface FapiOpenOrder {
  orderId: string
  symbol: string
  status: string
  price: string
  avgPrice: string
  origQty: string
  executedQty: string
  type: string
  origType?: string
  timeInForce: string
  side: string
  positionSide: string
  reduceOnly?: boolean
  time: number
  updateTime: number
  /** Conditional orders (fgw 0.6.9+): STOP / TAKE_PROFIT / STOP_MARKET / TAKE_PROFIT_MARKET. */
  stopPrice?: string
  workingType?: string
  closePosition?: boolean
  /** Vendor web market OPEN conditionals: the USDT amount (`origQty` 0), fgw 0.6.10. */
  origQuoteQty?: string
}

export function fetchFapiAccount(): Promise<FapiAccount> {
  return fapiRequest<FapiAccount>('GET', 'fapi/v3/account')
}

export function fetchPositionRisk(symbol?: string): Promise<FapiPositionRisk[]> {
  return fapiRequest<FapiPositionRisk[]>('GET', 'fapi/v3/positionRisk', { params: { symbol } })
}

export function fetchOpenOrders(symbol?: string): Promise<FapiOpenOrder[]> {
  return fapiRequest<FapiOpenOrder[]>('GET', 'fapi/v1/openOrders', { params: { symbol } })
}

export function fetchOpenOrder(symbol: string, orderId: string): Promise<FapiOpenOrder> {
  return fapiRequest<FapiOpenOrder>('GET', 'fapi/v1/openOrder', { params: { symbol, orderId } })
}
