import { describe, expect, it } from 'vitest'
import { mergeClosedPositions, normalizeClosedPositions } from '@/modules/futures/position-history'

// Row shape of position/history_position_list, synthetic account B, 2026-09-30.
const ROW = {
  side: 'SELL', positionType: 1, tradeFee: -0.125215665, realizedAmount: 0, positionVolume: 10, leverageLevel: 20, openPrice: 83479.14,
  settleProfit: 0, mtime: 1790719146000, shareAmount: 0, closeProfit: 0.00406, volume: 10, contractId: 1, historyRealizedAmount: -0.121155665,
  ctime: 1790719124000, id: 1034, closePrice: 83475.08, capitalFee: 0, traderName: null,
}

describe('仓位历史', () => {
  it('normalizes closed position rows', () => {
    const { rows, count } = normalizeClosedPositions({ positionList: [ROW], count: 7 })
    expect(count).toBe(7)
    expect(rows[0]).toMatchObject({
      id: 1034, contractId: 1, side: 'SELL', positionType: 1, leverageLevel: 20, volume: '10', openPrice: '83479.14', closePrice: '83475.08',
      closeProfit: '0.00406', tradeFee: '-0.125215665', capitalFee: '0', realized: '-0.121155665', openedAt: 1790719124000, closedAt: 1790719146000,
    })
  })
  it('drops rows without ids and tolerates garbage', () => {
    expect(normalizeClosedPositions({ positionList: [{ side: 'BUY' }] }).rows).toEqual([])
    expect(normalizeClosedPositions(null)).toEqual({ rows: [], count: 0 })
  })
})

describe('仓位历史: all contracts', () => {
  const row = (id: number, contractId: number, closedAt: number) => ({ ...normalizeClosedPositions({ positionList: [{ ...ROW, id, contractId, mtime: closedAt }] }).rows[0] })
  it('merges contracts newest close first and pages the merged list', () => {
    const btc = { rows: [row(1, 1, 500), row(2, 1, 300), row(3, 1, 100)], count: 30 }
    const eth = { rows: [row(4, 2, 400), row(5, 2, 200)], count: 2 }
    expect(mergeClosedPositions([btc, eth], 1, 3).rows.map((entry) => entry.id)).toEqual([1, 4, 2])
    expect(mergeClosedPositions([btc, eth], 2, 3).rows.map((entry) => entry.id)).toEqual([5, 3])
    expect(mergeClosedPositions([btc, eth], 1, 3).count).toBe(32)
  })
})
