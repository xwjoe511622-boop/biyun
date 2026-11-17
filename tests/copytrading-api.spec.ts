// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from '@/modules/api/http'
import {
  applyBecomeTrader,
  buildFollowQuery,
  fetchApplyStatus,
  fetchMyStatistics,
  fetchTrader,
  fetchTraderPositions,
  fetchTraders,
  followTrader,
  fractionPercent,
  unfollowTrader,
  validateFollow,
  type FollowSettings,
} from '@/modules/copytrading/copytrading.api'
import { isUnset, signedAmount, signedPercent, signedPercentFromFraction } from '@/modules/copytrading/format'

vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))
const mocked = vi.mocked(request)
beforeEach(() => vi.resetAllMocks())

const settings = (overrides: Partial<FollowSettings> = {}): FollowSettings => ({
  traderUid: '10025', mode: 'ratio', value: '0.5', deposit: '100', takeProfit: '', stopLoss: '', ...overrides,
})

describe('traderUser contract (@RequestParam -> query string)', () => {
  it('lists traders with query params and parses TraderUserVo', async () => {
    mocked.mockResolvedValue([{ uid: 10025, nickname: 'Ann', profitRatio: 0.1234, winRatio: 66.5, profitUSDT: 12.3, totalRatio: -0.05, totalUSDT: -4, orderCount: 9, followerCount: 3, currentFollowCount: 2, entryDay: 40, follow: -1 }])
    const rows = await fetchTraders(2, 12, 'winRatio')
    expect(mocked).toHaveBeenCalledWith('traderUser/list?page=2&pageSize=12&orderBy=winRatio', { body: {}, signal: undefined })
    expect(rows[0]).toMatchObject({ uid: '10025', profitRatio: '0.1234', winRatio: '66.5', follow: -1, entryDay: 40 })
  })

  it('returns null for a non-trader detail and validates uids', async () => {
    mocked.mockResolvedValue(null)
    await expect(fetchTrader('7')).resolves.toBeNull()
    expect(mocked).toHaveBeenCalledWith('traderUser/query?uid=7', { body: {}, signal: undefined })
    await expect(fetchTrader('7&uid=8')).rejects.toThrow()
  })

  it('reads positions from futures-web-api', async () => {
    mocked.mockResolvedValue({ positionList: [{ contractName: 'E-BTC-USDT', orderSide: 'BUY', positionVolume: 2, openAvgPrice: '60000', unRealizedAmount: -1.2 }] })
    const rows = await fetchTraderPositions('10025')
    expect(mocked).toHaveBeenCalledWith('trader/trader_position_list?traderUid=10025&status=1', { api: 'futures', body: {}, signal: undefined })
    expect(rows[0]).toMatchObject({ contractName: 'E-BTC-USDT', positionVolume: '2', unRealizedAmount: '-1.2' })
  })

  it('reads my statistics with GET', async () => {
    mocked.mockResolvedValue({ followTotalAmount: 10, profit: -1.5, rate: 2 })
    await expect(fetchMyStatistics()).resolves.toEqual({ followTotalAmount: '10', profit: '-1.5', rate: '2' })
    expect(mocked).toHaveBeenCalledWith('traderUser/myStatistics', { method: 'GET', signal: undefined })
  })
})

