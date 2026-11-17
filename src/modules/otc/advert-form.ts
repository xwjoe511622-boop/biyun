import { canonicalDecimal, decimalPlaces, gt, gte, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { coinToFiat, floatingPrice } from './amounts'

/**
 * Publish-advert form model and validation.
 *
 * Request fields follow the legacy PC `otcRelease/index.js#confirm` and the server `otc/wanted_save`
 * (exchange-otc-api AdvertAct): coin, side, payCoin, volume, price, priceRate, priceRateType
 * (0 = fixed, 2 = floating above the reference, 3 = floating below), minTrade, maxTrade,
 * limitTime (minutes), dealVolume (counterparty completed-trade threshold), days,
 * payments [{ payment }], description, autoReply.
 */

export type AdvertSide = 'BUY' | 'SELL'
export type PriceType = 'fixed' | 'floating'
export type FloatDirection = 'above' | 'below'

export interface AdvertFormState {
  side: AdvertSide
  coin: string
  payCoin: string
  priceType: PriceType
  price: string
  floatRate: string
  floatDirection: FloatDirection
  volume: string
  minTrade: string
  maxTrade: string
  limitTime: string
  dealVolume: string
  days: string
  payments: string[]
  description: string
  autoReply: string
}

export interface AdvertFormContext {
  fiatDp: number
  coinDp: number
  /** Reference market price for floating adverts (`otc/rates`); `''` when not available. */
  referencePrice: string
  /** Free OTC balance for SELL adverts; `''` when unknown (the server still checks). */
  availableVolume: string
  /** Max selectable payment methods for BUY adverts (legacy limit: 3). */
  maxPayments: number
}

export const LIMIT_TIME_MIN = 5
export const LIMIT_TIME_MAX = 60
export const FLOAT_RATE_MAX = '50'
export const DAYS_OPTIONS = ['2', '4', '7', '30'] as const

export type AdvertField =
  | 'coin' | 'payCoin' | 'price' | 'floatRate' | 'volume' | 'minTrade' | 'maxTrade'
  | 'limitTime' | 'dealVolume' | 'days' | 'payments' | 'description' | 'autoReply'

export type AdvertErrorCode =
  | 'required' | 'invalid' | 'precision' | 'positive' | 'rateMax' | 'noReference' | 'aboveBalance'
  | 'minAboveMax' | 'limitAboveTotal' | 'limitTime' | 'tooManyPayments' | 'tooLong'

export type AdvertErrors = Partial<Record<AdvertField, AdvertErrorCode>>

export function emptyAdvertForm(): AdvertFormState {
  return {
    side: 'SELL', coin: '', payCoin: '', priceType: 'fixed', price: '', floatRate: '', floatDirection: 'above',
    volume: '', minTrade: '', maxTrade: '', limitTime: '15', dealVolume: '0', days: '30', payments: [],
    description: '', autoReply: '',
  }
}

/** The unit price that will be submitted (fixed input, or reference × (1 ± rate)). */
export function effectivePrice(form: AdvertFormState, ctx: AdvertFormContext): string {
  if (form.priceType === 'fixed') return isDecimalString(form.price) ? canonicalDecimal(form.price) : ''
  const rate = form.floatRate.trim() === '' ? '0' : form.floatRate.trim()
  return floatingPrice(ctx.referencePrice, rate, form.floatDirection, ctx.fiatDp)
}

/** Total fiat value of the advert (`volume × price`), used as the ceiling for the order limits. */
export function advertTotal(form: AdvertFormState, ctx: AdvertFormContext): string {
  const price = effectivePrice(form, ctx)
  return isDecimalString(form.volume) && isDecimalString(price) ? coinToFiat(form.volume, price, ctx.fiatDp) : ''
}

function decimalError(value: string, dp: number, positive = true): AdvertErrorCode | null {
  const text = value.trim()
  if (text === '') return 'required'
  if (!isDecimalString(text)) return 'invalid'
  const places = decimalPlaces(text)
  if (places !== null && places > dp) return 'precision'
  if (positive && !isPositive(text)) return 'positive'
  return null
}

function integerIn(value: string, min: number, max: number): boolean {
  const text = value.trim()
  if (!/^\d{1,4}$/.test(text)) return false
  const n = Number.parseInt(text, 10)
  return n >= min && n <= max
}

export function validateAdvertForm(form: AdvertFormState, ctx: AdvertFormContext): AdvertErrors {
  const errors: AdvertErrors = {}
  if (form.coin === '') errors.coin = 'required'
  if (form.payCoin === '') errors.payCoin = 'required'

  if (form.priceType === 'fixed') {
    const e = decimalError(form.price, ctx.fiatDp)
    if (e !== null) errors.price = e
  } else {
    const rate = form.floatRate.trim() === '' ? '0' : form.floatRate.trim()
    const e = decimalError(rate, 2, false)
    if (e !== null) errors.floatRate = e
    else if (gt(rate, FLOAT_RATE_MAX)) errors.floatRate = 'rateMax'
    else if (!isPositive(ctx.referencePrice)) errors.floatRate = 'noReference'
  }

  const volumeError = decimalError(form.volume, ctx.coinDp)
  if (volumeError !== null) errors.volume = volumeError
  else if (form.side === 'SELL' && isDecimalString(ctx.availableVolume) && gt(form.volume, ctx.availableVolume)) {
    errors.volume = 'aboveBalance'
  }

  const minError = decimalError(form.minTrade, ctx.fiatDp)
  const maxError = decimalError(form.maxTrade, ctx.fiatDp)
  if (minError !== null) errors.minTrade = minError
  if (maxError !== null) errors.maxTrade = maxError
  if (minError === null && maxError === null) {
    if (gte(form.minTrade, form.maxTrade)) errors.minTrade = 'minAboveMax'
    const total = advertTotal(form, ctx)
    if (isDecimalString(total) && errors.volume === undefined && errors.price === undefined) {
      if (gt(form.maxTrade, total)) errors.maxTrade = 'limitAboveTotal'
      if (errors.minTrade === undefined && gt(form.minTrade, total)) errors.minTrade = 'limitAboveTotal'
    }
  }

  if (!integerIn(form.limitTime, LIMIT_TIME_MIN, LIMIT_TIME_MAX)) errors.limitTime = 'limitTime'
  if (!/^\d{1,6}$/.test(form.dealVolume.trim())) errors.dealVolume = 'invalid'
  if (!(DAYS_OPTIONS as readonly string[]).includes(form.days)) errors.days = 'invalid'

  if (form.payments.length === 0) errors.payments = 'required'
  else if (form.side === 'BUY' && form.payments.length > ctx.maxPayments) errors.payments = 'tooManyPayments'

  if (form.description.length > 500) errors.description = 'tooLong'
  if (form.autoReply.length > 500) errors.autoReply = 'tooLong'
  return errors
}

export function isAdvertFormValid(errors: AdvertErrors): boolean {
  return Object.keys(errors).length === 0
}

/** Request body for `otc/wanted_save`. Only call with a validated form. */
export function buildAdvertPayload(form: AdvertFormState, ctx: AdvertFormContext): Record<string, unknown> {
  const floating = form.priceType === 'floating'
  const rate = form.floatRate.trim() === '' ? '0' : canonicalDecimal(form.floatRate.trim())
  return {
    coin: form.coin,
    side: form.side,
    payCoin: form.payCoin,
    volume: canonicalDecimal(form.volume.trim()),
    price: effectivePrice(form, ctx),
    priceRate: floating ? rate : '0',
    priceRateType: floating ? (form.floatDirection === 'above' ? 2 : 3) : 0,
    minTrade: canonicalDecimal(form.minTrade.trim()),
    maxTrade: canonicalDecimal(form.maxTrade.trim()),
    limitTime: form.limitTime.trim(),
    dealVolume: form.dealVolume.trim(),
    days: form.days,
    payments: form.payments.map(payment => ({ payment })),
    description: form.description.trim(),
    autoReply: form.autoReply.trim(),
  }
}

