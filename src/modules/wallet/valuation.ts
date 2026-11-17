import { add, canonicalDecimal, div, groupDigits, isDecimalString, isPositive, isZero, mul, toFixedString } from '@/modules/finance/decimal'

/**
 * Asset valuation display (home account card, assets overview), Binance style: the total in a
 * chosen unit (BTC / USDT / USD), a secondary `≈ $x,xxx.xx` line, per-coin amounts at the coin's
 * display precision with their USD value, and a hide-amounts toggle.
 *
 * Sources (all real, nothing invented):
 * - `finance/account_balance`: `totalBalance` (denominated in `totalBalanceSymbol`, BTC on this
 *   deployment) and each coin's `btcValuatin`.
 * - BTC→USDT: the last BTC/USDT price from the market `review` stream (`market.tickers.btcusdt`).
 * - USD: there is no USD rate source (`public_info_v4.market.rate.en_US` only carries `USD: "1"`, a
 *   fiat self-rate, not a coin price), so USD is shown at USDT 1:1 — approximate, hence the `≈`.
 *
 * All math is decimal-string (`@/modules/finance/decimal`), rounded down, never `Number`.
 */
export type ValuationUnit = 'BTC' | 'USDT' | 'USD'
export const VALUATION_UNITS: readonly ValuationUnit[] = ['BTC', 'USDT', 'USD']
const UNIT_DECIMALS: Record<ValuationUnit, number> = { BTC: 8, USDT: 2, USD: 2 }
/** Display cap for coin amounts (the coin's `showPrecision`, never more than 8). */
export const MAX_COIN_DECIMALS = 8
export const HIDDEN_MASK = '******'

const UNIT_KEY = 'longbit.valuation.unit.v1'
const HIDE_KEY = 'longbit.valuation.hidden.v1'

/** Positive BTC/USDT price from the tickers, or `''` when the stream has not delivered one. */
export function btcUsdtPrice(tickers: Record<string, { close?: string } | undefined>): string {
  const close = canonicalDecimal(tickers.btcusdt?.close ?? '')
  return isDecimalString(close) && isPositive(close) ? close : ''
}

/** Converts an amount denominated in `from` (BTC or USDT) to `to`; `''` when no price is available. */
export function convertValue(amount: string, from: string, to: ValuationUnit, btcPrice: string): string {
  const value = canonicalDecimal(amount)
  if (!isDecimalString(value)) return ''
  const source = from.toUpperCase()
  const sourceIsUsd = source === 'USDT' || source === 'USD'
  const targetIsUsd = to === 'USDT' || to === 'USD'
  if (source === to || (sourceIsUsd && targetIsUsd)) return value
  if (source === 'BTC' && targetIsUsd) return btcPrice === '' ? '' : mul(value, btcPrice)
  // Division rounds down to 12 places; the display truncates to 8.
  if (sourceIsUsd && to === 'BTC') return btcPrice === '' ? '' : div(value, btcPrice, 12)
  return ''
}

/** Unit-appropriate text: BTC at most 8 decimals (trailing zeros trimmed), USDT/USD 2 decimals, grouped. */
export function formatValuation(value: string, unit: ValuationUnit): string {
  if (!isDecimalString(value)) return '--'
  const fixed = toFixedString(value, UNIT_DECIMALS[unit])
  return unit === 'BTC' ? groupDigits(canonicalDecimal(fixed)) : groupDigits(fixed, UNIT_DECIMALS[unit])
}

/** `≈ $1,234.56` from a USD(T) amount; `''` when unknown. */
export function usdLine(usdValue: string): string {
  return isDecimalString(usdValue) ? `≈ $${groupDigits(toFixedString(usdValue, 2), 2)}` : ''
}

/** Coin amount trimmed to its display precision (max 8, rounded down, trailing zeros removed). */
export function formatCoinAmount(amount: string, showPrecision: number): string {
  const value = canonicalDecimal(amount)
  if (!isDecimalString(value)) return '--'
  const dp = Math.max(0, Math.min(Number.isInteger(showPrecision) ? showPrecision : MAX_COIN_DECIMALS, MAX_COIN_DECIMALS))
  return groupDigits(canonicalDecimal(toFixedString(value, dp)))
}

const USD_COINS = new Set(['USDT', 'USD'])