describe('follow settings', () => {
  it('mirrors the server validation', () => {
    expect(validateFollow(settings())).toEqual({})
    expect(validateFollow(settings({ value: '0' })).value).toBe('valueRequired')
    expect(validateFollow(settings({ deposit: '-1' })).deposit).toBe('depositRequired')
    expect(validateFollow(settings({ stopLoss: '100' })).stopLoss).toBe('stopLossRange')
    expect(validateFollow(settings({ stopLoss: '99.5' }))).toEqual({})
    expect(validateFollow(settings({ takeProfit: '1e3' })).takeProfit).toBe('takeProfitRange')
  })

  it('builds the create query with -1 for unset TP/SL', () => {
    expect(buildFollowQuery(settings())).toEqual({ traderUid: '10025', type: '0', rate: '0.5', deposit: '100', profitRatio: '-1', lossRatio: '-1' })
    expect(buildFollowQuery(settings({ mode: 'amount', value: '20', takeProfit: '30', stopLoss: '10' }))).toEqual({ traderUid: '10025', type: '1', amount: '20', deposit: '100', profitRatio: '30', lossRatio: '10' })
  })

  it('sends follow and unfollow and refuses invalid settings before any request', async () => {
    mocked.mockResolvedValue('0')
    await followTrader(settings())
    await unfollowTrader('10025')
    expect(mocked.mock.calls).toEqual([
      ['traderUser/create?traderUid=10025&type=0&deposit=100&profitRatio=-1&lossRatio=-1&rate=0.5', { body: {} }],
      ['traderUser/cancel?traderUid=10025', { body: {} }],
    ])
    mocked.mockClear()
    await expect(followTrader(settings({ deposit: '' }))).rejects.toThrow()
    expect(mocked).not.toHaveBeenCalled()
  })
})

describe('formatting', () => {
  it('renders ratios and amounts with sign and tone', () => {
    expect(fractionPercent('0.1234')).toBe('12.34')
    expect(signedPercentFromFraction('0.1234')).toEqual({ text: '+12.34%', tone: 'up' })
    expect(signedPercentFromFraction('-0.05')).toEqual({ text: '-5.00%', tone: 'down' })
    expect(signedPercentFromFraction('0')).toEqual({ text: '0.00%', tone: 'flat' })
    expect(signedPercentFromFraction('')).toEqual({ text: '--', tone: 'flat' })
    expect(signedAmount('-1234.5')).toEqual({ text: '-1,234.50', tone: 'down' })
    expect(isUnset('-1')).toBe(true)
    expect(isUnset('-1.0')).toBe(true)
    expect(isUnset('5')).toBe(false)
  })

  it('shows profitRatio / totalRatio as percent, not as a fraction (10-01: -10.67 displayed as -1067%)', () => {
    expect(signedPercent('-10.67')).toEqual({ text: '-10.67%', tone: 'down' })
    expect(signedPercent('-12.2657')).toEqual({ text: '-12.27%', tone: 'down' })
    expect(signedPercent('3.5')).toEqual({ text: '+3.50%', tone: 'up' })
    expect(signedPercent('0')).toEqual({ text: '0.00%', tone: 'flat' })
    expect(signedPercent('-0.001')).toEqual({ text: '0.00%', tone: 'flat' })
    expect(signedPercent('')).toEqual({ text: '--', tone: 'flat' })
  })
})

describe('trader application (applyBecomeTrader / currentStatus)', () => {
  it('submits the application with POST and an empty body', async () => {
    mocked.mockResolvedValue('ok')
    await applyBecomeTrader()
    expect(mocked).toHaveBeenCalledWith('traderUser/applyBecomeTrader', { body: {} })
  })

  it('reads the review state with GET and normalizes unknown values', async () => {
    mocked.mockResolvedValueOnce({ id: 3, uid: 10001, status: 0, ctime: 1 })
    await expect(fetchApplyStatus()).resolves.toEqual({ uid: '10001', status: 0 })
    expect(mocked).toHaveBeenCalledWith('traderUser/currentStatus', { method: 'GET', signal: undefined })
    mocked.mockResolvedValueOnce({ uid: 10001, status: '2' })
    await expect(fetchApplyStatus()).resolves.toEqual({ uid: '10001', status: 2 })
    mocked.mockResolvedValueOnce({ uid: 10001, status: 7 })
    await expect(fetchApplyStatus()).resolves.toEqual({ uid: '10001', status: -1 })
    mocked.mockResolvedValueOnce(null)
    await expect(fetchApplyStatus()).resolves.toEqual({ uid: '', status: -1 })
  })
})
