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
import * as marginApi from '@/modules/margin/api'
import { normalizeSymbolAccount } from '@/modules/margin/normalize'
import type { MarginSymbolAccount } from '@/modules/margin/types'
import * as transferApi from '@/modules/transfer/api'
import type { FuturesGate, FuturesGateStatus, TransferResult } from '@/modules/transfer/transfer'
import { useMarketStore } from '@/stores/market'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

// Synthetic only: every request is mocked in this suite.
vi.mock('@/modules/margin/api', () => ({ fetchMarginSymbolAccount: vi.fn() }))
vi.mock('@/modules/transfer/api', () => ({ submitTransfer: vi.fn() }))
vi.mock('@/modules/api/account.api', () => ({ fetchAccountBalance: vi.fn(), fetchAccountBalanceV5: vi.fn() }))

const publicInfo = {
  switch: { lever_open: '1' },
  futures_type: '',
  market: {
    coinList: {},
    market: { USDT: { 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: 1, multiple: 3 } } },
  },
} as unknown as PublicInfoV4

const marginAccount = normalizeSymbolAccount({
  symbol: 'btcusdt', name: 'BTC/USDT', baseCoin: 'BTC', quoteCoin: 'USDT',
  baseNormalBalance: '0.2', quoteNormalBalance: '300', baseCanTransfer: '0.1', quoteCanTransfer: '250',
}) as MarginSymbolAccount

let pinia: Pinia
let app: App | null = null
const transferred: TransferResult[] = []

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  transferred.length = 0
  session.setToken('synthetic-transfer-session')
  vi.mocked(accountApi.fetchAccountBalance).mockResolvedValue({ allCoinMap: { USDT: { normal_balance: '120.5' }, BTC: { normal_balance: '1' } } })
  vi.mocked(marginApi.fetchMarginSymbolAccount).mockResolvedValue(marginAccount)
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

async function mount(props: Record<string, unknown>): Promise<{ open: { value: boolean } }> {
  const open = ref(true)
  const Root = defineComponent({
    setup() {
      return () => h(TransferDialog, {
        ...props,
        open: open.value,
        'onUpdate:open': (value: boolean) => { open.value = value },
        onTransferred: (result: TransferResult) => transferred.push(result),
      })
    },
  })
  app = createApp(Root)
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
  return { open }
}

/** Reactive stand-in for the futures account store: `ensureOpened` creates the account silently. */
function makeGate(status: FuturesGateStatus, createOk = true): FuturesGate {
  const gate: FuturesGate = reactive({
    status,
    error: null as string | null,
    initFailed: false,
    ensureOpened: vi.fn(async () => {
      gate.status = 'opening'
      await Promise.resolve()
      if (createOk) {
        gate.status = 'opened'
        return true
      }
      gate.status = 'error'
      gate.error = 'create failed'
      gate.initFailed = true
      return false
    }),
    refresh: vi.fn(async () => {}),
  })
  return gate
}

function el<T extends Element>(selector: string): T {
  const found = document.body.querySelector<T>(selector)
  if (found === null) throw new Error(`missing ${selector}: ${document.body.textContent ?? ''}`)
  return found
}

async function type(value: string): Promise<void> {
  const input = el<HTMLInputElement>('[data-testid="transfer-amount"]')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('blur'))
  await nextTick()
}

