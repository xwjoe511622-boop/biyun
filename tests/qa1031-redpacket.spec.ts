// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { router as appRouter } from '@/router'
import RedPacketDetailView from '@/views/RedPacketDetailView.vue'
import RedPacketSendView from '@/views/RedPacketSendView.vue'
import * as api from '@/modules/redpacket/api'
import { fetchOrderDetail } from '@/modules/otc/api'
const context = vi.hoisted(() => ({ session: {} as Record<string, unknown>, account: {} as Record<string, unknown> }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => context.session }))
vi.mock('@/stores/account', () => ({ useAccountStore: () => context.account }))
vi.mock('@/modules/redpacket/api', async original => ({ ...await original<typeof import('@/modules/redpacket/api')>(), fetchRedPacketDetail: vi.fn(), fetchRedPacketConfig: vi.fn(), sendRedPacket: vi.fn(), claimRedPacket: vi.fn() }))
vi.mock('@/modules/otc/api', async original => ({ ...await original<typeof import('@/modules/otc/api')>(), fetchOrderDetail: vi.fn() }))
let app: App | undefined
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host)
  context.session = reactive({ isAuthenticated: false, user: { id: '42' }, token: '', loadUserInfo: vi.fn().mockResolvedValue(undefined) })
  context.account = reactive({ coinRows: [], load: vi.fn().mockResolvedValue(undefined) })
  vi.mocked(api.fetchRedPacketConfig).mockResolvedValue({ open: true, coins: [] } as Awaited<ReturnType<typeof api.fetchRedPacketConfig>>)
})
afterEach(() => { app?.unmount(); app = undefined; vi.clearAllMocks(); document.body.innerHTML = '' })
async function mount(detail: boolean, lang: string): Promise<void> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/redpacket/send', component: RedPacketSendView }, { path: '/redpacket/:sn', component: RedPacketDetailView }, { path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push(detail ? '/redpacket/example' : '/redpacket/send'); await router.isReady()
  app = createApp(detail ? RedPacketDetailView : RedPacketSendView).use(router).use(createI18n({ legacy: false, locale: lang, fallbackLocale: lang, messages: {} }))
  app.mount(host)
  for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() }
}
describe('QA144/145 red-packet entry context', () => {
  it.each([['zh-CN', '登录后可查看和领取红包'], ['en-US', 'Log in to view and claim the red packet']])('uses a view/claim guest message in %s', async (lang, expected) => {
    await mount(true, lang)
    expect(host.querySelector('.gate-message')?.textContent).toBe(expected)
    expect(api.fetchRedPacketDetail).not.toHaveBeenCalled()
    expect(api.claimRedPacket).not.toHaveBeenCalled()
  })
  it.each([['zh-CN', '请从 C2C 订单进入', '前往 C2C 订单'], ['en-US', 'Open a C2C order to send a red packet', 'Go to C2C orders']])('keeps the already-fixed no-order send guidance in %s', async (lang, expected, action) => {
    context.session.isAuthenticated = true
    expect(appRouter.resolve('/redpacket/send').name).toBe('redpacket-send')
    await mount(false, lang)
    expect(host.textContent).toContain(expected)
    expect(host.querySelector('a[href="/otc/orders"]')?.textContent).toBe(action)
    expect(host.textContent).not.toMatch(/红包编号无效|Invalid red-packet number/)
    expect(fetchOrderDetail).not.toHaveBeenCalled()
    expect(api.sendRedPacket).not.toHaveBeenCalled()
    expect(api.claimRedPacket).not.toHaveBeenCalled()
  })
})
