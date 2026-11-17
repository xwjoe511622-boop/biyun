import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { newSessionKey, session } from '@/core/session'
import { useAccountStore } from '@/stores/account'
import { fetchAccountBalance } from '@/modules/api/account.api'
import type { AccountBalanceData } from '@/modules/api/types'

vi.mock('@/modules/api/account.api', () => ({ fetchAccountBalance: vi.fn() }))
const balance: AccountBalanceData = { totalBalance: '1', allCoinMap: { BTC: { normal_balance: '1', lock_balance: '0' } } }
let pinia: Pinia

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => { disposePinia(pinia); session.clear() })

describe('account session boundaries', () => {
  it('coalesces simultaneous page and child loads without superseding the first committed read', async () => {
    session.setToken(newSessionKey())
    let finish: (data: AccountBalanceData) => void = () => { throw new Error('Missing account read') }
    vi.mocked(fetchAccountBalance).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const store = useAccountStore()
    const parent = store.load(); const child = store.load()
    expect(fetchAccountBalance).toHaveBeenCalledOnce()
    finish(balance); await Promise.all([parent, child])
    expect(store.data).toEqual(balance); expect(store.loading).toBe(false)
    vi.mocked(fetchAccountBalance).mockResolvedValueOnce(balance)
    await store.load(); expect(fetchAccountBalance).toHaveBeenCalledTimes(2)
  })
  it('queues one authoritative trailing read for concurrent refresh notifications during a read', async () => {
    session.setToken(newSessionKey())
    let finish: (data: AccountBalanceData) => void = () => { throw new Error('Missing old read') }
    vi.mocked(fetchAccountBalance).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const store = useAccountStore(); const old = store.load()
    const refresh = store.refresh(); const duplicate = store.refresh()
    vi.mocked(fetchAccountBalance).mockResolvedValueOnce({ totalBalance: '2', allCoinMap: {} })
    finish(balance); await Promise.all([old, refresh, duplicate])
    expect(fetchAccountBalance).toHaveBeenCalledTimes(2)
    expect(store.totalBalance).toBe('2'); expect(store.loading).toBe(false)
  })
  it('QA-167 invalidates known UID changes and late reads without clearing the first profile identification', async () => {
    session.setToken(newSessionKey())
    vi.mocked(fetchAccountBalance).mockResolvedValueOnce(balance)
    const store = useAccountStore()
    await store.load()
    session.setUser({ id: 10000011 })
    expect(store.totalBalance).toBe('1')
    let finish: (data: AccountBalanceData) => void = () => { throw new Error('Missing old-user read') }
    vi.mocked(fetchAccountBalance).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const oldRead = store.load()
    session.setUser({ id: 10000012 })
    expect(store.data).toBeNull()
    vi.mocked(fetchAccountBalance).mockResolvedValueOnce({ totalBalance: '2', allCoinMap: { BTC: { normal_balance: '2', lock_balance: '0' } } })
    await store.load()
    finish(balance); await oldRead
    expect(store.totalBalance).toBe('2')
    expect(store.allCoinMap?.BTC?.normal_balance).toBe('2')
  })
  it('immediately clears all balances on logout', async () => {
    session.setToken('synthetic-test-session')
    vi.mocked(fetchAccountBalance).mockResolvedValue(balance)
    const store = useAccountStore()
    await store.load()
    expect(store.totalBalance).toBe('1')
    session.clear()
    expect(store.data).toBeNull()
    expect(store.totalBalance).toBe('')
    expect(store.loadedAt).toBeNull()
  })

  it('ignores a previous user response that arrives after logout', async () => {
    session.setToken('synthetic-test-session')
    let resolve!: (data: AccountBalanceData) => void
    vi.mocked(fetchAccountBalance).mockReturnValue(new Promise(done => { resolve = done }))
    const store = useAccountStore()
    const request = store.load()
    session.clear()
    session.setToken('different-synthetic-session')
    resolve(balance)
    await request
    expect(store.data).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('does not retain a stale usable balance after refresh fails', async () => {
    session.setToken('synthetic-test-session')
    vi.mocked(fetchAccountBalance).mockResolvedValueOnce(balance).mockRejectedValueOnce(new Error('offline'))
    const store = useAccountStore()
    await store.load()
    await store.load()
    expect(store.data).toBeNull()
    expect(store.error).toBe('offline')
  })
})
