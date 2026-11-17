import { afterEach, describe, expect, it } from 'vitest'
import { percentOf, type FuturesDraft, type FuturesValidationContext } from '@/modules/futures/math'
import {
  BBO_OPTIONS,
  DEFAULT_QUOTE_MODE,
  QUOTE_MODE_KEY,
  marginToNotional,
  maxOpenNotional,
  notionalToContracts,
  notionalToMargin,
  orderTypeCode,
  pickTakerFee,
  readQuoteMode,
  readTimeInForce,
  resolveBboPrice,
  saveQuoteMode,
  saveTimeInForce,
  TIF_KEY,
  TICKET_ORDER_TYPES,
  draftMode,
  type BookTop,
} from '@/modules/futures/order-entry'
import { validateSizedOrder, wireToEntry, type SizeMarket, type SizeUnit } from '@/modules/futures/size-unit'

// Live BTC perpetual shape: 1 张 = 0.0001 BTC, symbolPricePrecision 2, marginCoinPrecision 6.
const contract: FuturesValidationContext['contract'] = {
  pricePrecision: 2,
  marginCoinPrecision: 6,
  minLever: 1,
  maxLever: 125,
  minOrderVolume: '1',
  maxLimitVolume: '99999999',
  maxMarketVolume: '99999999',
  maxMarketMoney: '99999999',
  minOrderMoney: '1',
  multiplier: '0.0001',
}

const book: BookTop = {
  asks: ['83263.31', '83263.9', '83264.5', '83265', '83266.12', '83270'],
  bids: ['83257.98', '83257.1', '83256', '83255.5', '83254.07', '83250'],
}

afterEach(() => localStorage.clear())

describe('best-price shortcuts (最优价)', () => {
  it('对手价1: buy takes the best ask, sell the best bid', () => {
    expect(resolveBboPrice('opp1', 'BUY', book)).toEqual({ ok: true, price: '83263.31', bookSide: 'ask', level: 1 })
    expect(resolveBboPrice('opp1', 'SELL', book)).toEqual({ ok: true, price: '83257.98', bookSide: 'bid', level: 1 })
  })

  it('对手价5: the 5th level of the opposite side', () => {
    expect(resolveBboPrice('opp5', 'BUY', book)).toMatchObject({ ok: true, price: '83266.12', bookSide: 'ask' })
    expect(resolveBboPrice('opp5', 'SELL', book)).toMatchObject({ ok: true, price: '83254.07', bookSide: 'bid' })
  })

  it('同向价1 / 同向价5: the own side (buy → bids, sell → asks)', () => {
    expect(resolveBboPrice('same1', 'BUY', book)).toMatchObject({ ok: true, price: '83257.98', bookSide: 'bid' })
    expect(resolveBboPrice('same1', 'SELL', book)).toMatchObject({ ok: true, price: '83263.31', bookSide: 'ask' })
    expect(resolveBboPrice('same5', 'BUY', book)).toMatchObject({ ok: true, price: '83254.07' })
    expect(resolveBboPrice('same5', 'SELL', book)).toMatchObject({ ok: true, price: '83266.12' })
  })

  it('fails clearly when the book lacks depth, never falling back to another level', () => {
    const thin: BookTop = { asks: ['1', '2', '3'], bids: [] }
    expect(resolveBboPrice('opp5', 'BUY', thin)).toEqual({ ok: false, error: 'noDepth', bookSide: 'ask', level: 5, have: 3 })
    expect(resolveBboPrice('opp1', 'SELL', thin)).toEqual({ ok: false, error: 'noDepth', bookSide: 'bid', level: 1, have: 0 })
    expect(resolveBboPrice('same1', 'SELL', thin)).toMatchObject({ ok: true, price: '1' })
    expect(resolveBboPrice('opp1', 'BUY', { asks: [], bids: [] }).ok).toBe(false)
  })

  it('ignores junk and non-positive levels and canonicalises the price', () => {
    expect(resolveBboPrice('opp1', 'BUY', { asks: ['', '0', 'abc', '100.500'], bids: [] })).toMatchObject({ ok: true, price: '100.5' })
  })

  it('offers exactly the four Binance shortcuts', () => {
    expect(BBO_OPTIONS).toEqual(['opp1', 'opp5', 'same1', 'same5'])
  })
})

