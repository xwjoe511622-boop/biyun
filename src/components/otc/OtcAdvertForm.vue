<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { groupDigits, isDecimalString, ratioToPercent } from '@/modules/finance/decimal'
import {
  DAYS_OPTIONS,
  advertTotal,
  buildAdvertPayload,
  effectivePrice,
  emptyAdvertForm,
  isAdvertFormValid,
  validateAdvertForm,
  type AdvertFormContext,
  type AdvertFormState,
  type AdvertField,
} from '@/modules/otc/advert-form'
import { sanitizeDecimalInput } from '@/modules/otc/amounts'
import { fetchRates, publishAdvert } from '@/modules/otc/api'
import { coinDpFor, fiatDpFor } from '@/modules/otc/coins'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { useOtcStore } from '@/stores/otc'

/**
 * Publish an advert (`otc/wanted_save`, AdvertAct.java:119). The server has no edit endpoint, so
 * "edit" means taking the old advert offline and publishing a prefilled copy (`prefill`).
 */
const props = defineProps<{ prefill?: Partial<AdvertFormState> | null }>()
const emit = defineEmits<{ (event: 'published'): void }>()

const { t } = useOtcI18n()
const otc = useOtcStore()
const MAX_BUY_PAYMENTS = 3

const form = reactive<AdvertFormState>(emptyAdvertForm())
const touched = ref(false)
const submitting = ref(false)
const submitError = ref('')
const success = ref('')
const rates = ref<Record<string, string>>({})
const ratesCoin = ref('')

const coinMeta = computed(() => otc.coinMeta(form.coin))
const fiatDp = computed(() => fiatDpFor(coinMeta.value, form.payCoin))
const coinDp = computed(() => coinDpFor(coinMeta.value))
const reference = computed(() => (ratesCoin.value === form.coin ? rates.value[form.payCoin.toUpperCase()] ?? '' : ''))
const balance = computed(() => otc.balanceOf(form.coin))
const feeRate = computed(() => otc.publicInfo?.feeRates[form.coin] ?? '')

const ctx = computed<AdvertFormContext>(() => ({
  fiatDp: fiatDp.value,
  coinDp: coinDp.value,
  referencePrice: reference.value,
  availableVolume: balance.value?.normal ?? '',
  maxPayments: MAX_BUY_PAYMENTS,
}))
const errors = computed(() => validateAdvertForm(form, ctx.value))
const valid = computed(() => isAdvertFormValid(errors.value))
const price = computed(() => effectivePrice(form, ctx.value))
const total = computed(() => advertTotal(form, ctx.value))

/** SELL adverts list the user's enabled receiving methods; BUY adverts list the platform's methods. */
const paymentOptions = computed(() => {
  if (form.side === 'SELL') {
    const seen = new Set<string>()
    return (otc.paymentMethods ?? [])
      .filter(item => item.open && !seen.has(item.payment) && seen.add(item.payment))
      .map(item => ({ key: item.payment, label: `${item.title || otc.paymentTitle(item.payment)} · ${item.account}` }))
  }
  return (otc.publicInfo?.payments ?? []).map(item => ({ key: item.key, label: item.title }))
})

function err(field: AdvertField): string {
  const code = errors.value[field]
  // "Required" waits for a submit attempt; every other problem shows as soon as the value is typed.
  if (code === undefined || (!touched.value && code === 'required')) return ''
  return t(`otc.form.errors.${code}`)
}

function decimalInput(field: 'price' | 'volume' | 'minTrade' | 'maxTrade' | 'floatRate', dp: number) {
  return (event: Event): void => {
    form[field] = sanitizeDecimalInput((event.target as HTMLInputElement).value, dp)
  }
}

function intInput(field: 'limitTime' | 'dealVolume') {
  return (event: Event): void => {
    form[field] = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6)
  }
}

function togglePayment(key: string): void {
  const index = form.payments.indexOf(key)
  if (index >= 0) form.payments.splice(index, 1)
  else form.payments.push(key)
}

function fmt(value: string, dp: number): string {
  return isDecimalString(value) ? groupDigits(value, dp) : '--'
}

function reset(): void {
  const keep = { coin: form.coin, payCoin: form.payCoin, side: form.side }
  Object.assign(form, emptyAdvertForm(), keep)
  touched.value = false
  submitError.value = ''
}

