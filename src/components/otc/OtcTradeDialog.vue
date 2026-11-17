<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Clock, ShieldCheck } from '@lucide/vue'
import OtcDialog from './OtcDialog.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import {
  evaluateTradeAmount,
  maxTradeAmount,
  sanitizeDecimalInput,
  type AmountMode,
} from '@/modules/otc/amounts'
import { createOrder, fetchAdvertDetail, type OtcAdvert, type OtcAdvertDetail } from '@/modules/otc/api'
import { coinDpFor, fiatDpFor } from '@/modules/otc/coins'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { useOtcStore } from '@/stores/otc'

/**
 * Take an advert. Always re-reads `otc/v4/wanted_detail` first so the price, remaining volume and
 * limits used for validation are the server's current values (the server also rejects a stale
 * `price` with 2062). A SELL advert means the user buys (`v4/otc/buy_order_save`); a BUY advert means
 * the user sells (`v4/otc/sell_order_save`, fund password required).
 */
const props = defineProps<{ open: boolean; advert: OtcAdvert | null; coin: string }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const { t } = useOtcI18n()
const otc = useOtcStore()
const router = useRouter()

const detail = ref<OtcAdvertDetail | null>(null)
const loading = ref(false)
const loadError = ref('')
const mode = ref<AmountMode>('fiat')
const input = ref('')
const fundPassword = ref('')
const submitting = ref(false)
const submitError = ref('')
const touched = ref(false)

const userBuys = computed(() => (detail.value?.side || props.advert?.side) === 'SELL')
const coin = computed(() => detail.value?.coin || props.coin)
const coinMeta = computed(() => otc.coinMeta(coin.value))
const payCoin = computed(() => detail.value?.payCoin || props.advert?.payCoin || '')
const fiatDp = computed(() => fiatDpFor(coinMeta.value, payCoin.value))
const coinDp = computed(() => coinDpFor(coinMeta.value))

const limits = computed(() => ({
  price: detail.value?.price ?? '',
  minTrade: detail.value?.minTrade ?? '',
  maxTrade: detail.value?.maxTrade ?? '',
  volumeBalance: detail.value?.volumeBalance ?? '',
  fiatDp: fiatDp.value,
  coinDp: coinDp.value,
}))

const evaluation = computed(() => evaluateTradeAmount({ ...limits.value, input: input.value, mode: mode.value }))
const errorText = computed(() => {
  if (!touched.value || evaluation.value.error === null || evaluation.value.error === 'required') return ''
  return t(`otc.amountError.${evaluation.value.error}`)
})

const matchingPayments = computed(() => {
  const accepted = new Set((detail.value?.payments ?? []).map(p => p.key))
  return (otc.paymentMethods ?? []).filter(item => item.open && accepted.has(item.payment))
})

const blockedByTip = computed(() => (detail.value?.tip ?? '') !== '')
const canSubmit = computed(() => {
  if (detail.value === null || submitting.value || blockedByTip.value || !evaluation.value.ok) return false
  if (!userBuys.value) return fundPassword.value !== '' && matchingPayments.value.length > 0
  return true
})

function fmtFiat(value: string): string {
  return isDecimalString(value) ? groupDigits(value, fiatDp.value) : '--'
}

function fmtCoin(value: string): string {
  return isDecimalString(value) ? groupDigits(value, coinDp.value) : '--'
}

function onInput(event: Event): void {
  touched.value = true
  input.value = sanitizeDecimalInput((event.target as HTMLInputElement).value, mode.value === 'fiat' ? fiatDp.value : coinDp.value)
}

function switchMode(next: AmountMode): void {
  if (mode.value === next) return
  // Carry the derived counterpart across so switching never loses the user's amount.
  const derived = next === 'fiat' ? evaluation.value.fiat : evaluation.value.volume
  mode.value = next
  input.value = derived
}

function fillMax(): void {
  touched.value = true
  input.value = maxTradeAmount({ ...limits.value, mode: mode.value })
}