describe('initial margin ↔ notional', () => {
  it('100 USDT at 10x is 1000 USDT of notional (and back)', () => {
    expect(marginToNotional('100', { leverage: 10, marginRate: '1' })).toBe('1000')
    expect(notionalToMargin('1000', { leverage: 10, marginRate: '1' }, 2)).toBe('100')
  })

  it('honours the margin exchange rate and rounds the margin as asked', () => {
    expect(marginToNotional('100', { leverage: 10, marginRate: '2' })).toBe('500')
    expect(notionalToMargin('10', { leverage: 3, marginRate: '1' }, 2)).toBe('3.33')
    expect(notionalToMargin('10', { leverage: 3, marginRate: '1' }, 2, 'up')).toBe('3.34')
  })

  it('rejects unusable leverage / amounts', () => {
    expect(marginToNotional('100', { leverage: 0, marginRate: '1' })).toBe('')
    expect(marginToNotional('100', { leverage: 2.5, marginRate: '1' })).toBe('')
    expect(marginToNotional('x', { leverage: 10, marginRate: '1' })).toBe('')
    expect(notionalToMargin('1', { leverage: 10, marginRate: '0' }, 2)).toBe('')
  })
})

describe('fee-aware maximum (最大)', () => {
  it('1000 USDT at 10x is about 10000 USDT minus the taker fee', () => {
    expect(maxOpenNotional({ available: '1000', leverage: 10, marginRate: '1', takerFee: '0.0005', dp: 2 })).toBe('9950.24')
    expect(maxOpenNotional({ available: '1000', leverage: 10, marginRate: '1', takerFee: '0.00075', dp: 2 })).toBe('9925.55')
  })

  it('without a known fee it is available × leverage / marginRate', () => {
    expect(maxOpenNotional({ available: '1000', leverage: 10, marginRate: '1', takerFee: '', dp: 2 })).toBe('10000')
    expect(maxOpenNotional({ available: '1000', leverage: 10, marginRate: '1', takerFee: '0', dp: 2 })).toBe('10000')
  })

  it('margin + fee at the maximum never exceeds the available balance', () => {
    const n = maxOpenNotional({ available: '1234.567891', leverage: 125, marginRate: '1', takerFee: '0.00075', dp: 2 })
    const needed = Number(n) / 125 + Number(n) * 0.00075 // test-only float check of the invariant
    expect(needed).toBeLessThanOrEqual(1234.567891)
  })

  it('empty or negative balances', () => {
    expect(maxOpenNotional({ available: '', leverage: 10, marginRate: '1', takerFee: '0.0005', dp: 2 })).toBe('')
    expect(maxOpenNotional({ available: '0', leverage: 10, marginRate: '1', takerFee: '0.0005', dp: 2 })).toBe('0')
    // Negative balances are clamped to 0 by the account store before they get here.
    expect(maxOpenNotional({ available: '-3', leverage: 10, marginRate: '1', takerFee: '0.0005', dp: 2 })).toBe('')
  })

  it('max contracts floor the notional at the reference price; the slider takes a floored share', () => {
    const notional = maxOpenNotional({ available: '1000', leverage: 10, marginRate: '1', takerFee: '0.00075', dp: 2 })
    expect(notionalToContracts(notional, '100000', '0.0001')).toBe('992')
    expect(percentOf('992', 25, 0)).toBe('248')
    expect(percentOf('992', 75, 0)).toBe('744')
    expect(notionalToContracts(notional, '0', '0.0001')).toBe('')
  })

  it('picks the taker fee of the contract row (matched by base coin), else the highest', () => {
    const rows = [
      { openTakerFee: '0.0006', multiplierCoin: 'ETH', marginCoin: 'USDT' },
      { openTakerFee: '0.00075', multiplierCoin: 'BTC', marginCoin: 'USDT' },
      { openTakerFee: '0.001', multiplierCoin: 'XAUT', marginCoin: 'USDT' },
    ]
    expect(pickTakerFee(rows, { multiplierCoin: 'BTC', marginCoin: 'USDT' })).toBe('0.00075')
    expect(pickTakerFee(rows, { multiplierCoin: 'DOGE', marginCoin: 'USDT' })).toBe('0.001')
    expect(pickTakerFee([], { multiplierCoin: 'BTC', marginCoin: 'USDT' })).toBe('')
  })
})

