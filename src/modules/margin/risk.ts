import { Decimal, canonicalDecimal, groupDigits, isDecimalString, isPositive, isZero, toFixedString } from '@/modules/finance/decimal'

/**
 * Risk-rate presentation for isolated margin accounts.
 *
 * The server's risk rate is `assets / (borrowed + interest)` (LeverUtils.calculateRiskRate) and the
 * API returns it multiplied by 100 with scale 0 — `150` means 150 %. The thresholds are the server
 * constants in exchange-common/.../util/LeverUtils.java:19-23:
 *   1.0  LEVER_BURST_WEAR_RATE      穿仓 (assets no longer cover the debt)
 *   1.1  LEVER_BURST_RISK_RATE      爆仓 (liquidation is triggered)
 *   1.3  LEVER_BURST_REMIND_RATE    爆仓提醒 (margin-call reminder)
 *   1.5  LEVER_BURST_BORROW_RATE    more borrowing is refused below this
 *   2.0  LEVER_BURST_TRANFERS_RATE  transfers out are refused below this
 * A rate of `0` means "nothing borrowed" (calculateRiskRate returns ZERO), not "bankrupt".
 */
export const RISK_THRESHOLDS = {
  wear: '100',
  liquidation: '110',
  reminder: '130',
  borrow: '150',
  transfer: '200',
} as const

export type RiskBand = 'none' | 'safe' | 'normal' | 'caution' | 'danger' | 'liquidation' | 'unknown'

/** Band for a percent risk rate string. `''`/non-decimal → `unknown`; `0` → `none` (no debt). */
export function riskBand(riskRatePercent: string): RiskBand {
  const value = canonicalDecimal(riskRatePercent)
  if (!isDecimalString(value)) return 'unknown'
  if (isZero(value)) return 'none'
  const rate = new Decimal(value)
  if (rate.lte(RISK_THRESHOLDS.liquidation)) return 'liquidation'
  if (rate.lte(RISK_THRESHOLDS.reminder)) return 'danger'
  if (rate.lt(RISK_THRESHOLDS.borrow)) return 'caution'
  if (rate.lt(RISK_THRESHOLDS.transfer)) return 'normal'
  return 'safe'
}

/** Account balances disambiguate a real 0% with debt from the legacy no-debt zero sentinel. */
export function accountRiskBand(rate: string, hasBorrowing: boolean | null): RiskBand {
  if (hasBorrowing === null) return 'unknown'
  if (!hasBorrowing) return 'none'
  const value = canonicalDecimal(rate)
  return isDecimalString(value) && isZero(value) ? 'liquidation' : riskBand(rate)
}

export function accountRiskText(rate: string, hasBorrowing: boolean | null): string {
  const value = canonicalDecimal(rate)
  return hasBorrowing === true && isDecimalString(value) ? `${value}%` : '--'
}

/** CSS colour token for a band (theme-aware custom properties). */
export function riskColor(band: RiskBand): string {
  switch (band) {
    case 'safe':
    case 'normal':
      return 'var(--color-up)'
    case 'caution':
      return 'var(--color-accent)'
    case 'danger':
    case 'liquidation':
      return 'var(--color-down)'
    default:
      return 'var(--color-text-muted)'
  }
}

/**
 * Gauge fill in [0, 1] mapping 100 % → 0 and 300 % → 1 (display only). The scale is anchored on the
 * wear threshold so the danger bands occupy a readable share of the arc.
 */
export const GAUGE_MIN = '100'
export const GAUGE_MAX = '300'

export function riskGaugeFraction(riskRatePercent: string): number {
  const value = canonicalDecimal(riskRatePercent)
  if (!isDecimalString(value) || isZero(value)) return 0
  const clamped = Decimal.min(Decimal.max(new Decimal(value), GAUGE_MIN), GAUGE_MAX)
  return clamped.minus(GAUGE_MIN).dividedBy(new Decimal(GAUGE_MAX).minus(GAUGE_MIN)).toNumber()
}

