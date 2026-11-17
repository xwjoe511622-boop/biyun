import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { session } from '@/core/session'
import { API_PREFIX } from '@/config/endpoints'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'

// Synthetic only (fetch stubbed): the futures gate / transfer error texts of 2026-09-29.
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

describe('futures gate and transfer errors', () => {
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

  it('futures 10002 while spot confirms the session → futures-side retry text, the session is kept', async () => {
    const probes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith(API_PREFIX)) { probes.push(url.replace(API_PREFIX, '')); return respond({ code: '0', data: { id: 1 } }) }
      return respond({ code: '10002', msg: '用户未登陆' })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(probes).toEqual(['common/user_info'])
    expect(session.getToken()).toBe('jwt')
    expect(account.open.status).toBe('error')
    expect(account.open.error).toContain('合约服务暂时无法确认登录状态')
  })

  it('futures 10002 and spot rejects the token too (stale token after the key rotation) → session cleared', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith(API_PREFIX)) return respond({ code: '110009', msg: 'Login credentials expired, please log in again' })
      return respond({ code: '10002', msg: '用户未登陆' })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(session.isAuthenticated()).toBe(false)
    expect(account.open.status).toBe('signedOut')
  })

  it('futures restarting (502 HTML) → service-unavailable text, never a raw code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '<html>502</html>' }) as unknown as Response))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(account.open.error).toBe('合约服务暂时不可用（可能正在维护），请稍后重试')
  })

  it('assets failing after the account is confirmed explains the「合约账户 --」', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } })
      return respond({ code: '-1', msg: '' })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    expect(account.isOpened).toBe(true)
    expect(account.available).toBe('')
    expect(account.assetsError).not.toMatch(/错误码 -1/)
  })

  it('the futures-page transfer maps a legacy -1 to a clear line', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '').replace(API_PREFIX, '')
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } })
      if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '50' }] } })
      if (path === 'contract/co_transfer') return respond({ code: '-1', msg: '' })
      return respond({ code: '0', data: {} })
    }))
    const account = useFuturesAccountStore()
    await account.refresh()
    const result = await account.transfer('wallet_to_contract', '10000', 'USDT')
    expect(result).toContain('资金未变动')
    expect(result).not.toMatch(/错误码 -1/)
  })
})
