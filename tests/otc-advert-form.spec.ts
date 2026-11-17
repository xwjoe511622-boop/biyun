import { describe, expect, it } from 'vitest'
import {
  advertTotal,
  buildAdvertPayload,
  effectivePrice,
  emptyAdvertForm,
  isAdvertFormValid,
  validateAdvertForm,
  type AdvertFormContext,
  type AdvertFormState,
} from '@/modules/otc/advert-form'

const ctx: AdvertFormContext = { fiatDp: 2, coinDp: 4, referencePrice: '7.10', availableVolume: '500', maxPayments: 3 }

function valid(partial: Partial<AdvertFormState> = {}): AdvertFormState {
  return {
    ...emptyAdvertForm(),
    side: 'SELL',
    coin: 'USDT',
    payCoin: 'CNY',
    price: '7.15',
    volume: '100',
    minTrade: '100',
    maxTrade: '700',
    payments: ['otc.payment.alipay'],
    ...partial,
  }
}

describe('otc advert form validation', () => {
  it('accepts a complete fixed-price sell advert', () => {
    expect(validateAdvertForm(valid(), ctx)).toEqual({})
    expect(isAdvertFormValid(validateAdvertForm(valid(), ctx))).toBe(true)
  })

  it('flags every required field on an empty form', () => {
    const errors = validateAdvertForm(emptyAdvertForm(), ctx)
    expect(errors).toMatchObject({
      coin: 'required', payCoin: 'required', price: 'required', volume: 'required',
      minTrade: 'required', maxTrade: 'required', payments: 'required',
    })
  })

  it('checks decimal precision per fiat/coin', () => {
    expect(validateAdvertForm(valid({ price: '7.155' }), ctx).price).toBe('precision')
    expect(validateAdvertForm(valid({ volume: '1.00001' }), ctx).volume).toBe('precision')
    expect(validateAdvertForm(valid({ price: '0' }), ctx).price).toBe('positive')
    expect(validateAdvertForm(valid({ price: '7,1' }), ctx).price).toBe('invalid')
  })

  it('requires min < max and both within the advert total', () => {
    expect(validateAdvertForm(valid({ minTrade: '700', maxTrade: '700' }), ctx).minTrade).toBe('minAboveMax')
    // total = 100 × 7.15 = 715
    expect(advertTotal(valid(), ctx)).toBe('715')
    expect(validateAdvertForm(valid({ maxTrade: '715.01' }), ctx).maxTrade).toBe('limitAboveTotal')
    expect(validateAdvertForm(valid({ maxTrade: '715' }), ctx).maxTrade).toBeUndefined()
  })

  it('limits SELL volume to the OTC balance but not BUY volume', () => {
    expect(validateAdvertForm(valid({ volume: '500.0001' }), ctx).volume).toBe('aboveBalance')
    expect(validateAdvertForm(valid({ side: 'BUY', volume: '500.0001', maxTrade: '700' }), ctx).volume).toBeUndefined()
    expect(validateAdvertForm(valid({ volume: '600' }), { ...ctx, availableVolume: '' }).volume).toBeUndefined()
  })

  it('validates floating pricing against the reference price', () => {
    const floating = valid({ priceType: 'floating', price: '', floatRate: '2', floatDirection: 'above' })
    expect(effectivePrice(floating, ctx)).toBe('7.24')
    expect(validateAdvertForm(floating, ctx)).toEqual({})
    expect(validateAdvertForm({ ...floating, floatRate: '50.01' }, ctx).floatRate).toBe('rateMax')
    expect(validateAdvertForm(floating, { ...ctx, referencePrice: '' }).floatRate).toBe('noReference')
  })

  it('bounds the payment window, the days option and BUY payment count', () => {
    expect(validateAdvertForm(valid({ limitTime: '4' }), ctx).limitTime).toBe('limitTime')
    expect(validateAdvertForm(valid({ limitTime: '61' }), ctx).limitTime).toBe('limitTime')
    expect(validateAdvertForm(valid({ limitTime: '60' }), ctx).limitTime).toBeUndefined()
    expect(validateAdvertForm(valid({ days: '5' }), ctx).days).toBe('invalid')
    const four = ['a', 'b', 'c', 'd']
    expect(validateAdvertForm(valid({ side: 'BUY', payments: four }), ctx).payments).toBe('tooManyPayments')
    expect(validateAdvertForm(valid({ side: 'SELL', payments: four }), ctx).payments).toBeUndefined()
    expect(validateAdvertForm(valid({ description: 'x'.repeat(501) }), ctx).description).toBe('tooLong')
  })

  it('builds the wanted_save payload the server reads', () => {
    expect(buildAdvertPayload(valid({ price: '7.150', description: ' hi ' }), ctx)).toEqual({
      coin: 'USDT', side: 'SELL', payCoin: 'CNY', volume: '100', price: '7.15', priceRate: '0', priceRateType: 0,
      minTrade: '100', maxTrade: '700', limitTime: '15', dealVolume: '0', days: '30',
      payments: [{ payment: 'otc.payment.alipay' }], description: 'hi', autoReply: '',
    })
    const below = buildAdvertPayload(valid({ priceType: 'floating', floatRate: '1.50', floatDirection: 'below' }), ctx)
    expect(below).toMatchObject({ price: '6.99', priceRate: '1.5', priceRateType: 3 })
    expect(buildAdvertPayload(valid({ priceType: 'floating', floatRate: '1', floatDirection: 'above' }), ctx).priceRateType).toBe(2)
  })
})