async function loadRates(): Promise<void> {
  const coin = form.coin
  if (coin === '') return
  try {
    const result = await fetchRates(coin)
    if (form.coin === coin) {
      rates.value = result
      ratesCoin.value = coin
    }
  } catch {
    if (form.coin === coin) {
      rates.value = {}
      ratesCoin.value = coin
    }
  }
}

async function submit(): Promise<void> {
  touched.value = true
  success.value = ''
  if (!valid.value || submitting.value) return
  submitting.value = true
  submitError.value = ''
  try {
    await publishAdvert(buildAdvertPayload(form, ctx.value))
    success.value = t('otc.form.published')
    reset()
    void otc.loadAccounts()
    emit('published')
  } catch (error) {
    submitError.value = describeOtcError(t, error)
  } finally {
    submitting.value = false
  }
}

function applyDefaults(): void {
  if (form.coin === '' && otc.coins.length > 0) {
    const preferred = otc.publicInfo?.defaultCoin ?? ''
    form.coin = otc.coins.find(c => c.coin === preferred)?.coin ?? otc.coins[0].coin
  }
  const paycoins = otc.publicInfo?.paycoins ?? []
  if (form.payCoin === '' && paycoins.length > 0) {
    const preferred = otc.publicInfo?.defaultPayCoin ?? ''
    form.payCoin = paycoins.find(p => p.key.toUpperCase() === preferred)?.key ?? paycoins[0].key
  }
}

watch(() => props.prefill, (prefill) => {
  if (prefill === null || prefill === undefined) return
  Object.assign(form, emptyAdvertForm(), prefill)
  touched.value = false
  success.value = ''
}, { immediate: true })
watch(() => [otc.coins.length, otc.publicInfo], applyDefaults, { immediate: true })
watch(() => form.coin, () => { void loadRates() }, { immediate: true })
watch(() => form.side, (side, previous) => {
  if (previous !== undefined && side !== previous) form.payments = []
  if (side === 'SELL' && otc.paymentMethods === null) void otc.loadPaymentMethods()
}, { immediate: true })
</script>