describe('order types and time in force', () => {
  it('offers the four Binance types the engine executes, post-only validated as a limit order', () => {
    expect(TICKET_ORDER_TYPES).toEqual(['limit', 'postOnly', 'market', 'trigger'])
    expect(draftMode('postOnly')).toBe('limit')
    expect(draftMode('market')).toBe('market')
  })

  it('maps to the wire type', () => {
    expect(orderTypeCode('limit', false, 'GTC')).toBe(1)
    expect(orderTypeCode('limit', false, 'IOC')).toBe(3)
    expect(orderTypeCode('limit', false, 'FOK')).toBe(4)
    expect(orderTypeCode('postOnly', false, 'IOC')).toBe(5)
    expect(orderTypeCode('market', false, 'IOC')).toBe(2)
    expect(orderTypeCode('trigger', false, 'FOK')).toBe(1)
    expect(orderTypeCode('trigger', true, 'GTC')).toBe(2)
  })

  it('remembers TIF and the USDT mode', () => {
    expect(readTimeInForce()).toBe('GTC')
    saveTimeInForce('FOK')
    expect(localStorage.getItem(TIF_KEY)).toBe('FOK')
    expect(readTimeInForce()).toBe('FOK')
    expect(readQuoteMode()).toBe(DEFAULT_QUOTE_MODE)
    saveQuoteMode('margin')
    expect(localStorage.getItem(QUOTE_MODE_KEY)).toBe('margin')
    expect(readQuoteMode()).toBe('margin')
    localStorage.setItem(QUOTE_MODE_KEY, 'junk')
    expect(readQuoteMode()).toBe('notional')
  })
})

/* ------------------------------------------------------------ unit conversions on the ticket */

function draft(patch: Partial<FuturesDraft> = {}): FuturesDraft {
  return { mode: 'limit', open: 'OPEN', side: 'BUY', price: '100000', triggerPrice: '', triggerAtMarket: false, volume: '', leverage: 10, tpTrigger: '', slTrigger: '', ...patch }
}

function sized(unit: SizeUnit, patch: Partial<FuturesDraft>, options: { quoteMode?: 'notional' | 'margin'; leverage?: number; referencePrice?: string; presetWire?: string; canClose?: string } = {}) {
  return validateSizedOrder({
    draft: draft(patch),
    context: { contract, canClose: options.canClose ?? '', referencePrice: options.referencePrice ?? '100000' },
    unit,
    presetWire: options.presetWire,
    unitLabel: unit === 'base' ? 'BTC' : 'USDT',
    coin: 'USDT',
    contractsLabel: '张',
    quoteMode: options.quoteMode,
    marginBasis: { leverage: options.leverage ?? 10, marginRate: '1' },
  })
}

const volumeError = (result: ReturnType<typeof sized>) => result.errors.find((entry) => entry.field === 'volume')

