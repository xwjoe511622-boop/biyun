import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import { useSessionStore } from '@/stores/session'
import * as auth from '@/modules/api/auth.api'

vi.mock('@/modules/api/auth.api', () => ({ fetchUserInfo: vi.fn(), logout: vi.fn(), loginStepOne: vi.fn(), loginStepTwo: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let pinia: Pinia
beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => { disposePinia(pinia); session.clear() })

describe('session request isolation', () => {
  it('does not restore a cancelled login challenge from a late response', async () => {
    const pending = deferred<Awaited<ReturnType<typeof auth.loginStepOne>>>()
    vi.mocked(auth.loginStepOne).mockReturnValue(pending.promise)
    const store = useSessionStore()
    const result = store.requestLogin({ mobileNumber: 'synthetic@example.invalid', loginPword: 'Synthetic!123' })
    store.cancelChallenge()
    pending.resolve({ session: 'cookie', type: '1' })
    expect(await result).toBeNull()
    expect(store.pending).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('ignores a confirmation that finishes after cancellation', async () => {
    const pending = deferred<Awaited<ReturnType<typeof auth.loginStepTwo>>>()
    vi.mocked(auth.loginStepTwo).mockReturnValue(pending.promise)
    session.setPendingLogin('', '1')
    const store = useSessionStore()
    const result = store.confirmLogin('123456', '1')
    store.cancelChallenge()
    pending.resolve({})
    expect(await result).toBe(false)
    expect(store.isAuthenticated).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('does not replace a new authenticated account with an old confirmation', async () => {
    const pending = deferred<Awaited<ReturnType<typeof auth.loginStepTwo>>>()
    vi.mocked(auth.loginStepTwo).mockReturnValue(pending.promise)
    session.setPendingLogin('', '1')
    const store = useSessionStore()
    const result = store.confirmLogin('123456', '1')
    session.setToken('new-synthetic-account')
    pending.resolve({})
    expect(await result).toBe(false)
    expect(store.token).toBe('new-synthetic-account')
    expect(session.getPendingLogin().token).toBeNull()
    expect(store.pending).toBe(false)
  })
  it('clears the old profile immediately when the token changes', () => {
    const store = useSessionStore()
    session.setToken('synthetic-A')
    session.setUser({ id: 1 })
    session.setToken('synthetic-B')
    expect(store.user).toBeNull()
  })

  it('ignores a profile arriving after an account switch', async () => {
    const pending = deferred<Awaited<ReturnType<typeof auth.fetchUserInfo>>>()
    vi.mocked(auth.fetchUserInfo).mockReturnValue(pending.promise)
    session.setToken('synthetic-A')
    const store = useSessionStore()
    const load = store.loadUserInfo()
    session.setToken('synthetic-B')
    session.setUser({ id: 2 })
    pending.resolve({ id: 1 })
    await load
    expect(store.user?.id).toBe(2)
    expect(session.getUser()?.id).toBe(2)
  })

  it('ignores stale profile errors after logout', async () => {
    const pending = deferred<Awaited<ReturnType<typeof auth.fetchUserInfo>>>()
    vi.mocked(auth.fetchUserInfo).mockReturnValue(pending.promise)
    session.setToken('synthetic-A')
    const store = useSessionStore()
    const load = store.loadUserInfo()
    session.clear()
    pending.reject(new Error('old account request'))
    await load
    expect(store.error).toBeNull()
    expect(store.user).toBeNull()
  })

  it('preserves the most recent profile response for the same account', async () => {
    const first = deferred<Awaited<ReturnType<typeof auth.fetchUserInfo>>>()
    vi.mocked(auth.fetchUserInfo).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ id: 1, nickName: 'updated' })
    session.setToken('synthetic-A')
    const store = useSessionStore()
    const oldLoad = store.loadUserInfo()
    await store.loadUserInfo()
    first.resolve({ id: 1, nickName: 'old' })
    await oldLoad
    expect(store.user?.nickName).toBe('updated')
  })

  it('does not clear a replacement session when logout finishes late', async () => {
    const pending = deferred<void>()
    vi.mocked(auth.logout).mockReturnValue(pending.promise)
    session.setToken('synthetic-A')
    const store = useSessionStore()
    const logout = store.logout()
    session.setToken('synthetic-B')
    session.setUser({ id: 2 })
    pending.resolve()
    await logout
    expect(store.token).toBe('synthetic-B')
    expect(store.user?.id).toBe(2)
  })
})
