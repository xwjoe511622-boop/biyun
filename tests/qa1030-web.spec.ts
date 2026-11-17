// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import BizDialog from '@/components/business/ui/BizDialog.vue'
import { utcTimestamp } from '@/core/swr'
import { dateBoundary, formatDateTime as orderTime, toServerDate } from '@/components/orders/model'
import { formatDateTime as futuresTime } from '@/modules/futures/format'
import { formatClock } from '@/modules/finance/display'
import { dateTime } from '@/modules/business/format'
import { normalizeAssets } from '@/modules/futures/types'
import { validateAmount } from '@/modules/futures/math'
import { validateTransfer } from '@/modules/transfer/transfer'
import { selectAgreement } from '@/modules/business/agreement'
import * as agreementApi from '@/modules/business/agreement'
import { businessRequest, type BusinessRow } from '@/modules/business/client'

vi.mock('@/modules/business/client', async (original) => ({
  ...await original<typeof import('@/modules/business/client')>(), businessRequest: vi.fn(),
}))

let app: App | null = null
afterEach(() => {
  app?.unmount(); app = null
  document.body.innerHTML = ''
  vi.useRealTimers(); vi.restoreAllMocks()
})

describe('QA-090 UTC timestamps and date filters', () => {
  it('uses the same UTC instant for optimistic rows, orders, futures and latest trades', () => {
    const ms = Date.parse('2026-10-27T14:49:59Z')
    expect(utcTimestamp(new Date(ms))).toBe('2026-10-27 14:49:59')
    expect(orderTime(ms)).toBe('2026-10-27 14:49:59')
    expect(futuresTime(ms)).toBe('2026-10-27 14:49:59')
    expect(formatClock(String(ms))).toBe('14:49:59')
    expect(dateTime('2026-10-27 14:49:59')).toBe('2026-10-27 14:49')
    expect(dateTime('2026-10-27T22:49:59+08:00')).toBe('2026-10-27 14:49')
  })
  it('keeps the selected UTC day when constructing server filters', () => {
    expect(toServerDate('2026-10-29')).toBe('2026-10-29 00:00:00')
    expect(toServerDate('2026-10-29', true)).toBe('2026-10-29 23:59:59')
    expect(orderTime(undefined)).toBe('--')
    expect(dateBoundary('2026-02-30')).toBeNull()
    expect(toServerDate('2026-03-08')).toBe('2026-03-08 00:00:00')
    expect(toServerDate('2026-03-08', true)).toBe('2026-03-08 23:59:59')
  })
})

describe('QA-122 account PnL is separate from equity and current positions', () => {
  it('preserves exact cumulative close PnL and never substitutes current-position zero', () => {
    const accounts = normalizeAssets({ accountList: [{ symbol: 'USDT', realizedAmount: '0', totalAmount: '123456.78', cumulativeClosedPnl: '-0.0735000000000001' }] }).accounts
    expect(accounts[0]?.cumulativeClosedPnl).toBe('-0.0735000000000001')
    expect(accounts[0]?.realizedAmount).toBe('0')
    expect(accounts[0]?.totalAmount).toBe('123456.78')
    expect(normalizeAssets({ accountList: [{ symbol: 'USDT', realizedAmount: '0' }] }).accounts[0]?.cumulativeClosedPnl).toBe('')
  })
})

describe('QA-127 error amounts keep decimal precision and grouping', () => {
  it('formats the limit without changing the requested amount or comparisons', () => {
    const limit = '1799749.0200000000000001'
    const result = validateAmount('9999999', limit, 16)
    expect(result.params?.available).toBe('1,799,749.0200000000000001')
    expect(result.amount).toBe('9999999')
    expect(validateAmount(limit, limit, 16).ok).toBe(true)
    const transfer = validateTransfer({ from: 'spot', to: 'margin', coin: 'USDT', amount: '9999999', marginSymbol: 'btcusdt' }, { available: limit, precision: 16 })
    expect(transfer.errors.find(error => error.key === 'insufficient')?.params?.available).toBe('1,799,749.0200000000000001')
  })
})

