<script setup lang="ts">
import { toastSuccess } from '@/core/toast'
import { computed, ref, watch } from 'vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive, toFixedString } from '@/modules/finance/decimal'
import { useMarginI18n } from '@/modules/margin/i18n'
import { displayAmount } from '@/modules/margin/risk'
import { formatDailyRate, hasBorrowRule } from '@/modules/margin/risk'
import { validateBorrow } from '@/modules/margin/validation'
import { useMarginStore } from '@/stores/margin'

/** Borrow into the selected pair's margin account: POST lever/finance/borrow {symbol, coin, amount}. */
const props = withDefaults(defineProps<{ open: boolean; coin?: string }>(), { coin: '' })
const emit = defineEmits<{ (event: 'update:open', value: boolean): void; (event: 'done'): void }>()

const { t } = useMarginI18n()
const margin = useMarginStore()

const coin = ref('')
const amount = ref('')
const touched = ref(false)
const submitting = ref(false)
const submitError = ref<string | null>(null)

const acc = computed(() => margin.account)
/** No admin rule for the pair (QA-051): say so instead of a 0% rate and a 0 minimum that look configured. */
const ruleSet = computed(() => acc.value !== null && hasBorrowRule(acc.value))
const coins = computed(() => (acc.value === null ? [] : [acc.value.baseCoin, acc.value.quoteCoin]))
const isBase = computed(() => acc.value !== null && coin.value === acc.value.baseCoin)
const canBorrow = computed(() => (acc.value === null ? '' : isBase.value ? acc.value.baseCanBorrow : acc.value.quoteCanBorrow))
const minBorrow = computed(() => (acc.value === null ? '' : isBase.value ? acc.value.baseMinBorrow : acc.value.quoteMinBorrow))
const borrowed = computed(() => (acc.value === null ? '' : isBase.value ? acc.value.baseBorrowBalance : acc.value.quoteBorrowBalance))
const precision = computed(() => (acc.value === null ? 8 : Math.min(8, isBase.value ? acc.value.baseReturnPrecision : acc.value.quoteReturnPrecision)))

const validation = computed(() => validateBorrow(amount.value, { canBorrow: canBorrow.value, minBorrow: minBorrow.value, precision: precision.value }))
const errorText = computed(() => (validation.value.error === null ? '' : t(`margin.error.${validation.value.error.key}`, validation.value.error.params ?? {})))

function show(value: string, dp = 8): string {
  return displayAmount(value, dp)
}

watch(() => props.open, (open) => {
  if (!open) return
  const wanted = props.coin.toUpperCase()
  coin.value = coins.value.includes(wanted) ? wanted : (coins.value[1] ?? '')
  amount.value = ''
  touched.value = false
  submitError.value = null
}, { immediate: true })

function selectCoin(next: string): void {
  coin.value = next
  amount.value = ''
  touched.value = false
}

function fillMax(): void {
  if (isPositive(canBorrow.value)) {
    amount.value = canonicalDecimal(toFixedString(canBorrow.value, precision.value))
    touched.value = true
  }
}

function close(): void {
  if (!submitting.value) emit('update:open', false)
}

async function submit(): Promise<void> {
  touched.value = true
  if (!validation.value.ok || submitting.value) return
  submitting.value = true
  submitError.value = null
  const error = await margin.borrow(coin.value, validation.value.amount)
  if (error !== null) {
    submitting.value = false
    submitError.value = error.startsWith('error.') || error.startsWith('common.') ? t(error) : error
    return
  }
  // Stay "submitting" until the balances are reloaded: re-enabling first let a second click borrow twice (10-01 audit).
  try {
    await margin.loadAccount()
  } finally {
    submitting.value = false
  }
  toastSuccess(t('margin.borrowDialog.done', { amount: validation.value.amount, coin: coin.value }), 'margin-borrow')
  emit('done')
  emit('update:open', false)
}
</script>

<template>
  <DialogShell :open="open" :title="t('margin.borrowDialog.title')" :close-label="t('common.close')" @close="close">
    <div class="coin-switch" role="radiogroup" :aria-label="t('margin.borrowDialog.coin')">
      <button
        v-for="entry in coins"
        :key="entry"
        type="button"
        role="radio"
        class="coin-option"
        :class="{ active: entry === coin }"
        :aria-checked="entry === coin"
        @click="selectCoin(entry)"
      >{{ entry }}</button>
    </div>

    <dl class="facts">
      <div><dt>{{ t('margin.borrowDialog.canBorrow') }}</dt><dd class="num" data-testid="borrow-max">{{ show(canBorrow) }} {{ coin }}</dd></div>
      <div><dt>{{ t('margin.borrowed') }}</dt><dd class="num">{{ show(borrowed) }} {{ coin }}</dd></div>
      <div><dt>{{ t('margin.borrowDialog.minBorrow') }}</dt><dd class="num">{{ ruleSet ? `${show(minBorrow)} ${coin}` : t('margin.ruleMissing') }}</dd></div>
      <div><dt>{{ t('margin.borrowDialog.rate') }}</dt><dd class="num">{{ acc === null ? '--' : ruleSet ? formatDailyRate(acc.rate) : t('margin.ruleMissing') }}</dd></div>
    </dl>
    <p v-if="acc !== null && !ruleSet" class="notice notice-error" data-testid="borrow-rule-missing">{{ t('margin.borrowDialog.ruleMissing') }}</p>

    <label class="field">
      <span class="field-label">{{ t('margin.borrowDialog.amount') }}</span>
      <span class="field-input" :class="{ invalid: touched && !validation.ok }">
        <input v-model="amount" type="text" inputmode="decimal" autocomplete="off" :aria-label="t('margin.borrowDialog.amount')" :disabled="submitting" data-testid="borrow-amount" @blur="touched = true" @keydown.enter.prevent="submit" />
        <span class="field-suffix">{{ coin }}</span>
        <button class="max-btn" type="button" :disabled="submitting || !isPositive(canBorrow)" @click="fillMax">{{ t('margin.max') }}</button>
      </span>
      <span v-if="touched && !validation.ok" class="field-error" data-testid="borrow-error">{{ errorText }}</span>
    </label>
    <p class="field-hint">{{ t('margin.borrowDialog.hint') }}</p>
    <p v-if="margin.accountError !== null" class="notice notice-error wrap-anywhere">{{ margin.accountError }}</p>
    <p v-if="submitError !== null" class="notice notice-error wrap-anywhere">{{ submitError }}</p>

    <p v-if="!submitting && (!ruleSet || !validation.ok)" class="notice muted-note" role="status">{{ !ruleSet ? t('margin.ruleMissing') : errorText }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="submitting" @click="close">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="!ruleSet || !validation.ok || submitting" data-testid="borrow-submit" @click="submit">
        {{ submitting ? t('trade.submitting') : t('margin.borrowDialog.submit') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.coin-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border-radius: 12px; background: var(--color-surface-alt); }
.coin-option { height: 36px; border-radius: 9px; color: var(--color-text-muted); font-weight: 700; font-size: 13px; }
.coin-option.active { background: var(--color-elevated); color: var(--color-text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin: 0; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 12px; }
.facts dt { color: var(--color-text-muted); font-size: 11.5px; }
.facts dd { margin: 2px 0 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; white-space: normal; }
.max-btn { flex: 0 0 auto; padding: 0 4px; color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.max-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.field-hint, .notice { margin: 0; }
</style>
