import { newClientOrderId } from '@/modules/futures/fapi-order'
import type { SpotOrderParams } from './spot-api'
import { v3Symbol } from './spot-stream-model'

/**
 * Spot order entry on `/api/v3/order` (fgw session mode → Rust spot core), with the classic `order/create` as the
 * fallback. The ticket's payload keeps the classic wire meaning (`volume` = base quantity for a limit order and a
 * market sell, quote amount for a market buy), which is exactly the Binance split:
 *   LIMIT  → `price` + `quantity` + `timeInForce` (GTC / IOC / FOK)
 *   MARKET BUY → `quoteOrderQty`;  MARKET SELL → `quantity`.
 */

export type SpotTimeInForce = 'GTC' | 'IOC' | 'FOK'
export const SPOT_TIFS: readonly SpotTimeInForce[] = ['GTC', 'IOC', 'FOK']

export interface SpotOrderPayload {
  side: 'BUY' | 'SELL'
  type: '1' | '2'
  price: string
  volume: string
  /** Limit orders only; GTC when absent. IOC / FOK exist only on `/api/v3` (never sent to the classic path). */
  timeInForce?: SpotTimeInForce
}

/**
 * Build-time switch `VITE_SPOT_V3_ORDERS` ('0' / 'false' / 'off' → classic only). Default on in the app; off under
 * vitest so the classic-path suites keep testing the fallback (`setSpotV3Enabled` turns it on in a test).
 */
let enabled: boolean = (() => {
  const raw = import.meta.env.VITE_SPOT_V3_ORDERS
  if (typeof raw === 'string' && ['0', 'false', 'off'].includes(raw.trim().toLowerCase())) return false
  return import.meta.env.MODE !== 'test'
})()

/** A refusal that means "no session-mode `/api/v3` here" turns it off for this long, then it is tried again. */
export const V3_RETRY_AFTER_MS = 5 * 60_000
let unavailableUntil = 0

export function spotV3Enabled(now = Date.now()): boolean {
  return enabled && now >= unavailableUntil
}

/** Tests / emergency switch. */
export function setSpotV3Enabled(on: boolean): void {
  enabled = on
  unavailableUntil = 0
}

/** The gateway answered "not here" (404 / HTML / API-key only): classic path for a while. */
export function markSpotV3Unavailable(now = Date.now()): void {
  unavailableUntil = now + V3_RETRY_AFTER_MS
}

/** `/api/v3/order` parameters for a ticket payload, or null when it cannot be expressed (then: classic path). */
export function spotOrderParams(symbol: string, payload: SpotOrderPayload, clientId = newClientOrderId()): SpotOrderParams | null {
  if (symbol === '' || payload.volume === '') return null
  const params: SpotOrderParams = { symbol: v3Symbol(symbol), side: payload.side, newClientOrderId: clientId, newOrderRespType: 'RESULT' }
  if (payload.type === '1') {
    if (payload.price === '') return null
    params.type = 'LIMIT'
    params.timeInForce = payload.timeInForce ?? 'GTC'
    params.price = payload.price
    params.quantity = payload.volume
  } else if (payload.side === 'BUY') {
    params.type = 'MARKET'
    params.quoteOrderQty = payload.volume
  } else {
    params.type = 'MARKET'
    params.quantity = payload.volume
  }
  return params
}
