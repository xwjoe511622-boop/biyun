import {
  Decimal,
  canonicalDecimal,
  decimalPlaces,
  isDecimalString,
  isPositive,
  lt,
  gt,
  min as decMin,
  toDecString,
} from '@/modules/finance/decimal'

/**
 * C2C amount maths. Every value is a decimal string; Decimal.js does the arithmetic.
 *
 * Conventions (from the legacy PC `otcTrade.js` + `OrderActV4.buy_order_save / sell_order_save`):
 * - `minTrade` / `maxTrade` on an advert are FIAT limits (the order `totalPrice`).
 * - `volumeBalance` is the advert's remaining COIN amount.
 * - Fiat amounts round down to the fiat precision, coin amounts round down to the coin precision.
 */

export const DEFAULT_FIAT_PRECISION = 2
export const DEFAULT_COIN_PRECISION = 6

/** Legacy list endpoints append the fiat code to money fields (`"7.12CNY"`). Returns the bare decimal. */
export function stripCurrencySuffix(value: unknown): string {
  const text = toDecString(value).trim()
  if (text === '') return ''
  const match = /^(\d+(?:\.\d+)?)\s*[A-Za-z]*$/.exec(text)
  return match === null ? '' : match[1]
}

/** Keeps only digits and one dot, truncating to `dp` decimals (input sanitiser; never rounds up). */
export function sanitizeDecimalInput(raw: string, dp: number): string {
  let text = raw.replace(/[^\d.]/g, '')
  const dot = text.indexOf('.')
  if (dot !== -1) {
    text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, '')
  }
  if (text.startsWith('.')) text = `0${text}`
  if (dp <= 0) return text.split('.')[0]
  const [intPart, fraction] = text.split('.')
  if (fraction === undefined) return text
  return `${intPart}.${fraction.slice(0, dp)}`
}

function roundDown(value: Decimal, dp: number): string {
  return value.toDecimalPlaces(Math.max(0, dp), Decimal.ROUND_DOWN).toFixed()
}

/** coin = fiat / price, rounded down to the coin precision. `''` when inputs are unusable. */
export function fiatToCoin(fiat: string, price: string, coinDp: number): string {
  if (!isDecimalString(fiat) || !isPositive(price)) return ''
  return roundDown(new Decimal(fiat).dividedBy(price), coinDp)
}

/** fiat = coin × price, rounded down to the fiat precision. */
export function coinToFiat(coin: string, price: string, fiatDp: number): string {
  if (!isDecimalString(coin) || !isDecimalString(price)) return ''
  return roundDown(new Decimal(coin).times(price), fiatDp)
}

export type AmountMode = 'fiat' | 'coin'

export interface TradeLimitsInput {
  /** What the user typed. */
  input: string
  mode: AmountMode
  price: string
  /** Fiat limits of the advert. */
  minTrade: string
  maxTrade: string
  /** Remaining coin on the advert. */
  volumeBalance: string
  fiatDp: number
  coinDp: number
}

export type TradeAmountError =
  | 'required'
  | 'invalid'
  | 'precision'
  | 'belowMin'
  | 'aboveMax'
  | 'aboveAvailable'
  | 'zero'

export interface TradeAmountResult {
  ok: boolean
  error: TradeAmountError | null
  /** Fiat total (order `totalPrice`). */
  fiat: string
  /** Coin amount (order `volume`). */
  volume: string
}

/**
 * The effective fiat ceiling: the advert's `maxTrade`, but never more than what the remaining coin is
 * worth (`volumeBalance × price`). Returns `''` when unknown.
 */
export function effectiveMaxFiat(maxTrade: string, volumeBalance: string, price: string, fiatDp: number): string {
  const cap = coinToFiat(volumeBalance, price, fiatDp)
  if (isDecimalString(maxTrade) && isDecimalString(cap)) return decMin(maxTrade, cap)
  if (isDecimalString(maxTrade)) return maxTrade
  return cap
}

/** Validates a buy/sell dialog amount and derives the other side of the pair. */
export function evaluateTradeAmount(params: TradeLimitsInput): TradeAmountResult {
  const empty = { fiat: '', volume: '' }
  const input = params.input.trim()
  if (input === '') return { ok: false, error: 'required', ...empty }
  if (!isDecimalString(input)) return { ok: false, error: 'invalid', ...empty }
  const dp = params.mode === 'fiat' ? params.fiatDp : params.coinDp
  const places = decimalPlaces(input)
  if (places !== null && places > dp) return { ok: false, error: 'precision', ...empty }
  if (!isPositive(input)) return { ok: false, error: 'zero', ...empty }
  if (!isPositive(params.price)) return { ok: false, error: 'invalid', ...empty }

  const fiat = params.mode === 'fiat' ? canonicalDecimal(input) : coinToFiat(input, params.price, params.fiatDp)
  const volume = params.mode === 'coin' ? canonicalDecimal(input) : fiatToCoin(input, params.price, params.coinDp)
  const derived = { fiat, volume }

  if (!isPositive(volume) || !isPositive(fiat)) return { ok: false, error: 'zero', ...derived }
  if (isDecimalString(params.volumeBalance) && gt(volume, params.volumeBalance)) {
    return { ok: false, error: 'aboveAvailable', ...derived }
  }
  if (isDecimalString(params.minTrade) && lt(fiat, params.minTrade)) {
    return { ok: false, error: 'belowMin', ...derived }
  }
  if (isDecimalString(params.maxTrade) && gt(fiat, params.maxTrade)) {
    return { ok: false, error: 'aboveMax', ...derived }
  }
  return { ok: true, error: null, ...derived }
}

/** "Max" button: the largest amount allowed, in the requested mode. */
export function maxTradeAmount(params: Omit<TradeLimitsInput, 'input'>): string {
  const maxFiat = effectiveMaxFiat(params.maxTrade, params.volumeBalance, params.price, params.fiatDp)
  if (!isDecimalString(maxFiat)) return ''
  if (params.mode === 'fiat') return canonicalDecimal(maxFiat)
  const coin = fiatToCoin(maxFiat, params.price, params.coinDp)
  if (isDecimalString(params.volumeBalance) && isDecimalString(coin)) return canonicalDecimal(decMin(coin, params.volumeBalance))
  return coin
}

/** Floating price = reference × (1 ± rate%), rounded down to the fiat precision. */
export function floatingPrice(reference: string, ratePercent: string, direction: 'above' | 'below', fiatDp: number): string {
  if (!isPositive(reference) || !isDecimalString(ratePercent)) return ''
  const factor = new Decimal(ratePercent).dividedBy(100)
  const multiplier = direction === 'above' ? new Decimal(1).plus(factor) : new Decimal(1).minus(factor)
  if (multiplier.lte(0)) return ''
  return roundDown(new Decimal(reference).times(multiplier), fiatDp)
}
