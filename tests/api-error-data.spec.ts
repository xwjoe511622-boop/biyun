/**
 * Classic futures refusals carry `data.reason` / `data.param` as a string OR a one-element list (web-api Feign
 * `Map<String, List<String>>`, 2026-10-01): both must reach the error tables as the same plain string.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { isApiError } from '@/core/errors'
import { normalizeErrorData } from '@/modules/api/error-data'
import { request } from '@/modules/api/http'

afterEach(() => { vi.unstubAllGlobals() })

describe('normalizeErrorData', () => {
  it('unwraps one-element lists of reason / param, keeps strings and other fields', () => {
    expect(normalizeErrorData({ reason: ['VOLUME_NOT_INTEGER'], param: ['volume'], minQty: '1' })).toEqual({ reason: 'VOLUME_NOT_INTEGER', param: 'volume', minQty: '1' })
    const plain = { reason: 'PRICE_TICK', param: 'price' }
    expect(normalizeErrorData(plain)).toBe(plain)
    expect(normalizeErrorData({ reason: ['A', 'B'] })).toEqual({ reason: 'A' })
    expect(normalizeErrorData({ reason: [] })).toEqual({ reason: [] })
    expect(normalizeErrorData(null)).toBeNull()
    expect(normalizeErrorData(['x'])).toEqual(['x'])
  })

  it('unwraps the per-id rows of data.results', () => {
    expect(normalizeErrorData({ results: [{ orderId: '1', code: '10019', reason: ['NOT_FOUND'] }, { orderId: '2', code: '0' }] }))
      .toEqual({ results: [{ orderId: '1', code: '10019', reason: 'NOT_FOUND' }, { orderId: '2', code: '0' }] })
  })

  it('the API client error carries the unwrapped data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ code: '10019', msg: 'bad', data: { reason: ['VOLUME_NOT_INTEGER'], param: ['volume'] } }) }) as unknown as Response))
    const error = await request('order/order_create', { api: 'futures', body: {} }).catch((e: unknown) => e)
    expect(isApiError(error)).toBe(true)
    expect((error as { data: unknown }).data).toEqual({ reason: 'VOLUME_NOT_INTEGER', param: 'volume' })
  })
})
