import { groupDigits, Decimal, canonicalDecimal, decimalPlaces, isDecimalString, isPositive } from '@/modules/finance/decimal'
import type { FuturesContract } from './contracts'
import { isSignedDecimal, signedDisplay, signedPercent, sign } from './signed'

/**
 * Futures order maths. Formulas follow the legacy client (`coTrade/tradeForm/calculateVolume.js`)
 * for USDT-margined (forward, `contractSide = 1`) contracts; the server re-validates everything and
 * its answer always wins. All inputs/outputs are decimal strings.
 */

export type OrderMode = 'limit' | 'market' | 'trigger'
export type OrderOpen = 'OPEN' | 'CLOSE'
export type OrderSide = 'BUY' | 'SELL'

/* ------------------------------------------------------------------ estimates */

function dec(value: string): Decimal | null {
  return isDecimalString(value) ? new Decimal(value) : null
}

/** Notional value of `contracts` at `price`: `contracts * multiplier * price`. */
export function contractsValue(contracts: string, multiplier: string, price: string): string {
  const c = dec(contracts)
  const m = dec(multiplier)
  const p = dec(price)
  if (c === null || m === null || p === null) return ''
  return c.times(m).times(p).toFixed()
}

/**
 * Value of a futures trade in the quote coin: `vol * multiplier * price` (L43). The futures WS
 * `amount` is `vol * price` (the closed-source futures-wss omits the face value), so it is never shown.
 */
export function futuresTradeValue(trade: { vol: string | number; price: string | number }, multiplier: string): string {
  return contractsValue(canonicalDecimal(String(trade.vol)), multiplier, canonicalDecimal(String(trade.price)))
}

/**
 * 24h turnover in the quote coin from a futures ticker. The WS ticker `amount` is `Σ vol * price`
 * (face value missing, L43), so the true turnover is `amount * multiplier`; `''` while the
 * multiplier is unknown rather than a value 1/multiplier too large.
 */
export function futuresTurnover(wsAmount: string, multiplier: string): string {
  const a = dec(wsAmount)
  const m = dec(multiplier)
  if (a === null || m === null) return ''
  return a.times(m).toFixed()
}

/** Whole contracts bought by `value` at `price` (rounded down). */
export function valueToContracts(value: string, multiplier: string, price: string): string {
  const v = dec(value)
  const m = dec(multiplier)
  const p = dec(price)
  if (v === null || m === null || p === null || m.isZero() || p.isZero()) return ''
  return v.dividedBy(m.times(p)).toFixed(0, Decimal.ROUND_DOWN)
}

/**
 * Initial margin for an opening order:
 *   contracts: `contracts * multiplier * price / leverage * marginRate`
 *   market open (value): `value / leverage * marginRate`
 */
export function openCost(input: {
  contracts?: string
  value?: string
  price?: string
  multiplier: string
  leverage: number
  marginRate: string
}): string {
  if (!Number.isInteger(input.leverage) || input.leverage <= 0) return ''
  const rate = dec(input.marginRate) ?? new Decimal(1)
  const leverage = new Decimal(input.leverage)
  if (input.value !== undefined) {
    const value = dec(input.value)
    return value === null ? '' : value.dividedBy(leverage).times(rate).toFixed()
  }
  const notional = contractsValue(input.contracts ?? '', input.multiplier, input.price ?? '')
  return notional === '' ? '' : new Decimal(notional).dividedBy(leverage).times(rate).toFixed()
}

/** Max opening contracts from available margin: `available * leverage / marginRate / (price * multiplier)`. */
export function maxOpenContracts(input: { available: string; leverage: number; price: string; multiplier: string; marginRate: string }): string {
  const available = dec(input.available)
  const price = dec(input.price)
  const multiplier = dec(input.multiplier)
  const rate = dec(input.marginRate) ?? new Decimal(1)
  if (available === null || price === null || multiplier === null || price.isZero() || multiplier.isZero() || rate.isZero()) return ''
  if (!Number.isInteger(input.leverage) || input.leverage <= 0) return ''
  return available.times(input.leverage).dividedBy(rate).dividedBy(price.times(multiplier)).toFixed(0, Decimal.ROUND_DOWN)
}

/** Max market-open value (margin coin): `available * leverage / marginRate`. */
export function maxOpenValue(input: { available: string; leverage: number; marginRate: string; dp: number }): string {
  const available = dec(input.available)
  const rate = dec(input.marginRate) ?? new Decimal(1)
  if (available === null || rate.isZero() || !Number.isInteger(input.leverage) || input.leverage <= 0) return ''
  return available.times(input.leverage).dividedBy(rate).toFixed(Math.max(0, input.dp), Decimal.ROUND_DOWN)
}

