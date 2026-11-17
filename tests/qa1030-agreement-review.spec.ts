// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue'
import BizDialog from '@/components/business/ui/BizDialog.vue'
import { loadAgreement, publishedAgreementArticle } from '@/modules/business/agreement'
import { fetchCmsArticle, fetchFooterArticles, fetchHelpTree, type CmsArticle } from '@/modules/content/content.api'
import { businessRequest } from '@/modules/business/client'
import { session } from '@/core/session'
vi.mock('@/modules/content/content.api', async (original) => ({ ...await original<typeof import('@/modules/content/content.api')>(), fetchCmsArticle: vi.fn(), fetchFooterArticles: vi.fn(), fetchHelpTree: vi.fn() }))
const link = { id: '1', title: '理财服务协议', fileName: 'earn-terms' }
const article = (content = '<p>Published service agreement text for a component test.</p>'): CmsArticle => ({ title: '理财服务协议', fileName: 'earn-terms', content, time: null, categoryId: '1' })
let app: App | undefined
let host: HTMLDivElement
async function flush(): Promise<void> { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }
const checkbox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
const submit = () => document.querySelector<HTMLButtonElement>('.btn-block')!
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host)
  vi.mocked(fetchHelpTree).mockReset().mockResolvedValue([{ id: '1', name: '产品协议', articles: [link] }])
  vi.mocked(fetchFooterArticles).mockReset().mockResolvedValue([])
  vi.mocked(fetchCmsArticle).mockReset().mockResolvedValue(article())
})
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ''; session.clear(); vi.unstubAllGlobals() })

describe('QA-094 agreement readiness is based on the rendered product text', () => {
  it('refuses blank, sanitizer-empty and mismatched product articles', () => {
    for (const body of ['', '<p><br>&nbsp; \u200b</p>', '<script>hidden legal text</script>', '<style>hidden</style>']) expect(publishedAgreementArticle(article(body), link, 'earn')).toBeNull()
    expect(publishedAgreementArticle({ ...article(), title: '用户协议' }, link, 'earn')).toBeNull()
    expect(publishedAgreementArticle({ ...article(), fileName: 'loan-terms' }, link, 'earn')).toBeNull()
    expect(publishedAgreementArticle(article('<p>Real published terms.</p><script>bad()</script>'), link, 'earn')?.content).toBe('<p>Real published terms.</p>')
  })
  it('uses the explicitly published site version when online article content is invalid', async () => {
    vi.mocked(fetchCmsArticle).mockResolvedValue(article('<p><br></p>'))
    app = createApp(BizDialog, { open: true, lang: 'zh', title: '申购', path: '/sapi/v1/simple-earn/flexible/subscribe', fields: [], agree: '我已阅读协议', agreementKind: 'earn' })
    app.mount(host); await flush()
    expect(checkbox().disabled).toBe(false)
    expect(submit().disabled).toBe(true)
    expect(document.querySelector('.agreement')?.getAttribute('data-publication-status')).toBe('invalid')
    expect(document.body.textContent).toContain('当前展示本站')
  })
  it('shows readable terms before enabling consent and revokes earlier consent while language reloads', async () => {
    const state = reactive({ lang: 'zh' as 'zh' | 'en' })
    app = createApp(defineComponent({ setup: () => () => h(BizDialog, { open: true, lang: state.lang, title: '申购', path: '/sapi/v1/simple-earn/flexible/subscribe', fields: [], agree: '我已阅读协议', agreementKind: 'earn' }) }))
    app.mount(host); await flush()
    expect(document.body.textContent).toContain('Published service agreement text')
    expect(checkbox().disabled).toBe(false)
    checkbox().checked = true; checkbox().dispatchEvent(new Event('change', { bubbles: true })); await flush()
    expect(submit().disabled).toBe(false)
    let resolveArticle: (value: CmsArticle) => void = () => { throw new Error('pending article not initialized') }
    vi.mocked(fetchCmsArticle).mockImplementationOnce(() => new Promise((resolve) => { resolveArticle = resolve }))
    state.lang = 'en'; await flush()
    expect(checkbox().disabled).toBe(true)
    expect(checkbox().checked).toBe(false)
    expect(submit().disabled).toBe(true)
    resolveArticle({ ...article(), title: 'Simple Earn Terms' }); await flush()
    expect(checkbox().disabled).toBe(false)
    expect(checkbox().checked).toBe(false)
    expect(submit().disabled).toBe(true)
    expect(fetchCmsArticle).toHaveBeenCalledTimes(2)
  })
  it('identifies the fallback when an online index points to the wrong product article', async () => {
    vi.mocked(fetchCmsArticle).mockResolvedValue({ ...article(), title: 'General Terms' })
    expect(await loadAgreement('earn', new AbortController().signal)).toMatchObject({ source: 'site', cmsStatus: 'invalid', version: '0.1' })
  })
})

describe('QA-100 old pages retain clear server refusals without retrying writes', () => {
  it.each([['-6004', '当前不可申购'], ['-6008', '当前不可赎回']])('explains %s in Chinese and sends one mocked request', async (code, expected) => {
    session.setToken('qa-session')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code, msg: 'Product not in purchase status' }), { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    await expect(businessRequest('/sapi/v1/simple-earn/flexible/subscribe', { amount: '0.1' }, true)).rejects.toThrow(expected)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