<template>
  <form class="advert-form" novalidate @submit.prevent="submit">
    <div class="side-cards" role="radiogroup" :aria-label="t('otc.form.side')">
      <button type="button" class="side-card buy" :class="{ active: form.side === 'BUY' }" role="radio" :aria-checked="form.side === 'BUY'" @click="form.side = 'BUY'">
        {{ t('otc.form.buySide') }}
      </button>
      <button type="button" class="side-card sell" :class="{ active: form.side === 'SELL' }" role="radio" :aria-checked="form.side === 'SELL'" @click="form.side = 'SELL'">
        {{ t('otc.form.sellSide') }}
      </button>
    </div>

    <div class="grid two">
      <div class="field">
        <span class="field-label">{{ t('otc.form.coin') }}</span>
        <div class="coin-picks">
          <button
            v-for="c in otc.coins"
            :key="c.coin"
            type="button"
            class="coin-pick"
            :class="{ active: form.coin === c.coin }"
            :aria-pressed="form.coin === c.coin"
            @click="form.coin = c.coin"
          >
            <CoinMark :symbol="c.coin" :icon-url="c.icon" :size="18" />{{ c.showName }}
          </button>
        </div>
      </div>
      <label class="field">
        <span class="field-label">{{ t('otc.form.fiat') }}</span>
        <span class="field-input">
          <select v-model="form.payCoin">
            <option v-for="p in otc.publicInfo?.paycoins ?? []" :key="p.key" :value="p.key">{{ p.key.toUpperCase() }} · {{ p.title }}</option>
          </select>
        </span>
      </label>
    </div>

    <fieldset class="block">
      <legend class="field-label">{{ t('otc.form.priceType') }}</legend>
      <div class="tabs price-tabs">
        <button type="button" class="tab" :class="{ active: form.priceType === 'fixed' }" @click="form.priceType = 'fixed'">{{ t('otc.form.fixed') }}</button>
        <button type="button" class="tab" :class="{ active: form.priceType === 'floating' }" @click="form.priceType = 'floating'">{{ t('otc.form.floating') }}</button>
        <span class="reference">
          {{ t('otc.form.reference') }}:
          <b class="num">{{ reference !== '' ? `${fmt(reference, fiatDp)} ${form.payCoin.toUpperCase()}` : t('otc.form.noReference') }}</b>
        </span>
      </div>
      <div v-if="form.priceType === 'fixed'" class="grid two">
        <label class="field">
          <span class="field-label">{{ t('otc.form.price') }}</span>
          <span class="field-input" :class="{ invalid: err('price') !== '' }">
            <input :value="form.price" inputmode="decimal" autocomplete="off" @input="decimalInput('price', fiatDp)($event)" />
            <span class="field-suffix">{{ form.payCoin.toUpperCase() }}</span>
          </span>
          <span v-if="err('price') !== ''" class="field-error">{{ err('price') }}</span>
        </label>
      </div>
      <div v-else class="grid three">
        <label class="field">
          <span class="field-label">{{ t('otc.form.floatRate') }}</span>
          <span class="field-input" :class="{ invalid: err('floatRate') !== '' }">
            <select v-model="form.floatDirection" class="dir-select" :aria-label="t('otc.form.floatRate')">
              <option value="above">{{ t('otc.form.above') }}</option>
              <option value="below">{{ t('otc.form.below') }}</option>
            </select>
            <input :value="form.floatRate" inputmode="decimal" placeholder="0" autocomplete="off" @input="decimalInput('floatRate', 2)($event)" />
            <span class="field-suffix">%</span>
          </span>
          <span v-if="err('floatRate') !== ''" class="field-error">{{ err('floatRate') }}</span>
        </label>
        <div class="field">
          <span class="field-label">{{ t('otc.form.resultPrice') }}</span>
          <span class="static-value num">{{ fmt(price, fiatDp) }} <small>{{ form.payCoin.toUpperCase() }}</small></span>
        </div>
      </div>
    </fieldset>

    <div class="grid three">
      <label class="field">
        <span class="field-label">
          {{ t('otc.form.volume') }}
          <span v-if="form.side === 'SELL'" class="muted">{{ t('otc.form.availableBalance', { amount: fmt(balance?.normal ?? '', coinDp), coin: form.coin }) }}</span>
        </span>
        <span class="field-input" :class="{ invalid: err('volume') !== '' }">
          <input :value="form.volume" inputmode="decimal" autocomplete="off" @input="decimalInput('volume', coinDp)($event)" />
          <span class="field-suffix">{{ form.coin }}</span>
        </span>
        <span v-if="err('volume') !== ''" class="field-error">{{ err('volume') }}</span>
        <span v-else-if="form.side === 'SELL' && feeRate !== ''" class="field-hint">{{ t('otc.form.feeNote', { rate: `${ratioToPercent(feeRate, 2)}%` }) }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('otc.form.minTrade') }}</span>
        <span class="field-input" :class="{ invalid: err('minTrade') !== '' }">
          <input :value="form.minTrade" inputmode="decimal" autocomplete="off" @input="decimalInput('minTrade', fiatDp)($event)" />
          <span class="field-suffix">{{ form.payCoin.toUpperCase() }}</span>
        </span>
        <span v-if="err('minTrade') !== ''" class="field-error">{{ err('minTrade') }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('otc.form.maxTrade') }}</span>
        <span class="field-input" :class="{ invalid: err('maxTrade') !== '' }">
          <input :value="form.maxTrade" inputmode="decimal" autocomplete="off" @input="decimalInput('maxTrade', fiatDp)($event)" />
          <span class="field-suffix">{{ form.payCoin.toUpperCase() }}</span>
        </span>
        <span v-if="err('maxTrade') !== ''" class="field-error">{{ err('maxTrade') }}</span>
        <span v-else class="field-hint">{{ t('otc.form.total') }} <b class="num">{{ fmt(total, fiatDp) }}</b></span>
      </label>
    </div>

    <div class="grid three">
      <label class="field">
        <span class="field-label">{{ t('otc.form.limitTime') }}</span>
        <span class="field-input" :class="{ invalid: err('limitTime') !== '' }">
          <input :value="form.limitTime" inputmode="numeric" @input="intInput('limitTime')($event)" />
        </span>
        <span v-if="err('limitTime') !== ''" class="field-error">{{ err('limitTime') }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('otc.form.dealVolume') }}</span>
        <span class="field-input" :class="{ invalid: err('dealVolume') !== '' }">
          <input :value="form.dealVolume" inputmode="numeric" @input="intInput('dealVolume')($event)" />
        </span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('otc.form.days') }}</span>
        <span class="field-input">
          <select v-model="form.days">
            <option v-for="d in DAYS_OPTIONS" :key="d" :value="d">{{ t('otc.form.daysOption', { n: d }) }}</option>
          </select>
        </span>
      </label>
    </div>

    <fieldset class="block">
      <legend class="field-label">
        {{ form.side === 'SELL' ? t('otc.form.paymentsSell') : t('otc.form.payments') }}
        <span v-if="form.side === 'BUY'" class="muted">{{ t('otc.form.paymentsBuyHint', { n: MAX_BUY_PAYMENTS }) }}</span>
      </legend>
      <div v-if="paymentOptions.length > 0" class="pay-picks">
        <button
          v-for="p in paymentOptions"
          :key="p.key"
          type="button"
          class="pay-pick"
          :class="{ active: form.payments.includes(p.key) }"
          :aria-pressed="form.payments.includes(p.key)"
          @click="togglePayment(p.key)"
        >
          {{ p.label }}
        </button>
      </div>
      <p v-else class="notice">
        {{ t('otc.form.noPaymentMethods') }}
        <RouterLink class="inline-link" :to="{ query: { tab: 'payments' } }">{{ t('otc.paymentMethods.add') }}</RouterLink>
      </p>
      <span v-if="err('payments') !== ''" class="field-error">{{ err('payments') }}</span>
    </fieldset>

    <div class="grid two">
      <label class="field">
        <span class="field-label">{{ t('otc.form.description') }} <span class="muted">{{ form.description.length }}/500</span></span>
        <textarea v-model="form.description" class="textarea" rows="3" maxlength="500" />
      </label>
      <label class="field">
        <span class="field-label">{{ t('otc.form.autoReply') }} <span class="muted">{{ form.autoReply.length }}/500</span></span>
        <textarea v-model="form.autoReply" class="textarea" rows="3" maxlength="500" />
      </label>
    </div>

    <p v-if="submitError !== ''" class="notice notice-error" role="alert">{{ submitError }}</p>
    <p v-if="success !== ''" class="ok-note" role="status">{{ success }}</p>
    <div class="form-actions">
      <button class="btn" type="button" :disabled="submitting" @click="reset">{{ t('otc.form.reset') }}</button>
      <button class="btn" :class="form.side === 'BUY' ? 'btn-buy' : 'btn-sell'" type="submit" :disabled="submitting || (touched && !valid)">
        {{ submitting ? t('common.loading') : t('otc.form.submit') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.advert-form { display: flex; flex-direction: column; gap: 20px; }
.side-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-width: 480px; }
.side-card {
  height: 48px; border: 1px solid var(--color-border-strong); border-radius: 12px; font-weight: 700; color: var(--color-text-secondary);
  background: var(--color-surface-alt); transition: all 0.15s;
}
.side-card.buy.active { border-color: var(--color-up); background: var(--color-up-soft); color: var(--color-up); }
.side-card.sell.active { border-color: var(--color-down); background: var(--color-down-soft); color: var(--color-down); }
.grid { display: grid; gap: 14px 16px; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.block { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; border: 0; min-width: 0; }
.block legend { margin-bottom: 8px; padding: 0; }
.coin-picks, .pay-picks { display: flex; flex-wrap: wrap; gap: 8px; }
.coin-pick, .pay-pick {
  display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border: 1px solid var(--color-border-strong);
  border-radius: var(--radius); background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13px; font-weight: 600;
}
.coin-pick.active, .pay-pick.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-text); }
.price-tabs { gap: 4px; flex-wrap: wrap; }
.reference { margin-left: auto; color: var(--color-text-muted); font-size: 12.5px; }
.reference b { color: var(--color-text); }
.dir-select { flex: 0 0 auto !important; max-width: 46%; font-size: 12.5px !important; color: var(--color-text-secondary) !important; }
.static-value { display: flex; align-items: center; height: 46px; padding: 0 14px; border-radius: var(--radius); background: var(--color-surface-alt); font-size: 16px; font-weight: 650; }
.static-value small { margin-left: 6px; color: var(--color-text-muted); font-family: var(--font-sans); font-size: 12px; }
.field-label .muted { font-weight: 500; }
.textarea {
  width: 100%; padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); resize: vertical;
  background: var(--color-surface-alt); color: var(--color-text); font: inherit; font-size: 13.5px; outline: none;
}
.textarea:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.inline-link { margin-left: 6px; font-weight: 700; text-decoration: underline; }
.ok-note { margin: 0; color: var(--color-up); font-weight: 600; font-size: 13px; }
.form-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 6px; border-top: 1px solid var(--color-border); }
.form-actions .btn { min-width: 128px; height: 44px; margin-top: 14px; }
@media (max-width: 760px) {
  .grid.two, .grid.three { grid-template-columns: 1fr; }
  .reference { margin-left: 0; width: 100%; }
  .form-actions .btn { flex: 1; min-width: 0; }
}
</style>
