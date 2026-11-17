import { ref, watch, type Ref } from 'vue'
import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'
import type { OrderSide } from './math'

/**
 * Binance-style order-entry helpers for the futures ticket (pure, decimal-only):
 *   - best-price shortcuts (对手价1/5, 同向价1/5) resolved against the live order book;
 *   - the USDT input mode (订单金额 = notional, 初始保证金 = initial margin) and its conversions;
 *   - the fee-aware maximum notional (available × leverage minus the taker fee).
 * Every amount is a decimal string; nothing here uses floating point.
 */

/* ------------------------------------------------------------------ best-price shortcuts */

export type BboOption = 'opp1' | 'opp5' | 'same1' | 'same5'
export const BBO_OPTIONS: readonly BboOption[] = ['opp1', 'opp5', 'same1', 'same5']

/** Top-of-book prices from the finest depth channel, nearest the spread first. */
export interface BookTop {
  asks: string[]
  bids: string[]
}

export type BboResolution =
  | { ok: true; price: string; bookSide: 'ask' | 'bid'; level: number }
  | { ok: false; error: 'noDepth'; bookSide: 'ask' | 'bid'; level: number; have: number }

/** Which side of the book an option reads for `side`: opposite = asks for a buy, bids for a sell. */
export function bboBookSide(option: BboOption, side: OrderSide): 'ask' | 'bid' {
  const opposite = option === 'opp1' || option === 'opp5'
  if (side === 'BUY') return opposite ? 'ask' : 'bid'
  return opposite ? 'bid' : 'ask'
}

export function bboLevel(option: BboOption): number {
  return option === 'opp5' || option === 'same5' ? 5 : 1
}

/**
 * Price for `option` on `side` from `top`: 对手价N = N-th level of the opposite side (buy → asks),
 * 同向价N = N-th level of the own side (buy → bids). Fails with `noDepth` when that level is missing,
 * never falls back to a different level.
 */
export function resolveBboPrice(option: BboOption, side: OrderSide, top: BookTop): BboResolution {
  const bookSide = bboBookSide(option, side)
  const level = bboLevel(option)
  const levels = (bookSide === 'ask' ? top.asks : top.bids).filter((price) => {
    const text = canonicalDecimal(price)
    return isDecimalString(text) && new Decimal(text).gt(0)
  })
  const price = levels[level - 1]
  if (price === undefined) return { ok: false, error: 'noDepth', bookSide, level, have: levels.length }
  return { ok: true, price: canonicalDecimal(price), bookSide, level }
}

/* ------------------------------------------------------------------ USDT input mode */

/** How a USDT amount on the ticket is read: order notional (订单金额) or initial margin (初始保证金). */
export type QuoteMode = 'notional' | 'margin'
export const QUOTE_MODE_KEY = 'picat.futures.quoteMode'
export const DEFAULT_QUOTE_MODE: QuoteMode = 'notional'

function isQuoteMode(value: unknown): value is QuoteMode {
  return value === 'notional' || value === 'margin'
}

export function readQuoteMode(): QuoteMode {
  try {
    const saved = localStorage.getItem(QUOTE_MODE_KEY)
    return isQuoteMode(saved) ? saved : DEFAULT_QUOTE_MODE
  } catch {
    return DEFAULT_QUOTE_MODE
  }
}

export function saveQuoteMode(mode: QuoteMode): void {
  try {
    localStorage.setItem(QUOTE_MODE_KEY, mode)
  } catch {
    // Private mode: not remembered.
  }
}

let sharedQuoteMode: Ref<QuoteMode> | null = null

/** App-wide USDT input mode, persisted per browser (`picat.futures.quoteMode`). */
export function useQuoteMode(): Ref<QuoteMode> {
  if (sharedQuoteMode === null) {
    const mode = ref<QuoteMode>(readQuoteMode())
    watch(mode, saveQuoteMode)
    sharedQuoteMode = mode
  }
  return sharedQuoteMode
}

/** Leverage and margin exchange rate (`marginRate`, normally 1) the margin ↔ notional maths needs. */
export interface MarginBasis {
  leverage: number
  marginRate: string
}

function dec(value: string): Decimal | null {
  const text = canonicalDecimal(value)
  return isDecimalString(text) ? new Decimal(text) : null
}

function basisOk(basis: MarginBasis): { leverage: Decimal; rate: Decimal } | null {
  if (!Number.isInteger(basis.leverage) || basis.leverage <= 0) return null
  const rate = dec(basis.marginRate) ?? new Decimal(1)
  if (rate.lte(0)) return null
  return { leverage: new Decimal(basis.leverage), rate }
}

/**
 * Initial margin → order notional: `margin × leverage / marginRate` (inverse of `openCost`), exact
 * (no rounding; the wire conversion floors afterwards). 100 USDT at 10x → 1000 USDT.
 */
export function marginToNotional(margin: string, basis: MarginBasis): string {
  const m = dec(margin)
  const b = basisOk(basis)
  if (m === null || b === null) return ''
  return canonicalDecimal(m.times(b.leverage).dividedBy(b.rate).toFixed())
}

