import { describe, expect, it } from 'vitest'
import { validateData } from '@/modules/api/validation'
import { decodeFrame } from '@/modules/ws/kline-socket'
import { safeWebUrl } from '@/core/urls'
import { percentView } from '@/modules/finance/display'
import { toDecString } from '@/modules/finance/decimal'

describe('runtime boundaries', () => {
  it('rejects malformed balances instead of displaying a guessed zero', () => {
    expect(() => validateData('finance/account_balance', { allCoinMap: { BTC: { normal_balance: 'NaN' } } })).toThrow('contract mismatch')
    expect(() => validateData('finance/account_balance', null)).toThrow('contract mismatch')
  })
  it('accepts the server default empty overcharge field without accepting empty usable balances', () => {
    const result = validateData<{ allCoinMap: { BTC: { normal_balance: string; overcharge_balance?: string } } }>('finance/account_balance', {
      totalBalance: '1', allCoinMap: { BTC: { normal_balance: '0.01', lock_balance: '0', overcharge_balance: '', checked: 'true' } }, withdrawAddressMap: {},
    })
    expect(result.allCoinMap.BTC.normal_balance).toBe('0.01')
    expect(result.allCoinMap.BTC.overcharge_balance).toBeUndefined()
    for (const value of ['', null, '-1', 'NaN']) expect(() => validateData('finance/account_balance', { allCoinMap: { BTC: { normal_balance: value } } })).toThrow()
  })
  it('renders negative market changes and small JSON numeric amounts correctly', () => {
    expect(percentView('-0.0123')).toEqual({ text: '-1.23%', direction: 'down' })
    expect(percentView('0.0123')).toEqual({ text: '+1.23%', direction: 'up' })
    expect(toDecString(1e-8)).toBe('0.00000001')
    expect(toDecString('1e-8')).toBe('0.00000001')
  })
  it('accepts public history frames and depth metadata but rejects unknown depth shapes', () => {
    expect(decodeFrame(JSON.stringify({ channel: 'market_btcusdt_trade_ticker', event_rep: 'rep', tick: null, data: [{ price: '102', vol: '0.006', ts: 1790360350000, side: 'BUY' }] }))).not.toBeNull()
    expect(decodeFrame(JSON.stringify({ channel: 'market_btcusdt_depth_step2', tick: { asks: [[102, 0.01]], buys: [], version: 1 } }))).not.toBeNull()
    expect(decodeFrame(JSON.stringify({ channel: 'market_btcusdt_depth_step2', tick: { side: 'unexpected', price: 1, volume: 1 } }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ channel: 'market_btcusdt_depth_step2', tick: { asks: [[-1, 0.01]], buys: [] } }))).toBeNull()
  })
  it('does not round large order ids through Number', () => {
    const id = '9223372036854775807'
    const result = validateData<{ orderList: { id: string }[] }>('order/list/new', { orderList: [{ id, side: 'BUY', type: 1, status: 1 }] })
    expect(result.orderList[0].id).toBe(id)
    expect(() => validateData('order/list/new', { orderList: [{ id: Number(id), side: 'BUY', type: 1, status: 1 }] })).toThrow()
  })
  it('rejects null frames, invalid financial values and malformed depth rows', () => {
    for (const input of ['null', '[]', '{"channel":"market_btcusdt_ticker","tick":{"close":"NaN"}}', '{"channel":"market_btcusdt_depth_step2","tick":{"asks":[["5"]]}}']) expect(decodeFrame(input)).toBeNull()
  })
  it('allows only web URLs for uploaded branding and coin references', () => {
    expect(safeWebUrl('javascript:alert(1)')).toBe('')
    expect(safeWebUrl('https://user:pass@example.com')).toBe('')
    expect(safeWebUrl('//example.com/a', true)).toBe('')
    expect(safeWebUrl('/\\example.com/a', true)).toBe('')
    expect(safeWebUrl('/logo.png', true)).toBe('/logo.png')
    expect(safeWebUrl('https://example.com')).toBe('https://example.com/')
  })
})
