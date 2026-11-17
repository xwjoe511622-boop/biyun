<script setup lang="ts">
/**
 * TransferDialog — the one internal-transfer dialog for spot ↔ margin and spot ↔ futures.
 *
 * Usage (assets page, margin page, futures page):
 *
 *   <TransferDialog
 *     v-model:open="transferOpen"
 *     from="spot" to="futures" coin="USDT"
 *     :futures-enabled="true"
 *     :futures-available="futuresUsdtAvailable"
 *     @transferred="reloadBalances"
 *   />
 *
 * Props
 *   open             (v-model:open) visibility.
 *   from / to        initial accounts: 'spot' | 'margin' | 'futures'. Defaults: spot → margin (or futures
 *                    when margin is not offered). The user can change both and swap them.
 *   coin             initial coin (upper case). Falls back to the first coin the route supports.
 *   marginSymbol     initial margin pair, lower-case server symbol (`btcusdt`). Defaults to the margin
 *                    page's pair, else the first margin pair from public info.
 *   accounts         accounts offered in the selectors. Default: spot, margin (when any pair has
 *                    margin enabled) and futures (when `futuresEnabled`).
 *   futuresEnabled   show the futures account (default false — only pages that own futures data opt in).
 *   futuresAvailable the futures account's transferable balance of `coin`, supplied by the futures page.
 *                    Without it no client-side max is applied for futures → spot and the server decides.
 *   futuresCoins     coins the futures account accepts (default ['USDT']).
 *   futuresGate      futures account state + actions (`FuturesGate`, usually the futures account store).
 *                    Every user has a futures account by default: the dialog never asks to open one. A
 *                    route touching futures waits until `status === 'opened'` (not opened → the gate creates
 *                    it silently); without a gate the futures side stays blocked (fail closed). A 105001
 *                    answer (no futures account, nothing debited) → silent `ensureOpened(true)` and exactly
 *                    one retry. Only a failed silent creation is shown, as a plain error with retry.
 *
 * Emits
 *   update:open(false)  on close / success.
 *   transferred({ from, to, coin, amount, marginSymbol }) after the server answered code "0".
 *
 * Requests: spot↔margin → POST lever/finance/transfer, spot↔futures → POST contract/co_transfer
 * (see `@/modules/transfer/transfer.ts` for the contract). Nothing is sent before validation passes.
 */
import { computed, ref, shallowRef, watch } from 'vue'
import { ArrowUpDown } from '@lucide/vue'
import DialogShell from './DialogShell.vue'
import { isApiError } from '@/core/errors'
import { canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { fetchMarginSymbolAccount } from '@/modules/margin/api'
import { displayAmount } from '@/modules/margin/risk'
import type { MarginSymbolAccount } from '@/modules/margin/types'
import { availableBalance, findCoinBalance } from '@/modules/market/symbols'
import { submitTransfer } from '@/modules/transfer/api'
import { DraftRequestId } from '@/modules/api/draft-request-id'
import { describeTransferError } from '@/modules/transfer/errors'
import { requestLanguage } from '@/modules/api/http'
import { useI18n } from 'vue-i18n'
import { useTransferI18n } from '@/modules/transfer/i18n'
import { toastSuccess } from '@/core/toast'
import {
  ALL_TRANSFER_ACCOUNTS,
  buildTransferRequest,
  futuresGateView,
  futuresOutboundSupported,
  TRANSFER_CODE_FUTURES_NOT_OPENED,
  validateTransfer,
  type FuturesGate,
  type TransferAccount,
  type TransferResult,
} from '@/modules/transfer/transfer'
import { useAccountStore } from '@/stores/account'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

const TRANSFER_PRECISION = 8
/** Spot ⇄ futures moves the exact ledger amount (DECIMAL(32,16); user-api co_transfer and the trading core take 16
 *  decimals): 全部 must not leave dust (建议-025, 10-26). Margin keeps 8. */
const FUTURES_TRANSFER_PRECISION = 16

const props = withDefaults(defineProps<{
  open: boolean
  from?: TransferAccount
  to?: TransferAccount
  coin?: string
  marginSymbol?: string
  accounts?: TransferAccount[]
  futuresEnabled?: boolean
  futuresAvailable?: string
  futuresCoins?: string[]
  futuresGate?: FuturesGate
}>(), {
  from: undefined,
  to: undefined,
  coin: '',
  marginSymbol: '',
  accounts: undefined,
  futuresEnabled: false,
  futuresAvailable: undefined,
  futuresCoins: () => ['USDT'],
  futuresGate: undefined,
})

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void
  (event: 'transferred', result: TransferResult): void
}>()

