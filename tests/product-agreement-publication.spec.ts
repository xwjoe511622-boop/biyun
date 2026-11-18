// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { i18n } from '@/i18n'
import { router as appRouter } from '@/router'
import { PRODUCT_TERMS_ROUTES } from '@/router/product-terms'
import BizDialog from '@/components/business/ui/BizDialog.vue'
import { loadAgreement } from '@/modules/business/agreement'
import { bundledAgreement } from '@/modules/business/agreements/published'
import { fetchCmsArticle, fetchFooterArticles, fetchHelpTree, type CmsArticle, type CmsLink } from '@/modules/content/content.api'
vi.mock('@/modules/content/content.api', async (original) => ({ ...await original<typeof import('@/modules/content/content.api')>(), fetchCmsArticle: vi.fn(), fetchFooterArticles: vi.fn(), fetchHelpTree: vi.fn() }))
const link: CmsLink = { id: '1', title: '理财服务协议', fileName: 'online-earn' }
const online: CmsArticle = { title: '理财服务协议', fileName: 'online-earn', content: '<p>Published online product rules.</p>', time: null, categoryId: '1' }
let app: App | undefined
let host: HTMLDivElement
async function flush(): Promise<void> { for (let i = 0; i < 7; i++) { await Promise.resolve(); await nextTick() } }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host)
  i18n.global.locale.value = 'zh-CN'
  vi.mocked(fetchHelpTree).mockReset().mockResolvedValue([])
  vi.mocked(fetchFooterArticles).mockReset().mockResolvedValue([])
  vi.mocked(fetchCmsArticle).mockReset().mockResolvedValue(online)
})
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ''; i18n.global.locale.value = 'zh-CN' })

