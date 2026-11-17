import { ref, watch, type Ref } from 'vue'
import { Decimal, canonicalDecimal, decimalPlaces, isDecimalString, isPositive } from '@/modules/finance/decimal'
import {
  isValueVolume,
  valueWireDp,
  normalizeInput,
  validateFuturesOrder,
  type FuturesDraft,
  type FuturesFieldError,
  type FuturesValidation,
  type FuturesValidationContext,
} from './math'
import { marginToNotional, notionalToMargin, type MarginBasis, type QuoteMode } from './order-entry'

/**
 * Order-size unit chosen on the futures ticket (Binance / Hyperliquid style):
 *   `quote` – margin/quote coin value (USDT), the default;
 *   `base`  – base coin amount (BTC), i.e. contracts × multiplier;
 *   `cont`  – raw contracts (张). Internal only since 2026-09-29: the wire unit, no longer offered in
 *             the selector (a saved `cont` preference is migrated to `base`).
 * A USDT amount on the ticket is either the order notional or the initial margin (`QuoteMode`,
 * `order-entry.ts`); margin = notional × marginRate / leverage.
 *
 * The wire format never changes: the server takes CONTRACTS for every order except a market (or
 * trigger-at-market) OPEN, which it sizes by VALUE in the margin coin (`CoOrderServiceImpl`
 * freezes `volume × marginRate / leverage` for `isMarket()` orders; there is no contracts variant).
 * So the user's amount is converted to that wire volume here:
 *   contracts wire: quote → floor(v / (price × multiplier)); base → floor(b / multiplier); cont as-is.
 *   value wire:     quote as-is; base → floor(b × price, coinDp); cont → floor(n × multiplier × price, coinDp).
 * Conversions always round DOWN, never above what the user typed.
 */
export type SizeUnit = 'quote' | 'base' | 'cont'

/** Units offered to the user (Binance order: coin first, then USDT). */
export const SIZE_UNITS: readonly SizeUnit[] = ['base', 'quote']
export const SIZE_UNIT_KEY = 'picat.futures.sizeUnit'
export const DEFAULT_SIZE_UNIT: SizeUnit = 'quote'

function isUserUnit(value: unknown): value is SizeUnit {
  return value === 'quote' || value === 'base'
}

export function readSizeUnit(): SizeUnit {
  try {
    const saved = localStorage.getItem(SIZE_UNIT_KEY)
    // `cont` (张) was a user choice until 2026-09-29; the closest remaining unit is the base coin.
    if (saved === 'cont') return 'base'
    return isUserUnit(saved) ? saved : DEFAULT_SIZE_UNIT
  } catch {
    return DEFAULT_SIZE_UNIT
  }
}

export function saveSizeUnit(unit: SizeUnit): void {
  try {
    localStorage.setItem(SIZE_UNIT_KEY, unit)
  } catch {
    // Private mode: the choice simply is not remembered.
  }
}

let shared: Ref<SizeUnit> | null = null

/** App-wide size unit (order ticket + position table), persisted per browser. */
export function useSizeUnit(): Ref<SizeUnit> {
  if (shared === null) {
    const unit = ref<SizeUnit>(readSizeUnit())
    watch(unit, saveSizeUnit)
    shared = unit
  }
  return shared
}

/* ------------------------------------------------------------------ conversions */

export interface SizeMarket {
  /** Contract face value in the base coin (`0.0001` BTC per contract). */
  multiplier: string
  /** Reference price: the limit price for limit legs, otherwise trigger / last / mark. `''` = unknown. */
  price: string
  /** Decimals of a value-sized wire volume / USDT amount (`valueWireDp(contract)`, 2 for BTC-USDT). */
  coinDp: number
}

function dec(value: string): Decimal | null {
  const text = canonicalDecimal(value)
  return isDecimalString(text) ? new Decimal(text) : null
}

function positive(value: string): Decimal | null {
  const d = dec(value)
  return d !== null && d.gt(0) ? d : null
}

/** Decimals a base-coin amount may carry: those of the face value (`0.0001` → 4). */
export function baseDp(multiplier: string): number {
  return Math.max(0, decimalPlaces(canonicalDecimal(multiplier)) ?? 0)
}

