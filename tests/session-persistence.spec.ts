import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_SESSION_STORAGE_KEY, SESSION_STORAGE_KEY, newSessionKey, readCsrfCookie, readLegacyToken, readStoredToken, session } from '@/core/session'
import { startSessionKeepAlive } from '@/core/session-keepalive'
import { rawRequest, requestWithRetry } from '@/modules/api/http'

const TOKEN_A = 'synthetic.token-A'
const TOKEN_B = 'synthetic.token-B'

function envelope(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function pathOf(call: unknown[]): string {
  return String(call[0])
}

beforeEach(() => {
  session.clear()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  session.clear()
})

describe('session persistence', () => {
  it('persists only the session key (v2), so a reload or a new tab stays signed in', () => {
    session.setToken(TOKEN_A)
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? 'null')).toEqual({ v: 2, key: TOKEN_A })
    expect(readStoredToken()).toBe(TOKEN_A)
  })

  it('creates random, non-secret session keys', () => {
    const a = newSessionKey()
    expect(a).toMatch(/^c[0-9a-f]{32}$/)
    expect(newSessionKey()).not.toBe(a)
  })

  it('reads the readable CSRF cookie only when well-formed', () => {
    expect(readCsrfCookie('a=1; __Host-lb_csrf=0123456789abcdef0123456789abcdef; b=2')).toBe('0123456789abcdef0123456789abcdef')
    expect(readCsrfCookie('__Host-lb_csrf=short')).toBe('')
    expect(readCsrfCookie('lb_csrf=0123456789abcdef0123456789abcdef')).toBe('')
    expect(readCsrfCookie('')).toBe('')
  })

  it('a pre-10-17 stored token is only a one-time upgrade header, then removed for good', () => {
    localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify({ v: 1, token: TOKEN_B }))
    expect(readLegacyToken()).toBe(TOKEN_B)
    session.setToken(TOKEN_A)
    expect(session.legacyToken()).toBeNull()
    expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull()
    session.finishLegacyUpgrade()
    session.clear()
    expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('removes the stored token on logout / clear and on an account switch overwrites it', () => {
    session.setToken(TOKEN_A)
    session.setToken(TOKEN_B)
    expect(readStoredToken()).toBe(TOKEN_B)
    session.clear()
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('drops a malformed or foreign stored entry instead of trusting it', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ v: 2, key: 'has spaces "quoted"' }))
    expect(readStoredToken()).toBeNull()
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    localStorage.setItem(SESSION_STORAGE_KEY, 'not json')
    expect(readStoredToken()).toBeNull()
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ v: 99, key: TOKEN_A }))
    expect(readStoredToken()).toBeNull()
  })

  it('follows another tab that logged out or switched account', () => {
    session.setToken(TOKEN_A)
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ v: 2, key: TOKEN_B }))
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY }))
    expect(session.getToken()).toBe(TOKEN_B)
    localStorage.removeItem(SESSION_STORAGE_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_STORAGE_KEY }))
    expect(session.getToken()).toBeNull()
  })
})