describe('owner-published BITWINEX v0.1 rules', () => {
  it.each([['earn', 'zh'], ['earn', 'en'], ['loan', 'zh'], ['loan', 'en']] as const)('publishes %s/%s as readable site rules when no dedicated online text exists', async (kind, lang) => {
    const result = await loadAgreement(kind, new AbortController().signal, lang)
    expect(result).toMatchObject({ source: 'site', version: '0.1', versionDate: '2026-10-30', language: lang, cmsStatus: 'missing' })
    expect(result?.content).toContain('BITWINEX')
    expect(result?.content).toContain(kind === 'loan' ? '8760' : '365')
    expect(result?.content).not.toMatch(/草案|未发布|运营主体全称|\[.*主体.*\]|Binance|OKX|CMS|schema/)
    expect(fetchCmsArticle).not.toHaveBeenCalled()
  })
  it('prefers a valid unambiguous online product article', async () => {
    vi.mocked(fetchHelpTree).mockResolvedValue([{ id: '1', name: 'Rules', articles: [link] }])
    expect(await loadAgreement('earn', new AbortController().signal)).toMatchObject({ source: 'cms', cmsStatus: 'published', fileName: 'online-earn', content: online.content })
  })
  it('does not mislabel duplicate online publications as a successful online read', async () => {
    vi.mocked(fetchHelpTree).mockResolvedValue([{ id: '1', name: 'Rules', articles: [link, { ...link, id: '2', fileName: 'other-version' }] }])
    const result = await loadAgreement('earn', new AbortController().signal)
    expect(result).toMatchObject({ source: 'site', cmsStatus: 'ambiguous', version: '0.1' })
    expect(fetchCmsArticle).not.toHaveBeenCalled()
  })
  it('keeps online lookup failures separate from genuinely missing publications', async () => {
    vi.mocked(fetchHelpTree).mockRejectedValue(new Error('offline'))
    expect(await loadAgreement('earn', new AbortController().signal)).toMatchObject({ source: 'site', cmsStatus: 'unavailable' })
  })
  it('identifies invalid online content separately while keeping the published site version readable', async () => {
    vi.mocked(fetchFooterArticles).mockResolvedValue([link])
    vi.mocked(fetchCmsArticle).mockResolvedValue({ ...online, content: '<p><br></p>' })
    expect(await loadAgreement('earn', new AbortController().signal)).toMatchObject({ source: 'site', cmsStatus: 'invalid' })
  })
  it('does not replace a cancelled read with a newly-ready fallback', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(loadAgreement('earn', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('shows plain source/version language and enables only deliberate consent to the displayed site rules', async () => {
    vi.mocked(fetchHelpTree).mockRejectedValue(new Error('offline'))
    app = createApp(BizDialog, { open: true, lang: 'zh', title: '申购', path: '/sapi/v1/simple-earn/flexible/subscribe', fields: [], agree: '我已阅读并同意', agreementKind: 'earn' })
    app.mount(host); await flush()
    expect(document.body.textContent).toContain('在线条款暂时无法读取')
    expect(document.body.textContent).toContain('v0.1')
    expect(document.body.textContent).not.toMatch(/CMS|schema|ambiguous|invalid/)
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.btn-block')?.disabled).toBe(true)
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    expect(document.querySelector<HTMLButtonElement>('.btn-block')?.disabled).toBe(false)
    expect(document.querySelector('a[href="/terms/earn"]')).toBeTruthy()
  })
  it('resets consent when a language reload replaces site rules with a readable online version', async () => {
    const state = reactive({ lang: 'zh' as 'zh' | 'en' })
    app = createApp(defineComponent({ setup: () => () => h(BizDialog, { open: true, lang: state.lang, title: '申购', path: '/sapi/v1/simple-earn/flexible/subscribe', fields: [], agree: '我已阅读并同意', agreementKind: 'earn' }) }))
    app.mount(host); await flush()
    expect(document.querySelector('.agreement')?.getAttribute('data-source')).toBe('site')
    let checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    expect(document.querySelector<HTMLButtonElement>('.btn-block')?.disabled).toBe(false)
    const englishLink = { ...link, title: 'Simple Earn Agreement' }
    vi.mocked(fetchHelpTree).mockResolvedValue([{ id: '1', name: 'Rules', articles: [englishLink] }])
    vi.mocked(fetchCmsArticle).mockResolvedValue({ ...online, title: englishLink.title, content: '<p>Current English online rules.</p>' })
    state.lang = 'en'; await flush()
    expect(document.querySelector('.agreement')?.getAttribute('data-source')).toBe('cms')
    expect(document.body.textContent).toContain('Current English online rules.')
    expect(document.body.textContent).toContain('published online product terms')
    checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('.btn-block')?.disabled).toBe(true)
  })
  it('retains the disclosed rules in both language versions', () => {
    const zh = bundledAgreement('loan', 'zh').content
    const en = bundledAgreement('loan', 'en').content
    for (const phrase of ['8760', '8', 'v0.1']) { expect(zh).toContain(phrase); expect(en).toContain(phrase) }
    expect(zh).toContain('未覆盖债务记入平台资金池坏账')
    expect(en).toContain('records uncovered debt as platform-pool bad debt')
    expect(zh).toContain('执行补计时读取的现行年利率及复利设置')
    expect(en).toContain('when that catch-up runs')
  })
})

describe('public /terms reading pages', () => {
  it('registers both real routes and renders the corresponding full bilingual rules without a session', async () => {
    expect(appRouter.resolve('/terms/earn').name).toBe('earn-terms')
    expect(appRouter.resolve('/terms/loan').name).toBe('loan-terms')
    const memory = createRouter({ history: createMemoryHistory(), routes: PRODUCT_TERMS_ROUTES })
    app = createApp(defineComponent({ setup: () => () => h(RouterView) })).use(memory).use(i18n)
    await memory.push('/terms/earn'); await memory.isReady(); app.mount(host); await flush()
    expect(host.querySelector('h1')?.textContent).toBe('理财服务协议')
    expect(host.querySelector('details')?.open).toBe(true)
    expect(host.textContent).toContain('申购次日起息')
    await memory.push('/terms/loan'); await flush()
    expect(host.querySelector('h1')?.textContent).toBe('借币服务协议')
    expect(host.textContent).toContain('8760')
    i18n.global.locale.value = 'en-US'; await flush()
    expect(host.querySelector('h1')?.textContent).toBe('Crypto Loan Agreement')
    expect(host.textContent).toContain('Current liquidation is book-based')
    expect(host.textContent).not.toContain('本说明适用于')
  })
})