const { t } = useTransferI18n()
// Shared keys (common.*) live in the global messages; the local scope would warn on every lookup.
const { t: gt } = useI18n({ useScope: 'global' })
const account = useAccountStore()
const market = useMarketStore()
const margin = useMarginStore()

const from = ref<TransferAccount>('spot')
const to = ref<TransferAccount>('margin')
const coin = ref('')
const amount = ref('')
const pairSymbol = ref('')
const touched = ref(false)
const submitting = ref(false)
const submitError = ref<string | null>(null)
/** The last submit failed because the session is gone (10002 / 110009): offer 重新登录 instead of a code. */
const submitSessionExpired = ref(false)
const sessionStore = useSessionStore()
const needsLogin = computed(() => submitSessionExpired.value || !sessionStore.isAuthenticated)

const marginAccount = shallowRef<MarginSymbolAccount | null>(null)
const marginLoading = ref(false)
const marginError = ref<string | null>(null)
let marginVersion = 0

const futuresType = computed(() => {
  const raw = market.publicInfo?.futures_type ?? market.publicInfo?.futuresType
  return typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw)
})

const offered = computed<TransferAccount[]>(() => {
  const base = props.accounts ?? ALL_TRANSFER_ACCOUNTS
  return base.filter((entry) => {
    if (entry === 'margin') return margin.markets.length > 0
    if (entry === 'futures') return props.futuresEnabled
    return true
  })
})

const involvesMargin = computed(() => from.value === 'margin' || to.value === 'margin')
const involvesFutures = computed(() => from.value === 'futures' || to.value === 'futures')

const precision = computed(() => (involvesFutures.value && !involvesMargin.value ? FUTURES_TRANSFER_PRECISION : TRANSFER_PRECISION))

const pairOptions = computed(() => margin.markets.map(entry => ({ symbol: entry.symbol.symbol, pair: entry.symbol.pair, base: entry.symbol.base, quote: entry.symbol.quote })))
const currentPair = computed(() => pairOptions.value.find(option => option.symbol === pairSymbol.value))

const coinOptions = computed<string[]>(() => {
  if (involvesMargin.value) {
    const pair = currentPair.value
    return pair === undefined ? [] : [pair.base, pair.quote]
  }
  if (involvesFutures.value) return props.futuresCoins.map(entry => entry.toUpperCase())
  return []
})

function spotAvailable(symbol: string): string {
  return availableBalance(findCoinBalance(account.allCoinMap, symbol))
}

function marginTransferable(symbol: string): string {
  const acc = marginAccount.value
  if (acc === null) return ''
  if (symbol === acc.baseCoin) return acc.baseCanTransfer
  if (symbol === acc.quoteCoin) return acc.quoteCanTransfer
  return ''
}

function marginNormal(symbol: string): string {
  const acc = marginAccount.value
  if (acc === null) return ''
  if (symbol === acc.baseCoin) return acc.baseNormalBalance
  if (symbol === acc.quoteCoin) return acc.quoteNormalBalance
  return ''
}

/** Balance shown under each account selector: what can leave (source) or what is already there (target). */
function balanceOf(target: TransferAccount, asSource: boolean): string {
  if (coin.value === '') return ''
  if (target === 'spot') return spotAvailable(coin.value)
  if (target === 'margin') return asSource ? marginTransferable(coin.value) : marginNormal(coin.value)
  return props.futuresAvailable !== undefined ? canonicalDecimal(props.futuresAvailable) : ''
}

