import type { SymbolInfo } from '@/modules/api/types'
import { canonicalDecimal, cmp, decimalPlaces, gte, isDecimalString, isPositive, isZero, mul, toDecString } from './decimal'

/**
 * Price/amount limits come from `/common/public_info_v4` -> `market.market[QUOTE]["BASE/QUOTE"]`:
 *   price, volume             -> allowed decimal places
 *   limitPriceMin, limitVolumeMin -> minimums for limit orders
 *   marketBuyMin, marketSellMin   -> minimums for market orders
 *   depth                     -> allowed depth steps (also used to pick the WS depth channel)
 *
 * The server re-validates all of this (codes 10062 / 10063 / 10064), so the client check is a
 * fast pre-flight only and never a substitute for the server answer.
 */

export interface SymbolRules {
  pricePrecision: number
  volumePrecision: number
  limitPriceMin: string
  limitVolumeMin: string
  marketBuyMin: string
  marketSellMin: string
  /** Depth steps as configured, e.g. `['0.00000001', '0.000001', '0.0001']`. */
  depthSteps: string[]
}

export const FALLBACK_RULES: SymbolRules = {
  pricePrecision: 2,
  volumePrecision: 8,
  limitPriceMin: '0',
  limitVolumeMin: '0',
  marketBuyMin: '0',
  marketSellMin: '0',
  depthSteps: [],
}

function precisionOf(value: unknown, fallback: number): number {
  const text = toDecString(value)
  if (!/^\d+$/.test(text)) {
    return fallback
  }
  // Manual digit accumulation: `price` / `volume` are precision counters (not amounts).
  let parsed = 0
  for (const digit of text) {
    parsed = parsed * 10 + (digit.charCodeAt(0) - 48)
  }
  return parsed
}

export function buildSymbolRules(info: SymbolInfo | null | undefined): SymbolRules {
  if (info === null || info === undefined) {
    return { ...FALLBACK_RULES }
  }
  const depthSteps = typeof info.depth === 'string' && info.depth !== ''
    ? info.depth.split(',').map((step) => canonicalDecimal(step.trim())).filter((step) => step !== '')
    : []
  return {
    // `price` / `volume` are integer precision counters, not amounts.
    pricePrecision: typeof info.price === 'number' ? info.price : precisionOf(info.price, FALLBACK_RULES.pricePrecision),
    volumePrecision: typeof info.volume === 'number' ? info.volume : precisionOf(info.volume, FALLBACK_RULES.volumePrecision),
    limitPriceMin: canonicalDecimal(toDecString(info.limitPriceMin)) || '0',
    limitVolumeMin: canonicalDecimal(toDecString(info.limitVolumeMin)) || '0',
    marketBuyMin: canonicalDecimal(toDecString(info.marketBuyMin)) || '0',
    marketSellMin: canonicalDecimal(toDecString(info.marketSellMin)) || '0',
    depthSteps,
  }
}

export type OrderSide = 'BUY' | 'SELL'
/** `1` limit, `2` market — mirrors the server enum. */
export type OrderType = '1' | '2'

export interface OrderDraft {
  side: OrderSide
  type: OrderType
  price: string
  volume: string
}

export interface ValidationContext {
  rules: SymbolRules
  /** Available balance of the base coin (sell side). */
  baseAvailable: string
  /** Available balance of the quote coin (buy side). */
  quoteAvailable: string
  /** Max quote decimals for a market buy; defaults to `rules.pricePrecision`. */
  quotePrecision?: number
}

export interface FieldError {
  field: 'price' | 'volume' | 'total'
  /** i18n key. */
  key: string
  params?: Record<string, string | number>
}

export interface DraftValidation {
  ok: boolean
  errors: FieldError[]
  /** Canonical (trailing-zero trimmed) decimal strings ready to POST. */
  price: string
  volume: string
  /** Quote amount: `price * volume` for limit orders, the volume itself for a market buy, `''` otherwise. */
  total: string
}

function fieldError(field: FieldError['field'], key: string, params?: Record<string, string | number>): FieldError {
  return params === undefined ? { field, key } : { field, key, params }
}

function isEmpty(value: string): boolean {
  return value.trim() === ''
}

/**
 * Validates a draft order against the public-info rules and the available balance.
 * Balances are optional: pass `''` to skip the balance check (e.g. logged out / not loaded yet).
 */
