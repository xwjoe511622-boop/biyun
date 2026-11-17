<script setup lang="ts">
import { computed, ref } from 'vue'
import { groupDigits, isDecimalString, sub, toFixedString } from '@/modules/finance/decimal'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { clampAvailable, validateAmount } from '@/modules/futures/math'
import type { FuturesPosition } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import FuturesDialog from './FuturesDialog.vue'

/** Isolated margin add/remove through `position/change_position_margin` (negative amount removes). */
const props = defineProps<{ position: FuturesPosition; coin: string; precision: number }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()

const mode = ref<'add' | 'reduce'>('add')
const amount = ref('')
const touched = ref(false)
const error = ref<string | null>(null)
const saving = computed(() => account.busy === `margin:${props.position.id}`)

const limit = computed(() => (mode.value === 'add' ? account.available : clampAvailable(props.position.canSubMarginAmount)))
const limitText = computed(() => (limit.value === '' ? '--' : groupDigits(toFixedString(limit.value, props.precision), props.precision)))
const validation = computed(() => validateAmount(amount.value, limit.value === '' ? '' : toFixedString(limit.value, props.precision), props.precision))
const errorText = computed(() => {
  if (validation.value.ok || validation.value.error === null) return ''
  if (mode.value === 'reduce' && validation.value.error === 'insufficient') return t('fut.maxReduceHint', { amount: limitText.value, coin: props.coin })
  if (validation.value.error === 'insufficient') return `${t('fut.err.insufficient', { available: limitText.value })} ${props.coin}`
  return t(`fut.err.${validation.value.error}`, validation.value.params ?? {})
})
const invested = computed(() => isDecimalString(props.position.holdAmount) && isDecimalString(props.position.unRealizedAmount) ? sub(props.position.holdAmount, props.position.unRealizedAmount) : '')
const investedText = computed(() => invested.value === '' ? '--' : groupDigits(toFixedString(invested.value, props.precision), props.precision))
const holdText = computed(() => (props.position.holdAmount === '' ? '--' : groupDigits(toFixedString(props.position.holdAmount, props.precision), props.precision)))

function switchMode(next: 'add' | 'reduce'): void {
  mode.value = next
  amount.value = ''
  touched.value = false
  error.value = null
}

async function submit(): Promise<void> {
  touched.value = true
  if (!validation.value.ok) return
  error.value = null
  const signed = mode.value === 'add' ? validation.value.amount : `-${validation.value.amount}`
  const result = await account.adjustMargin(props.position, signed)
  if (result === null) emit('close')
  else error.value = result
}
</script>

<template>
  <FuturesDialog :title="t('fut.adjustMargin')" :busy="saving" @close="emit('close')">
    <div class="seg" role="group">
      <button type="button" :class="{ active: mode === 'add' }" :aria-pressed="mode === 'add'" @click="switchMode('add')">{{ t('fut.addMargin') }}</button>
      <button type="button" :class="{ active: mode === 'reduce' }" :aria-pressed="mode === 'reduce'" @click="switchMode('reduce')">{{ t('fut.reduceMargin') }}</button>
    </div>
    <div class="facts">
      <div><span class="muted">{{ t('fut.marginEquity') }}</span><b class="num" :title="position.holdAmount">{{ holdText }} {{ coin }}</b></div>
      <div><span class="muted">{{ t('fut.marginInvested') }}</span><b class="num" :title="invested">{{ investedText }} {{ coin }}</b></div>
      <div><span class="muted">{{ mode === 'add' ? t('fut.canAdd') : t('fut.canReduce') }}</span><b class="num" :title="limit">{{ limitText }} {{ coin }}</b></div>
    </div>
    <label class="field-input amount" :class="{ invalid: touched && errorText !== '' }">
      <input v-model="amount" class="num" inputmode="decimal" :placeholder="t('fut.amount')" :aria-label="t('fut.amount')" :disabled="saving" @blur="touched = true" />
      <span class="field-suffix">{{ coin }}</span>
    </label>
    <p v-if="touched && errorText !== ''" class="field-error">{{ errorText }}</p>
    <p v-if="error !== null" class="notice notice-error wrap-anywhere">{{ error }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="saving" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="saving || !validation.ok" @click="submit">{{ saving ? t('fut.submitting') : t('fut.confirm') }}</button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 3px; border-radius: 10px; background: var(--color-surface-alt); }
.seg button { height: 32px; border-radius: 8px; color: var(--color-text-muted); font-size: 13px; font-weight: 650; }
.seg button.active { background: var(--color-elevated); color: var(--color-text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); }
.facts { display: grid; gap: 6px; margin: 14px 0; font-size: 12px; }
.facts div { display: flex; justify-content: space-between; gap: 8px; }
.amount { height: 46px; border-radius: 10px; }
.amount input { font-family: var(--font-mono); font-weight: 600; }
.notice { margin: 10px 0 0; }
</style>
