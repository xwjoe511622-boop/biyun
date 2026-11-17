// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import AppHeader from '@/components/layout/AppHeader.vue'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

vi.mock('@/router', () => ({ routeTitle: () => '' }))
vi.mock('@/router/chunk-recovery', () => ({ warmRoute: vi.fn() }))
vi.mock('@/stores/market', () => ({ useMarketStore: () => ({ publicInfo: null, loadPublicInfo: vi.fn() }) }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ isAuthenticated: false, user: null }) }))
vi.mock('@/components/layout/LocalePanel.vue', () => ({ default: { render: () => null } }))

let app: App | null = null
let host: HTMLDivElement
let viewport = 1152
let menuWidth = 620
let mountErrors: unknown[]
const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN, 'en-US': enUS } })

beforeEach(() => {
  viewport = 1152
  menuWidth = 620
  mountErrors = []
  i18n.global.locale.value = 'zh-CN'
  host = document.createElement('div')
  document.body.append(host)
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => viewport)
  // These values represent CSS pixel geometry only, never a financial amount.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement): number {
    return this.classList.contains('nav-menu') ? menuWidth : 100
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
    const left = this.classList.contains('nav-group') ? 900 : 0
    return new DOMRect(left, 0, 100, 64)
  })
})
afterEach(() => {
  app?.unmount()
  app = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function mountHeader(): Promise<void> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
  await router.push('/')
  await router.isReady()
  app = createApp(AppHeader).use(router).use(i18n)
  app.config.errorHandler = error => { mountErrors.push(error) }
  app.mount(host)
  await nextTick()
}

describe('QA158 header menu geometry and lifecycle', () => {
  it('keeps Escape and outside-click dismissal when ResizeObserver is unavailable', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    await mountHeader()
    expect(mountErrors).toEqual([])
    const group = host.querySelector<HTMLElement>('.nav .nav-group')!
    const trigger = group.querySelector<HTMLButtonElement>('.nav-trigger')!
    trigger.click(); await nextTick()
    expect(group.classList.contains('is-open')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
    expect(group.classList.contains('is-open')).toBe(false)
    trigger.click(); await nextTick()
    document.dispatchEvent(new Event('pointerdown', { bubbles: true })); await nextTick()
    expect(group.classList.contains('is-open')).toBe(false)
  })

  it('shows one menu after mouse hover and keyboard activation of another group', async () => {
    await mountHeader()
    const groups = [...host.querySelectorAll<HTMLElement>('.nav .nav-group')]
    expect(groups.length).toBeGreaterThan(1)
    groups[0]!.dispatchEvent(new MouseEvent('pointerenter'))
    await nextTick()
    expect(groups.filter(group => group.classList.contains('is-open'))).toEqual([groups[0]])
    // Keyboard Enter emits a click on the second button while the pointer remains over the first.
    groups[1]!.querySelector<HTMLButtonElement>('.nav-trigger')!.click()
    await nextTick()
    expect(groups.filter(group => group.classList.contains('is-open'))).toEqual([groups[1]])
    expect(groups[0]!.querySelector('.nav-trigger')!.getAttribute('aria-expanded')).toBe('false')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(groups.some(group => group.classList.contains('is-open'))).toBe(false)
  })

  it('fits hidden menus again after viewport and language changes, then disconnects observers', async () => {
    const observed: Element[] = []
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      observe(element: Element): void { observed.push(element) }
      disconnect(): void { disconnect() }
    })
    await mountHeader()
    const menus = [...host.querySelectorAll<HTMLElement>('.nav .nav-menu')]
    expect(menus.length).toBeGreaterThan(0)
    expect(observed.length).toBe(menus.length)
    expect(menus.every(menu => menu.style.left === '-376px')).toBe(true)
    viewport = 1280
    window.dispatchEvent(new Event('resize')); await nextTick()
    expect(menus.every(menu => menu.style.left === '-248px')).toBe(true)
    menuWidth = 800
    i18n.global.locale.value = 'en-US'; await nextTick()
    expect(menus.every(menu => menu.style.left === '-428px')).toBe(true)
    app?.unmount(); app = null
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
