// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import FuturesAccountPanel from '@/components/futures/FuturesAccountPanel.vue'
import { i18n } from '@/i18n'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'

/**
 * Platform rule (2026-09-27): every user has a futures account by default. The futures pages must never
 * render an "open futures" prompt / agreement; a missing account is created silently (create_co_id).
 */
const futuresSources = import.meta.glob('../src/{components/futures,views/futures}/**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let pinia: Pinia
let app: App | null = null

beforeEach(() => {
  session.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  const market = useFuturesMarketStore()
  const info = normalizePublicInfo({ contractList: [{ id: 1, contractName: 'E-BTC-USDT', multiplier: '0.001', marginCoin: 'USDT', base: 'BTC', quote: 'USDT', minLever: 1, maxLever: 100, coinResultVo: {} }] })
  market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
  market.selectedName = 'E-BTC-USDT'
  session.setToken('jwt')
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  vi.unstubAllGlobals()
  session.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mountPanel(): Promise<HTMLElement> {
  app = createApp(defineComponent({ setup: () => () => h(FuturesAccountPanel) }))
  app.use(pinia)
  app.use(i18n)
  app.component('RouterLink', defineComponent({ props: { to: { type: String, default: '' } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await useFuturesAccountStore().refresh()
  await flush()
  return host
}

function expectNoOpenPrompt(host: HTMLElement): void {
  expect(host.textContent ?? '').not.toMatch(/开通合约|立即开通|Enable futures|Enable now|自愿开通|understood these risks/)
  expect(host.querySelector('input[type="checkbox"]')).toBeNull()
}

describe('futures pages never ask the user to open a futures account', () => {
  it('no futures component or view carries the open-account card / agreement any more', () => {
    const files = Object.entries(futuresSources)
    expect(files.length).toBeGreaterThan(5)
    for (const [file, source] of files) {
      expect(file).not.toMatch(/OpenAccountCard/)
      expect(source, file).not.toMatch(/OpenAccountCard|setAgreed|openAgree|openAccount\(/)
    }
  })

  it('an unopened account (100501) is created silently and the account panel renders', async () => {
    let opened = false
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      calls.push(path)
      if (path === 'user/get_user_config') return respond(opened ? { code: '0', data: { openContract: 1, nowLevel: 20, marginModel: 1 } } : { code: '100501', msg: '用户未开启合约交易' })
      if (path === 'user/create_co_id') { opened = true; return respond({ code: '0', data: null }) }
      if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '50', totalAmount: '50' }] } })
      return respond({ code: '0', data: {} })
    }))
    const host = await mountPanel()
    expect(calls).toContain('user/create_co_id')
    expect(useFuturesAccountStore().isOpened).toBe(true)
    expectNoOpenPrompt(host)
    expect(host.querySelector('.acct-body')).not.toBeNull()
  })

  it('a failed silent creation shows a plain error with retry, still no open prompt', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '')
      if (path === 'user/get_user_config') return respond({ code: '100501', msg: '用户未开启合约交易' })
      if (path === 'user/create_co_id') return respond({ code: '500', msg: 'busy' })
      return respond({ code: '0', data: {} })
    }))
    const host = await mountPanel()
    expect(useFuturesAccountStore().open.initFailed).toBe(true)
    expect(host.textContent).toMatch(/合约账户初始化失败|Futures account setup failed/)
    expect(host.querySelector('.acct-body')).toBeNull()
    expectNoOpenPrompt(host)
  })
})
