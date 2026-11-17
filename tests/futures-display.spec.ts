import { describe, expect, it } from 'vitest'
import { countdownText, fundingRateView, liquidationView, nextFundingTime, pnlView, rateView, roeView } from '@/modules/futures/math'
import { signedDisplay, signedPercent } from '@/modules/futures/signed'
import { normalizeAssets, normalizeMarketInfo, normalizeOrders, normalizeTransactions } from '@/modules/futures/types'

describe('futures PnL / ROE / liquidation display', () => {
  it('formats signed PnL with direction', () => {
    expect(pnlView('12.345678', 4)).toEqual({ text: '+12.3456', direction: 'up' })
    expect(pnlView('-1234.5', 2)).toEqual({ text: '-1,234.50', direction: 'down' })
    expect(pnlView('0', 2)).toEqual({ text: '0.00', direction: 'flat' })
    expect(pnlView('', 2)).toEqual({ text: '--', direction: 'flat' })
  })

  it('renders ROE and rates from server ratios', () => {
    expect(roeView('0.1234')).toEqual({ text: '+12.34%', direction: 'up' })
    expect(roeView('-0.5')).toEqual({ text: '-50.00%', direction: 'down' })
    expect(rateView('0.005')).toBe('0.50%')
    expect(fundingRateView('0.0001').text).toBe('+0.0100%')
    expect(fundingRateView('-0.000375').text).toBe('-0.0375%')
  })

  it('hides a non-positive liquidation price', () => {
    expect(liquidationView('0', 1)).toBe('--')
    expect(liquidationView('-3', 1)).toBe('--')
    expect(liquidationView('58123.456', 1)).toBe('58,123.4')
  })

  it('signed helpers never produce -0', () => {
    expect(signedDisplay('-0.00001', 2)).toBe('0.00')
    expect(signedPercent('-0.0000001', 2)).toBe('0.00%')
  })
})

describe('funding countdown', () => {
  const at = (iso: string): number => Date.parse(iso)

  it('finds the next 8h settlement in UTC+8', () => {
    // 2026-09-26 10:30 UTC+8 = 02:30Z; schedule 0/8/16 (+8) -> next 16:00 UTC+8 = 08:00Z.
    expect(nextFundingTime(at('2026-09-26T02:30:00Z'), 0, 8)).toBe(at('2026-09-26T08:00:00Z'))
    // 23:59 UTC+8 -> next midnight UTC+8.
    expect(nextFundingTime(at('2026-09-26T15:59:00Z'), 0, 8)).toBe(at('2026-09-26T16:00:00Z'))
    // Start hour later than now (start 4, every 8h): 01:00 UTC+8 -> 04:00 UTC+8.
    expect(nextFundingTime(at('2026-09-25T17:00:00Z'), 4, 8)).toBe(at('2026-09-25T20:00:00Z'))
    expect(nextFundingTime(Date.now(), null, 8)).toBeNull()
  })

  it('formats HH:MM:SS', () => {
    expect(countdownText(1_000 + 3_723_000, 1_000)).toBe('01:02:03')
    expect(countdownText(null, 0)).toBe('--:--:--')
  })
})

describe('futures response normalisation', () => {
  it('keeps money as decimal strings and drops rows without ids', () => {
    const assets = normalizeAssets({
      positionList: [
        { id: 7, contractId: 1, orderSide: 'BUY', positionType: 2, positionVolume: 10, canCloseVolume: 10, openAvgPrice: 65000.1, indexPrice: 65100, reducePrice: 0, holdAmount: 32.5, unRealizedAmount: -1.25, returnRate: -0.0384, leverageLevel: 20 },
        { contractId: 1 },
      ],
      accountList: [{ symbol: 'USDT', canUseAmount: '100.5', totalAmount: 133, unRealizedAmount: -1.25 }],
    })
    expect(assets.positions).toHaveLength(1)
    expect(assets.positions[0]).toMatchObject({ openAvgPrice: '65000.1', markPrice: '65100', unRealizedAmount: '-1.25', reducePrice: '0' })
    expect(assets.accounts[0].canUseAmount).toBe('100.5')
  })

  it('treats the controller zero fallback of public_market_info as missing', () => {
    expect(normalizeMarketInfo({ tagPrice: 0, indexPrice: 0, currentFundRate: 0, nextFundRate: 0 })).toEqual({ tagPrice: '', indexPrice: '', currentFundRate: '0', nextFundRate: '0' })
  })

  it('reads orderList / transList keys', () => {
    expect(normalizeOrders({ count: 3, orderList: [{ id: '12', side: 'BUY', open: 'OPEN', type: 1, price: 1, volume: 2, dealVolume: 0 }] }).rows[0].id).toBe('12')
    expect(normalizeTransactions({ transList: [{ id: 1, amount: '+12.5', type: '转入', ctime: '2026-09-26 10:00:00' }] }).rows[0].amount).toBe('12.5')
    expect(normalizeTransactions({ transList: [{ id: 2, amount: '-3', type: '转出' }] }).rows[0].amount).toBe('-3')
  })
})

describe('liquidation and margin-ratio display', () => {
  it('labels reducePrice <= 0 as "no liquidation" instead of an unexplained dash', async () => {
    const { liquidationInfo } = await import('@/modules/futures/math')
    // Live cross-margin long: reducePrice -4986201.13 with ~200k USDT equity.
    expect(liquidationInfo('-4986201.134833941', 2)).toEqual({ kind: 'none', text: '' })
    expect(liquidationInfo('0', 2).kind).toBe('none')
    expect(liquidationInfo('4830933.775312492', 2)).toEqual({ kind: 'price', text: '4,830,933.77' })
    expect(liquidationInfo('', 2)).toEqual({ kind: 'missing', text: '--' })
  })

  it('grades margin ratio against the maintenance rate', async () => {
    const { marginRisk } = await import('@/modules/futures/math')
    expect(marginRisk('29.133896859481464', '0.004')).toBe('safe')
    expect(marginRisk('0.015', '0.004')).toBe('warn')
    expect(marginRisk('0.008', '0.004')).toBe('danger')
    expect(marginRisk('', '0.004')).toBe('unknown')
    expect(marginRisk('1', '0')).toBe('unknown')
  })
})
