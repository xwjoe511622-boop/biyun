<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ArrowDownUp } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { isApiError } from '@/core/errors'
import { toastInfo, toastSuccess } from '@/core/toast'
import { fetchAccountBalance } from '@/modules/api/account.api'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive, toFixedString } from '@/modules/finance/decimal'
import { availableBalance, findCoinBalance } from '@/modules/market/symbols'
import type { TransferDirection } from '@/modules/futures/api'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { validateAmount } from '@/modules/futures/math'
import { TRANSFER_PENDING, useFuturesAccountStore } from '@/stores/futures-account'
import FuturesDialog from './FuturesDialog.vue'

/**
 * Spot <-> futures transfer (`/fe-ex-api/contract/co_transfer`). Spot availability comes from
 * `finance/account_balance` (`normal_balance`), futures→spot from the server's `transferableAmount` (unrealized profit is
 * not transferable; 2026-09-29), falling back to `canUseAmount` on older servers.
 */
/**
 * Decimals a transfer may carry: the ledger's (DECIMAL(32,16); user-api co_transfer and the trading core take 16), not
 * the contract's display precision. With 6 the 全部 button left dust (9.9875134075 → 9.987513) that 可划转 then showed
 * as 0.000000 (建议-025, 10-26).
 */
const LEDGER_DP = 16

/** Display only: truncate DOWN at the configured precision; the full amount remains in title and 全部. */
function exactText(value: string, dp: number): string {
  const canon = canonicalDecimal(value)
  if (!isDecimalString(canon)) return value
  return groupDigits(toFixedString(canon, dp), dp)
}