const sourceAvailable = computed(() => balanceOf(from.value, true))
const targetBalance = computed(() => balanceOf(to.value, false))

const validation = computed(() => validateTransfer(
  { from: from.value, to: to.value, coin: coin.value, amount: amount.value, marginSymbol: pairSymbol.value },
  {
    available: sourceAvailable.value,
    precision: precision.value,
    futuresType: futuresType.value,
    allowedCoins: coinOptions.value,
  },
))

const routeError = computed(() => validation.value.errors.find(entry => entry.field === 'route' || entry.field === 'symbol' || entry.field === 'coin'))
const amountError = computed(() => validation.value.errors.find(entry => entry.field === 'amount'))
const sourceReady = computed(() => {
  if (from.value === 'spot') return account.data !== null && !account.loading
  if (from.value === 'margin') return marginAccount.value !== null && !marginLoading.value
  return true
})
const gateView = computed(() => futuresGateView(involvesFutures.value, props.futuresGate?.status))
const canSubmit = computed(() => validation.value.ok && sourceReady.value && gateView.value === 'ok' && !submitting.value)

function retryGate(): void {
  void props.futuresGate?.refresh()
}

function display(value: string): string {
  return displayAmount(value, precision.value)
}

function errorText(entry: { key: string; params?: Record<string, string | number> } | undefined): string {
  return entry === undefined ? '' : t(`transfer.error.${entry.key}`, entry.params ?? {})
}

async function loadMarginAccount(): Promise<void> {
  const symbol = pairSymbol.value
  const version = ++marginVersion
  marginAccount.value = null
  marginError.value = null
  if (!involvesMargin.value || symbol === '') return
  marginLoading.value = true
  try {
    const next = await fetchMarginSymbolAccount(symbol)
    if (version === marginVersion) marginAccount.value = next
  } catch (error_) {
    if (version === marginVersion) marginError.value = isApiError(error_) || error_ instanceof Error ? error_.message : String(error_)
  } finally {
    if (version === marginVersion) marginLoading.value = false
  }
}

function pickDefaultAccounts(): void {
  const list = offered.value
  const start = props.from !== undefined && list.includes(props.from) ? props.from : 'spot'
  let end: TransferAccount | undefined = props.to !== undefined && list.includes(props.to) ? props.to : undefined
  if (end === undefined || end === start) {
    end = list.find(entry => entry !== start && (start === 'spot' || entry === 'spot')) ?? list.find(entry => entry !== start) ?? 'spot'
  }
  from.value = start
  to.value = end
}

function pickCoin(): void {
  const options = coinOptions.value
  const wanted = props.coin.toUpperCase()
  if (options.length === 0) {
    coin.value = wanted
    return
  }
  if (!options.includes(coin.value)) {
    coin.value = options.includes(wanted) ? wanted : options[options.length - 1]
  }
}

function initialise(): void {
  pickDefaultAccounts()
  const wantedPair = props.marginSymbol.toLowerCase()
  pairSymbol.value = pairOptions.value.some(option => option.symbol === wantedPair)
    ? wantedPair
    : (margin.currentSymbol !== '' ? margin.currentSymbol : pairOptions.value[0]?.symbol ?? '')
  coin.value = props.coin.toUpperCase()
  pickCoin()
  amount.value = ''
  touched.value = false
  submitError.value = null
  // Always re-read the spot balance on open (kept on screen meanwhile): a snapshot from before an order or another
  // tab's transfer let the dialog accept an amount the server then refused (2026-09-29「接口返回错误码 -1」).
  submitSessionExpired.value = false
  if (!account.loading) void account.load()
  void loadMarginAccount()
  // Not opened yet (fresh registration): create it silently; a previous failure: re-check (which retries).
  const gate = props.futuresGate
  if (gate !== undefined && gate.status === 'unopened') void gate.ensureOpened()
  else if (gate !== undefined && gate.status === 'error') void gate.refresh()
}