/** `percent`% of `max`, rounded down to `dp`. */
export function percentOf(max: string, percent: number, dp: number): string {
  const value = dec(max)
  if (value === null || percent <= 0) return ''
  return canonicalDecimal(value.times(percent).dividedBy(100).toFixed(Math.max(0, dp), Decimal.ROUND_DOWN))
}

/* ------------------------------------------------------------------ validation */

export interface FuturesDraft {
  mode: OrderMode
  open: OrderOpen
  side: OrderSide
  price: string
  triggerPrice: string
  /** Conditional order executes at market once triggered. */
  triggerAtMarket: boolean
  /** Contracts, or the open value when `isValueVolume(draft)`. */
  volume: string
  leverage: number
  tpTrigger: string
  slTrigger: string
}

export interface FuturesValidationContext {
  contract: Pick<FuturesContract, 'pricePrecision' | 'marginCoinPrecision' | 'minLever' | 'maxLever' | 'minOrderVolume' | 'maxLimitVolume' | 'maxMarketVolume' | 'maxMarketMoney' | 'minOrderMoney' | 'multiplier'>
  /** Closable contracts for the position this close targets (`''` = unknown / skip). */
  canClose: string
  /** Reference price for TP/SL direction checks (order price, or last price for market). */
  referencePrice: string
}

export type FuturesField = 'price' | 'triggerPrice' | 'volume' | 'leverage' | 'tp' | 'sl'

export interface FuturesFieldError {
  field: FuturesField
  /** Key in the futures i18n `futures.err.*` namespace. */
  key: string
  params?: Record<string, string | number>
}

export interface FuturesValidation {
  ok: boolean
  errors: FuturesFieldError[]
  price: string
  triggerPrice: string
  volume: string
}

/**
 * Decimals the server accepts for a value-sized (market open) `volume`. `ValidateServiceImpl.verifyOrder`
 * checks EVERY order volume against the symbol's `pricePrecision` (`symbolPricePrecision`, 2 for
 * BTC-USDT) - not `marginCoinPrecision` (6 on the live BTC contract) - and rejects more decimals with
 * 「数量精度错误」. The smaller of the two is used so the wire value is always acceptable.
 */
export function valueWireDp(contract: Pick<FuturesContract, 'pricePrecision' | 'marginCoinPrecision'>): number {
  const price = Number.isInteger(contract.pricePrecision) && contract.pricePrecision >= 0 ? contract.pricePrecision : 2
  const coin = Number.isInteger(contract.marginCoinPrecision) && contract.marginCoinPrecision >= 0 ? contract.marginCoinPrecision : price
  return Math.min(price, coin)
}

/** A market (or market-triggered) OPEN is sized by value in the margin coin, everything else in contracts. */
export function isValueVolume(draft: Pick<FuturesDraft, 'mode' | 'open' | 'triggerAtMarket'>): boolean {
  return draft.open === 'OPEN' && (draft.mode === 'market' || (draft.mode === 'trigger' && draft.triggerAtMarket))
}

/** Limit price is needed for limit orders and limit-conditional orders. */
export function needsPrice(draft: Pick<FuturesDraft, 'mode' | 'triggerAtMarket'>): boolean {
  return draft.mode === 'limit' || (draft.mode === 'trigger' && !draft.triggerAtMarket)
}

/** `"0010.50"` -> `"10.5"`; non-decimal input is returned trimmed for the error path. */
export function normalizeInput(raw: string): string {
  const value = canonicalDecimal(raw.trim())
  return isDecimalString(value) ? canonicalDecimal(new Decimal(value).toFixed()) : value
}

function checkPrice(field: FuturesField, raw: string, dp: number, errors: FuturesFieldError[]): string {
  const value = normalizeInput(raw)
  if (value === '') {
    errors.push({ field, key: 'required' })
  } else if (!isDecimalString(value)) {
    errors.push({ field, key: 'invalidNumber' })
  } else if (!isPositive(value)) {
    errors.push({ field, key: 'mustBePositive' })
  } else if ((decimalPlaces(value) ?? 0) > dp) {
    errors.push({ field, key: 'precision', params: { dp } })
  }
  return value
}