const props = withDefaults(defineProps<{
  coin: string
  precision: number
  fundsIn: boolean
  fundsOut: boolean
  initial?: TransferDirection
}>(), { initial: 'wallet_to_contract' })
const emit = defineEmits<{ close: []; done: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()

const direction = ref<TransferDirection>(props.initial)
const amount = ref('')
const touched = ref(false)
const spotAvailable = ref('')
const spotError = ref<string | null>(null)
const error = ref<string | null>(null)
/** Set by a success until the next edit (suppresses the stale-balance validation flash). */
const submitted = ref(false)
/** This dialog's request is in flight (the store's `busy` may clear before this component sees the answer). */
const sending = ref(false)
const saving = computed(() => account.busy === 'transfer')

const toFutures = computed(() => direction.value === 'wallet_to_contract')
const available = computed(() => (toFutures.value ? spotAvailable.value : account.transferable))
/** Unrealized profit kept out of 可划转 (shown only when > 0). */
const heldProfit = computed(() => {
  const raw = account.transferHeldProfit
  return isDecimalString(raw) && isPositive(raw) ? groupDigits(toFixedString(raw, props.precision), props.precision) : ''
})
const availableText = computed(() => (available.value === '' ? '--' : exactText(available.value, props.precision)))
const closedByContract = computed(() => (toFutures.value ? !props.fundsIn : !props.fundsOut))
/**
 * Fail closed while the futures account is not confirmed (incident 2026-09-27: the spot server debited
 * before futures rejected an unknown user). The account is created automatically; the store's
 * `transfer` also handles 105001 by creating it silently and retrying once.
 */
const notOpened = computed(() => !account.isOpened)
const blocked = computed(() => closedByContract.value || notOpened.value)
const validation = computed(() => validateAmount(amount.value, available.value === '' ? '' : toFixedString(available.value, LEDGER_DP), LEDGER_DP))
const errorText = computed(() => {
  // 待确认-011: no validation message while a transfer is in flight or right after it succeeded (the balance refresh
  // lands before the box is cleared, so the sent amount briefly looked like 「余额不足」).
  if (saving.value || sending.value || submitted.value) return ''
  const result = validation.value
  if (result.ok || result.error === null) return ''
  return t(`fut.err.${result.error}`, result.params ?? {})
})

async function loadSpot(): Promise<void> {
  spotError.value = null
  try {
    const data = await fetchAccountBalance()
    spotAvailable.value = availableBalance(findCoinBalance(data.allCoinMap, props.coin))
    if (spotAvailable.value === '') spotAvailable.value = '0'
  } catch (error_) {
    spotError.value = isApiError(error_) ? error_.message : String(error_)
  }
}

watch(amount, (value) => {
  if (value !== '') submitted.value = false
})

function swap(): void {
  direction.value = toFutures.value ? 'contract_to_wallet' : 'wallet_to_contract'
  amount.value = ''
  touched.value = false
  error.value = null
}

/** 全部: the exact transferable amount (ledger precision), so nothing is left behind. */
function fillAll(): void {
  if (available.value !== '') {
    amount.value = canonicalDecimal(toFixedString(available.value, LEDGER_DP))
    touched.value = true
  }
}

async function submit(): Promise<void> {
  touched.value = true
  if (blocked.value) {
    error.value = closedByContract.value ? t('fut.transferClosed') : t('fut.initializingAccount')
    return
  }
  if (!validation.value.ok) return
  error.value = null
  sending.value = true
  let result: Awaited<ReturnType<typeof account.transfer>>
  try {
    result = await account.transfer(direction.value, validation.value.amount, props.coin)
    if (result === null || result === TRANSFER_PENDING) {
      // Clear the box first: the store already reloaded the balances, and the sent amount checked against the new
      // 可划转 flashed 「余额不足」 until the spot reload below finished (待确认-011).
      submitted.value = true
      amount.value = ''
      touched.value = false
    }
  } finally {
    sending.value = false
  }
  if (result === TRANSFER_PENDING) {
    // Results are toasts (fixed overlay) so the dialog never grows; a refusal stays in the reserved status line.
    toastInfo(t('fut.transferPending'), 'fut-transfer')
    emit('done')
    return
  }
  if (result !== null) {
    error.value = result
    return
  }
  toastSuccess(t('fut.transferDone'), 'fut-transfer')
  emit('done')
  await loadSpot()
}

onMounted(() => {
  void loadSpot()
  void account.loadAssets()
})
</script>

<template>
  <FuturesDialog :title="t('fut.transferTitle')" :busy="saving" @close="emit('close')">
    <div class="route">
      <div class="route-rows">
        <div class="route-row"><span class="muted">{{ t('fut.from') }}</span><b>{{ toFutures ? t('fut.spotAccount') : t('fut.futuresAccount') }}</b></div>
        <div class="route-row"><span class="muted">{{ t('fut.to') }}</span><b>{{ toFutures ? t('fut.futuresAccount') : t('fut.spotAccount') }}</b></div>
      </div>
      <button class="swap" type="button" :title="t('fut.swap')" :aria-label="t('fut.swap')" :disabled="saving" @click="swap"><ArrowDownUp :size="16" /></button>
    </div>

    <div class="coin-row">
      <span class="muted">{{ t('fut.coin') }}</span>
      <span class="coin"><CoinMark :symbol="coin" :size="18" /> {{ coin }}</span>
    </div>

    <label class="field-input amount" :class="{ invalid: touched && errorText !== '' }">
      <input v-model="amount" class="num" inputmode="decimal" :placeholder="t('fut.transferAmount')" :aria-label="t('fut.transferAmount')" :disabled="saving" @blur="touched = true" />
      <span class="field-suffix">{{ coin }}</span>
      <button class="all" type="button" :disabled="saving || available === ''" @click="fillAll">{{ t('fut.all') }}</button>
    </label>
    <p v-if="touched && errorText !== ''" class="field-error">{{ errorText }}</p>
    <p class="avail"><span class="muted">{{ t('fut.transferable') }}</span><span class="num" :title="available">{{ availableText }} {{ coin }}</span></p>
    <p v-if="!toFutures" class="hint" data-testid="fut-transfer-out-hint">{{ t('fut.transferOutHint') }}<template v-if="heldProfit !== ''">{{ t('fut.transferHeldProfit', { amount: heldProfit, coin }) }}</template></p>

    <p v-if="toFutures && spotError !== null" class="notice notice-error wrap-anywhere">{{ spotError }}</p>
    <p v-if="notOpened && account.open.initFailed" class="notice notice-error" data-testid="fut-transfer-init-failed">{{ t('fut.initFailed') }} <button class="retry-btn" type="button" @click="account.refresh()">{{ t('common.retry') }}</button></p>
    <p v-else-if="notOpened" class="notice" data-testid="fut-transfer-initializing">{{ t('fut.initializingAccount') }}</p>
    <p v-else-if="closedByContract" class="notice">{{ toFutures ? t('fut.transferInClosed') : t('fut.transferOutClosed') }}</p>
    <p class="status-line wrap-anywhere" role="status" aria-live="polite" data-testid="fut-transfer-status" :title="error ?? ''">{{ error ?? '' }}</p>

    <template #footer>
      <button class="btn" type="button" :disabled="saving" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="saving || blocked || !validation.ok" @click="submit">{{ saving ? t('fut.submitting') : t('fut.confirm') }}</button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.route { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; background: var(--color-surface-alt); }
.route-rows { flex: 1; display: grid; gap: 8px; }
.route-row { display: grid; grid-template-columns: 40px 1fr; gap: 8px; font-size: 13px; }
.swap { width: 36px; height: 36px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--color-accent-text); background: var(--color-accent-soft); }
.swap:hover:not(:disabled) { filter: brightness(1.1); }
.coin-row { display: flex; justify-content: space-between; align-items: center; margin: 14px 0 10px; font-size: 13px; }
.coin { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
.amount { height: 46px; border-radius: 10px; }
.amount input { font-family: var(--font-mono); font-weight: 600; }
.all { padding: 0 4px; color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.avail { display: flex; justify-content: space-between; margin: 10px 0 0; font-size: 12px; }
.hint { margin: 6px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 18px; }
.notice { margin: 10px 0 0; }
.status-line { min-height: 36px; max-height: 36px; margin: 8px 0 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--color-down); font-size: 12px; line-height: 18px; }
.retry-btn { margin-left: 6px; color: var(--color-accent-text); font-weight: 700; }
</style>
