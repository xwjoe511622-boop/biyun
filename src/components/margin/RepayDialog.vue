<script setup lang="ts">
import { toastSuccess } from '@/core/toast'
import { computed, ref, watch } from 'vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive, toFixedString } from '@/modules/finance/decimal'
import { useMarginI18n } from '@/modules/margin/i18n'
import { displayAmount } from '@/modules/margin/risk'
import type { BorrowRecord } from '@/modules/margin/types'
import { maxRepayable, totalOwed, validateRepay } from '@/modules/margin/validation'
import { useMarginStore } from '@/stores/margin'

/**
 * Repay one loan: POST lever/finance/return {id, amount}. The server takes interest first, then
 * principal, and accepts `amount >= minPayment` or `amount >= everything owed`.
 */
const props = withDefaults(defineProps<{ open: boolean; recordId?: string }>(), { recordId: '' })
const emit = defineEmits<{ (event: 'update:open', value: boolean): void; (event: 'done'): void }>()

const { t } = useMarginI18n()
const margin = useMarginStore()

const selectedId = ref('')
const amount = ref('')
const touched = ref(false)
const submitting = ref(false)
const submitError = ref<string | null>(null)

const records = computed<BorrowRecord[]>(() => margin.borrows.open)
const record = computed(() => records.value.find(entry => entry.id === selectedId.value))
const acc = computed(() => margin.account)
const isBase = computed(() => acc.value !== null && record.value !== undefined && record.value.coin === acc.value.baseCoin)
const available = computed(() => (acc.value === null || record.value === undefined ? '' : isBase.value ? acc.value.baseNormalBalance : acc.value.quoteNormalBalance))
const minPayment = computed(() => (acc.value === null ? '' : isBase.value ? acc.value.baseMinPayment : acc.value.quoteMinPayment))
const precision = computed(() => (acc.value === null ? 8 : Math.min(8, isBase.value ? acc.value.baseReturnPrecision : acc.value.quoteReturnPrecision)))

const context = computed(() => ({
  owePrincipal: record.value?.oweAmount ?? '',
  oweInterest: record.value?.oweInterest ?? '',
  minPayment: minPayment.value,
  available: available.value,
  precision: precision.value,
}))
const owed = computed(() => totalOwed(context.value.owePrincipal, context.value.oweInterest))
const maxAmount = computed(() => maxRepayable(context.value))
const validation = computed(() => validateRepay(amount.value, context.value))
const errorText = computed(() => (validation.value.error === null ? '' : t(`margin.error.${validation.value.error.key}`, validation.value.error.params ?? {})))

function show(value: string, dp = 8): string {
  return displayAmount(value, dp)
}

function recordLabel(entry: BorrowRecord): string {
  return `${entry.coin} · ${show(entry.borrowMoney)} · #${entry.id}`
}

watch(() => props.open, (open) => {
  if (!open) return
  selectedId.value = records.value.some(entry => entry.id === props.recordId) ? props.recordId : (records.value[0]?.id ?? '')
  amount.value = ''
  touched.value = false
  submitError.value = null
  if (margin.borrows.open.length === 0) void margin.loadBorrows('open')
}, { immediate: true })

watch(records, (list) => {
  if (!props.open) return
  if (selectedId.value !== '' && !list.some(entry => entry.id === selectedId.value)) {
    submitError.value = t('margin.repayDialog.stale')
    return
  }
  if (selectedId.value === '' && list.length > 0) selectedId.value = list[0].id
})

function fillMax(): void {
  if (isPositive(maxAmount.value)) {
    amount.value = canonicalDecimal(toFixedString(maxAmount.value, precision.value))
    touched.value = true
  }
}

function close(): void {
  if (!submitting.value) emit('update:open', false)
}

