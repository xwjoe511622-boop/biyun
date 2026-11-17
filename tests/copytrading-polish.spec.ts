// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import * as api from '@/modules/copytrading/copytrading.api'
import FollowDialog from '@/components/copytrading/FollowDialog.vue'

// Synthetic only: the API module is mocked, nothing is sent to a server.
vi.mock('@/modules/copytrading/copytrading.api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/copytrading/copytrading.api')>()
  return { ...real, fetchBonusRate: vi.fn(), followTrader: vi.fn() }
})

const { profitShare, cumulativeRealized, followersAum } = await vi.importActual<typeof import('@/modules/copytrading/copytrading.api')>('@/modules/copytrading/copytrading.api')

describe('copy trading rules shown in the UI (2026-09-30)', () => {
  it('profit share = realized x rate, truncated to 0.01 and paid only above 0.01 (backend: 0.40267 -> 0.04, 0.1069 -> none)', () => {
    expect(profitShare('0.40267', 10)).toBe('0.04')
    expect(profitShare('0.1069', 10)).toBe('0.00')
    expect(profitShare('0.19', 10)).toBe('0.00')
    expect(profitShare('0.2', 10)).toBe('0.02')
    expect(profitShare('-5', 10)).toBe('0.00')
    expect(profitShare('10', 10)).toBe('1.00')
  })
  it('cumulative realized PnL of closed lead positions, oldest first', () => {
    const row = (id: string, mtime: number, amount: string) => ({ id, contractId: 1, side: 'BUY', positionType: 1, leverageLevel: 10, volume: '1', openPrice: '1', closePrice: '1', historyRealizedAmount: amount, ctime: mtime - 1, mtime })
    expect(cumulativeRealized([row('b', 200, '-1.5'), row('a', 100, '2'), row('c', 300, '0.25')]).map((p) => p.total)).toEqual(['2', '0.5', '0.75'])
  })
  it('AUM is the sum of the copiers margin', () => {
    expect(followersAum([{ nickname: 'a', followAmount: '100.5' }, { nickname: 'b', followAmount: '20' }, { nickname: 'c', followAmount: '' }])).toBe('120.5')
  })
})

describe('FollowDialog risk acknowledgement', () => {
  let host: HTMLDivElement
  let app: App | null = null
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    vi.mocked(api.fetchBonusRate).mockResolvedValue(10)
    vi.mocked(api.followTrader).mockResolvedValue()
  })
  afterEach(() => { app?.unmount(); app = null; vi.resetAllMocks(); document.body.innerHTML = '' })
  async function flush(): Promise<void> { for (let i = 0; i < 6; i += 1) { await Promise.resolve(); await nextTick() } }
  async function mount(existing: unknown = null, locale = 'zh-CN') {
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'zh-CN', messages: {} })
    app = createApp(FollowDialog, { traderUid: '10025', name: 'T', existing })
    app.use(i18n); app.mount(host)
    await flush()
    return i18n.global.locale
  }
  const q = <T extends Element>(id: string): T => host.querySelector(`[data-testid="${id}"]`) as T
  function type(id: string, value: string): void {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  it('shows the profit-share rule and blocks a new follow until the risks are ticked', async () => {
    await mount()
    expect(q('copy-share-rule').textContent).toContain('10%')
    expect(q('copy-share-rule').textContent).toContain('0.01 USDT')
    expect(q('copy-ack').textContent).toContain('强制逐仓')
    expect(q('copy-ack').textContent).toContain('不会平掉')
    type('copy-value', '1')
    type('copy-deposit', '100')
    await flush()
    expect(q<HTMLButtonElement>('copy-follow-submit').disabled).toBe(true)
    q<HTMLInputElement>('copy-ack-check').click()
    await flush()
    expect(q<HTMLButtonElement>('copy-follow-submit').disabled).toBe(false)
    q<HTMLButtonElement>('copy-follow-submit').click()
    await flush()
    expect(api.followTrader).toHaveBeenCalledTimes(1)
  })

  it('localizes the defensive acknowledgement error on a direct form submit', async () => {
    const locale = await mount()
    type('copy-value', '1')
    type('copy-deposit', '100')
    await flush()
    const submit = q<HTMLButtonElement>('copy-follow-submit')
    expect(submit.disabled).toBe(true)
    submit.click()
    await flush()
    const alert = () => host.querySelector('[role="alert"]')?.textContent
    expect(alert()).toBeUndefined()

    // The disabled button cannot submit. Exercise the form guard separately.
    host.querySelector('form')!.requestSubmit()
    await flush()
    expect(alert()).toBe('请先勾选风险确认')
    locale.value = 'en-US'
    await flush()
    expect(alert()).toBe('Please confirm the risks first')
    expect(api.followTrader).not.toHaveBeenCalled()

    vi.mocked(api.followTrader).mockRejectedValueOnce(new Error('服务端拒绝 #42'))
    q<HTMLInputElement>('copy-ack-check').click()
    await flush()
    submit.click()
    await flush()
    expect(alert()).toBe('服务端拒绝 #42')
    locale.value = 'zh-CN'
    await flush()
    expect(alert()).toBe('服务端拒绝 #42')
    expect(api.followTrader).toHaveBeenCalledTimes(1)
  })

  it('QA146 separates the English example from the rule with an explicit line break', async () => {
    await mount(null, 'en-US')
    const rule = q<HTMLElement>('copy-share-rule')
    expect(rule.textContent).toContain('losses pay nothing.')
    expect(rule.querySelector('br')?.nextElementSibling?.textContent).toContain('e.g.')
    expect(api.followTrader).not.toHaveBeenCalled()
  })

  it('editing an existing copy does not ask again', async () => {
    await mount({ uid: '10025', nickname: 'T', type: 0, amount: '-1', rate: '1', deposit: '100', profitRatio: '-1', lossRatio: '-1', profitUSDT: '0', status: 1, followAmount: '0', currentFollowCount: 0, ctime: null })
    expect(q<HTMLButtonElement>('copy-follow-submit').disabled).toBe(false)
  })
})
