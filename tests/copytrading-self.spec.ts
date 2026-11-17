// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import * as api from '@/modules/copytrading/copytrading.api'
import TraderSelfPanel from '@/components/copytrading/TraderSelfPanel.vue'

// Synthetic only: the API module is mocked.
vi.mock('@/modules/copytrading/copytrading.api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/copytrading/copytrading.api')>()
  return { ...real, fetchTotalIncome: vi.fn(), fetchFollowers: vi.fn(), fetchMyDescription: vi.fn(), saveMyDescription: vi.fn() }
})

let host: HTMLDivElement
let app: App | null = null
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.mocked(api.fetchTotalIncome).mockResolvedValue('1.23')
  vi.mocked(api.fetchFollowers).mockResolvedValue([{ nickname: 'a**1', followAmount: '100' }, { nickname: 'b**2', followAmount: '50.5' }])
  vi.mocked(api.fetchMyDescription).mockResolvedValue('')
  vi.mocked(api.saveMyDescription).mockResolvedValue()
})
afterEach(() => { app?.unmount(); app = null; vi.resetAllMocks(); document.body.innerHTML = '' })
async function flush(): Promise<void> { for (let i = 0; i < 6; i += 1) { await Promise.resolve(); await nextTick() } }

describe('TraderSelfPanel (我的带单)', () => {
  it('shows income, copiers and AUM, and saves the bio', async () => {
    const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: {} })
    app = createApp(TraderSelfPanel, { uid: '2147482514' })
    app.use(i18n); app.mount(host)
    await flush()
    expect(api.fetchFollowers).toHaveBeenCalledWith('2147482514', expect.anything())
    const text = host.textContent ?? ''
    expect(text).toContain('1.23 USDT')
    expect(text).toContain('150.50 USDT')
    expect(text).toContain('a**1')
    host.querySelector<HTMLButtonElement>('[data-testid="copy-bio-edit"]')!.click()
    await flush()
    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="copy-bio-input"]')!
    input.value = '趋势交易，单笔风险 1%'
    input.dispatchEvent(new Event('input'))
    host.querySelector<HTMLButtonElement>('[data-testid="copy-bio-save"]')!.click()
    await flush()
    expect(api.saveMyDescription).toHaveBeenCalledWith('趋势交易，单笔风险 1%')
    expect(host.textContent).toContain('趋势交易，单笔风险 1%')
  })
})
