// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import * as api from '@/modules/copytrading/copytrading.api'
import TraderApplyPanel from '@/components/copytrading/TraderApplyPanel.vue'

// Synthetic only: the API module is mocked, nothing is sent to a server.
vi.mock('@/modules/copytrading/copytrading.api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/copytrading/copytrading.api')>()
  return { ...real, fetchApplyStatus: vi.fn(), applyBecomeTrader: vi.fn() }
})

let host: HTMLDivElement
let app: App | null = null
const events: string[] = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  events.length = 0
})
afterEach(() => { app?.unmount(); app = null; vi.resetAllMocks(); document.body.innerHTML = '' })

async function flush(): Promise<void> { for (let i = 0; i < 6; i += 1) { await Promise.resolve(); await nextTick() } }
async function mount() {
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: {} })
  app = createApp(TraderApplyPanel, { onSubmitted: () => events.push('submitted'), onProfile: (uid: string) => events.push(`profile:${uid}`) })
  app.use(i18n); app.mount(host)
  await flush()
  return i18n.global.locale
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

describe('TraderApplyPanel', () => {
  it('updates a visible status error across locale changes and clears it on retry', async () => {
    vi.mocked(api.fetchApplyStatus)
      .mockRejectedValueOnce(new Error('读取失败 #42'))
      .mockResolvedValueOnce({ uid: '10001', status: 0 })
    const locale = await mount()
    const message = () => host.querySelector('.msg')?.textContent
    expect(message()).toBe('申请状态暂不可读取：读取失败 #42')
    locale.value = 'en-US'
    await flush()
    expect(message()).toBe('Application status unavailable: 读取失败 #42')
    locale.value = 'zh-CN'
    await flush()
    expect(message()).toBe('申请状态暂不可读取：读取失败 #42')
    expect(api.fetchApplyStatus).toHaveBeenCalledTimes(1)
    button('↻')!.click()
    await flush()
    expect(host.textContent).toContain('审核中')
    expect(message()).not.toContain('读取失败 #42')
  })

  it('applies after a confirm step and then shows the pending state', async () => {
    vi.mocked(api.fetchApplyStatus).mockResolvedValueOnce({ uid: '10001', status: -1 }).mockResolvedValueOnce({ uid: '10001', status: 0 })
    vi.mocked(api.applyBecomeTrader).mockResolvedValue()
    await mount()
    expect(host.textContent).toContain('成为带单交易员')
    button('申请成为交易员')!.click(); await flush()
    expect(api.applyBecomeTrader).not.toHaveBeenCalled()
    button('确认申请')!.click(); await flush()
    expect(api.applyBecomeTrader).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['submitted'])
    expect(host.textContent).toContain('审核中')
    expect(button('申请成为交易员')).toBeUndefined()
  })

  it('shows the approved state with a profile link, and re-apply after rejection', async () => {
    vi.mocked(api.fetchApplyStatus).mockResolvedValueOnce({ uid: '10001', status: 1 })
    await mount()
    expect(host.textContent).toContain('已是交易员')
    button('查看我的主页')!.click()
    expect(events).toEqual(['profile:10001'])
    app?.unmount(); app = null; host.innerHTML = ''
    vi.mocked(api.fetchApplyStatus).mockResolvedValueOnce({ uid: '10001', status: 2 })
    await mount()
    expect(host.textContent).toContain('未通过')
    expect(button('重新申请')).toBeDefined()
  })

  it('shows the server error verbatim when applying fails', async () => {
    vi.mocked(api.fetchApplyStatus).mockResolvedValue({ uid: '10001', status: -1 })
    vi.mocked(api.applyBecomeTrader).mockRejectedValue(new Error('请先完成实名认证'))
    await mount()
    button('申请成为交易员')!.click(); await flush()
    button('确认申请')!.click(); await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('请先完成实名认证')
    expect(events).toEqual([])
  })
})