/** Input precision for `unit`. */
export function unitDp(unit: SizeUnit, market: Pick<SizeMarket, 'multiplier' | 'coinDp'>): number {
  if (unit === 'cont') return 0
  if (unit === 'base') return baseDp(market.multiplier)
  return Math.max(0, market.coinDp)
}

/** Whether converting between `unit` and the wire volume needs a price. */
export function needsReferencePrice(unit: SizeUnit, byValue: boolean): boolean {
  return byValue ? unit !== 'quote' : unit === 'quote'
}

/** Whole contracts for `amount` in `unit` (rounded down); `''` when it cannot be computed. */
export function unitToContracts(amount: string, unit: SizeUnit, market: SizeMarket): string {
  const a = dec(amount)
  const m = positive(market.multiplier)
  if (a === null || m === null) return ''
  if (unit === 'cont') return a.toFixed(0, Decimal.ROUND_DOWN)
  if (unit === 'base') return a.dividedBy(m).toFixed(0, Decimal.ROUND_DOWN)
  const p = positive(market.price)
  return p === null ? '' : a.dividedBy(m.times(p)).toFixed(0, Decimal.ROUND_DOWN)
}

/** Margin-coin value for `amount` in `unit` (rounded down to `coinDp`); `''` when unknown. */
export function unitToValue(amount: string, unit: SizeUnit, market: SizeMarket): string {
  const a = dec(amount)
  if (a === null) return ''
  const dp = Math.max(0, market.coinDp)
  if (unit === 'quote') return a.toFixed(dp, Decimal.ROUND_DOWN)
  const p = positive(market.price)
  if (p === null) return ''
  if (unit === 'base') return a.times(p).toFixed(dp, Decimal.ROUND_DOWN)
  const m = positive(market.multiplier)
  return m === null ? '' : a.times(m).times(p).toFixed(dp, Decimal.ROUND_DOWN)
}

type Rounding = 'down' | 'up'

function round(value: Decimal, dp: number, mode: Rounding): string {
  return canonicalDecimal(value.toFixed(Math.max(0, dp), mode === 'down' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP))
}

/** `contracts` expressed in `unit`; limits round up (min) or down (max/available) as asked. */
export function contractsToUnit(contracts: string, unit: SizeUnit, market: SizeMarket, rounding: Rounding = 'down'): string {
  const c = dec(contracts)
  if (c === null) return ''
  if (unit === 'cont') return canonicalDecimal(c.toFixed())
  const m = dec(market.multiplier)
  if (m === null) return ''
  if (unit === 'base') return canonicalDecimal(c.times(m).toFixed())
  const p = positive(market.price)
  return p === null ? '' : round(c.times(m).times(p), market.coinDp, rounding)
}

/** A margin-coin `value` expressed in `unit`. */
export function valueToUnit(value: string, unit: SizeUnit, market: SizeMarket, rounding: Rounding = 'down'): string {
  const v = dec(value)
  if (v === null) return ''
  if (unit === 'quote') return round(v, market.coinDp, rounding)
  const p = positive(market.price)
  if (p === null) return ''
  if (unit === 'base') return round(v.dividedBy(p), baseDp(market.multiplier), rounding)
  const m = positive(market.multiplier)
  return m === null ? '' : round(v.dividedBy(m.times(p)), 0, rounding)
}

/** Wire volume (contracts, or value when `byValue`) expressed in `unit`. */
export function wireToUnit(wire: string, byValue: boolean, unit: SizeUnit, market: SizeMarket, rounding: Rounding = 'down'): string {
  return byValue ? valueToUnit(wire, unit, market, rounding) : contractsToUnit(wire, unit, market, rounding)
}

/* ------------------------------------------------------------------ validation */

export interface SizedValidation extends FuturesValidation {
  /** Volume actually sent (contracts, or value for a market open). */
  volume: string
  /** Contracts this order represents (`''` if no price to estimate a market open). */
  contracts: string
  /** Margin-coin notional estimate (`''` when unknown). */
  value: string
}

