// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App, type Component } from 'vue'
import EarnView from '@/views/business/EarnView.vue'
import LoansView from '@/views/business/LoansView.vue'
import AffiliateView from '@/views/business/AffiliateView.vue'
import VipView from '@/views/business/VipView.vue'
import { bundledAgreement } from '@/modules/business/agreements/published'
import { loadAgreement } from '@/modules/business/agreement'
import { businessRequest } from '@/modules/business/client'
const context = vi.hoisted(() => ({ lang: 'zh', authed: true }))
vi.mock('@/components/business/ui/useBiz', async (original) => {
  const { computed } = await import('vue')
  const { translateForLocale } = await import('@/i18n/composer')
  return { ...await original<typeof import('@/components/business/ui/useBiz')>(),
    useBizContext: () => ({ lang: computed(() => context.lang), authed: computed(() => context.authed), t: (key: string, values?: Record<string, unknown>) => translateForLocale(context.lang, key, values) }),
    useSpotBalances: () => ({ of: () => '1000', reload: vi.fn() }),
  }
})
vi.mock('@/modules/business/client', async (original) => ({ ...await original<typeof import('@/modules/business/client')>(), businessRequest: vi.fn() }))
vi.mock('@/modules/business/agreement', async (original) => ({ ...await original<typeof import('@/modules/business/agreement')>(), loadAgreement: vi.fn(async () => null) }))
vi.mock('@/components/business/ui/BizRecords.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/CoinMark.vue', () => ({ default: { template: '<span />' } }))
let app: App | undefined
let host: HTMLDivElement
let fixtures: Record<string, unknown>
async function flush(): Promise<void> { for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick() } }
async function mount(component: Component): Promise<void> { app = createApp(component); app.mount(host); await flush() }
const button = (text: string): HTMLButtonElement | undefined => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.trim() === text)
beforeEach(() => {
  context.lang = 'zh'; context.authed = true
  host = document.createElement('div'); document.body.append(host)
  fixtures = {}
  vi.mocked(loadAgreement).mockReset().mockResolvedValue(null)
  vi.mocked(businessRequest).mockReset().mockImplementation(async (path) => fixtures[path] ?? {})
})
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })
describe('QA-100/101 real product views use published capability flags', () => {
  it('disables subscription and redemption when the server pauses them', async () => {
    const prefix = '/sapi/v1/simple-earn'
    fixtures[`${prefix}/flexible/list`] = { rows: [{ productId: '1', asset: 'SOL', canPurchase: false, minPurchaseAmount: '0.1', latestAnnualPercentageRate: '0.05' }] }
    fixtures[`${prefix}/locked/list`] = { rows: [{ projectId: '2', detail: { asset: 'BTC', status: 'PURCHASING', canPurchase: false, duration: '1', apr: '0.03' }, quota: { minimum: '0.0001' } }] }
    fixtures[`${prefix}/flexible/position`] = { rows: [{ productId: '1', asset: 'SOL', totalAmount: '1', canRedeem: false }] }
    fixtures[`${prefix}/locked/position`] = { rows: [{ positionId: '2', projectId: '2', asset: 'BTC', amount: '0.0001', status: 'HOLDING', canRedeem: false, canRedeemEarly: false }] }
    await mount(EarnView)
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter((item) => item.textContent?.trim() === '暂停申购')).toHaveLength(2)
    expect(button('暂停申购')?.disabled).toBe(true)
    expect(button('赎回')?.disabled).toBe(true)
    expect(button('全部赎回')?.disabled).toBe(true)
    expect(host.textContent?.match(/赎回已暂停/g)).toHaveLength(2)
    button('暂停申购')?.click(); button('赎回')?.click(); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(vi.mocked(businessRequest).mock.calls.every((call) => call[2] !== true)).toBe(true)
  })
  it('pauses new loans while leaving repayment and collateral controls available', async () => {
    const prefix = '/sapi/v2/loan/flexible'
    fixtures[`${prefix}/loanable/data`] = { rows: [{ loanCoin: 'USDT', canBorrow: false, annualInterestRate: '0.08', flexibleMinLimit: '10', flexibleMaxLimit: '50000' }] }
    fixtures[`${prefix}/collateral/data`] = { rows: [{ collateralCoin: 'BTC', initialLTV: '0.65', marginCallLTV: '0.75', liquidationLTV: '0.85' }] }
    fixtures[`${prefix}/ongoing/orders`] = { rows: [{ loanCoin: 'USDT', collateralCoin: 'BTC', totalDebt: '10', collateralAmount: '0.001', currentLTV: '0.2', status: 'ACTIVE' }] }
    await mount(LoansView)
    expect(button('暂停新借款')?.disabled).toBe(true)
    expect(button('还款')?.disabled).toBe(false)
    expect(button('调整抵押')?.disabled).toBe(false)
    expect(button('全部还清')?.disabled).toBe(false)
    button('暂停新借款')?.click(); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(vi.mocked(businessRequest).mock.calls.every((call) => call[2] !== true)).toBe(true)
  })
})
describe('additional borrowing contract regression', () => {
  it('submits exactly one amount after reading the site rules, never both sizing methods', async () => {
    const prefix = '/sapi/v2/loan/flexible'
    fixtures[`${prefix}/loanable/data`] = { rows: [{ loanCoin: 'USDT', canBorrow: true, annualInterestRate: '0.08', flexibleMinLimit: '10', flexibleMaxLimit: '50000' }] }
    fixtures[`${prefix}/collateral/data`] = { rows: [{ collateralCoin: 'BTC', initialLTV: '0.65', marginCallLTV: '0.75', liquidationLTV: '0.85' }] }
    vi.mocked(loadAgreement).mockResolvedValue({ ...bundledAgreement('loan', 'zh'), source: 'site', version: '0.1', versionDate: '2026-10-30', language: 'zh', cmsStatus: 'missing' })
    await mount(LoansView)
    button('立即借币')!.click(); await flush()
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[inputmode="decimal"]')!
    expect(document.querySelectorAll('[role="dialog"] input[inputmode="decimal"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('所需抵押数量由系统处理时')
    input.value = '10'; input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
    const agree = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!
    expect(agree.disabled).toBe(false)
    agree.checked = true; agree.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    button('确认借币')!.click(); await flush()
    const writes = vi.mocked(businessRequest).mock.calls.filter((call) => call[2] === true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.slice(0, 3)).toEqual([`${prefix}/borrow`, { loanCoin: 'USDT', collateralCoin: 'BTC', loanAmount: '10' }, true])
    expect(writes[0]?.[1]).not.toHaveProperty('collateralAmount')
  })
})

describe('QA-107/108 affiliate follow-up and disabled referral links', () => {
  it('offers a localized supplement flow with previous values and review remark', async () => {
    fixtures['/sapi/v1/affiliate/application'] = { applicationId: '9', status: 'MORE_INFO', channelType: 'website', links: ['https://example.com/channel'], followers: '1200', contact: 'qa-contact', remark: '请补充渠道资料' }
    fixtures['/sapi/v1/affiliate/overview'] = { affiliate: false }
    await mount(AffiliateView)
    expect(host.textContent).toContain('待补充资料')
    expect(host.textContent).toContain('请补充渠道资料')
    button('补充并重新提交')!.click(); await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('补充代理商申请')
    expect(dialog.querySelector<HTMLSelectElement>('select')?.value).toBe('website')
    expect(Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).map((item) => item.value)).toEqual(['https://example.com/channel', '1200', 'qa-contact'])
    expect(vi.mocked(businessRequest).mock.calls.every((call) => call[2] !== true)).toBe(true)
  })
  it('offers a new application for the uppercase rejected state', async () => {
    fixtures['/sapi/v1/affiliate/application'] = { status: 'REJECTED' }
    fixtures['/sapi/v1/affiliate/overview'] = { affiliate: false }
    await mount(AffiliateView)
    expect(button('申请成为代理商')).toBeTruthy()
    expect(host.textContent).toContain('未通过')
  })
  it('renders disabled codes as disabled and prevents copying their link', async () => {
    fixtures['/sapi/v1/affiliate/overview'] = { affiliate: true, tier: 'L1' }
    fixtures['/sapi/v1/affiliate/codes'] = { rows: [{ code: 'QAOFF', enabled: false }, { code: 'QAON', enabled: true }] }
    await mount(AffiliateView)
    const rows = Array.from(host.querySelectorAll<HTMLTableRowElement>('tbody tr'))
    expect(rows.find((row) => row.textContent?.includes('QAOFF'))?.textContent).toContain('已停用')
    expect(rows.find((row) => row.textContent?.includes('QAOFF'))?.querySelector('button')?.disabled).toBe(true)
    expect(rows.find((row) => row.textContent?.includes('QAON'))?.querySelector('button')?.disabled).toBe(false)
  })
})
describe('QA-099 per-tier VIP qualification text', () => {
  it('uses AND/OR separately for each tier and next-tier card', async () => {
    fixtures['/sapi/v1/vip/levels'] = { enabled: true, levels: [{ level: '1', combine: 'OR' }, { level: '2', combine: 'AND' }] }
    fixtures['/sapi/v1/vip/info'] = { vipLevel: '0', next: { level: '2', rule: 'AND', spotVolumeNeeded: '1000' } }
    await mount(VipView)
    const rows = Array.from(host.querySelectorAll('tbody tr'))
    expect(rows[0]?.textContent).toContain('任一满足')
    expect(rows[1]?.textContent).toContain('全部满足')
    expect(host.querySelector('.vip-next')?.textContent).toContain('全部满足')
    expect(host.textContent).not.toContain('或 资产余额')
  })
})
