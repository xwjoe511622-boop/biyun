// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import TransferDialog from '@/components/transfer/TransferDialog.vue'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import * as accountApi from '@/modules/api/account.api'
import type { PublicInfoV4 } from '@/modules/api/types'
import { emptyMessageFallback } from '@/modules/api/empty-message'
import * as transferApi from '@/modules/transfer/api'
import { describeFuturesGateError, describeTransferError, isPlaceholderMessage } from '@/modules/transfer/errors'
import type { FuturesGate } from '@/modules/transfer/transfer'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

// Synthetic only: every request is mocked in this suite (incident 2026-09-29: raw「接口返回错误码 -1」in 资金划转).
vi.mock('@/modules/margin/api', () => ({ fetchMarginSymbolAccount: vi.fn() }))
vi.mock('@/modules/transfer/api', () => ({ submitTransfer: vi.fn() }))
vi.mock('@/modules/api/account.api', () => ({ fetchAccountBalance: vi.fn(), fetchAccountBalanceV5: vi.fn() }))

const api = (code: string, message = '', kind: 'api' | 'unauthorized' | 'http' | 'network' | 'timeout' | 'parse' = 'api', status?: number): ApiError =>
  new ApiError({ kind, code, message, status })

describe('describeTransferError', () => {
  it('never shows a bare -1: legacy code-less refusal says nothing moved', () => {
    const view = describeTransferError(api('-1', '接口返回错误码 -1'), 'zh_CN')
    expect(view.kind).toBe('refused')
    expect(view.text).toContain('资金未变动')
    expect(view.text).not.toMatch(/错误码 -1/)
    expect(describeTransferError(api('-1'), 'en_US').text).toContain('nothing moved')
  })

  it('maps the coded refusals of the cotransfer-msg web-api', () => {
    expect(describeTransferError(api('10034', '可用余额不足，划转未执行，资金未变动'), 'zh_CN').text).toBe('可用余额不足，划转未执行，资金未变动')
    expect(describeTransferError(api('105003'), 'zh_CN').text).toContain('可转出额度')
    expect(describeTransferError(api('105004'), 'zh_CN').text).toContain('累计转入')
    expect(describeTransferError(api('105002'), 'zh_CN').kind).toBe('refused')
    expect(describeTransferError(api('105000', '合约资金划转失败！'), 'zh_CN')).toMatchObject({ kind: 'pending', text: expect.stringContaining('请勿重复提交') })
  })

  it('session expiry (spot 110009 / 10002, or kind unauthorized) asks to log in again', () => {
    for (const error of [api('110009', 'Login credentials expired', 'unauthorized'), api('10002', '用户未登陆'), api('401', '', 'unauthorized', 401)]) {
      expect(describeTransferError(error, 'zh_CN')).toMatchObject({ kind: 'session', text: '登录已过期，请重新登录后再划转' })
    }
  })

  it('transport failures: unknown result (do not resubmit) vs service unavailable', () => {
    expect(describeTransferError(api('', '网络请求失败', 'network'), 'zh_CN')).toMatchObject({ kind: 'unknownResult', text: expect.stringContaining('不要重复提交') })
    expect(describeTransferError(api('502', 'HTTP 502', 'http', 502), 'zh_CN').kind).toBe('unavailable')
    expect(describeTransferError(api('', 'not json', 'parse'), 'zh_CN').kind).toBe('unavailable')
  })

  it('rate limits use the guard text; other codes keep a real server message or say the code in words', () => {
    expect(describeTransferError(api('-1003', '请求过于频繁 / Too many', 'http', 429), 'zh_CN').kind).toBe('rate')
    expect(describeTransferError(api('10039', '划转已关闭'), 'zh_CN').text).toBe('划转已关闭')
    expect(describeTransferError(api('12345', '接口返回错误码 12345'), 'zh_CN').text).toBe('划转失败（代码 12345），请稍后重试')
  })

  it('placeholder detection matches only the http fallback text', () => {
    expect(isPlaceholderMessage('接口返回错误码 -1')).toBe(true)
    expect(isPlaceholderMessage('Request failed (code 7)')).toBe(true)
    expect(isPlaceholderMessage('')).toBe(true)
    expect(isPlaceholderMessage('余额不足')).toBe(false)
  })

  it('the http layer itself never produces「接口返回错误码 -1」', () => {
    expect(emptyMessageFallback('default', '-1', 'zh_CN')).toBe('请求未执行（服务端未返回原因），请稍后重试')
    expect(emptyMessageFallback('futures', '-1', 'en_US')).toContain('not executed')
  })
})