export function validateLeverage(leverage: number, minLever: number, maxLever: number): FuturesFieldError | null {
  if (!Number.isInteger(leverage)) return { field: 'leverage', key: 'leverageInteger' }
  if (leverage < minLever || leverage > maxLever) return { field: 'leverage', key: 'leverageRange', params: { min: minLever, max: maxLever } }
  return null
}

export function validateFuturesOrder(draft: FuturesDraft, context: FuturesValidationContext): FuturesValidation {
  const { contract } = context
  const errors: FuturesFieldError[] = []
  let price = ''
  let triggerPrice = ''
  if (needsPrice(draft)) {
    price = checkPrice('price', draft.price, contract.pricePrecision, errors)
  }
  if (draft.mode === 'trigger') {
    triggerPrice = checkPrice('triggerPrice', draft.triggerPrice, contract.pricePrecision, errors)
  }

  const leverageError = validateLeverage(draft.leverage, contract.minLever, contract.maxLever)
  if (leverageError !== null && draft.open === 'OPEN') errors.push(leverageError)

  const volume = normalizeInput(draft.volume)
  const byValue = isValueVolume(draft)
  if (volume === '') {
    errors.push({ field: 'volume', key: 'required' })
  } else if (!isDecimalString(volume)) {
    errors.push({ field: 'volume', key: 'invalidNumber' })
  } else if (!isPositive(volume)) {
    errors.push({ field: 'volume', key: 'mustBePositive' })
  } else if (byValue) {
    const dp = valueWireDp(contract)
    if ((decimalPlaces(volume) ?? 0) > dp) {
      errors.push({ field: 'volume', key: 'precision', params: { dp } })
    } else if (contract.minOrderMoney !== '' && isPositive(contract.minOrderMoney) && new Decimal(volume).lt(contract.minOrderMoney)) {
      errors.push({ field: 'volume', key: 'belowMinValue', params: { min: contract.minOrderMoney } })
    } else if (contract.maxMarketMoney !== '' && isPositive(contract.maxMarketMoney) && new Decimal(volume).gt(contract.maxMarketMoney)) {
      errors.push({ field: 'volume', key: 'aboveMaxValue', params: { max: contract.maxMarketMoney } })
    }
  } else if ((decimalPlaces(volume) ?? 0) > 0) {
    errors.push({ field: 'volume', key: 'wholeContracts' })
  } else {
    const amount = new Decimal(volume)
    const min = contract.minOrderVolume
    const max = draft.mode === 'market' ? contract.maxMarketVolume : contract.maxLimitVolume
    if (min !== '' && isPositive(min) && amount.lt(min)) {
      errors.push({ field: 'volume', key: 'belowMinVolume', params: { min } })
    } else if (max !== '' && isPositive(max) && amount.gt(max)) {
      errors.push({ field: 'volume', key: 'aboveMaxVolume', params: { max } })
    } else if (draft.open === 'CLOSE' && context.canClose !== '' && amount.gt(context.canClose)) {
      errors.push({ field: 'volume', key: 'aboveCanClose', params: { max: context.canClose } })
    }
  }

  // Optional OTO take profit / stop loss on opening orders: long TP above / SL below the entry,
  // short the other way round.
  if (draft.open === 'OPEN') {
    const reference = canonicalDecimal(needsPrice(draft) ? price : context.referencePrice)
    const long = draft.side === 'BUY'
    const tp = draft.tpTrigger.trim() === '' ? '' : checkPrice('tp', draft.tpTrigger, contract.pricePrecision, errors)
    const sl = draft.slTrigger.trim() === '' ? '' : checkPrice('sl', draft.slTrigger, contract.pricePrecision, errors)
    if (isPositive(reference)) {
      if (isPositive(tp) && !errors.some((e) => e.field === 'tp')) {
        const wrong = long ? new Decimal(tp).lte(reference) : new Decimal(tp).gte(reference)
        if (wrong) errors.push({ field: 'tp', key: long ? 'tpAboveEntry' : 'tpBelowEntry' })
      }
      if (isPositive(sl) && !errors.some((e) => e.field === 'sl')) {
        const wrong = long ? new Decimal(sl).gte(reference) : new Decimal(sl).lte(reference)
        if (wrong) errors.push({ field: 'sl', key: long ? 'slBelowEntry' : 'slAboveEntry' })
      }
    }
  }

  return { ok: errors.length === 0, errors, price, triggerPrice, volume }
}

/* ------------------------------------------------------------------ position display */