describe('coin ↔ USDT notional ↔ initial margin ↔ contracts', () => {
  // 1 张 at 100000 = 0.0001 BTC = 10 USDT notional = 1 USDT margin at 10x.
  const market: SizeMarket = { multiplier: '0.0001', price: '100000', coinDp: 2 }

  it('coin → contracts (floored, exact decimals)', () => {
    expect(sized('base', { volume: '0.012' }).volume).toBe('120')
    expect(sized('base', { volume: '0.0129' }).volume).toBe('129')
    expect(volumeError(sized('base', { volume: '0.01299' }))?.key).toBe('precision')
  })

  it('USDT notional → contracts (floored)', () => {
    expect(sized('quote', { volume: '1000' }).volume).toBe('100')
    expect(sized('quote', { volume: '1009.99' }).volume).toBe('100')
    expect(sized('quote', { volume: '1000', price: '83257.98' }, { referencePrice: '83257.98' }).volume).toBe('120')
  })

  it('initial margin → notional → contracts: 100 USDT at 10x = 1000 USDT = 100 张 at 100000', () => {
    const result = sized('quote', { volume: '100' }, { quoteMode: 'margin' })
    expect(result.ok).toBe(true)
    expect(result.volume).toBe('100')
    expect(result.value).toBe('1000')
    expect(sized('quote', { volume: '100', price: '83257.98' }, { quoteMode: 'margin', referencePrice: '83257.98' }).volume).toBe('120')
    expect(sized('quote', { volume: '100' }, { quoteMode: 'margin', leverage: 20 }).volume).toBe('200')
  })

  it('initial margin floors to whole contracts and states the minimum in margin terms', () => {
    expect(sized('quote', { volume: '1.99' }, { quoteMode: 'margin' }).volume).toBe('1')
    const tiny = sized('quote', { volume: '0.5' }, { quoteMode: 'margin' })
    expect(tiny.ok).toBe(false)
    expect(volumeError(tiny)).toMatchObject({ key: 'belowMinUnit', params: { amount: '1', ref: '1 张' } })
    expect(volumeError(sized('quote', { volume: '1.234' }, { quoteMode: 'margin' }))).toMatchObject({ key: 'precision', params: { dp: 2 } })
  })

  it('initial margin on a market open sends the notional value (≤ 2 decimals)', () => {
    const result = sized('quote', { mode: 'market', price: '', volume: '33.33' }, { quoteMode: 'margin', leverage: 3 })
    expect(result.volume).toBe('99.99')
    const odd = sized('quote', { mode: 'market', price: '', volume: '0.37' }, { quoteMode: 'margin', leverage: 7 })
    expect(odd.volume).toBe('2.59')
    expect(volumeError(sized('quote', { mode: 'market', price: '', volume: '0.05' }, { quoteMode: 'margin', leverage: 10 }))?.key).toBe('belowMinUnit')
  })

  it('closable limits are restated in margin terms', () => {
    const result = sized('quote', { open: 'CLOSE', side: 'SELL', volume: '5' }, { quoteMode: 'margin', canClose: '3' })
    expect(result.volume).toBe('5')
    expect(volumeError(result)).toMatchObject({ key: 'aboveCanCloseUnit', params: { amount: '3', ref: '3 张' } })
  })

  it('wire → entry unit for 最大 / hints', () => {
    expect(wireToEntry('12', false, 'base', market)).toBe('0.0012')
    expect(wireToEntry('12', false, 'quote', market)).toBe('120')
    expect(wireToEntry('12', false, 'quote', market, { quoteMode: 'margin', marginBasis: { leverage: 10, marginRate: '1' } })).toBe('12')
    expect(wireToEntry('9925.55', true, 'quote', market, { quoteMode: 'margin', marginBasis: { leverage: 10, marginRate: '1' } })).toBe('992.55')
    expect(wireToEntry('7', false, 'quote', market, { quoteMode: 'margin', marginBasis: { leverage: 3, marginRate: '1' } }, 'up')).toBe('23.34')
    expect(wireToEntry('7', false, 'quote', market, { quoteMode: 'margin' })).toBe('')
  })

  it('the slider preset bypasses unit parsing in every mode', () => {
    expect(sized('quote', { volume: '' }, { quoteMode: 'margin', presetWire: '248' }).volume).toBe('248')
    expect(sized('base', { volume: '' }, { presetWire: '248' }).volume).toBe('248')
  })
})
