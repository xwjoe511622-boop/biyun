// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import LeverageDialog from '@/components/futures/LeverageDialog.vue'
import { i18n } from '@/i18n'
import { session } from '@/core/session'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'

/** 调整杠杆 dialog (2026-09-29): preview of what the change does, industry refusals, isolated top-up after level_edit. */
function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

let pinia: Pinia
let app: App | null = null
let calls: { path: string; body: Record<string, string> }[] = []
let resting = 0
let positions: Record<string, unknown>[] = []
let serverTopUp = false
let levelEditCode = '0'

beforeEach(() => {
  localStorage.clear()
  session.clear()
  calls = []
  resting = 0
  positions = []
  serverTopUp = false
  levelEditCode = '0'
  pinia = createPinia()
  setActivePinia(pinia)
  const market = useFuturesMarketStore()
  const info = normalizePublicInfo({
    contractList: [{
      id: 5, contractName: 'E-TSLA-USDT', multiplier: '0.01', multiplierCoin: 'TSLA', marginCoin: 'USDT', marginRate: '1', base: 'TSLA', quote: 'USDT', minLever: 1, maxLever: 10,
      coinResultVo: { symbolPricePrecision: 2, marginCoinPrecision: 2, minOrderVolume: 1, minOrderMoney: 1, maxLimitVolume: 99999999, maxMarketVolume: 99999999, maxMarketMoney: 99999999, fundsInStatus: 1, fundsOutStatus: 1, depth: ['2'] },
    }],
  })
  market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
  market.selectedName = 'E-TSLA-USDT'
  session.setToken('jwt')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0] ?? ''
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, string> })
    if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 5, marginModel: 2, leverOriginCeiling: { 3: 10000000, 5: 2000000, 10: 500000 } } })
    if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: positions, accountList: [{ symbol: 'USDT', canUseAmount: '100', totalAmount: '100' }] } })
    if (path === 'order/current_order_list') return respond({ code: '0', data: { count: resting, orderList: [] } })
    if (path === 'user/level_edit') {
      if (levelEditCode !== '0') return respond({ code: levelEditCode, msg: 'server text', data: null })
      return respond({ code: '0', data: serverTopUp ? { crossMarginDelta: '0', isolatedTopUps: [{ positionId: 694, amount: '0.48' }], topUpTotal: '0.48' } : {} })
    }
    return respond({ code: '0', data: {} })
  }))
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
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mountDialog(): Promise<HTMLElement> {
  await useFuturesAccountStore().refresh()
  app = createApp(defineComponent({ setup: () => () => h(LeverageDialog, { current: 5, min: 1, max: 10 }) }))
  app.use(pinia)
  app.use(i18n)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
  return document.body // FuturesDialog teleports to <body>
}

const q = <T extends Element>(host: HTMLElement, id: string): T | null => host.querySelector(`[data-testid="${id}"]`) as T | null

async function setLever(host: HTMLElement, value: string): Promise<void> {
  const input = host.querySelector('input.num') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

const isolated = { id: 694, contractId: 5, positionType: 2, orderSide: 'BUY', positionVolume: 1, positionBalance: 3.5816, holdAmount: 0.71643, realizedAmount: 0, unRealizedAmount: 0, reducePrice: 292.58, keepRate: 0.02, maxFeeRate: 0.00075, leverageLevel: 5 }

describe('LeverageDialog', () => {
  it('isolated lower: shows the margin to add and the new liquidation price, then adds it after level_edit', async () => {
    positions = [isolated]
    const host = await mountDialog()
    await setLever(host, '3')
    const preview = q(host, 'lev-preview')?.textContent ?? ''
    expect(preview).toContain('0.48 USDT')
    expect(preview).toContain('292.58 → 243.56')
    const confirm = q<HTMLButtonElement>(host, 'lev-confirm')!
    expect(confirm.textContent).toContain('确认并追加 0.48 USDT')
    confirm.click()
    await flush()
    const edits = calls.filter((c) => c.path === 'user/level_edit' || c.path === 'position/change_position_margin')
    expect(edits).toEqual([
      { path: 'user/level_edit', body: { contractId: '5', nowLevel: '3' } },
      { path: 'position/change_position_margin', body: { positionId: '694', amount: '0.48' } },
    ])
  })

  it('isolated lower on a guarded server: level_edit alone, no second top-up', async () => {
    positions = [isolated]
    serverTopUp = true
    const host = await mountDialog()
    await setLever(host, '3')
    q<HTMLButtonElement>(host, 'lev-confirm')!.click()
    await flush()
    const edits = calls.filter((c) => c.path === 'user/level_edit' || c.path === 'position/change_position_margin')
    expect(edits).toEqual([{ path: 'user/level_edit', body: { contractId: '5', nowLevel: '3' } }])
  })

  it('shows the Chinese reason when the server refuses (10068)', async () => {
    positions = [{ ...isolated, positionType: 1 }]
    levelEditCode = '10068'
    const host = await mountDialog()
    await setLever(host, '4')
    q<HTMLButtonElement>(host, 'lev-confirm')!.click()
    await flush()
    expect(host.textContent).toContain('可用保证金不足，无法调低到该杠杆')
  })

  it('refuses while the contract has resting orders and offers to cancel them', async () => {
    resting = 2
    const host = await mountDialog()
    await setLever(host, '10')
    expect(q(host, 'lev-block')?.textContent).toContain('2 笔未成交委托')
    expect(q(host, 'lev-block')?.textContent).toContain('撤销该合约全部委托')
    expect(q<HTMLButtonElement>(host, 'lev-confirm')!.disabled).toBe(true)
  })

  it('refuses an isolated lower the available balance cannot fund', async () => {
    positions = [{ ...isolated, positionBalance: 500, holdAmount: 100 }]
    const host = await mountDialog()
    await setLever(host, '1')
    // 1x needs 500 - 100 = 400 USDT, 可用 100; 2x needs 150 -> too much too, 3x needs ~66.67 -> lowest 3x
    const text = q(host, 'lev-block')?.textContent ?? ''
    expect(text).toContain('可用保证金不足')
    expect(text).toContain('3x')
    expect(q<HTMLButtonElement>(host, 'lev-confirm')!.disabled).toBe(true)
    expect(calls.some((c) => c.path === 'user/level_edit')).toBe(false)
  })

  it('no position: says only new positions use it', async () => {
    const host = await mountDialog()
    await setLever(host, '8')
    expect(q(host, 'lev-preview')?.textContent).toContain('只修改之后新开仓使用的杠杆')
  })
})
