import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { INITIAL_OPEN_STATE, isNotOpenedError, openAccountReducer, type OpenAccountState } from '@/modules/futures/open-account'
import { ApiError } from '@/core/errors'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'

describe('open-account reducer (futures account by default, silent creation)', () => {
  it('walks check -> unopened -> autoOpen -> opened, never needing an agreement', () => {
    let state: OpenAccountState = { ...INITIAL_OPEN_STATE }
    state = openAccountReducer(state, { type: 'check' })
    expect(state.status).toBe('checking')
    state = openAccountReducer(state, { type: 'notOpened' })
    expect(state.status).toBe('unopened')
    state = openAccountReducer(state, { type: 'autoOpen' })
    expect(state.status).toBe('opening')
    // A late "not opened" answer (or config 0) from an in-flight request must not undo the creation.
    expect(openAccountReducer(state, { type: 'notOpened' }).status).toBe('opening')
    expect(openAccountReducer(state, { type: 'config', openContract: false }).status).toBe('opening')
    state = openAccountReducer(state, { type: 'opened' })
    expect(state).toEqual({ status: 'opened', error: null, initFailed: false })
    expect(openAccountReducer(state, { type: 'autoOpen' })).toBe(state)
  })

  it('a failed silent creation is a plain error (initFailed), not an onboarding state', () => {
    const state = openAccountReducer({ status: 'opening', error: null, initFailed: false }, { type: 'openFailed', message: 'boom' })
    expect(state).toEqual({ status: 'error', error: 'boom', initFailed: true })
  })

  it('config openContract decides the state and sign-out resets', () => {
    expect(openAccountReducer(INITIAL_OPEN_STATE, { type: 'config', openContract: true }).status).toBe('opened')
    expect(openAccountReducer(INITIAL_OPEN_STATE, { type: 'config', openContract: false }).status).toBe('unopened')
    expect(openAccountReducer({ status: 'opened', error: null, initFailed: false }, { type: 'signedOut' })).toEqual(INITIAL_OPEN_STATE)
  })
})

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

describe('futures account store onboarding', () => {
  beforeEach(() => {
    session.clear()
    setActivePinia(createPinia())
    const market = useFuturesMarketStore()
    const info = normalizePublicInfo({ contractList: [{ id: 1, contractName: 'E-BTC-USDT', multiplier: '0.001', marginCoin: 'USDT', base: 'BTC', quote: 'USDT', minLever: 1, maxLever: 100, coinResultVo: { fundsInStatus: 1, fundsOutStatus: 1 } }] })
    market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
    market.selectedName = 'E-BTC-USDT'
    vi.spyOn(market, 'refreshPublicInfo').mockResolvedValue()
    session.setToken('jwt')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    session.clear()
  })

  it('on 100501 creates the futures account silently through create_co_id and loads it', async () => {
    let opened = false
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      calls.push(path)
      if (path === 'user/get_user_config') {
        return respond(opened ? { code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } } : { code: '100501', msg: '用户未开启合约交易' })
      }
      if (path === 'user/create_co_id') {
        opened = true
        return respond({ code: '0', data: null })
      }
      if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '50' }] } })
      return respond({ code: '0', data: {} })
    }))

    const account = useFuturesAccountStore()
    await account.refresh()
    expect(calls.filter((path) => path === 'user/create_co_id')).toHaveLength(1)
    expect(account.open.status).toBe('opened')
    // The spot session survives the futures rejection.
    expect(session.getToken()).toBe('jwt')
    expect(account.leverage).toBe(20)
    expect(account.available).toBe('50')
  })

  it('also creates it silently when get_user_config says openContract=0', async () => {
    let opened = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: opened ? 1 : 0, nowLevel: 20, marginModel: 1 } })
      if (path === 'user/create_co_id') { opened = true; return respond({ code: '0', data: null }) }
      return respond({ code: '0', data: { positionList: [], accountList: [] } })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(account.open.status).toBe('opened')
  })

  it('a create_co_id rejection ends in a plain init error (fails closed), and retry tries again', async () => {
    let reject = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: reject ? 0 : 1 } })
      if (path === 'user/create_co_id') return reject ? respond({ code: '100601', msg: 'KYC 未认证' }) : respond({ code: '0', data: null })
      return respond({ code: '0', data: { positionList: [], accountList: [] } })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(account.open).toEqual({ status: 'error', error: 'KYC 未认证', initFailed: true })
    expect(account.isOpened).toBe(false)
    reject = false
    await account.refresh()
    expect(account.open.status).toBe('opened')
  })

  it('a transfer answered 105001 creates the account silently and retries exactly once', async () => {
    const calls: string[] = []
    let transfers = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '').replace(/^.*\/fe-ex-api\//, '')
      calls.push(path)
      if (path.endsWith('contract/co_transfer')) {
        transfers += 1
        return respond(transfers === 1 ? { code: '105001', msg: '合约资金划转失败' } : { code: '0', data: null })
      }
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1 } })
      if (path === 'user/create_co_id') return respond({ code: '0', data: null })
      return respond({ code: '0', data: { positionList: [], accountList: [] } })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(account.open.status).toBe('opened')
    expect(await account.transfer('wallet_to_contract', '5', 'USDT')).toBeNull()
    expect(transfers).toBe(2)
    expect(calls.filter((path) => path === 'user/create_co_id')).toHaveLength(1)
  })

  it('a second 105001 after the silent creation is reported, not retried again', async () => {
    let transfers = 0
    let creates = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      if (path.endsWith('contract/co_transfer')) { transfers += 1; return respond({ code: '105001', msg: '合约资金划转失败' }) }
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1 } })
      if (path === 'user/create_co_id') { creates += 1; return respond({ code: '0', data: null }) }
      return respond({ code: '0', data: { positionList: [], accountList: [] } })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    // Spot 105001 is localised by code (transfer wording), not the server's generic 「合约资金划转失败」.
    expect(await account.transfer('wallet_to_contract', '5', 'USDT')).toBe('合约账户尚未就绪，划转未执行，请稍后重试')
    expect(transfers).toBe(2)
    expect(creates).toBe(1)
  })
})

describe('not-opened answers', () => {
  it('treats futures 100501 and the spot transfer pre-check 105001 as "not opened", nothing else', () => {
    expect(isNotOpenedError(new ApiError({ kind: 'api', code: '100501', message: 'x' }))).toBe(true)
    expect(isNotOpenedError(new ApiError({ kind: 'api', code: '105001', message: 'x' }))).toBe(true)
    expect(isNotOpenedError(new ApiError({ kind: 'api', code: '105000', message: 'x' }))).toBe(false)
    expect(isNotOpenedError(new Error('105001'))).toBe(false)
  })
})