/**
 * USD value of a coin holding: USDT itself 1:1; otherwise the coin's own `<COIN>/USDT` last price;
 * otherwise its BTC valuation × BTC/USDT. `''` when none is known.
 */
export function coinUsdValue(
  coin: string,
  amount: string,
  btcValuation: string,
  tickers: Record<string, { close?: string } | undefined>,
  multiply: (left: string, right: string) => string = mul,
): string {
  const value = canonicalDecimal(amount)
  const upper = coin.toUpperCase()
  if (USD_COINS.has(upper)) return isDecimalString(value) ? value : ''
  const close = canonicalDecimal(tickers[`${upper.toLowerCase()}usdt`]?.close ?? '')
  if (isDecimalString(value) && isDecimalString(close) && isPositive(close)) return multiply(value, close)
  const btc = canonicalDecimal(btcValuation)
  const price = btcUsdtPrice(tickers)
  return isDecimalString(btc) && price !== '' ? multiply(btc, price) : ''
}

/**
 * BTC value of the current holding, using only this balance and current market quotes. Never falls
 * back to the legacy per-row BTC snapshot: that snapshot can precede the authoritative balances.
 * Division rounds DOWN to 12 places, followed by the normal 8-place BTC display truncation.
 */
export function coinBtcValue(coin: string, amount: string, tickers: Record<string, { close?: string } | undefined>): string {
  const value = canonicalDecimal(amount)
  if (!isDecimalString(value)) return ''
  if (coin.toUpperCase() === 'BTC' || isZero(value)) return value
  const usd = coinUsdValue(coin, value, '', tickers)
  return usd === '' ? '' : convertValue(usd, 'USDT', 'BTC', btcUsdtPrice(tickers))
}

/** One holding as the account snapshot returns it (`coinRows` of the account store). */
export interface ValuationRow {
  coin: string
  total: string
  btcValuation: string
}

/**
 * Total USD(T) value summed per holding (QA-001, 10-25): USDT 1:1, other coins at their own live price. The server's
 * `totalBalance` is a BTC snapshot priced at request time; multiplying it by a newer BTC/USDT price re-prices the USDT
 * part too, so a USDT-only account "moved" with BTC (2,482 USDT on a 2M balance). `''` when any non-zero holding has
 * no price (the caller then falls back to the BTC snapshot).
 */
export function totalUsdValue(rows: readonly ValuationRow[], tickers: Record<string, { close?: string } | undefined>): string {
  let total = '0'
  for (const row of rows) {
    const amount = canonicalDecimal(row.total)
    if (!isDecimalString(amount) || isZero(amount)) continue
    const value = coinUsdValue(row.coin, amount, row.btcValuation, tickers)
    if (!isDecimalString(value)) return ''
    total = add(total, value)
  }
  return total
}

/**
 * The figure shown for `unit`: USDT / USD from the per-holding sum when known, BTC from the server snapshot (its own
 * price, never re-priced); otherwise the snapshot converted at the live BTC/USDT price.
 */
export function valuationIn(unit: ValuationUnit, totalBtc: string, sourceSymbol: string, usdTotal: string, btcPrice: string): string {
  if (unit !== 'BTC' && usdTotal !== '') return usdTotal
  return convertValue(totalBtc, sourceSymbol, unit, btcPrice)
}

function storageKey(base: string, userId: string): string {
  return userId === '' ? base : `${base}:${userId}`
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* A preference only: storage failure keeps the in-memory choice. */
  }
}

/** The user's remembered unit (per user id; BTC when nothing is stored). */
/** `fallback` is the unit shown until the user picks one (BTC on desktop, USDT on phones). */
export function readValuationUnit(userId: string, fallback: ValuationUnit = 'BTC'): ValuationUnit {
  const raw = readItem(storageKey(UNIT_KEY, userId))
  return VALUATION_UNITS.find((unit) => unit === raw) ?? fallback
}

export function writeValuationUnit(userId: string, unit: ValuationUnit): void {
  writeItem(storageKey(UNIT_KEY, userId), unit)
}

export function readAmountsHidden(userId: string): boolean {
  return readItem(storageKey(HIDE_KEY, userId)) === '1'
}

export function writeAmountsHidden(userId: string, hidden: boolean): void {
  writeItem(storageKey(HIDE_KEY, userId), hidden ? '1' : '0')
}