export interface SizedOrderInput {
  draft: FuturesDraft
  context: FuturesValidationContext
  unit: SizeUnit
  /** Wire volume chosen by the percentage slider; bypasses unit parsing when set. */
  presetWire?: string
  /** Unit label for messages (`USDT`, `BTC`, `张`). */
  unitLabel: string
  /** Margin coin label for messages. */
  coin: string
  /** Contracts label for messages (`张`). */
  contractsLabel: string
  /** How a USDT amount is read (default `notional`); `margin` needs `marginBasis`. */
  quoteMode?: QuoteMode
  /** Leverage (the order's) and marginRate for the 初始保证金 conversion. */
  marginBasis?: MarginBasis
}

/** Whether the ticket reads a USDT amount as initial margin. */
export function isMarginEntry(unit: SizeUnit, quoteMode: QuoteMode | undefined): boolean {
  return unit === 'quote' && quoteMode === 'margin'
}

/**
 * Wire volume → the amount shown in the entry unit (for 最大, hints, error limits). In 初始保证金
 * mode the USDT notional is divided by leverage / marginRate. `''` when it cannot be computed.
 */
export function wireToEntry(
  wire: string,
  byValue: boolean,
  unit: SizeUnit,
  market: SizeMarket,
  entry: { quoteMode?: QuoteMode; marginBasis?: MarginBasis } = {},
  rounding: Rounding = 'down',
): string {
  if (!isMarginEntry(unit, entry.quoteMode)) return wireToUnit(wire, byValue, unit, market, rounding)
  if (entry.marginBasis === undefined) return ''
  // Exact notional first, then round the margin once (rounding the notional first could lose a cent).
  const exact = byValue ? canonicalDecimal(wire) : exactValue(wire, market)
  return exact === '' ? '' : notionalToMargin(exact, entry.marginBasis, market.coinDp, rounding)
}

function exactValue(contracts: string, market: SizeMarket): string {
  const c = dec(contracts)
  const m = dec(market.multiplier)
  const p = positive(market.price)
  return c === null || m === null || p === null ? '' : c.times(m).times(p).toFixed()
}

function withVolumeError(result: FuturesValidation, error: FuturesFieldError | null): FuturesFieldError[] {
  const others = result.errors.filter((entry) => entry.field !== 'volume')
  return error === null ? others : [...others, error]
}

function parseUnit(raw: string, dp: number, whole: boolean): { amount: string; error: FuturesFieldError | null } {
  const amount = normalizeInput(raw)
  if (amount === '') return { amount, error: { field: 'volume', key: 'required' } }
  if (!isDecimalString(amount)) return { amount, error: { field: 'volume', key: 'invalidNumber' } }
  if (!isPositive(amount)) return { amount, error: { field: 'volume', key: 'mustBePositive' } }
  if ((decimalPlaces(amount) ?? 0) > dp) return { amount, error: whole ? { field: 'volume', key: 'wholeContracts' } : { field: 'volume', key: 'precision', params: { dp } } }
  return { amount, error: null }
}

/**
 * Validate an order whose size is typed in `unit`. Converts to the wire volume, runs the regular
 * `validateFuturesOrder`, and restates size limits (min/max/closable) in the chosen unit with the
 * wire equivalent in brackets, e.g. `最小下单 0.0001 BTC（1 张）`.
 */
