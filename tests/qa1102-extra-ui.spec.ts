// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App, type Component } from 'vue'
import { createI18n } from 'vue-i18n'
import BizDialog from '@/components/business/ui/BizDialog.vue'
import LaunchpadView from '@/views/business/LaunchpadView.vue'
import CopyTradingView from '@/views/futures/CopyTradingView.vue'
import MessagesView from '@/views/account/MessagesView.vue'
import { businessRequest } from '@/modules/business/client'
import { request } from '@/modules/api/http'
import { fetchMessages } from '@/modules/messages/messages.api'
import { messageTypeLabel } from '@/modules/messages/message-type-label'
import { messagesMessages } from '@/modules/messages/i18n'

// All transports are mocked. No orders, loans, follows or messages leave this process.
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ isAuthenticated: true }) }))
vi.mock('@/modules/api/http', async original => ({ ...await original<typeof import('@/modules/api/http')>(), request: vi.fn() }))
vi.mock('@/modules/business/client', async original => ({ ...await original<typeof import('@/modules/business/client')>(), businessRequest: vi.fn() }))
vi.mock('@/components/business/ui/useBiz', async original => {
  const { computed } = await import('vue')
  return { ...await original<typeof import('@/components/business/ui/useBiz')>(),
    useBizContext: () => ({ lang: computed(() => 'en'), authed: computed(() => true), t: (_zh: string, en: string) => en }),
    useSpotBalances: () => ({ of: () => '1000', reload: vi.fn() }),
  }
})
vi.mock('@/modules/messages/useUnreadMessages', async () => {
  const { ref } = await import('vue')
  return { useUnreadMessages: () => ({ count: ref(0), badge: ref('') }), refreshUnreadCount: vi.fn(), setUnreadCount: vi.fn() }
})
vi.mock('@/modules/copytrading/copytrading.api', async original => ({
  ...await original<typeof import('@/modules/copytrading/copytrading.api')>(),
  fetchTraders: vi.fn(async () => []), fetchMyStatistics: vi.fn(async () => null), fetchCopiedPositions: vi.fn(async () => []),
  fetchMyTraders: vi.fn(async () => [{ uid: '10025', nickname: 'Example', type: 1, amount: '0.1', rate: '1', deposit: '100', profitRatio: '-1', lossRatio: '-1', profitUSDT: '0', status: 1, followAmount: '0', currentFollowCount: 0, ctime: null }]),
}))
vi.mock('@/components/copytrading/TraderApplyPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/business/ui/BizRecords.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/CoinMark.vue', () => ({ default: { template: '<span />' } }))
let app: App | undefined
let host: HTMLDivElement
async function flush(): Promise<void> { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }
async function mount(component: Component, props = {}): Promise<void> {
  const i18n = createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: {} })
  app = createApp(component, props).use(i18n)
  app.mount(host); await flush()
}
function capture(name: string): void {
  if (import.meta.env.VITE_QA_CAPTURE_LAYOUT !== '1') return
  console.info('QA_LAYOUT_SNAPSHOT', JSON.stringify({ name, html: document.body.innerHTML }))
}
beforeEach(() => { host = document.createElement('div'); document.body.append(host); vi.mocked(businessRequest).mockReset().mockResolvedValue({}); vi.mocked(request).mockReset() })
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

it('QA177 preserves the exact max amount and renders the real English borrow form for narrow-screen layout checks', async () => {
  await mount(BizDialog, { open: true, lang: 'en', title: 'Borrow USDT', path: '/never-submit', fields: [
    { key: 'collateral', label: 'Collateral asset', kind: 'select', options: [{ value: 'BTC', label: 'BTC — Bitcoin collateral asset' }] },
    { key: 'amount', label: 'Loan amount (USDT)', kind: 'amount', asset: 'USDT', available: '12345678901234567890.1234567890123456', scale: 16 },
  ], summary: [{ label: 'Initial loan-to-value ratio', value: '65.00000000%' }], notes: ['Collateral requirements are checked by the server before confirmation.'] })
  document.querySelector<HTMLButtonElement>('.dlg-max')!.click(); await flush()
  expect(document.querySelector<HTMLInputElement>('.dlg-input input')!.value).toBe('12345678901234567890.1234567890123456')
  expect(businessRequest).not.toHaveBeenCalled(); capture('borrow')
})

it('QA178 renders three complete UTC-derived phase timestamps without changing project amounts', async () => {
  vi.mocked(businessRequest).mockImplementation(async path => path.endsWith('/projects') ? { rows: [{ projectId: '1', title: 'Example launch project', tokenCoin: 'TOKEN', quoteCoin: 'USDT', status: 'preview', price: '0.1', totalSupply: '12345678901234567890.1234567890123456', snapshotStart: '2026-11-01T00:00:00Z', subscribeStart: '2026-11-02T00:00:00Z', subscribeEnd: '2026-11-03T00:00:00Z' }] } : {})
  await mount(LaunchpadView)
  expect(document.querySelectorAll('.lp-steps li')).toHaveLength(3)
  expect([...document.querySelectorAll('.lp-steps .num')].every(node => node.textContent !== '--')).toBe(true)
  expect(vi.mocked(businessRequest).mock.calls.every(call => call[2] !== true)).toBe(true); capture('launchpad')
})

it('QA184 keeps both real My copies actions present, without executing either', async () => {
  await mount(CopyTradingView)
  const mine = [...host.querySelectorAll('button')].find(button => button.textContent?.trim().startsWith('My copies'))
  expect(mine).toBeDefined(); mine!.click(); await flush()
  expect([...host.querySelectorAll('.actions-cell button')].map(button => button.textContent?.trim())).toEqual(['Edit settings', 'Stop copying'])
  capture('copy')
})

it('QA179 accepts null titles and uses real type IDs in tabs and requests', async () => {
  vi.mocked(request).mockResolvedValue({ count: 0, userMessageList: [], typeList: [1, 2, 3, 4, 7, 99].map(tid => ({ tid, title: null })) })
  const parsed = await fetchMessages({ page: 1, pageSize: 10, type: 0 })
  expect(parsed.types.every(type => type.title === '')).toBe(true)
  await mount(MessagesView)
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs.map(tab => tab.textContent?.trim())).toEqual(['All', 'Unread', 'System', 'Deposits & withdrawals', 'Security', 'Verification', 'C2C', 'Message category 99'])
  tabs.find(tab => tab.textContent === 'C2C')!.click(); await flush()
  expect(request).toHaveBeenLastCalledWith('message/user_message', expect.objectContaining({ body: { page: 1, pageSize: 10, messageType: 7 } }))
})

it('QA179 preserves configured titles and localizes the stable backend language keys', () => {
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: messagesMessages })
  const translate = (key: string, values: { id: number }) => i18n.global.t(key, values)
  expect(messageTypeLabel({ id: 3, title: '  ' }, translate)).toBe('安全消息')
  expect(messageTypeLabel({ id: 4, title: 'authMessage' }, translate)).toBe('认证消息')
  expect(messageTypeLabel({ id: 7, title: 'Configured title' }, translate)).toBe('Configured title')
  expect(messageTypeLabel({ id: 88, title: '' }, translate)).toBe('消息类别 88')
})