/** Fraction positions of the server thresholds on the gauge scale (for tick marks). */
export function thresholdFraction(percent: string): number {
  return new Decimal(percent).minus(GAUGE_MIN).dividedBy(new Decimal(GAUGE_MAX).minus(GAUGE_MIN)).toNumber()
}

/** `150` → `150%`, `0` → `--` (no debt), non-decimal → `--`. */
export function formatRiskRate(riskRatePercent: string): string {
  const value = canonicalDecimal(riskRatePercent)
  if (!isDecimalString(value) || isZero(value)) return '--'
  return `${value}%`
}

/** Liquidation price is `0` when there is no debt; show `--` then instead of a fake `0`. */
export function formatBurstPrice(burstPrice: string, dp: number): string {
  const value = canonicalDecimal(burstPrice)
  if (!isPositive(value)) return '--'
  return new Decimal(value).toFixed(dp, Decimal.ROUND_DOWN)
}

/**
 * Whether the pair has a borrow rule. `lever/finance/symbol/balance` sends `multiple: 0`, `rate: 0` and min borrow 0
 * when the admin rule is missing (QA-051, SOL/USDT); a real rule always has a positive multiple.
 */
export function hasBorrowRule(account: { multiple: string }): boolean {
  return isPositive(canonicalDecimal(account.multiple))
}

/** Daily rate fraction (`0.0005`) → `0.05%`; the borrow_rule endpoint already sends percent. */
export function formatDailyRate(rateFraction: string, dp = 4): string {
  const value = canonicalDecimal(rateFraction)
  if (!isDecimalString(value)) return '--'
  const percent = new Decimal(value).times(100).toFixed(dp, Decimal.ROUND_HALF_UP)
  return `${canonicalDecimal(percent)}%`
}

/**
 * Net assets of one pair in the quote coin: `(baseTotal − baseBorrow) × price + (quoteTotal − quoteBorrow)`.
 * The API has no per-pair net asset field (`netAssetBalance` on lever/finance/balance is overwritten per
 * pair in a loop), so this is derived from returned balances and the live price. Returns `''` when any
 * input is missing. Interest is not included: the API does not return current interest per pair.
 */
export function netAssetsInQuote(input: {
  baseTotalBalance: string
  baseBorrowBalance: string
  quoteTotalBalance: string
  quoteBorrowBalance: string
  price: string
}): string {
  const values = [input.baseTotalBalance, input.baseBorrowBalance, input.quoteTotalBalance, input.quoteBorrowBalance, input.price].map(canonicalDecimal)
  if (values.some(value => !isDecimalString(value))) return ''
  const [baseTotal, baseBorrow, quoteTotal, quoteBorrow, price] = values.map(value => new Decimal(value))
  return baseTotal.minus(baseBorrow).times(price).plus(quoteTotal.minus(quoteBorrow)).toFixed()
}

/**
 * Amount for display: rounded down to `dp`, trailing zeros trimmed, digits grouped. Negative values
 * (net assets) keep their sign; anything non-decimal renders `--` so missing data never looks like 0.
 */
export function displayAmount(value: string | undefined, dp = 8): string {
  const normalized = canonicalDecimal(value ?? '')
  const negative = normalized.startsWith('-')
  const magnitude = negative ? normalized.slice(1) : normalized
  if (!isDecimalString(magnitude)) return '--'
  const text = groupDigits(canonicalDecimal(toFixedString(magnitude, dp)))
  return negative && text !== '0' ? `-${text}` : text
}

/**
 * Executed quantity / value / fee exactly as recorded (QA-005, 10-25): trailing zeros trimmed, digits grouped, never
 * truncated — a fill of 0.00415163 ETH or a 0.000000245 BTC fee must reconcile to the last digit. `--` when missing.
 */
export function exactAmount(value: string | undefined): string {
  const normalized = canonicalDecimal(value ?? '')
  const negative = normalized.startsWith('-')
  const magnitude = negative ? normalized.slice(1) : normalized
  if (!isDecimalString(magnitude)) return '--'
  const text = groupDigits(canonicalDecimal(magnitude))
  return negative && text !== '0' ? `-${text}` : text
}