/** Order notional → initial margin, rounded to `dp` (down for amounts/maxima, up for minimums). */
export function notionalToMargin(notional: string, basis: MarginBasis, dp: number, rounding: 'down' | 'up' = 'down'): string {
  const n = dec(notional)
  const b = basisOk(basis)
  if (n === null || b === null) return ''
  return canonicalDecimal(n.times(b.rate).dividedBy(b.leverage).toFixed(Math.max(0, dp), rounding === 'down' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP))
}

/* ------------------------------------------------------------------ fee-aware maximum */

/**
 * Largest opening notional the available balance covers once the taker fee is paid:
 *   margin + fee = N × marginRate / L + N × takerFee ≤ available
 *   ⇒ N = available × L / (marginRate + L × takerFee)
 * (1000 USDT, 10x, 0.05% → 9950.24 USDT). Rounded down to `dp`; `''` when unknown.
 */
export function maxOpenNotional(input: { available: string; leverage: number; marginRate: string; takerFee: string; dp: number }): string {
  const available = dec(input.available)
  const b = basisOk({ leverage: input.leverage, marginRate: input.marginRate })
  if (available === null || b === null) return ''
  if (available.lte(0)) return '0'
  const fee = dec(input.takerFee)
  const feeRate = fee === null || fee.lt(0) ? new Decimal(0) : fee
  const denominator = b.rate.plus(b.leverage.times(feeRate))
  return canonicalDecimal(available.times(b.leverage).dividedBy(denominator).toFixed(Math.max(0, input.dp), Decimal.ROUND_DOWN))
}

/** Whole contracts in `notional` at `price` (floored); `''` when unknown. */
export function notionalToContracts(notional: string, price: string, multiplier: string): string {
  const n = dec(notional)
  const p = dec(price)
  const m = dec(multiplier)
  if (n === null || p === null || m === null || p.lte(0) || m.lte(0)) return ''
  return n.dividedBy(p.times(m)).toFixed(0, Decimal.ROUND_DOWN)
}

/**
 * Open-taker fee used for the maximum. `common/getMakerAndTaker` returns one fee row per contract
 * config without a contract id; rows are matched by base coin (`multiplierCoin`) + margin coin. If
 * no row matches, the highest open-taker fee of all rows is used so the maximum never exceeds what
 * the account can pay. `''` (no rows) means "unknown" and the maximum ignores fees.
 */
export function pickTakerFee(
  rows: ReadonlyArray<{ openTakerFee: string; multiplierCoin?: string; marginCoin?: string }>,
  contract?: { multiplierCoin: string; marginCoin: string },
): string {
  const same = (a: string | undefined, b: string): boolean => (a ?? '').toUpperCase() === b.toUpperCase()
  const matched = contract === undefined ? [] : rows.filter((row) => same(row.multiplierCoin, contract.multiplierCoin) && same(row.marginCoin, contract.marginCoin))
  const pool = matched.length > 0 ? matched : rows
  let best: Decimal | null = null
  for (const row of pool) {
    const fee = dec(row.openTakerFee)
    if (fee === null || fee.lt(0)) continue
    if (best === null || fee.gt(best)) best = fee
  }
  return best === null ? '' : canonicalDecimal(best.toFixed())
}

/* ------------------------------------------------------------------ order types */

/**
 * Order types offered on the ticket, in Binance order. All four are executed by the live engine
 * (probe 2026-09-29 against the engine's own book): limit (1, with GTC / IOC 3 / FOK 4), post-only
 * (5: a crossing post-only buy was cancelled at once with memo 7 and nothing filled, while an IOC at
 * the same price filled), market (2) and conditional (trigger → limit or market).
 */
export type TicketOrderType = 'limit' | 'postOnly' | 'market' | 'trigger'
export const TICKET_ORDER_TYPES: readonly TicketOrderType[] = ['limit', 'postOnly', 'market', 'trigger']

/** The validation/estimate mode of a ticket type: post-only is a limit order for price and size rules. */
export function draftMode(type: TicketOrderType): 'limit' | 'market' | 'trigger' {
  return type === 'postOnly' ? 'limit' : type
}

/** Time in force of a plain limit order: GTC = type 1, IOC = type 3, FOK = type 4 (`OrderType`). */
export type TimeInForce = 'GTC' | 'IOC' | 'FOK'
export const TIME_IN_FORCE: readonly TimeInForce[] = ['GTC', 'IOC', 'FOK']
export const TIF_KEY = 'picat.futures.timeInForce'

export function readTimeInForce(): TimeInForce {
  try {
    const saved = localStorage.getItem(TIF_KEY)
    return saved === 'IOC' || saved === 'FOK' ? saved : 'GTC'
  } catch {
    return 'GTC'
  }
}

export function saveTimeInForce(value: TimeInForce): void {
  try {
    localStorage.setItem(TIF_KEY, value)
  } catch {
    // Private mode: not remembered.
  }
}

/** Wire `type` for `order/order_create`. */
export function orderTypeCode(mode: TicketOrderType, triggerAtMarket: boolean, tif: TimeInForce): 1 | 2 | 3 | 4 | 5 {
  if (mode === 'postOnly') return 5
  if (mode === 'market') return 2
  if (mode === 'trigger') return triggerAtMarket ? 2 : 1
  if (tif === 'IOC') return 3
  if (tif === 'FOK') return 4
  return 1
}