export function validateSizedOrder(input: SizedOrderInput): SizedValidation {
  const { draft, context, unit } = input
  const byValue = isValueVolume(draft)
  const market: SizeMarket = { multiplier: context.contract.multiplier, price: context.referencePrice, coinDp: valueWireDp(context.contract) }
  const marginEntry = isMarginEntry(unit, input.quoteMode)
  const native = !marginEntry && (byValue ? unit === 'quote' : unit === 'cont')

  let wire = ''
  let unitError: FuturesFieldError | null = null
  // QA-038 (10-26): a market open typed in the base coin is sent with its exact contracts (`targetContracts` =
  // floor(coin / multiplier), what the server fills). Estimating them back from the floored value wire floored twice
  // (0.002 XAUT at 4020.97 → 8.04 USDT → 1.9995 → 「1 张」 while 2 were filled).
  let exactContracts = ''
  if (input.presetWire !== undefined) {
    wire = input.presetWire
  } else if (native) {
    wire = draft.volume
  } else {
    const parsed = parseUnit(draft.volume, unitDp(unit, market), unit === 'cont')
    const notional = marginEntry && parsed.error === null ? (input.marginBasis === undefined ? '' : marginToNotional(parsed.amount, input.marginBasis)) : ''
    if (parsed.error !== null) {
      unitError = parsed.error
    } else if (marginEntry) {
      wire = notional === '' ? '' : byValue ? unitToValue(notional, 'quote', market) : unitToContracts(notional, 'quote', market)
      if (wire === '') unitError = { field: 'volume', key: 'needPrice' }
      else if (!isPositive(wire)) unitError = zeroError()
    } else {
      wire = byValue ? unitToValue(parsed.amount, unit, market) : unitToContracts(parsed.amount, unit, market)
      if (byValue && unit === 'base') exactContracts = unitToContracts(parsed.amount, 'base', market)
      if (wire === '') unitError = { field: 'volume', key: 'needPrice' }
      else if (!isPositive(wire)) unitError = zeroError()
    }
  }

  const result = validateFuturesOrder({ ...draft, volume: wire }, context)
  const contracts = isPositive(exactContracts) ? exactContracts : estimateContracts(result.volume, byValue, market)
  const value = estimateValue(result.volume, byValue, market)
  if (unitError !== null) return { ...result, ok: false, errors: withVolumeError(result, unitError), volume: '', contracts: '', value: '' }
  if (native) return { ...result, contracts, value }

  const errors = result.errors.map((entry) => (entry.field === 'volume' ? restate(entry) : entry))
  return { ...result, errors, contracts, value }

  function zeroError(): FuturesFieldError {
    const min = byValue ? context.contract.minOrderMoney : context.contract.minOrderVolume
    const floor = isPositive(canonicalDecimal(min)) ? min : byValue ? '' : '1'
    return floor === '' ? { field: 'volume', key: 'mustBePositive' } : limitError('belowMinUnit', floor, 'up')
  }

  function limitError(key: string, wireLimit: string, rounding: Rounding): FuturesFieldError {
    const amount = wireToEntry(wireLimit, byValue, unit, market, input, rounding)
    const ref = byValue ? `${canonicalDecimal(wireLimit)} ${input.coin}` : `${canonicalDecimal(wireLimit)} ${input.contractsLabel}`
    return { field: 'volume', key, params: { amount: amount === '' ? '--' : amount, unit: input.unitLabel, ref } }
  }

  function restate(entry: FuturesFieldError): FuturesFieldError {
    const limit = String(entry.params?.min ?? entry.params?.max ?? '')
    switch (entry.key) {
      case 'belowMinVolume':
      case 'belowMinValue':
        return limitError('belowMinUnit', limit, 'up')
      case 'aboveMaxVolume':
      case 'aboveMaxValue':
        return limitError('aboveMaxUnit', limit, 'down')
      case 'aboveCanClose':
        return limitError('aboveCanCloseUnit', limit, 'down')
      default:
        return entry
    }
  }
}

function estimateContracts(wire: string, byValue: boolean, market: SizeMarket): string {
  if (!isPositive(canonicalDecimal(wire))) return ''
  return byValue ? unitToContracts(wire, 'quote', market) : canonicalDecimal(wire)
}

function estimateValue(wire: string, byValue: boolean, market: SizeMarket): string {
  if (!isPositive(canonicalDecimal(wire))) return ''
  if (byValue) return canonicalDecimal(wire)
  const m = dec(market.multiplier)
  const p = positive(market.price)
  return m === null || p === null ? '' : new Decimal(wire).times(m).times(p).toFixed()
}

/* ------------------------------------------------------------------ display (whole futures UI) */

/** What the formatter needs from a contract (any contract: face value and base coin come from public_info). */
export interface SizeContract {
  multiplier: string
  multiplierCoin: string
  base?: string
  quote: string
  marginCoin?: string
}

/** Display decimals per unit: USDT 2, base coin = face-value decimals (0.0001 → 4), contracts 0. */
export function displayDp(unit: SizeUnit, multiplier: string): number {
  if (unit === 'quote') return 2
  if (unit === 'base') return baseDp(multiplier)
  return 0
}

