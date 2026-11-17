import { describe, expect, it } from 'vitest'
import { isFinalQuickOrderStatus, quickOrderSnapshot } from '@/modules/trade/quick-order-result'
import type { SpotV3Order } from '@/modules/spot/spot-api'
const snapshot = (over: Partial<SpotV3Order> = {}): SpotV3Order => ({ symbol: 'BTCUSDT', orderId: '9007199254740993', price: '0', origQty: '0.3', executedQty: '0.3', cummulativeQuoteQty: '0.3', status: 'NEW', type: 'MARKET', side: 'BUY', ...over })
const read = (over: Partial<SpotV3Order> = {}) => quickOrderSnapshot(snapshot(over), '9007199254740993', 'BTCUSDT')
describe('QA148 authoritative order results, exact decimal quantities', () => {
  it('does not infer terminal execution from filled totals, original quantity or spend', () => {
    expect(read()?.status).toBe('NEW')
    expect(isFinalQuickOrderStatus(read()?.status ?? '')).toBe(false)
    expect(read({ status: 'PARTIALLY_FILLED' })?.status).toBe('PARTIALLY_FILLED')
    expect(read({ status: 'FILLED' })?.status).toBe('FILLED')
  })
  it('preserves large and tiny decimal totals beyond doubles', () => {
    expect(read({ executedQty: '9007199254740993.12345678', cummulativeQuoteQty: '18014398509481986.24691356' })?.fill).toEqual({ baseQty: '9007199254740993.12345678', quoteQty: '18014398509481986.24691356', avgPrice: '2' })
    expect(read({ executedQty: '0.00000001', cummulativeQuoteQty: '0.00000003' })?.fill?.avgPrice).toBe('3')
  })
  it('rejects malformed, mismatched or contradictory snapshots', () => {
    for (const change of [{ orderId: 'other' }, { symbol: 'ETHUSDT' }, { status: 'future-code' }, { executedQty: '-1' }, { cummulativeQuoteQty: 'NaN' }, { status: 'FILLED', executedQty: '0', cummulativeQuoteQty: '0' }]) expect(read(change)).toBeNull()
    expect(read({ executedQty: '0', cummulativeQuoteQty: '0' })?.fill).toBeNull()
    expect(isFinalQuickOrderStatus('CANCELED')).toBe(true)
    expect(quickOrderSnapshot(null, '1', 'BTCUSDT')).toBeNull()
  })
})
