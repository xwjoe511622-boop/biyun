import type { TpslLeg } from '@/modules/futures/api'
import { Decimal, canonicalDecimal, decimalPlaces, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { normalizeInput } from '@/modules/futures/math'
import { contractsToUnit, sizeInputToContracts, type SizeMarket } from '@/modules/futures/size-unit'

/**
 * Quantity and trigger control for the futures TP/SL dialog.
 *
 * TP/SL is a close, so the size is always whole contracts. The dialog offers `base` (coin) and
 * `quote` (USDT) entry and floors to contracts (never above what was typed). Triggers are validated
 * against the LAST trade price — the only trigger the server supports (`order_tpsl_create` has no
 * trigger-price-type field; `ValidateServiceImpl.checkTrigger` compares TP/SL against the last price,
 * with the liquidation price as an extra floor/ceiling for the stop-loss).
 *
 * Error convention: every error is `{ key, ns, params? }` where `key` is the BARE message key and
 * `ns` picks the namespace under `fut`: `err` -> `fut.err.<key>` (the existing error keys), `tpq` ->
 * `fut.tpq.<key>` (the new keys this module owns).
 */
export type TpslUnit = 'base' | 'quote'

export interface TpslError {
  key: string
  ns: 'err' | 'tpq'
  params?: Record<string, string | number>
}

/**
 * `percent`% of the closable size, floored to whole contracts. `100` returns `canClose` exactly so a
 * full close never loses a contract to rounding; invalid `canClose` or a non-positive percent -> `'0'`.
 */
export function percentToContracts(canClose: string, percent: number): string {
  const close = canonicalDecimal(canClose)
  if (!isDecimalString(close)) return '0'
  const clamped = Math.max(0, Math.min(100, Math.floor(percent)))
  if (!Number.isFinite(clamped)) return '0'
  if (clamped >= 100) return close
  if (clamped <= 0) return '0'
  return new Decimal(close).times(clamped).dividedBy(100).toFixed(0, Decimal.ROUND_DOWN)
}

/**
 * Whole contracts as a percentage of the closable size: `Math.floor(contracts / canClose * 100)`,
 * clamped 0..100. `0` when the input is invalid; `100` only when `contracts >= canClose`.
 */
export function contractsToPercent(contracts: string, canClose: string): number {
  const c = canonicalDecimal(contracts)
  const close = canonicalDecimal(canClose)
  if (!isDecimalString(c) || !isDecimalString(close) || !isPositive(close)) return 0
  const ratio = new Decimal(c).dividedBy(close).times(100)
  if (ratio.gte(100)) return 100
  return Math.max(0, Math.min(100, ratio.toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber()))
}

export interface TpslSizeInput {
  raw: string
  unit: TpslUnit
  /** Whole contracts chosen by the percentage slider; bypasses parsing but still checks limits. */
  presetContracts?: string
  multiplier: string
  price: string
  coinDp: number
  canClose: string
  minContracts: string
  labels: { unit: string; contracts: string }
}

/**
 * Close size typed in `unit` (or the slider's `presetContracts`) -> whole contracts, checked against
 * `minContracts` and `canClose`. Error keys are the existing `fut.err.*` keys (`required`,
 * `invalidNumber`, `mustBePositive`, `precision`, `belowMinUnit`, `aboveCanCloseUnit`, `needPrice`).
 */
export function tpslSizeCheck(input: TpslSizeInput): { contracts: string; error: TpslError | null } {
  const market: SizeMarket = { multiplier: input.multiplier, price: input.price, coinDp: input.coinDp }
  const limits = { min: input.minContracts, max: input.canClose }

  const limitError = (key: string, wire: string, rounding: 'down' | 'up'): TpslError => {
    const amount = contractsToUnit(wire, input.unit, market, rounding)
    return {
      key,
      ns: 'err',
      params: {
        amount: amount === '' ? '--' : amount,
        unit: input.labels.unit,
        ref: `${canonicalDecimal(wire)} ${input.labels.contracts}`,
      },
    }
  }

  let contracts = ''
  if (input.presetContracts !== undefined) {
    const preset = canonicalDecimal(input.presetContracts)
    contracts = /^\d+$/.test(preset) ? preset : '0'
  } else {
    const result = sizeInputToContracts(input.raw, input.unit, market, limits, input.labels)
    if (result.error !== null) return { contracts: result.contracts, error: { key: result.error.key, ns: 'err', params: result.error.params } }
    contracts = result.contracts
  }

  const min = isPositive(canonicalDecimal(limits.min)) ? canonicalDecimal(limits.min) : '1'
  if (new Decimal(contracts).lt(min)) return { contracts, error: limitError('belowMinUnit', min, 'up') }
  if (isDecimalString(canonicalDecimal(limits.max)) && new Decimal(contracts).gt(canonicalDecimal(limits.max))) {
    return { contracts, error: limitError('aboveCanCloseUnit', limits.max, 'down') }
  }
  return { contracts, error: null }
}

export interface TpslTriggerInput {
  raw: string
  kind: 'tp' | 'sl'
  long: boolean
  last: string
  liq: string
  dp: number
}

/**
 * TP/SL trigger price, validated against the last trade price (long TP > last, long SL < last and >
 * liq; short mirrored). Empty raw means the leg is omitted; invalid / non-positive / over-precision
 * inputs reuse the `fut.err.*` keys, direction violations use the `fut.tpq.*` keys.
 */
export function tpslTriggerCheck(input: TpslTriggerInput): { price: string; error: TpslError | null } {
  const value = normalizeInput(input.raw)
  if (value === '') return { price: '', error: null }
  if (!isDecimalString(value)) return { price: value, error: { key: 'invalidNumber', ns: 'err' } }
  if (!isPositive(value)) return { price: value, error: { key: 'mustBePositive', ns: 'err' } }
  if ((decimalPlaces(value) ?? 0) > input.dp) return { price: value, error: { key: 'precision', ns: 'err', params: { dp: input.dp } } }

  const amount = new Decimal(value)
  if (isPositive(input.last)) {
    // Display only: contract precision truncates downward via groupDigits; all comparisons retain the raw Decimal.
    const last = new Decimal(input.last)
    if (input.kind === 'tp') {
      const wrong = input.long ? amount.lte(last) : amount.gte(last)
      if (wrong) return { price: value, error: { key: input.long ? 'tpAboveLast' : 'tpBelowLast', ns: 'tpq', params: { last: groupDigits(input.last, input.dp) } } }
    } else {
      const wrong = input.long ? amount.gte(last) : amount.lte(last)
      if (wrong) return { price: value, error: { key: input.long ? 'slBelowLast' : 'slAboveLast', ns: 'tpq', params: { last: groupDigits(input.last, input.dp) } } }
    }
  }
  if (input.kind === 'sl' && isPositive(input.liq)) {
    const liq = new Decimal(input.liq)
    const wrong = input.long ? amount.lte(liq) : amount.gte(liq)
    if (wrong) return { price: value, error: { key: input.long ? 'slAboveLiq' : 'slBelowLiq', ns: 'tpq', params: { liq: canonicalDecimal(liq.toFixed(Math.max(0, input.dp), input.long ? Decimal.ROUND_UP : Decimal.ROUND_DOWN)) } } }
  }
  return { price: value, error: null }
}

/**
 * Market TP/SL legs from the dialog's trigger prices: TP first (`triggerType` 2), then SL (1); a leg
 * whose price is `''` is omitted.
 */
export function tpslLegs(input: { tp: string; sl: string; contracts: string }): TpslLeg[] {
  const legs: TpslLeg[] = []
  if (input.tp !== '') legs.push({ triggerType: 2, triggerPrice: input.tp, price: '0', type: 2, volume: input.contracts })
  if (input.sl !== '') legs.push({ triggerType: 1, triggerPrice: input.sl, price: '0', type: 2, volume: input.contracts })
  return legs
}
