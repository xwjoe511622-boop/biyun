// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'

/**
 * Futures ⇄ spot transfer dialog (QA 10-26):
 * - 建议-025: 全部 transfers the exact ledger amount; QA-165 displays configured precision and keeps the full title;
 * - 待确认-011: after a successful transfer the refreshed (smaller) balance never flashes 「超过可用余额」 against the
 *   amount that was just sent.
 */
const store = reactive({
  busy: '' as string,
  transferable: '9.9875134075',
  transferHeldProfit: '',
  isOpened: true,
  open: { initFailed: false },
  transfer: vi.fn(),
  loadAssets: vi.fn(async () => undefined),
  refresh: vi.fn(),
})

vi.mock('@/stores/futures-account', () => ({ TRANSFER_PENDING: '__pending__', useFuturesAccountStore: () => store }))
vi.mock('@/modules/api/account.api', () => ({ fetchAccountBalance: vi.fn(async () => ({ allCoinMap: { USDT: { normal_balance: '5', lock_balance: '0' } } })) }))
vi.mock('@/core/toast', () => ({ toastInfo: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }))

const { default: TransferDialog } = await import('@/components/futures/TransferDialog.vue')

let app: App | undefined
let host: HTMLDivElement

beforeEach(() => {
  setActivePinia(createPinia())
  host = document.createElement('div')
  document.body.appendChild(host)
  store.busy = ''
  store.transferable = '9.9875134075'
  store.transfer.mockReset()
})

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

function mount(): void {
  app = createApp(defineComponent({ setup: () => () => h(TransferDialog, { coin: 'USDT', precision: 6, fundsIn: true, fundsOut: true, initial: 'contract_to_wallet' }) }))
  app.use(createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': {} } }))
  app.mount(host)
}

const input = (): HTMLInputElement => document.body.querySelector<HTMLInputElement>('.amount input')!
const allButton = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>('button.all')!
const fieldError = (): string => document.body.querySelector('.field-error')?.textContent ?? ''
const confirmButton = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>('.btn-primary')!

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('futures transfer dialog', () => {
  it('preserves the draft and displays a stopped-direction refusal', async () => {
    store.transfer.mockResolvedValue('该方向已停止划转')
    mount()
    await settle()
    allButton().click()
    await settle()
    confirmButton().click()
    await settle()
    expect(input().value).toBe('9.9875134075')
    expect(document.body.querySelector('[data-testid="fut-transfer-status"]')?.textContent).toContain('该方向已停止划转')
  })

  it('全部 fills the exact ledger amount while 可划转 truncates DOWN at display precision', async () => {
    mount()
    await settle()
    expect(document.body.querySelector('.avail .num')?.textContent).toContain('9.987513 USDT')
    expect(document.body.querySelector('.avail .num')?.getAttribute('title')).toBe('9.9875134075')
    allButton().click()
    await settle()
    expect(input().value).toBe('9.9875134075')
    expect(fieldError()).toBe('')
    expect(confirmButton().disabled).toBe(false)
  })

  it.each([
    ['0.0000000000000001', '0.000000'],
    ['9999999999999999.1234567890123456', '9,999,999,999,999,999.123456'],
    ['0', '0.000000'],
  ])('displays %s without losing the full ledger value', async (exact, shown) => {
    store.transferable = exact
    mount(); await settle()
    expect(document.body.querySelector('.avail .num')?.textContent).toContain(`${shown} USDT`)
    expect(document.body.querySelector('.avail .num')?.getAttribute('title')).toBe(exact)
    allButton().click(); await settle()
    expect(input().value).toBe(exact)
    expect(store.transfer).not.toHaveBeenCalled()
  })

  it('a balance with fewer decimals than the display keeps the display precision', async () => {
    store.transferable = '12.5'
    mount()
    await settle()
    expect(document.body.querySelector('.avail .num')?.textContent).toContain('12.500000')
  })

  it('does not flash an insufficient-balance error after a successful transfer', async () => {
    store.transfer.mockImplementation(async () => {
      // the store reloads the assets before answering: 可划转 is now 0
      store.transferable = '0'
      return null
    })
    mount()
    await settle()
    allButton().click()
    await settle()
    confirmButton().click()
    await nextTick()
    expect(fieldError()).toBe('')
    await settle()
    expect(store.transfer).toHaveBeenCalledWith('contract_to_wallet', '9.9875134075', 'USDT')
    expect(input().value).toBe('')
    expect(fieldError()).toBe('')
  })
})