describe('TransferDialog', () => {
  it('QA-215 explains a first over-limit input before blur and clears it when corrected', async () => {
    await mount({ from: 'spot', to: 'margin', coin: 'USDT', marginSymbol: 'btcusdt' })
    const input = el<HTMLInputElement>('[data-testid="transfer-amount"]')
    expect(document.body.querySelector('.field-error')).toBeNull()
    input.value = '120.50000001'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(document.body.textContent).toContain('Exceeds the transferable amount 120.5')
    expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(true)
    expect(transferApi.submitTransfer).not.toHaveBeenCalled()
    input.value = '120.5'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(document.body.textContent).not.toContain('Exceeds the transferable amount')
    expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(false)
  })

  it('shows spot availability, limits coins to the margin pair and sends lever/finance/transfer', async () => {
    const { open } = await mount({ from: 'spot', to: 'margin', coin: 'USDT', marginSymbol: 'btcusdt' })
    expect(marginApi.fetchMarginSymbolAccount).toHaveBeenCalledWith('btcusdt')
    const coins = [...el<HTMLSelectElement>('[data-testid="transfer-coin"]').options].map(option => option.value)
    expect(coins).toEqual(['BTC', 'USDT'])
    expect(el('[data-testid="transfer-route"]').textContent).toContain('120.5')

    await type('200')
    expect(document.body.textContent).toContain('Exceeds the transferable amount 120.5')
    expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(true)
    expect(transferApi.submitTransfer).not.toHaveBeenCalled()

    await type('20.5')
    el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
    await flush()
    expect(transferApi.submitTransfer).toHaveBeenCalledWith({
      path: 'lever/finance/transfer',
      body: { fromAccount: '1', toAccount: '2', amount: '20.5', coinSymbol: 'USDT', symbol: 'btcusdt', requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) },
    })
    expect(transferred).toEqual([{ from: 'spot', to: 'margin', coin: 'USDT', amount: '20.5', marginSymbol: 'btcusdt' }])
    expect(open.value).toBe(false)
  })

  it('reloads the shared futures balance after a confirmed generic transfer', async () => {
    const gate = makeGate('opened')
    const balance = ref('9')
    gate.refresh = vi.fn(async () => { balance.value = '10' })
    const { open } = await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '9', futuresGate: gate })
    const before = vi.mocked(gate.refresh).mock.calls.length
    const input = el<HTMLInputElement>('[data-testid="transfer-amount"]')
    input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
    await flush()
    expect(transferred).toHaveLength(1)
    expect(vi.mocked(gate.refresh).mock.calls.length).toBe(before + 1)
    expect(balance.value).toBe('10')
    expect(open.value).toBe(false)
  })

  it('does not report a confirmed transfer as failed if its follow-up balance read fails', async () => {
    const gate = makeGate('opened')
    const { open } = await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '9', futuresGate: gate })
    vi.mocked(gate.refresh).mockRejectedValueOnce(new Error('synthetic read unavailable'))
    const input = el<HTMLInputElement>('[data-testid="transfer-amount"]')
    input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
    await flush()
    expect(transferred).toHaveLength(1)
    expect(open.value).toBe(false)
  })

  it('swaps direction and uses the server-computed margin transferable amount for max', async () => {
    await mount({ from: 'spot', to: 'margin', coin: 'USDT', marginSymbol: 'btcusdt' })
    el<HTMLButtonElement>('[data-testid="transfer-swap"]').click()
    await flush()
    expect(el<HTMLSelectElement>('[data-testid="transfer-from"]').value).toBe('margin')
    expect(el<HTMLSelectElement>('[data-testid="transfer-to"]').value).toBe('spot')
    const max = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Max')
    max?.click()
    await nextTick()
    expect(el<HTMLInputElement>('[data-testid="transfer-amount"]').value).toBe('250')
    el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
    await flush()
    expect(transferApi.submitTransfer).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ fromAccount: '2', toAccount: '1', amount: '250' }) }))
  })

  it('routes spot → futures to contract/co_transfer and surfaces server errors without closing', async () => {
    vi.mocked(transferApi.submitTransfer).mockRejectedValueOnce(new ApiError({ kind: 'api', code: '10039', message: 'Transfer failed' }))
    const { open } = await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresAvailable: '9', futuresGate: makeGate('opened') })
    expect([...el<HTMLSelectElement>('[data-testid="transfer-coin"]').options].map(option => option.value)).toEqual(['USDT'])
    await type('5')
    el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
    await flush()
    expect(transferApi.submitTransfer).toHaveBeenCalledWith({ path: 'contract/co_transfer', body: { transferType: 'wallet_to_contract', amount: '5', coinSymbol: 'USDT' } })
    expect(el('[data-testid="transfer-submit-error"]').textContent).toContain('Transfer failed')
    expect(open.value).toBe(true)
    expect(transferred).toHaveLength(0)
  })

  it('hides the futures account unless the caller enables it', async () => {
    await mount({ coin: 'USDT' })
    const options = [...el<HTMLSelectElement>('[data-testid="transfer-from"]').options].map(option => option.value)
    expect(options).toEqual(['spot', 'margin'])
  })

  describe('futures account (every user has one by default; no open-account UI)', () => {
    function noOpenPrompt(): void {
      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(/open a futures account|开通|agree|risk/i)
      expect(document.body.querySelector('input[type="checkbox"]')).toBeNull()
    }

    it('not opened yet → creates it silently when the dialog opens, then the transfer proceeds', async () => {
      const gate = makeGate('unopened')
      await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresGate: gate })
      expect(gate.ensureOpened).toHaveBeenCalledTimes(1)
      noOpenPrompt()
      expect(document.body.querySelector('[data-testid="transfer-futures-gate"]')).toBeNull()
      await type('5')
      el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
      await flush()
      expect(transferApi.submitTransfer).toHaveBeenCalledWith({ path: 'contract/co_transfer', body: { transferType: 'wallet_to_contract', amount: '5', coinSymbol: 'USDT' } })
    })

    it('waits (fail closed) while the account is being checked or created, without any prompt', async () => {
      await mount({ from: 'futures', to: 'spot', coin: 'USDT', futuresEnabled: true, futuresAvailable: '9', futuresGate: makeGate('checking') })
      expect(el('[data-testid="transfer-futures-gate"]').getAttribute('data-state')).toBe('preparing')
      noOpenPrompt()
      await type('1')
      expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(true)
    })

    it('105001 → silent create + exactly one retry, dialog closes on success', async () => {
      vi.mocked(transferApi.submitTransfer).mockRejectedValueOnce(new ApiError({ kind: 'api', code: '105001', message: '合约资金划转失败' }))
      const gate = makeGate('opened')
      const { open } = await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresGate: gate })
      await type('5')
      el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
      await flush()
      expect(gate.ensureOpened).toHaveBeenCalledWith(true)
      expect(transferApi.submitTransfer).toHaveBeenCalledTimes(2)
      expect(transferred).toHaveLength(1)
      expect(open.value).toBe(false)
      noOpenPrompt()
    })

    it('105001 and the silent create fails → plain init error with retry, one request only, fails closed', async () => {
      vi.mocked(transferApi.submitTransfer).mockRejectedValueOnce(new ApiError({ kind: 'api', code: '105001', message: '合约资金划转失败' }))
      const gate = makeGate('opened', false)
      const { open } = await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresGate: gate })
      await type('5')
      el<HTMLButtonElement>('[data-testid="transfer-submit"]').click()
      await flush()
      expect(transferApi.submitTransfer).toHaveBeenCalledTimes(1)
      const panel = el('[data-testid="transfer-futures-gate"]')
      expect(panel.getAttribute('data-state')).toBe('error')
      expect(panel.textContent).toContain('Futures account setup failed. Please try again later.')
      noOpenPrompt()
      expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(true)
      expect(open.value).toBe(true)
      el<HTMLButtonElement>('[data-testid="transfer-futures-retry"]').click()
      await flush()
      expect(gate.refresh).toHaveBeenCalled()
    })

    it('a failed status check fails closed with a retry', async () => {
      const gate = makeGate('error')
      gate.error = 'network down'
      await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true, futuresGate: gate })
      expect(gate.refresh).toHaveBeenCalledTimes(1)
      expect(el('[data-testid="transfer-futures-gate"]').textContent).toContain('network down')
      await type('5')
      expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(true)
    })

    it('fails closed without any gate (status unknown)', async () => {
      await mount({ from: 'spot', to: 'futures', coin: 'USDT', futuresEnabled: true })
      expect(el('[data-testid="transfer-futures-gate"]').getAttribute('data-state')).toBe('preparing')
      await type('5')
      expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(true)
    })

    it('does not affect spot ↔ margin', async () => {
      await mount({ from: 'spot', to: 'margin', coin: 'USDT', marginSymbol: 'btcusdt', futuresEnabled: true, futuresGate: makeGate('checking') })
      expect(document.body.querySelector('[data-testid="transfer-futures-gate"]')).toBeNull()
      await type('5')
      expect(el<HTMLButtonElement>('[data-testid="transfer-submit"]').disabled).toBe(false)
    })
  })
})
