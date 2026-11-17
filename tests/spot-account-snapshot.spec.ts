import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountBalanceData } from '@/modules/api/types'
import { request } from '@/modules/api/http'
import { fetchAccountBalance } from '@/modules/api/account.api'
import { fetchSpotAccount } from '@/modules/spot/spot-api'
import { exactTradingSnapshot } from '@/modules/spot/account-snapshot'

vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))
vi.mock('@/modules/spot/spot-api', () => ({ fetchSpotAccount: vi.fn() }))
afterEach(() => { vi.resetAllMocks() })

function snapshot(free = '0.1', locked = '0.2', extra = '0.3', restricted = false): AccountBalanceData {
  return { totalBalance: '0.00001', totalBalanceSymbol: 'BTC', platformCoin: 'PLATFORM', allCoinMap: {
    usdt: { coinName: 'USDT', normal_balance: '0.00', lock_balance: '0.00', total_balance: '0.01',
      normalBalanceExact: free, lockBalanceExact: locked, nonTradingBalance: extra,
      overchargeRestricted: restricted, overcharge_balance: restricted ? '0' : '',
      nc_lock_balance: '0.1', lock_position_balance: '0.2', btcValuatin: '0.00001', depositOpen: 1, withdrawOpen: 0 },
  } }
}

describe('one authoritative response for all spot valuation buckets', () => {
  it('uses a single classic read and does not stitch another v3 snapshot to projected metadata', async () => {
    vi.mocked(request).mockResolvedValueOnce(snapshot('0.0049', '0.0051', '0'))
    const value = await fetchAccountBalance()
    expect(value.allCoinMap?.usdt).toMatchObject({ normal_balance: '0.0049', lock_balance: '0.0051', total_balance: '0.01' })
    expect(request).toHaveBeenCalledOnce(); expect(fetchSpotAccount).not.toHaveBeenCalled()
  })
  it('keeps exact 207/221 and metadata without subtracting independently rounded fields', () => {
    const before = snapshot(); const value = exactTradingSnapshot(before)
    expect(value.allCoinMap?.usdt).toMatchObject({ normal_balance: '0.1', lock_balance: '0.2', total_balance: '0.6',
      nonTradingBalance: '0.3', nc_lock_balance: '0.1', lock_position_balance: '0.2', depositOpen: 1, withdrawOpen: 0, btcValuatin: '' })
    expect(value.platformCoin).toBe('PLATFORM'); expect(value.totalBalance).toBe('')
    expect(before.allCoinMap?.usdt?.total_balance).toBe('0.01')
  })
  it('does not transiently double-count a 207-to-201 movement', () => {
    const before = exactTradingSnapshot(snapshot('0', '0', '1'))
    const after = exactTradingSnapshot(snapshot('1', '0', '0'))
    expect(before.allCoinMap?.usdt?.total_balance).toBe('1')
    expect(after.allCoinMap?.usdt?.total_balance).toBe('1')
  })
  it('keeps true zero and a complete empty map distinct from a failed read', () => {
    expect(exactTradingSnapshot(snapshot('0', '0', '0')).allCoinMap?.usdt?.total_balance).toBe('0')
    expect(exactTradingSnapshot({ allCoinMap: {} }).allCoinMap).toEqual({})
    expect(() => exactTradingSnapshot({})).toThrow('snapshot is unavailable')
  })
  it('accepts canonical names including COIN123 and the full 255-character backend boundary', () => {
    for (const name of ['COIN123', 'A'.repeat(255)]) {
      const x = snapshot(); const entry = x.allCoinMap!.usdt!; entry.coinName = name
      x.allCoinMap = { [name]: entry }
      expect(exactTradingSnapshot(x).allCoinMap?.[name]?.total_balance).toBe('0.6')
    }
    const name = 'A'.repeat(256)
    const x = snapshot(); const entry = x.allCoinMap!.usdt!; entry.coinName = name; x.allCoinMap = { [name]: entry }
    expect(() => exactTradingSnapshot(x)).toThrow('snapshot is unavailable')
  })
  it('keeps restricted overcharge unavailable to standard orders even when the legacy amount was zero', () => {
    const value = exactTradingSnapshot(snapshot('12.1234567890123456', '0.2', '0.3', true))
    expect(value.allCoinMap?.usdt).toMatchObject({ normal_balance: '0', overcharge_balance: '12.1234567890123456', total_balance: '12.6234567890123456' })
  })
  it('adds huge values and smallest ledger fractions without binary or display rounding', () => {
    const value = exactTradingSnapshot(snapshot('9999999999999999.9999999999999999', '0.0000000000000001', '0.3'))
    expect(value.allCoinMap?.usdt?.total_balance).toBe('10000000000000000.3')
  })
  it.each(['', '-1', 'NaN', '1e3', '1'.repeat(65)])('refuses malformed exact monetary fields: %s', value => {
    expect(() => exactTradingSnapshot(snapshot(value))).toThrow('snapshot is unavailable')
  })
  it('refuses a malformed member instead of silently accepting part of the account', () => {
    const x = snapshot(); x.allCoinMap!.BTC = { normalBalanceExact: '1', lockBalanceExact: 'bad', nonTradingBalance: '0', overchargeRestricted: false }
    expect(() => exactTradingSnapshot(x)).toThrow('snapshot is unavailable')
  })
  it('does not guess an absent precise bucket, numeric amount or unknown allocation rule', () => {
    for (const change of [() => { const x = snapshot(); delete x.allCoinMap!.usdt!.nonTradingBalance; return x },
      () => { const x = snapshot(); delete x.allCoinMap!.usdt!.normalBalanceExact; return x },
      () => { const x = snapshot(); delete x.allCoinMap!.usdt!.overchargeRestricted; return x },
      () => { const x = snapshot(); x.allCoinMap!.USDT = x.allCoinMap!.usdt!; return x },
      () => ({ allCoinMap: { USDT: { ...snapshot().allCoinMap!.usdt, normalBalanceExact: 1 } } })]) {
      expect(() => exactTradingSnapshot(change() as AccountBalanceData)).toThrow('snapshot is unavailable')
    }
  })
  it('does not return legacy spendable balances on a failed authoritative read', async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error('Authoritative account unavailable'))
    await expect(fetchAccountBalance()).rejects.toThrow('Authoritative account unavailable')
    expect(fetchSpotAccount).not.toHaveBeenCalled()
  })
})