watch(() => props.open, (open) => {
  if (open) initialise()
}, { immediate: true })

watch([from, to, pairSymbol], () => {
  pickCoin()
  submitError.value = null
}, { flush: 'sync' })
watch([involvesMargin, pairSymbol], ([involved], [wasInvolved, oldPair]) => {
  if (!props.open) return
  if (involved && (!wasInvolved || pairSymbol.value !== oldPair)) void loadMarginAccount()
})

function swap(): void {
  const previous = from.value
  from.value = to.value
  to.value = previous
  amount.value = ''
  touched.value = false
}

function onFromChange(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as TransferAccount
  if (next === to.value) to.value = from.value
  from.value = next
  amount.value = ''
}

function onToChange(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as TransferAccount
  if (next === from.value) from.value = to.value
  to.value = next
  amount.value = ''
}

function fillMax(): void {
  if (isDecimalString(sourceAvailable.value)) {
    const [integerPart, fraction = ''] = sourceAvailable.value.split('.')
    amount.value = canonicalDecimal(fraction === '' ? integerPart : `${integerPart}.${fraction.slice(0, precision.value)}`)
    touched.value = true
  }
}

function close(): void {
  if (!submitting.value) emit('update:open', false)
}

/** spot ⇄ margin: one client requestId per submitted draft (reused after an uncertain outcome; draft-request-id.ts). */
const leverTransferIds = new DraftRequestId()