/** Unit label for `contract`: its margin/quote coin, its base coin, or the contracts label. */
export function sizeUnitLabel(unit: SizeUnit, contract: SizeContract | undefined, contractsLabel: string): string {
  if (contract === undefined || unit === 'cont') return contractsLabel
  if (unit === 'base') return contract.multiplierCoin || contract.base || contractsLabel
  return contract.marginCoin || contract.quote || contractsLabel
}

export interface SizeAmount {
  /** Amount in `unit` rounded down to `displayDp` (`''` when it cannot be computed). */
  amount: string
  /** Unit actually used: falls back to contracts when USDT needs a price that is missing. */
  unit: SizeUnit
  dp: number
}

/**
 * `contracts` in the chosen unit. USDT = contracts × multiplier × `price` (the row's own price:
 * order / fill / entry price, the mark for live positions, the level price for depth); BTC =
 * contracts × multiplier. Without a price (or contract) USDT falls back to contracts.
 */
export function contractsAmount(contracts: string, unit: SizeUnit, contract: SizeContract | undefined, price = ''): SizeAmount {
  const c = dec(contracts)
  if (c === null) return { amount: '', unit, dp: 0 }
  const m = contract === undefined ? null : dec(contract.multiplier)
  if (unit === 'cont' || m === null || m.lte(0)) return { amount: canonicalDecimal(c.toFixed(0, Decimal.ROUND_DOWN)), unit: 'cont', dp: 0 }
  const dp = displayDp(unit, contract?.multiplier ?? '')
  if (unit === 'base') return { amount: round(c.times(m), dp, 'down'), unit, dp }
  const p = positive(price)
  if (p === null) return { amount: canonicalDecimal(c.toFixed(0, Decimal.ROUND_DOWN)), unit: 'cont', dp: 0 }
  return { amount: round(c.times(m).times(p), dp, 'down'), unit, dp }
}

/**
 * A margin-coin VALUE (the `volume` of a market-open order) in the chosen unit: USDT as-is,
 * BTC = value / price, contracts = value / (price × multiplier). Without a price it stays in USDT.
 */
export function valueAmount(value: string, unit: SizeUnit, contract: SizeContract | undefined, price = ''): SizeAmount {
  const v = dec(value)
  if (v === null) return { amount: '', unit, dp: 0 }
  const p = positive(price)
  const m = contract === undefined ? null : positive(contract.multiplier)
  if (unit === 'quote' || p === null || m === null) return { amount: round(v, 2, 'down'), unit: 'quote', dp: 2 }
  const dp = displayDp(unit, contract?.multiplier ?? '')
  if (unit === 'base') return { amount: round(v.dividedBy(p), dp, 'down'), unit, dp }
  return { amount: round(v.dividedBy(p.times(m)), 0, 'down'), unit, dp: 0 }
}

/**
 * A close/TP-SL size typed in `unit` → whole contracts (floored), checked against `min` contracts
 * and the closable `max`. Errors are phrased in the unit with the contract count in brackets.
 */
export function sizeInputToContracts(
  raw: string,
  unit: SizeUnit,
  market: SizeMarket,
  limits: { min: string; max: string },
  labels: { unit: string; contracts: string },
): { contracts: string; error: FuturesFieldError | null } {
  const parsed = parseUnit(raw, unitDp(unit, market), unit === 'cont')
  if (parsed.error !== null) return { contracts: '', error: parsed.error }
  const contracts = unitToContracts(parsed.amount, unit, market)
  if (contracts === '') return { contracts, error: { field: 'volume', key: 'needPrice' } }
  const limitError = (key: string, wire: string, rounding: Rounding): FuturesFieldError => {
    const amount = contractsToUnit(wire, unit, market, rounding)
    return { field: 'volume', key, params: { amount: amount === '' ? '--' : amount, unit: labels.unit, ref: `${canonicalDecimal(wire)} ${labels.contracts}` } }
  }
  const min = isPositive(canonicalDecimal(limits.min)) ? canonicalDecimal(limits.min) : '1'
  if (new Decimal(contracts).lt(min)) return { contracts, error: limitError('belowMinUnit', min, 'up') }
  if (isDecimalString(canonicalDecimal(limits.max)) && new Decimal(contracts).gt(canonicalDecimal(limits.max))) {
    return { contracts, error: limitError('aboveCanCloseUnit', limits.max, 'down') }
  }
  return { contracts, error: null }
}