export function validateOrderDraft(draft: OrderDraft, context: ValidationContext): DraftValidation {
  const { rules } = context
  const errors: FieldError[] = []
  const price = canonicalDecimal(draft.price)
  const volume = canonicalDecimal(draft.volume)
  const isLimit = draft.type === '1'
  let total = ''

  if (isLimit) {
    if (isEmpty(price)) {
      errors.push(fieldError('price', 'error.required'))
    } else if (!isDecimalString(price)) {
      errors.push(fieldError('price', 'error.invalidDecimal'))
    } else {
      const places = decimalPlaces(price) ?? 0
      if (places > rules.pricePrecision) {
        errors.push(fieldError('price', 'error.precision', { dp: rules.pricePrecision }))
      }
      if (!isPositive(price)) {
        errors.push(fieldError('price', 'error.mustBePositive'))
      } else if (rules.limitPriceMin !== '0' && cmp(price, rules.limitPriceMin) < 0) {
        errors.push(fieldError('price', 'error.belowPriceMin', { min: rules.limitPriceMin }))
      }
    }
  }

  if (isEmpty(volume)) {
    errors.push(fieldError('volume', 'error.required'))
  } else if (!isDecimalString(volume)) {
    errors.push(fieldError('volume', 'error.invalidDecimal'))
  } else if (!isPositive(volume)) {
    // A zero amount names the pair's minimum when there is one (10-24: "必须大于 0" left users guessing how much is enough).
    const min = isLimit ? rules.limitVolumeMin : draft.side === 'BUY' ? rules.marketBuyMin : rules.marketSellMin
    errors.push(min !== '0' ? fieldError('volume', 'error.belowVolumeMin', { min }) : fieldError('volume', 'error.mustBePositive'))
  } else if (isLimit || draft.side === 'SELL') {
    // Base-amount order: volume precision comes from `volume`.
    const places = decimalPlaces(volume) ?? 0
    if (places > rules.volumePrecision) {
      errors.push(fieldError('volume', 'error.precision', { dp: rules.volumePrecision }))
    }
  } else {
    // Market buy: volume is a quote-coin (USDT) amount.
    const quotePrecision = context.quotePrecision ?? rules.pricePrecision
    const places = decimalPlaces(volume) ?? 0
    if (places > quotePrecision) {
      errors.push(fieldError('volume', 'error.precision', { dp: quotePrecision }))
    }
  }

  if (errors.length === 0) {
    if (isLimit) {
      total = mul(price, volume)
      if (draft.side === 'BUY' && context.quoteAvailable !== '' && cmp(total, context.quoteAvailable) > 0) {
        errors.push(fieldError('total', 'error.insufficientQuote', { available: context.quoteAvailable }))
      }
      if (draft.side === 'SELL' && context.baseAvailable !== '' && cmp(volume, context.baseAvailable) > 0) {
        errors.push(fieldError('volume', 'error.insufficientBase', { available: context.baseAvailable }))
      }
      if (rules.limitVolumeMin !== '0' && cmp(volume, rules.limitVolumeMin) < 0) {
        errors.push(fieldError('volume', 'error.belowVolumeMin', { min: rules.limitVolumeMin }))
      }
    } else if (draft.side === 'BUY') {
      total = volume
      if (rules.marketBuyMin !== '0' && cmp(volume, rules.marketBuyMin) < 0) {
        errors.push(fieldError('volume', 'error.belowVolumeMin', { min: rules.marketBuyMin }))
      }
      if (context.quoteAvailable !== '' && cmp(volume, context.quoteAvailable) > 0) {
        errors.push(fieldError('volume', 'error.insufficientQuote', { available: context.quoteAvailable }))
      }
    } else {
      if (rules.marketSellMin !== '0' && cmp(volume, rules.marketSellMin) < 0) {
        errors.push(fieldError('volume', 'error.belowVolumeMin', { min: rules.marketSellMin }))
      }
      if (context.baseAvailable !== '' && cmp(volume, context.baseAvailable) > 0) {
        errors.push(fieldError('volume', 'error.insufficientBase', { available: context.baseAvailable }))
      }
    }
  }

  return { ok: errors.length === 0, errors, price, volume, total }
}

/** Depth level used by the market WebSocket channel (`market_<symbol>_depth_step<level>`). */
export function depthLevelFromStep(step: string): number {
  const canonical = canonicalDecimal(step)
  return decimalPlaces(canonical) ?? 0
}

export function isBelowMinimum(value: string, min: string): boolean {
  if (min === '0' || min === '' || !isDecimalString(value)) {
    return false
  }
  return !gte(value, min)
}

export function isZeroOrEmpty(value: string): boolean {
  return value.trim() === '' || isZero(value)
}