async function submit(): Promise<void> {
  touched.value = true
  if (!validation.value.ok || submitting.value || record.value === undefined) return
  submitting.value = true
  submitError.value = null
  const error = await margin.repay(record.value.id, validation.value.amount)
  if (error !== null) {
    submitting.value = false
    submitError.value = error.startsWith('error.') || error.startsWith('common.') ? t(error) : error
    return
  }
  // Stay "submitting" until the reloads finish: re-enabling first let a second click repay twice (10-01 audit).
  try {
    await Promise.all([margin.loadAccount(), margin.loadBorrows('open'), margin.loadBorrows('history')])
  } finally {
    submitting.value = false
  }
  toastSuccess(t('margin.repayDialog.done', { amount: validation.value.amount }), 'margin-repay')
  emit('done')
  emit('update:open', false)
}
</script>

<template>
  <DialogShell :open="open" :title="t('margin.repayDialog.title')" :close-label="t('common.close')" @close="close">
    <p v-if="records.length === 0 && !margin.borrowLoading.open" class="notice notice-info">{{ t('margin.repayDialog.none') }}</p>
    <template v-else>
      <label class="field">
        <span class="field-label">{{ t('margin.repayDialog.order') }}</span>
        <span class="field-input">
          <select v-model="selectedId" :aria-label="t('margin.repayDialog.pick')" :disabled="submitting" data-testid="repay-record">
            <option v-for="entry in records" :key="entry.id" :value="entry.id">{{ recordLabel(entry) }}</option>
          </select>
        </span>
      </label>

      <dl class="facts">
        <div><dt>{{ t('margin.repayDialog.owedPrincipal') }}</dt><dd class="num">{{ show(record?.oweAmount ?? '') }}</dd></div>
        <div><dt>{{ t('margin.repayDialog.owedInterest') }}</dt><dd class="num">{{ show(record?.oweInterest ?? '') }}</dd></div>
        <div><dt>{{ t('margin.repayDialog.owedTotal') }}</dt><dd class="num strong" data-testid="repay-owed">{{ show(owed) }} {{ record?.coin ?? '' }}</dd></div>
        <div><dt>{{ t('margin.repayDialog.available') }}</dt><dd class="num">{{ show(available) }} {{ record?.coin ?? '' }}</dd></div>
        <div><dt>{{ t('margin.repayDialog.minPayment') }}</dt><dd class="num">{{ show(minPayment) }}</dd></div>
      </dl>

      <label class="field">
        <span class="field-label">{{ t('margin.repayDialog.amount') }}</span>
        <span class="field-input" :class="{ invalid: touched && !validation.ok }">
          <input v-model="amount" type="text" inputmode="decimal" autocomplete="off" :aria-label="t('margin.repayDialog.amount')" :disabled="submitting" data-testid="repay-amount" @blur="touched = true" @keydown.enter.prevent="submit" />
          <span class="field-suffix">{{ record?.coin ?? '' }}</span>
          <button class="max-btn" type="button" :disabled="submitting || !isPositive(maxAmount)" @click="fillMax">{{ t('margin.max') }}</button>
        </span>
        <span v-if="touched && !validation.ok" class="field-error" data-testid="repay-error">{{ errorText }}</span>
      </label>
    </template>
    <p v-if="margin.borrowErrors.open !== null" class="notice notice-error wrap-anywhere">{{ margin.borrowErrors.open }}</p>
    <p v-if="submitError !== null" class="notice notice-error wrap-anywhere">{{ submitError }}</p>

    <p v-if="!submitting && (record === undefined || !validation.ok)" class="notice muted-note" role="status">{{ record === undefined ? t('margin.repayDialog.none') : errorText }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="submitting" @click="close">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="!validation.ok || submitting || record === undefined" data-testid="repay-submit" @click="submit">
        {{ submitting ? t('trade.submitting') : t('margin.repayDialog.submit') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin: 0; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 12px; }
.facts dt { color: var(--color-text-muted); font-size: 11.5px; }
.facts dd { margin: 2px 0 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; white-space: normal; }
.facts .strong { color: var(--color-accent-text); }
.field-input select { height: 44px; cursor: pointer; }
.max-btn { flex: 0 0 auto; padding: 0 4px; color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.max-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.notice { margin: 0; }
</style>