describe('session rejection handling', () => {
  it('clears the session only after a confirming user_info probe also rejects the token', async () => {
    session.setToken(TOKEN_A)
    const fetchMock = vi.fn(async () => envelope({ code: '10002', msg: 'not logged in', data: null }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(rawRequest('order/list/new', { body: {} })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(fetchMock.mock.calls.map(pathOf)).toEqual(['/fe-ex-api/order/list/new', '/fe-ex-api/common/user_info'])
    expect(session.getToken()).toBeNull()
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })

  it('keeps the session when the probe accepts the token (a stray 10002)', async () => {
    session.setToken(TOKEN_A)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(envelope({ code: '10002', msg: 'not logged in', data: null }))
      .mockResolvedValueOnce(envelope({ code: '0', msg: 'ok', data: {} })))
    await expect(rawRequest('some/legacy_endpoint', { body: {} })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(session.getToken()).toBe(TOKEN_A)
  })

  it.each([
    ['a 502 probe', () => envelope({ code: '502', msg: 'Bad Gateway' }, 502)],
    ['an offline probe', () => { throw new TypeError('Failed to fetch') }],
  ])('keeps the session when the rejection cannot be confirmed (%s)', async (_label, probe) => {
    session.setToken(TOKEN_A)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(envelope({ code: '110009', msg: 'expired', data: null }))
      .mockImplementationOnce(async () => probe()))
    await expect(rawRequest('order/list/new', { body: {} })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(session.getToken()).toBe(TOKEN_A)
  })

  it.each([
    ['HTTP 502', async () => envelope({ code: '502', msg: 'Bad Gateway' }, 502), 'http'],
    ['HTTP 504', async () => envelope({}, 504), 'http'],
    ['network error', async () => { throw new TypeError('Failed to fetch') }, 'network'],
  ])('never clears the session on a transient %s', async (_label, respond, kind) => {
    session.setToken(TOKEN_A)
    const fetchMock = vi.fn(respond)
    vi.stubGlobal('fetch', fetchMock)
    await expect(rawRequest('finance/account_balance', { body: {} })).rejects.toMatchObject({ kind })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(session.getToken()).toBe(TOKEN_A)
    expect(readStoredToken()).toBe(TOKEN_A)
  })

  it('never clears the session on a timeout', async () => {
    vi.useFakeTimers()
    session.setToken(TOKEN_A)
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const pending = rawRequest('finance/account_balance', { body: {}, timeoutMs: 100 })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(101)
    await assertion
    expect(session.getToken()).toBe(TOKEN_A)
  })

  it('never signs out of spot for a futures rejection, and sends no probe', async () => {
    session.setToken(TOKEN_A)
    const fetchMock = vi.fn(async () => envelope({ code: '10002', msg: 'not logged in', data: null }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(rawRequest('position/get_assets_list', { api: 'futures', body: {} })).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(session.getToken()).toBe(TOKEN_A)
  })

  it('records server contact on an authenticated success (keep-alive input)', async () => {
    session.setToken(TOKEN_A)
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ code: '0', msg: 'ok', data: {} })))
    await rawRequest('message/unread_count', { body: {} })
    expect(session.lastServerContact()).toBeGreaterThan(0)
  })
})

describe('bounded retry for public reads', () => {
  it('retries transport failures with backoff and then succeeds', async () => {
    const retries: number[] = []
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(envelope({}, 502))
      .mockResolvedValueOnce(envelope({ code: '0', msg: 'ok', data: { value: 1 } })))
    const data = await requestWithRetry<{ value: number }>('common/synthetic_public', { body: {}, anonymous: true }, {
      sleep: async () => undefined,
      onRetry: (retry) => retries.push(retry),
    })
    expect(data.value).toBe(1)
    expect(retries).toEqual([1, 2])
  })

  it('does not retry business errors and gives up after the bounded attempts', async () => {
    const business = vi.fn(async () => envelope({ code: '10034', msg: 'no', data: null }))
    vi.stubGlobal('fetch', business)
    await expect(requestWithRetry('common/public_info_v4', { body: {} }, { sleep: async () => undefined })).rejects.toMatchObject({ kind: 'api' })
    expect(business).toHaveBeenCalledTimes(1)

    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', offline)
    await expect(requestWithRetry('common/public_info_v4', { body: {} }, { attempts: 3, sleep: async () => undefined })).rejects.toMatchObject({ kind: 'network' })
    expect(offline).toHaveBeenCalledTimes(3)
  })
})

describe('session keep-alive', () => {
  function setup(options: { visible?: () => boolean } = {}): { touch: ReturnType<typeof vi.fn>; now: { value: number }; keepAlive: ReturnType<typeof startSessionKeepAlive> } {
    const now = { value: 1_000_000_000 }
    const touch = vi.fn(async () => undefined)
    const keepAlive = startSessionKeepAlive({
      touch,
      intervalMs: 10 * 60_000,
      idleMs: 15 * 60_000,
      now: () => now.value,
      isVisible: options.visible ?? (() => true),
    })
    return { touch, now, keepAlive }
  }

  it('touches at most once per interval while the user is active and the tab visible', async () => {
    session.setToken(TOKEN_A)
    const { touch, now, keepAlive } = setup()
    await keepAlive.check()
    expect(touch).toHaveBeenCalledTimes(1)
    now.value += 5 * 60_000
    keepAlive.markActive()
    await keepAlive.check()
    expect(touch).toHaveBeenCalledTimes(1)
    now.value += 5 * 60_000
    keepAlive.markActive()
    await keepAlive.check()
    expect(touch).toHaveBeenCalledTimes(2)
    keepAlive.stop()
  })

  it('does not touch while hidden, idle, signed out, or right after a real request', async () => {
    const hidden = setup({ visible: () => false })
    session.setToken(TOKEN_A)
    await hidden.keepAlive.check()
    expect(hidden.touch).not.toHaveBeenCalled()
    hidden.keepAlive.stop()

    const idle = setup()
    idle.now.value += 16 * 60_000
    await idle.keepAlive.check()
    expect(idle.touch).not.toHaveBeenCalled()
    idle.keepAlive.stop()

    const recent = setup()
    session.noteServerContact(TOKEN_A, recent.now.value - 60_000)
    await recent.keepAlive.check()
    expect(recent.touch).not.toHaveBeenCalled()
    recent.keepAlive.stop()

    session.clear()
    const signedOut = setup()
    await signedOut.keepAlive.check()
    expect(signedOut.touch).not.toHaveBeenCalled()
    signedOut.keepAlive.stop()
  })

  it('ignores a failed touch and keeps the session', async () => {
    session.setToken(TOKEN_A)
    const keepAlive = startSessionKeepAlive({ touch: async () => { throw new Error('502') }, isVisible: () => true })
    await keepAlive.check()
    expect(session.getToken()).toBe(TOKEN_A)
    keepAlive.stop()
  })
})