async function submit(): Promise<void> {
  touched.value = true
  const result = validation.value
  if (!canSubmit.value || result.route === null) return
  const request = buildTransferRequest(result.route, { coin: coin.value, amount: result.amount, marginSymbol: pairSymbol.value })
  const lever = request.path === 'lever/finance/transfer'
  submitting.value = true
  submitError.value = null
  try {
    if (lever) request.body.requestId = leverTransferIds.forDraft(JSON.stringify([request.body.fromAccount, request.body.toAccount, request.body.amount, request.body.coinSymbol, request.body.symbol]))
    try {
      await submitTransfer(request)
    } catch (error_) {
      // 105001: no futures account yet and nothing debited → create it silently, retry exactly once.
      const gate = props.futuresGate
      if (!(isApiError(error_) && error_.code === TRANSFER_CODE_FUTURES_NOT_OPENED && involvesFutures.value && gate !== undefined)) throw error_
      if (!(await gate.ensureOpened(true))) return // the gate now shows the plain init-failed error
      await submitTransfer(request)
    }
    if (lever) leverTransferIds.finish()
    const payload: TransferResult = { from: from.value, to: to.value, coin: coin.value, amount: result.amount, marginSymbol: pairSymbol.value }
    void account.load()
    // Refresh the shared futures balance even when only the generic assets dialog is mounted.
    // A failed follow-up read does not turn an already confirmed transfer into a failed transfer.
    if (involvesFutures.value) void props.futuresGate?.refresh().catch(() => undefined)
    if (payload.marginSymbol !== '' && payload.marginSymbol === margin.currentSymbol) void margin.loadAccount()
    emit('transferred', payload)
    submitting.value = false
    // The dialog closes; the confirmation is a toast (fixed overlay), not a notice that moves the page.
    toastSuccess(t('transfer.done'), 'transfer')
    emit('update:open', false)
  } catch (error_) {
    if (lever) leverTransferIds.finish(error_)
    // Coded refusals / session expiry / transport problems in plain words — never a bare「接口返回错误码 -1」.
    const view = describeTransferError(error_, requestLanguage())
    submitSessionExpired.value = view.kind === 'session'
    submitError.value = view.text
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <DialogShell :open="open" :title="t('transfer.title')" :close-label="gt('common.close')" @close="close">
    <div class="route" data-testid="transfer-route">
      <label class="route-side">
        <span class="route-label">{{ t('transfer.from') }}</span>
        <select class="route-select" :value="from" :aria-label="t('transfer.from')" :disabled="submitting" data-testid="transfer-from" @change="onFromChange">
          <option v-for="entry in offered" :key="entry" :value="entry">{{ t(`transfer.account.${entry}`) }}</option>
        </select>
        <span class="route-balance"><span class="muted">{{ t('transfer.available') }}</span> <span class="num">{{ display(sourceAvailable) }}</span> {{ coin }}</span>
      </label>
      <button class="swap" type="button" :aria-label="t('transfer.swap')" :title="t('transfer.swap')" :disabled="submitting" data-testid="transfer-swap" @click="swap">
        <ArrowUpDown :size="16" aria-hidden="true" />
      </button>
      <label class="route-side">
        <span class="route-label">{{ t('transfer.to') }}</span>
        <select class="route-select" :value="to" :aria-label="t('transfer.to')" :disabled="submitting" data-testid="transfer-to" @change="onToChange">
          <option v-for="entry in offered" :key="entry" :value="entry">{{ t(`transfer.account.${entry}`) }}</option>
        </select>
        <span class="route-balance"><span class="muted">{{ t(`transfer.account.${to}`) }}</span> <span class="num">{{ display(targetBalance) }}</span> {{ coin }}</span>
      </label>
    </div>

    <label v-if="involvesMargin" class="field">
      <span class="field-label">{{ t('transfer.pair') }}</span>
      <span class="field-input">
        <select v-model="pairSymbol" :aria-label="t('transfer.pair')" :disabled="submitting || pairOptions.length === 0" data-testid="transfer-pair">
          <option v-for="option in pairOptions" :key="option.symbol" :value="option.symbol">{{ option.pair }}</option>
        </select>
      </span>
    </label>
    <p v-if="involvesMargin && pairOptions.length === 0" class="notice">{{ t('transfer.noMarginPairs') }}</p>

    <label class="field">
      <span class="field-label">{{ t('transfer.coin') }}</span>
      <span class="field-input">
        <select v-model="coin" :aria-label="t('transfer.coin')" :disabled="submitting || coinOptions.length === 0" data-testid="transfer-coin">
          <option v-for="option in coinOptions" :key="option" :value="option">{{ option }}</option>
        </select>
      </span>
    </label>

    <label class="field">
      <span class="field-label">
        <span>{{ t('transfer.amount') }}</span>
        <span class="muted">{{ t('transfer.available') }} <span class="num">{{ display(sourceAvailable) }}</span></span>
      </span>
      <span class="field-input" :class="{ invalid: touched && amountError !== undefined }">
        <input
          v-model="amount"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          :aria-label="t('transfer.amount')"
          :disabled="submitting"
          data-testid="transfer-amount"
          @input="touched = true"
          @blur="touched = true"
          @keydown.enter.prevent="submit"
        />
        <span class="field-suffix">{{ coin }}</span>
        <button class="max-btn" type="button" :disabled="submitting || !isDecimalString(sourceAvailable)" @click="fillMax">{{ t('transfer.max') }}</button>
      </span>
      <span v-if="touched && amountError !== undefined" class="field-error">{{ errorText(amountError) }}</span>
    </label>

    <section v-if="gateView !== 'ok' && !needsLogin" class="gate" data-testid="transfer-futures-gate" :data-state="gateView">
      <p v-if="gateView === 'preparing'" class="notice">{{ t('transfer.futuresGate.preparing') }}</p>
      <template v-else>
        <p class="notice notice-error wrap-anywhere">
          {{ futuresGate?.initFailed ? t('transfer.futuresGate.initFailed') : t('transfer.futuresGate.checkFailed') }}<template v-if="!futuresGate?.initFailed && futuresGate?.error">: {{ futuresGate.error }}</template>
        </p>
        <button class="btn" type="button" data-testid="transfer-futures-retry" @click="retryGate">{{ t('transfer.futuresGate.retry') }}</button>
      </template>
    </section>

    <p v-if="routeError !== undefined" class="notice notice-error" data-testid="transfer-route-error">{{ errorText(routeError) }}</p>
    <p v-if="from === 'margin'" class="field-hint">{{ t('transfer.marginOutHint') }}</p>
    <p v-if="from === 'futures'" class="field-hint" data-testid="transfer-futures-out-hint">{{ t('transfer.futuresOutHint') }}</p>
    <p v-if="from === 'futures' && futuresAvailable === undefined" class="field-hint">{{ t('transfer.availableUnknown') }}</p>
    <p v-if="involvesFutures && futuresAvailable === undefined && futuresGate?.balanceError" class="notice notice-error wrap-anywhere" data-testid="transfer-futures-balance-error">
      {{ t('transfer.futuresBalanceFailed') }}：{{ futuresGate.balanceError }}
      <button class="link-btn" type="button" data-testid="transfer-futures-balance-retry" @click="retryGate">{{ t('transfer.futuresGate.retry') }}</button>
    </p>
    <p v-if="needsLogin" class="notice notice-error relogin" data-testid="transfer-relogin">
      <span>{{ t('transfer.sessionExpired') }}</span>
      <RouterLink class="btn btn-primary" to="/login" @click="close">{{ t('transfer.relogin') }}</RouterLink>
    </p>
    <p v-if="involvesFutures && !futuresOutboundSupported(futuresType)" class="field-hint">{{ t('transfer.futuresCloudHint') }}</p>
    <p v-if="marginError !== null" class="notice notice-error wrap-anywhere">{{ marginError }}</p>
    <p v-if="account.error !== null && (from === 'spot' || to === 'spot')" class="notice notice-error wrap-anywhere">{{ account.error }}</p>
    <!-- Reserved status line: a refusal appears here without changing the dialog height (前端状态管理约定). -->
    <p class="status-line wrap-anywhere" :class="{ error: submitError !== null }" role="status" aria-live="polite" data-testid="transfer-submit-error" :title="submitError ?? ''">{{ submitError ?? '' }}</p>

    <template #footer>
      <button class="btn" type="button" :disabled="submitting" @click="close">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="!canSubmit" data-testid="transfer-submit" @click="submit">
        {{ submitting ? t('transfer.submitting') : t('transfer.submit') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.status-line { min-height: 36px; max-height: 36px; margin: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 12px; line-height: 18px; }
.status-line.error { color: var(--color-down); }
.relogin { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.link-btn { margin-left: 6px; color: var(--color-accent-text); font-weight: 700; }
.route { position: relative; display: grid; gap: 6px; }
.route-side {
  display: grid; grid-template-columns: 44px minmax(0, 1fr); grid-template-areas: 'label select' 'balance balance'; align-items: center; gap: 4px 10px;
  padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface-alt);
}
.route-label { grid-area: label; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.route-select { grid-area: select; height: 30px; border: 0; outline: 0; background: transparent; font-size: 15px; font-weight: 650; cursor: pointer; }
.route-select:focus-visible { outline: 2px solid var(--color-accent); border-radius: 6px; }
.route-balance { grid-area: balance; font-size: 12px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.swap {
  position: absolute; right: 14px; top: 50%; transform: translateY(-50%); z-index: 1; display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border: 1px solid var(--color-border-strong); border-radius: 50%; background: var(--color-elevated); color: var(--color-accent-text);
  transition: transform 0.2s var(--ease-out), background-color 0.15s;
}
.swap:hover:not(:disabled) { background: var(--color-accent-soft); transform: translateY(-50%) rotate(180deg); }
.field-input select { height: 44px; cursor: pointer; }
.max-btn { flex: 0 0 auto; padding: 0 4px; color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.max-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.field-hint, .notice { margin: 0; }
.gate { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--color-border-strong); border-radius: 12px; background: var(--color-surface-alt); }
</style>
