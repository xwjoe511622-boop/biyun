import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { buildHeaders, rawRequest, setLanguageProvider } from '@/modules/api/http'
import { API_PREFIX } from '@/config/endpoints'

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

describe('http adapter', () => {
  beforeEach(() => {
    session.clear()
    setLanguageProvider(() => 'en_US')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    session.clear()
  })

  it('unwraps a successful envelope and sends the pc headers', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: { totalBalance: '1.5', allCoinMap: {} } }))
    vi.stubGlobal('fetch', fetchMock)

    const data = await rawRequest<{ totalBalance: string }>('finance/account_balance', { body: {} })

    expect(data.data.totalBalance).toBe('1.5')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API_PREFIX}finance/account_balance`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['exchange-client']).toBe('pc')
    expect(headers['exchange-language']).toBe('en_US')
    expect(headers['exchange-token']).toBeUndefined()
    expect(init.body).toBe(JSON.stringify({}))
  })

  it('never puts the session key on the wire; the HttpOnly cookie authenticates (10-17)', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    session.setToken('csynthetic-session-key')
    // jsdom refuses __Host- cookies on http://, so the readable CSRF cookie is provided through the getter
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '__Host-lb_csrf=0123456789abcdef0123456789abcdef' })

    await rawRequest('common/user_info', { body: {} })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['exchange-token']).toBeUndefined()
    expect(Object.values(headers)).not.toContain('csynthetic-session-key')
    expect(headers['X-LB-Session']).toBe('cookie')
    expect(headers['X-CSRF-Token']).toBe('0123456789abcdef0123456789abcdef')
    expect(init.credentials).toBe('same-origin')
    Reflect.deleteProperty(document, 'cookie')
  })

  it('drops an explicit exchange-token header unless it is the pre-10-17 token being upgraded', () => {
    session.setToken('csynthetic-session-key')
    expect(buildHeaders({ headers: { 'exchange-token': 'csynthetic-session-key' } })['exchange-token']).toBeUndefined()
  })

  it('buildHeaders never reads localStorage', () => {
    const headers = buildHeaders()
    expect(headers['exchange-token']).toBeUndefined()
  })

  it('anonymous onboarding strips every authentication header and preserves the existing session on rejection', async () => {
    session.setToken('signed-in-synthetic')
    const headers = buildHeaders({ anonymous: true, headers: { 'Exchange-Token': 'override', Authorization: 'Bearer override' } })
    expect(Object.keys(headers).some(key => /^(exchange-token|authorization)$/i.test(key))).toBe(false)
    expect(headers['X-LB-Anonymous']).toBe('1')
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ code: '110009', msg: 'invalid challenge', data: null })))
    await expect(rawRequest('user/reset_password_step2', { anonymous: true, body: {} })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(session.getToken()).toBe('signed-in-synthetic')
  })

  it('throws the real business code and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ code: '10034', msg: '可用余额不足', data: null })))

    await expect(rawRequest('order/create', { body: { symbol: 'btcusdt' } })).rejects.toMatchObject({
      kind: 'api',
      code: '10034',
      message: '可用余额不足',
    })
  })

  it('clears the session when the token is rejected', async () => {
    session.setToken('stale-token')
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ code: '110009', msg: 'token invalid', data: null })))

    await expect(rawRequest('order/list/new', { body: {} })).rejects.toBeInstanceOf(ApiError)
    expect(session.getToken()).toBeNull()
  })

  it('surfaces HTTP failures instead of pretending success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ code: '500', msg: 'server exploded' }, 500)))

    await expect(rawRequest('order/create', { body: {} })).rejects.toMatchObject({
      kind: 'http',
      status: 500,
      message: 'server exploded',
    })
  })

  it.each([200, 401])('does not clear a new session on a stale unauthorized response (HTTP %s)', async (status) => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    session.setToken('synthetic-A')
    const pending = rawRequest('common/user_info', { body: {} })
    session.setToken('synthetic-B')
    resolve(mockResponse({ code: '110009', msg: 'expired', data: null }, status))
    await expect(pending).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(session.getToken()).toBe('synthetic-B')
  })

  it('keeps the timeout active while the response body is downloading', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => ({
      ...mockResponse({}),
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })))
    const pending = rawRequest('common/user_info', { timeoutMs: 100 })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(101)
    await assertion
  })

  it('reports a network failure with the underlying reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    await expect(rawRequest('common/public_info_v4', { body: {} })).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('reports a non-JSON response as a parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html>gateway</html>',
      }) as unknown as Response),
    )

    await expect(rawRequest('common/public_info_v4', { body: {} })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('aborts after the timeout and reports it', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      ),
    )

    const pending = rawRequest('common/public_info_v4', { body: {}, timeoutMs: 1_000 })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
  })

  it('wraps a signed body in the security envelope with Sign/Timestamp headers', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: { token: 't', type: '2' } }))
    vi.stubGlobal('fetch', fetchMock)

    await rawRequest('user/login_in', {
      body: { mobileNumber: 'user@example.com', loginPword: 'secret' },
      signed: true,
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(typeof headers.Sign).toBe('string')
    expect(headers.Sign.length).toBeGreaterThan(0)
    expect(Number.isInteger(Number(headers.Timestamp))).toBe(true)
    const body = JSON.parse(String(init.body)) as { data: string; key: string }
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.key.length).toBeGreaterThan(0)
    // Invariants the server relies on: the envelopes are base64, not plain JSON.
    expect(body.data).not.toContain('loginPword')
    expect(body.key).not.toContain('secret')
  })

  describe('wallet namespace', () => {
    it('throws a localized "not configured" error before any fetch when the gateway is unset', async () => {
      const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: {} }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(rawRequest('account/withdraw', { api: 'wallet', body: {} }))
        .rejects.toThrow(/钱包网关未配置/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects an absolute or protocol-relative prefix without fetching', async () => {
      const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: {} }))
      vi.stubGlobal('fetch', fetchMock)

      for (const bad of ['https://exchange.filoxex.com/web/', '//evil.example/', '/wallet-api/../secret', '/wallet-api/?x=1']) {
        vi.stubEnv('VITE_WALLET_API_BASE', bad)
        await expect(rawRequest('account/withdraw', { api: 'wallet', body: {} }))
          .rejects.toThrow(/钱包网关地址无效/)
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('routes a configured wallet request to the same-origin prefix', async () => {
      vi.stubEnv('VITE_WALLET_API_BASE', '/wallet-api/')
      const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: {} }))
      vi.stubGlobal('fetch', fetchMock)

      await rawRequest('account/withdrawList', { api: 'wallet', body: { page: 1, pageSize: 10 } })

      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/wallet-api/account/withdrawList')
    })

    it('uses signedPath for the signature instead of the client-visible path', async () => {
      const fetchMock = vi.fn(async () => mockResponse({ code: '0', msg: 'suc', data: {} }))
      vi.stubGlobal('fetch', fetchMock)

      await rawRequest('common/user_info', { body: { a: 1 }, signed: true, signedPath: '/account/withdraw' })
      const firstSign = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .headers as unknown as Record<string, string>

      await rawRequest('common/user_info', { body: { a: 1 }, signed: true })
      const secondSign = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
        .headers as unknown as Record<string, string>

      expect(firstSign.Sign).not.toBe(secondSign.Sign)
    })
  })
})

describe('empty server messages', () => {
  it('maps known codes to readable text and keeps the code for unknown ones', async () => {
    const { emptyMessageFallback } = await import('@/modules/api/empty-message')
    expect(emptyMessageFallback('otc', '2029', 'zh_CN')).toBe('订单不存在或无权查看')
    expect(emptyMessageFallback('otc', '2029', 'en_US')).toBe('Order not found or not accessible')
    expect(emptyMessageFallback(undefined, '10044', 'zh_CN')).toBe('文章不存在')
    expect(emptyMessageFallback('futures', '10044', 'zh_CN')).toBe('接口返回错误码 10044')
    expect(emptyMessageFallback('wallet', '777', 'en_US')).toBe('Request failed (code 777)')
  })
})
