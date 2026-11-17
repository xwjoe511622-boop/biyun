import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_PREFIX } from '@/config/endpoints'
import { session } from '@/core/session'
import { transferFunds } from '@/modules/futures/api'
import { clampAvailable, validateAmount } from '@/modules/futures/math'

describe('transfer amount validation', () => {
  it('accepts a positive amount within precision and balance', () => {
    expect(validateAmount('10.5', '100', 4)).toEqual({ ok: true, error: null, amount: '10.5' })
    expect(validateAmount('100', '100', 4).ok).toBe(true)
    expect(validateAmount('0010.5000', '100', 4).amount).toBe('10.5')
  })

  it('rejects empty, malformed, zero, over-precise and over-balance amounts', () => {
    expect(validateAmount('', '100', 4).error).toBe('required')
    expect(validateAmount('abc', '100', 4).error).toBe('invalidNumber')
    expect(validateAmount('-1', '100', 4).error).toBe('invalidNumber')
    expect(validateAmount('0', '100', 4).error).toBe('mustBePositive')
    expect(validateAmount('1.23456', '100', 4)).toMatchObject({ error: 'precision', params: { dp: 4 } })
    expect(validateAmount('100.0001', '100', 4)).toMatchObject({ error: 'insufficient', params: { available: '100' } })
  })

  it('blocks submission while the balance is unknown', () => {
    expect(validateAmount('1', '', 4).error).toBe('unavailable')
  })

  it('clamps a negative futures available balance to zero', () => {
    expect(clampAvailable('-3.2')).toBe('0')
    expect(clampAvailable('12')).toBe('12')
    expect(clampAvailable('')).toBe('')
  })
})

describe('transfer request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    session.clear()
  })

  it('posts contract/co_transfer on the spot api with the legacy fields', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ code: '0', msg: 'ok', data: null }) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    session.setToken('jwt')
    await transferFunds('wallet_to_contract', '25.5', 'USDT')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API_PREFIX}contract/co_transfer`)
    expect(JSON.parse(String(init.body))).toEqual({ transferType: 'wallet_to_contract', amount: '25.5', coinSymbol: 'USDT' })
  })
})