describe('QA-094 published product agreements', () => {
  it('requires one exact product agreement and refuses general terms or ambiguous versions', () => {
    const earn = { id: '1', title: '理财服务协议', fileName: 'earn-terms' }
    expect(selectAgreement([earn], 'earn')).toEqual(earn)
    expect(selectAgreement([earn, earn], 'earn')).toEqual(earn)
    expect(selectAgreement([earn, { ...earn, id: '2', fileName: 'earn-terms-new' }], 'earn')).toBeNull()
    expect(selectAgreement([{ id: '3', title: '用户协议', fileName: 'terms' }], 'earn')).toBeNull()
    expect(selectAgreement([earn], 'loan')).toBeNull()
  })
  it('keeps confirmation unavailable if no readable publication can be returned', async () => {
    vi.spyOn(agreementApi, 'loadAgreement').mockResolvedValue(null)
    const host = document.createElement('div'); document.body.appendChild(host)
    app = createApp(BizDialog, { open: true, lang: 'zh', title: '申购', path: '/sapi/v1/simple-earn/flexible/subscribe', fields: [], agree: '我已阅读并同意理财服务协议', agreementKind: 'earn' })
    app.mount(host)
    await nextTick(); await Promise.resolve(); await nextTick()
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox?.disabled).toBe(true)
    expect(document.body.textContent).toContain('产品规则暂时无法读取')
    expect(document.querySelector<HTMLButtonElement>('.btn-block')?.disabled).toBe(true)
    expect(businessRequest).not.toHaveBeenCalled()
  })
})

describe('QA-095 locked subscription preview', () => {
  it('renders the documented array response and removes stale preview when amount becomes invalid', async () => {
    vi.useFakeTimers()
    vi.mocked(businessRequest).mockResolvedValue([{ totalRewardAmt: '0.00000001', valueDate: '2026-10-30', deliverDate: '2026-10-31' }])
    const host = document.createElement('div'); document.body.appendChild(host)
    app = createApp(BizDialog, { open: true, lang: 'zh', title: '定期申购', path: '/sapi/v1/simple-earn/locked/subscribe', fixed: { projectId: '2' },
      fields: [{ key: 'amount', label: '数量', kind: 'amount', asset: 'BTC' }],
      preview: { path: '/sapi/v1/simple-earn/locked/subscriptionPreview', keys: ['projectId', 'amount'], render: (row: BusinessRow) => [
        { label: '预计收益', value: String(row.totalRewardAmt) }, { label: '起息日', value: String(row.valueDate) }, { label: '到期日', value: String(row.deliverDate) },
      ] },
    })
    app.mount(host)
    const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
    input.value = '0.0001'; input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick(); await vi.advanceTimersByTimeAsync(350); await nextTick()
    expect(document.querySelector('.dlg-preview')?.textContent).toContain('0.00000001')
    expect(document.querySelector('.dlg-preview')?.textContent).toContain('2026-10-31')
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    expect(document.querySelector('.dlg-preview')).toBeNull()
  })
})


describe('QA-095 an overtaken preview cannot restore old amounts', () => {
  it('ignores an already in-flight response after the amount is cleared', async () => {
    vi.useFakeTimers()
    let resolvePreview: (value: unknown) => void = () => { throw new Error('preview not initialized') }
    vi.mocked(businessRequest).mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve }))
    const host = document.createElement('div'); document.body.appendChild(host)
    app = createApp(BizDialog, { open: true, lang: 'zh', title: '定期申购', path: '/sapi/v1/simple-earn/locked/subscribe', fields: [{ key: 'amount', label: '数量', kind: 'amount' }],
      preview: { path: '/sapi/v1/simple-earn/locked/subscriptionPreview', keys: ['amount'], render: (row: BusinessRow) => [{ label: '预计收益', value: String(row.totalRewardAmt) }] } })
    app.mount(host)
    const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
    input.value = '0.1'; input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick(); await vi.advanceTimersByTimeAsync(350)
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    resolvePreview([{ totalRewardAmt: '0.000001' }]); await Promise.resolve(); await nextTick()
    expect(document.querySelector('.dlg-preview')).toBeNull()
  })
})