describe('describeFuturesGateError', () => {
  it('futures 10002 with the spot session gone → re-login; spot still valid → futures-side retry', () => {
    expect(describeFuturesGateError(api('10002', '用户未登陆', 'unauthorized'), 'zh_CN', false)).toMatchObject({ kind: 'session', text: '登录已过期，请重新登录后再划转' })
    expect(describeFuturesGateError(api('10002', '用户未登陆', 'unauthorized'), 'zh_CN', true).kind).toBe('futuresAuth')
  })

  it('restart / gateway / not-an-API failures → service unavailable; -1 or placeholder → words with the code', () => {
    expect(describeFuturesGateError(api('502', 'HTTP 502', 'http', 502), 'zh_CN', true).text).toContain('合约服务暂时不可用')
    expect(describeFuturesGateError(new Error('futures contracts unavailable'), 'zh_CN', true).kind).toBe('unavailable')
    expect(describeFuturesGateError(api('-1', '接口返回错误码 -1'), 'zh_CN', true).text).toBe('合约服务返回异常（代码 -1），请稍后重试')
    expect(describeFuturesGateError(api('200002', '系统异常'), 'zh_CN', true).text).toBe('系统异常')
  })
})

/* ------------------------------------------------------------------ dialog */

const publicInfo = { switch: {}, futures_type: '', market: { coinList: {}, market: {} } } as unknown as PublicInfoV4
let pinia: Pinia
let app: App | null = null

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  session.setToken('synthetic-transfer-errors')
  vi.mocked(accountApi.fetchAccountBalance).mockResolvedValue({ allCoinMap: { USDT: { normal_balance: '20000' } } })
  vi.mocked(transferApi.submitTransfer).mockResolvedValue(undefined)
  useMarketStore().publicInfo = publicInfo
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  session.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

function gate(extra: Partial<FuturesGate> = {}): FuturesGate {
  return reactive({ status: 'opened', error: null, initFailed: false, ensureOpened: vi.fn(async () => true), refresh: vi.fn(async () => {}), ...extra }) as FuturesGate
}

async function mount(props: Record<string, unknown>): Promise<{ open: { value: boolean } }> {
  const open = ref(true)
  const Root = defineComponent({
    setup() {
      return () => h(TransferDialog, { ...props, open: open.value, 'onUpdate:open': (value: boolean) => { open.value = value } })
    },
  })
  app = createApp(Root)
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  app.component('RouterLink', defineComponent({ props: { to: { type: String, required: true } }, setup(p, { slots }) { return () => h('a', { href: p.to }, slots.default?.()) } }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
  return { open }
}

const el = <T extends Element>(selector: string): T => {
  const found = document.body.querySelector<T>(selector)
  if (found === null) throw new Error(`missing ${selector}: ${document.body.textContent ?? ''}`)
  return found
}

async function submit(amount: string): Promise<void> {
  const input = el<HTMLInputElement>('[data-testid="transfer-amount"]')
  input.value = amount
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
  await flush()
}

describe('TransferDialog error display (2026-09-29)', () => {
  it('re-reads the spot balance every time it opens (a stale snapshot let the server refuse with -1)', async () => {
    await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '5', futuresGate: gate() })
    expect(accountApi.fetchAccountBalance).toHaveBeenCalledTimes(1)
    app?.unmount(); app = null
    await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '5', futuresGate: gate() })
    expect(accountApi.fetchAccountBalance).toHaveBeenCalledTimes(2)
  })

  it('a legacy -1 answer shows a clear Chinese line, never「接口返回错误码 -1」', async () => {
    vi.mocked(transferApi.submitTransfer).mockRejectedValueOnce(api('-1', '接口返回错误码 -1'))
    const { open } = await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '5', futuresGate: gate() })
    await submit('10000')
    const text = el('[data-testid="transfer-submit-error"]').textContent ?? ''
    expect(text).toContain('资金未变动')
    expect(text).not.toContain('错误码 -1')
    expect(open.value).toBe(true)
    expect(document.body.querySelector('[data-testid="transfer-relogin"]')).toBeNull()
  })

  it('session expiry on submit → 重新登录 prompt with a link to /login', async () => {
    vi.mocked(transferApi.submitTransfer).mockRejectedValueOnce(api('110009', 'Login credentials expired, please log in again', 'unauthorized'))
    await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '5', futuresGate: gate() })
    await submit('10')
    const prompt = el('[data-testid="transfer-relogin"]')
    expect(prompt.textContent).toContain('登录已过期')
    expect(prompt.querySelector('a')?.getAttribute('href')).toBe('/login')
  })

  it('unknown futures balance with a load error → says why next to「合约账户 --」, retry calls the gate', async () => {
    const g = gate({ balanceError: '合约服务暂时不可用（可能正在维护），请稍后重试' })
    await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresGate: g })
    expect(el('[data-testid="transfer-futures-balance-error"]').textContent).toContain('合约账户余额暂时无法获取')
    el<HTMLButtonElement>('[data-testid="transfer-futures-balance-retry"]').click()
    expect(g.refresh).toHaveBeenCalled()
  })
})


describe('QA1102 frozen transfer refusal', () => {
  it('maps the verified pre-debit USER_LOCK code without submitting a transfer', () => {
    const error = new ApiError({ kind: 'api', code: '100102', message: 'ParameterError' })
    expect(describeTransferError(error, 'zh-CN')).toMatchObject({ kind: 'refused', code: '100102', text: '账户交易已被冻结，划转未执行，资金未变动' })
    expect(describeTransferError(error, 'en-US').text).toContain('Nothing was transferred')
  })
})
