// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { session } from '@/core/session'
import * as api from '@/modules/invite/invite.api'
import InviteView from '@/views/account/InviteView.vue'

// Synthetic only: the API module is mocked, nothing is sent to a server.
vi.mock('@/modules/invite/invite.api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/invite/invite.api')>()
  return { ...real, fetchInviteInfo: vi.fn(), fetchRebates: vi.fn() }
})
vi.mock('@/components/invite/InviteQr.vue', () => ({ default: { name: 'InviteQr', render: () => null } }))

let host: HTMLDivElement
let app: App | null = null
let pinia: Pinia

beforeEach(() => {
  session.clear()
  session.setToken('synthetic-token')
  pinia = createPinia()
  setActivePinia(pinia)
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.mocked(api.fetchInviteInfo).mockResolvedValue({ inviteCode: 'QEZLZHQEEA', coin: 'USDT', invitedCount: 3, rebateTotal: '0', invitees: [{ account: 'a****@x.io', registeredAt: 1790536778000 }] })
})
afterEach(() => {
  app?.unmount(); app = null
  disposePinia(pinia); session.clear(); vi.resetAllMocks(); document.body.innerHTML = ''
})

async function mount(): Promise<void> {
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: {} })
  app = createApp(InviteView); app.use(pinia); app.use(i18n); app.mount(host)
  for (let i = 0; i < 6; i += 1) { await Promise.resolve(); await nextTick() }
}

describe('InviteView rebates', () => {
  it('shows invitee count, per-coin totals and the rebate records', async () => {
    vi.mocked(api.fetchRebates).mockResolvedValue(api.summarizeRebates([
      { id: '4', uid: 2147482508, roleId: 0, symbol: 'BTC', fee: '0.00011792126', scale: '20', amount: '0.00002358', ctime: 1790536778000, email: 'a****@x.io', phoneNumber: '' },
      { id: '6', uid: 2147482502, roleId: 1, symbol: 'USDT', fee: '1747.70340739725', scale: '20', amount: '349.54068147', ctime: 1790536779000, email: 'c****@x.io', phoneNumber: '' },
    ] as never))
    await mount()
    const text = host.textContent ?? ''
    expect(text).toContain('QEZLZHQEEA')
    expect(text).toContain('3')
    expect(text).toContain('349.54068147')
    expect(text).toContain('0.00002358')
    expect(text).toContain('返佣记录')
    expect(text).toContain('合约')
    expect(text).toContain('+349.54068147 USDT')
    expect(text).toContain('20%')
  })

  it('shows 0 USDT and an empty state when nothing was paid, and an error banner on failure', async () => {
    vi.mocked(api.fetchRebates).mockResolvedValue({ records: [], totals: [] })
    await mount()
    expect(host.textContent).toContain('还没有返佣')
    expect(host.querySelector('.stat-totals')?.textContent).toContain('0USDT')
    app?.unmount(); app = null; host.innerHTML = ''
    vi.mocked(api.fetchRebates).mockRejectedValue(new Error('boom'))
    await mount()
    expect(host.textContent).toContain('boom')
  })
})