export interface SignedView {
  text: string
  direction: 'up' | 'down' | 'flat'
}

/** Unrealized / realized PnL: `+12.34` green, `-5.00` red, `--` when missing. */
export function pnlView(value: string, dp: number): SignedView {
  if (!isSignedDecimal(value)) return { text: '--', direction: 'flat' }
  const s = sign(value)
  return { text: signedDisplay(value, dp), direction: s > 0 ? 'up' : s < 0 ? 'down' : 'flat' }
}

/** ROE / return rate: server ratio -> `+12.34%`. */
export function roeView(ratio: string): SignedView {
  if (!isSignedDecimal(ratio)) return { text: '--', direction: 'flat' }
  const s = sign(ratio)
  return { text: signedPercent(ratio, 2), direction: s > 0 ? 'up' : s < 0 ? 'down' : 'flat' }
}

export interface PositionPnl {
  pnl: string
  roe: string
  initialMargin: string
  mark: string
}

/**
 * Position PnL / ROE / initial margin on the mark-price basis (Binance USDT-M).
 *
 * Per the Binance FAQ "How to Calculate Profit and Loss for Futures Contracts" (mark price basis):
 *   qty           = volume * multiplier
 *   direction     = +1 for BUY, -1 for SELL
 *   pnl           = qty * (mark - entry) * direction * marginRate
 *   initialMargin = qty * mark / leverage * marginRate
 *   roe           = pnl / initialMargin   (a ratio, e.g. 0.0051 means 0.51%)
 *
 * Entry is the server snapshot's effective accounting cost. Historical settled PnL is already in the wallet;
 * never re-add the original open->settled part to account equity. marginRate is the existing contract exchange
 * factor (normally1), matching the core projection; this is display math, never a trading/risk decision.
 */
export function positionPnl(input: {
  side: 'BUY' | 'SELL' | ''
  volume: string
  multiplier: string
  entry: string
  mark: string
  leverage: number | null
  marginRate?: string
}): PositionPnl {
  const empty: PositionPnl = { pnl: '', roe: '', initialMargin: '', mark: '' }
  if (input.side === '') return empty
  const volume = dec(input.volume)
  const multiplier = dec(input.multiplier)
  const entry = dec(input.entry)
  const mark = dec(input.mark)
  const rate = input.marginRate === undefined ? new Decimal(1) : dec(input.marginRate)
  if (volume === null || multiplier === null || entry === null || mark === null || rate === null || rate.lte(0)) return empty
  if (volume.lte(0) || multiplier.lte(0) || mark.lte(0)) return empty

  const qty = volume.times(multiplier)
  const direction = input.side === 'BUY' ? 1 : -1
  const pnl = qty.times(mark.minus(entry)).times(direction).times(rate).toFixed()

  let roe = ''
  let initialMargin = ''
  if (input.leverage !== null && Number.isInteger(input.leverage) && input.leverage > 0) {
    const leverage = new Decimal(input.leverage)
    initialMargin = qty.times(mark).times(rate).dividedBy(leverage).toFixed()
    roe = new Decimal(pnl).dividedBy(new Decimal(initialMargin)).toFixed()
  }

  return { pnl, roe, initialMargin, mark: mark.toFixed() }
}

/** Sum of signed decimal strings; skips `''` / non-decimal values, `''` when none are valid. */
export function sumPnl(values: string[]): string {
  let total: Decimal | null = null
  for (const value of values) {
    if (!isSignedDecimal(value)) continue
    total = total === null ? new Decimal(value) : total.plus(value)
  }
  return total === null ? '' : total.toFixed()
}

/** Liquidation price; the server sends `<= 0` when there is none (legacy `positionLis.js:324-329`). */
export function liquidationView(value: string, dp: number): string {
  if (!isSignedDecimal(value) || sign(value) <= 0) return '--'
  return signedDisplay(value, dp, false)
}

export interface LiquidationInfo {
  /** `price`: a real liquidation price; `none`: server says `<= 0` (cannot be liquidated at any price); `missing`: no data. */
  kind: 'price' | 'none' | 'missing'
  text: string
}

/**
 * Liquidation cell. `reducePrice <= 0` is not "unknown": the server computed that the price would
 * have to fall to or below zero, i.e. (typically cross margin) the account equity covers the position.
 */
export function liquidationInfo(value: string, dp: number): LiquidationInfo {
  if (!isSignedDecimal(value)) return { kind: 'missing', text: '--' }
  if (sign(value) <= 0) return { kind: 'none', text: '' }
  return { kind: 'price', text: signedDisplay(value, dp, false) }
}