async function load(): Promise<void> {
  if (props.advert === null) return
  loading.value = true
  loadError.value = ''
  detail.value = null
  try {
    detail.value = await fetchAdvertDetail(props.advert.advertId)
    if (!userBuys.value && otc.paymentMethods === null) await otc.loadPaymentMethods()
  } catch (error) {
    loadError.value = describeOtcError(t, error)
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  touched.value = true
  if (!canSubmit.value || detail.value === null) return
  submitting.value = true
  submitError.value = ''
  try {
    const sequence = await createOrder({
      advertSide: userBuys.value ? 'SELL' : 'BUY',
      advertId: detail.value.advertId,
      price: detail.value.price,
      totalPrice: evaluation.value.fiat,
      volume: evaluation.value.volume,
      type: mode.value === 'fiat' ? 'price' : 'volume',
      capitalPword: userBuys.value ? undefined : fundPassword.value,
    })
    fundPassword.value = ''
    emit('close')
    await router.push({ name: 'otc-order', params: { id: sequence } })
  } catch (error) {
    submitError.value = describeOtcError(t, error)
  } finally {
    submitting.value = false
  }
}

watch(() => [props.open, props.advert?.advertId], ([open]) => {
  if (!open) {
    fundPassword.value = ''
    return
  }
  mode.value = 'fiat'
  input.value = ''
  touched.value = false
  submitError.value = ''
  void load()
}, { immediate: true })
</script>

<template>
  <OtcDialog
    :open="open"
    :busy="submitting"
    width="520px"
    :title="t('otc.trade.title', { action: userBuys ? t('otc.buy') : t('otc.sell'), coin })"
    @close="emit('close')"
  >
    <StateBlock v-if="loading" variant="loading" :message="t('otc.trade.loadingAdvert')" />
    <StateBlock v-else-if="loadError !== ''" variant="error" :message="loadError" retryable @retry="load" />
    <form v-else-if="detail !== null" id="otc-trade-form" class="trade-form" @submit.prevent="submit">
      <div class="td-merchant">
        <span class="td-avatar" aria-hidden="true">{{ (detail.nickname || '?').slice(0, 1).toUpperCase() }}</span>
        <div class="td-merchant-text">
          <strong class="wrap-anywhere">{{ detail.nickname || '--' }}</strong>
          <span class="muted">{{ t('otc.orders', { n: detail.completeOrders || '--' }) }}</span>
        </div>
        <div class="td-price">
          <span class="muted">{{ t('otc.price') }}</span>
          <strong class="num" :class="userBuys ? 'up' : 'down'">{{ fmtFiat(detail.price) }} <small>{{ payCoin }}</small></strong>
        </div>
      </div>

      <p v-if="blockedByTip" class="notice">{{ detail.tip }}</p>

      <div class="td-facts">
        <span>{{ t('otc.trade.limitRange', { min: fmtFiat(detail.minTrade), max: fmtFiat(detail.maxTrade), fiat: payCoin }) }}</span>
        <span>{{ t('otc.trade.remaining', { amount: fmtCoin(detail.volumeBalance), coin }) }}</span>
        <span v-if="detail.limitTime !== ''"><Clock :size="13" /> {{ t('otc.trade.payWindow', { n: detail.limitTime }) }}</span>
      </div>

      <div class="td-mode tabs" role="tablist">
        <button class="tab" :class="{ active: mode === 'fiat' }" type="button" role="tab" :aria-selected="mode === 'fiat'" @click="switchMode('fiat')">
          {{ t('otc.trade.byFiat') }}
        </button>
        <button class="tab" :class="{ active: mode === 'coin' }" type="button" role="tab" :aria-selected="mode === 'coin'" @click="switchMode('coin')">
          {{ t('otc.trade.byCoin') }}
        </button>
      </div>

      <label class="field">
        <span class="field-label">
          {{ mode === 'fiat' ? (userBuys ? t('otc.trade.payAmount') : t('otc.trade.getAmount')) : (userBuys ? t('otc.trade.receiveAmount') : t('otc.trade.sellAmount')) }}
        </span>
        <span class="field-input td-amount" :class="{ invalid: errorText !== '' }">
          <input
            :value="input"
            inputmode="decimal"
            autocomplete="off"
            :placeholder="mode === 'fiat' ? `${fmtFiat(detail.minTrade)} – ${fmtFiat(detail.maxTrade)}` : '0'"
            :aria-invalid="errorText !== ''"
            @input="onInput"
          />
          <button class="td-max" type="button" @click="fillMax">{{ t('otc.trade.max') }}</button>
          <span class="field-suffix">{{ mode === 'fiat' ? payCoin : coin }}</span>
        </span>
      </label>
      <p v-if="errorText !== ''" class="field-error">{{ errorText }}</p>

      <div class="td-derived">
        <CoinMark :symbol="coin" :icon-url="coinMeta?.icon ?? ''" :size="22" />
        <span class="muted">{{ mode === 'fiat' ? (userBuys ? t('otc.trade.receiveAmount') : t('otc.trade.sellAmount')) : (userBuys ? t('otc.trade.payAmount') : t('otc.trade.getAmount')) }}</span>
        <strong class="num">
          {{ mode === 'fiat' ? fmtCoin(evaluation.volume) : fmtFiat(evaluation.fiat) }}
          <small>{{ mode === 'fiat' ? coin : payCoin }}</small>
        </strong>
      </div>

      <div class="td-section">
        <span class="field-label">{{ userBuys ? t('otc.trade.paymentsAccepted') : t('otc.trade.yourReceiving') }}</span>
        <div v-if="userBuys" class="td-pay-list">
          <span v-for="p in detail.payments" :key="p.key" class="chip">{{ p.title || otc.paymentTitle(p.key) }}</span>
          <span v-if="detail.payments.length === 0" class="muted">--</span>
        </div>
        <template v-else>
          <div v-if="matchingPayments.length > 0" class="td-pay-list">
            <span v-for="p in matchingPayments" :key="p.id" class="chip">{{ p.title || otc.paymentTitle(p.payment) }} · {{ p.account }}</span>
          </div>
          <p v-else class="notice">
            {{ t('otc.trade.noMatchingPayment') }}
            <RouterLink class="td-link" :to="{ path: '/otc/adverts', query: { tab: 'payments' } }" @click="emit('close')">{{ t('otc.adverts.tabs.payments') }}</RouterLink>
          </p>
        </template>
      </div>

      <label v-if="!userBuys" class="field">
        <span class="field-label">{{ t('otc.trade.fundPassword') }}<span class="muted"><ShieldCheck :size="12" /> {{ t('otc.trade.fundPasswordHint') }}</span></span>
        <span class="field-input">
          <input v-model="fundPassword" type="password" autocomplete="off" maxlength="64" />
        </span>
      </label>

      <details v-if="detail.description !== ''" class="td-remarks">
        <summary>{{ t('otc.trade.remarks') }}</summary>
        <p class="wrap-anywhere">{{ detail.description }}</p>
      </details>

      <p v-if="submitError !== ''" class="notice notice-error" role="alert">{{ submitError }}</p>
    </form>

    <template #footer>
      <button class="btn" type="button" :disabled="submitting" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button
        class="btn"
        :class="userBuys ? 'btn-buy' : 'btn-sell'"
        type="submit"
        form="otc-trade-form"
        :disabled="!canSubmit"
      >
        {{ submitting ? t('common.loading') : userBuys ? t('otc.trade.confirmBuy') : t('otc.trade.confirmSell') }}
      </button>
    </template>
  </OtcDialog>
</template>

<style scoped>
.trade-form { display: flex; flex-direction: column; gap: 14px; }
.td-merchant { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; background: var(--color-surface-alt); }
.td-avatar {
  display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; flex: 0 0 38px;
  border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent-text); font-weight: 750;
}
.td-merchant-text { display: flex; flex-direction: column; min-width: 0; flex: 1; font-size: 13px; }
.td-price { display: flex; flex-direction: column; align-items: flex-end; font-size: 12px; }
.td-price strong { font-size: 20px; }
.td-price small, .td-derived small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 12px; font-weight: 600; }
.td-facts { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--color-text-secondary); font-size: 12px; }
.td-facts span { display: inline-flex; align-items: center; gap: 4px; }
.td-mode { align-self: flex-start; padding: 3px; border-radius: var(--radius); background: var(--color-surface-alt); }
.td-amount input { font-family: var(--font-mono); font-size: 18px; }
.td-max { color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.td-derived {
  display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px dashed var(--color-border-strong);
  border-radius: 12px; font-size: 13px;
}
.td-derived strong { margin-left: auto; font-size: 17px; }
.td-section { display: flex; flex-direction: column; gap: 8px; }
.td-pay-list { display: flex; flex-wrap: wrap; gap: 6px; }
.td-pay-list .chip { height: 26px; font-size: 12px; }
.td-link { margin-left: 6px; color: var(--color-accent-text); font-weight: 700; text-decoration: underline; }
.td-remarks { font-size: 13px; color: var(--color-text-secondary); }
.td-remarks summary { cursor: pointer; font-weight: 650; }
.td-remarks p { margin: 8px 0 0; white-space: pre-line; }
.field-label .muted { display: inline-flex; align-items: center; gap: 4px; font-weight: 500; }
</style>
