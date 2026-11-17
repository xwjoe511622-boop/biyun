import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { buildHeaders } from '@/modules/api/http'
import { parseLosslessJson } from '@/modules/futures/fapi'
import { siteWsUrl } from '@/config/site'

/**
 * Binance-style spot REST (`/api/v3/*`, fgw `spotv3.rs` → Rust spot core; reference docs/03-reference/api/spot-v3.md).
 * Web-session mode: the same web session as the classic API and `/fapi` (HttpOnly cookie → `exchange-token` at Nginx, 10-17; no API key, no signature). Bare
 * JSON answers, errors `{code:int,msg}` with a 4xx/5xx status → `ApiError` with the code as a string (`"-2010"`) and
 * `path` starting with `api/v3/` (`spot-errors.ts` describes them).
 */

/** Same-origin prefix (default `/`): `/api/v3/order`. Build-time override `VITE_SPOT_V3_BASE`. */
export const SPOT_V3_PREFIX: string = (() => {
  const raw = import.meta.env.VITE_SPOT_V3_BASE
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().replace(/\/*$/, '/') : '/'
})()

/** Spot user data stream socket base (`<base>/<listenKey>`); build-time override `VITE_SPOT_USER_WS_URL`. */
export const SPOT_USER_WS_URL: string = (() => {
  const raw = import.meta.env.VITE_SPOT_USER_WS_URL
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : siteWsUrl('/spot/ws')
})()

export const SPOT_V3_TIMEOUT_MS = 10_000
/** Order requests wait as long as the classic path (15 s, "result unconfirmed" after that). */
export const SPOT_ORDER_TIMEOUT_MS = 15_000

export type SpotMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface SpotV3Options {
  params?: Record<string, string | number | undefined>
  signal?: AbortSignal
  timeoutMs?: number
  /** Session key the call belongs to (closing the listenKey of a session being logged out); the cookie authenticates. */
  token?: string
}

function v3Error(status: number, body: unknown, path: string): ApiError {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = typeof record.code === 'number' || typeof record.code === 'string' ? String(record.code) : `HTTP${status}`
  const message = typeof record.msg === 'string' && record.msg !== '' ? record.msg : `HTTP ${status}`
  const kind = status === 401 ? 'unauthorized' : 'http'
  return new ApiError({ kind, code, message, status, path, data: record.data, product: 'spot' })
}

export async function spotV3Request<T>(method: SpotMethod, path: string, options: SpotV3Options = {}): Promise<T> {
  const query = Object.entries(options.params ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const url = `${SPOT_V3_PREFIX}${path}${query === '' ? '' : `?${query}`}`
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? SPOT_V3_TIMEOUT_MS)
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
    throw new ApiError({ kind, code: '', message: error_ instanceof Error ? error_.message : String(error_), path, product: 'spot' })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  let body: unknown = null
  try {
    body = text === '' ? null : parseLosslessJson(text)
  } catch {
    // An HTML error page (no route yet: nginx 404 / SPA fallback) is "not available", never a parse crash.
    if (response.ok) throw new ApiError({ kind: 'parse', code: '', message: `Invalid JSON from ${path}`, status: response.status, path, product: 'spot' })
  }
  if (!response.ok) throw v3Error(response.status, body, path)
  if (token !== null && token !== '') session.noteServerContact(token)
  return body as T
}

/* ------------------------------------------------------------------ listenKey */

function keyOf(body: unknown): string {
  const key = body !== null && typeof body === 'object' ? (body as { listenKey?: unknown }).listenKey : undefined
  if (typeof key !== 'string' || key === '') throw new ApiError({ kind: 'parse', code: '', message: 'listenKey missing', path: 'api/v3/userDataStream', product: 'spot' })
  return key
}

let currentKey: string | null = null

/** `POST userDataStream` (60 min; PUT extends it). */
export async function createSpotListenKey(): Promise<string> {
  currentKey = keyOf(await spotV3Request<unknown>('POST', 'api/v3/userDataStream'))
  return currentKey
}

/** `PUT userDataStream` with the key (Binance requires it); `-1125` when the gateway no longer knows it. */
export async function keepAliveSpotListenKey(): Promise<void> {
  await spotV3Request<unknown>('PUT', 'api/v3/userDataStream', { params: { listenKey: currentKey ?? undefined } })
}

/*
 * No DELETE: fgw keeps ONE listenKey per uid, shared with the user's API-key clients (spot-v3.md §1.1); closing it
 * on logout / unload would cut their connections. The page just stops using it (it expires 60 min after the last PUT).
 */

/* ------------------------------------------------------------------ snapshots */

export interface SpotV3Balance {
  asset: string
  free: string
  locked: string
}

export interface SpotV3Account {
  balances: SpotV3Balance[]
  [key: string]: unknown
}

/** Binance order object (`order_obj` in spotv3.rs). `orderId` is a lossless string. */
export interface SpotV3Order {
  symbol: string
  orderId: string | number
  clientOrderId?: string
  price: string
  origQty: string
  executedQty: string
  cummulativeQuoteQty: string
  status: string
  timeInForce?: string
  type: string
  side: string
  time?: number
  updateTime?: number
  origQuoteOrderQty?: string
  /** Not Binance: 1 spot / 2 margin, when the gateway passes it (margin rows are dropped). */
  orderType?: number
}

export function fetchSpotAccount(): Promise<SpotV3Account> {
  return spotV3Request<SpotV3Account>('GET', 'api/v3/account')
}

export function fetchSpotOpenOrders(symbol?: string): Promise<SpotV3Order[]> {
  return spotV3Request<SpotV3Order[]>('GET', 'api/v3/openOrders', { params: { symbol } })
}

/** Read one authoritative order, including its final state (core memory, then persistent history). */
export function fetchSpotOrder(symbol: string, orderId: string, signal?: AbortSignal): Promise<SpotV3Order> {
  return spotV3Request<SpotV3Order>('GET', 'api/v3/order', { params: { symbol, orderId }, signal })
}

/* ------------------------------------------------------------------ orders */

export type SpotOrderParams = Record<string, string>

/** `POST order` → the order object (`newOrderRespType` RESULT). */
export function placeSpotOrder(params: SpotOrderParams): Promise<SpotV3Order> {
  return spotV3Request<SpotV3Order>('POST', 'api/v3/order', { params, timeoutMs: SPOT_ORDER_TIMEOUT_MS })
}

/** `DELETE order` (answer status `PENDING_CANCEL`; the final `CANCELED` arrives on the stream). */
export function cancelSpotOrder(symbol: string, orderId: string): Promise<SpotV3Order> {
  return spotV3Request<SpotV3Order>('DELETE', 'api/v3/order', { params: { symbol, orderId } })
}

/** `DELETE openOrders` (every open order of the symbol). */
export function cancelAllSpotOrders(symbol: string): Promise<unknown> {
  return spotV3Request<unknown>('DELETE', 'api/v3/openOrders', { params: { symbol } })
}