/**
 * Margin-ratio headroom: server `marginRate` (equity / position value, `CoComputeUtils.marginRate`)
 * against the maintenance rate `keepRate`; liquidation triggers at `marginRate <= keepRate`.
 * `danger` below 2x maintenance, `warn` below 5x, else `safe`; `unknown` without both numbers.
 */
export function marginRisk(marginRate: string, keepRate: string): 'safe' | 'warn' | 'danger' | 'unknown' {
  const m = dec(marginRate)
  const k = dec(keepRate)
  if (m === null || k === null || k.lte(0)) return 'unknown'
  if (m.lte(k.times(2))) return 'danger'
  if (m.lte(k.times(5))) return 'warn'
  return 'safe'
}

/** Ratio (`0.005`) -> `0.50%` without a sign; `--` when missing. */
export function rateView(ratio: string, dp = 2): string {
  if (!isSignedDecimal(ratio)) return '--'
  return signedPercent(ratio, dp, false)
}

/** Funding rate with sign and 4 decimals (`+0.0100%`). */
export function fundingRateView(ratio: string): SignedView {
  if (!isSignedDecimal(ratio)) return { text: '--', direction: 'flat' }
  const s = sign(ratio)
  return { text: signedPercent(ratio, 4), direction: s > 0 ? 'up' : s < 0 ? 'down' : 'flat' }
}

/* ------------------------------------------------------------------ funding countdown */

const HOUR_MS = 3_600_000

/**
 * Next funding settlement. Funding runs every `frequency` hours starting at hour `startHour` **UTC**, exactly as the
 * trading core settles it (cloud-lab/trading-core/src/funding.rs `next_slot`, UTC iron rule 10-18; was UTC+8 like the
 * legacy client). `now` is already corrected by the server time offset.
 */
export function nextFundingTime(now: number, startHour: number | null, frequency: number | null, tzOffsetHours = 0): number | null {
  if (startHour === null || frequency === null || frequency <= 0 || !Number.isFinite(now)) return null
  const offset = tzOffsetHours * HOUR_MS
  const local = now + offset
  const dayStart = Math.floor(local / (24 * HOUR_MS)) * 24 * HOUR_MS
  const start = ((startHour % 24) + 24) % 24
  // Walk the schedule from the previous day so a start hour later than "now" still works.
  for (let hour = start - 24; hour <= start + 48; hour += frequency) {
    const at = dayStart + hour * HOUR_MS
    if (at > local) return at - offset
  }
  return null
}

/** `HH:MM:SS` until `target`; `--:--:--` when unknown. */
export function countdownText(target: number | null, now: number): string {
  if (target === null) return '--:--:--'
  const left = Math.max(0, target - now)
  const hours = Math.floor(left / HOUR_MS)
  const minutes = Math.floor((left % HOUR_MS) / 60_000)
  const seconds = Math.floor((left % 60_000) / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/* ------------------------------------------------------------------ transfer / margin inputs */

export type AmountError = 'required' | 'invalidNumber' | 'mustBePositive' | 'precision' | 'insufficient' | 'unavailable'

export interface AmountValidation {
  ok: boolean
  error: AmountError | null
  amount: string
  params?: Record<string, string | number>
}

/**
 * Transfer / margin amount: positive decimal within `dp` places and not above `available`.
 * `available === ''` means the balance is not known yet, which blocks submission.
 */
export function validateAmount(raw: string, available: string, dp: number): AmountValidation {
  const amount = normalizeInput(raw)
  if (amount === '') return { ok: false, error: 'required', amount }
  if (!isDecimalString(amount)) return { ok: false, error: 'invalidNumber', amount }
  if (!isPositive(amount)) return { ok: false, error: 'mustBePositive', amount }
  if ((decimalPlaces(amount) ?? 0) > dp) return { ok: false, error: 'precision', amount, params: { dp } }
  const limit = canonicalDecimal(available)
  if (!isDecimalString(limit)) return { ok: false, error: 'unavailable', amount }
  if (new Decimal(amount).gt(limit)) return { ok: false, error: 'insufficient', amount, params: { available: groupDigits(limit) } }
  return { ok: true, error: null, amount }
}

/** Non-negative display of a possibly negative available balance (negative clamps to `0`). */
export function clampAvailable(value: string): string {
  if (!isSignedDecimal(value)) return ''
  return sign(value) < 0 ? '0' : value
}
