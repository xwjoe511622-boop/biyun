import { afterEach, describe, expect, it, vi } from 'vitest'
import { session } from '@/core/session'
import { fetchPublicInfo } from '@/modules/api/public.api'

afterEach(() => { session.clear(); vi.unstubAllGlobals() })

describe('public info request', () => {
  it('never forwards the session token and never signs the user out', async () => {
    session.setToken('stale-token')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: '0', data: { msg: {}, market: { market: {}, coinList: {} } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchPublicInfo()
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.has('exchange-token')).toBe(false)
    expect(session.getToken()).toBe('stale-token')
  })
})
