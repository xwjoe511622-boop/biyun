<script setup lang="ts">
import { computed, ref } from 'vue'
import { toastError, toastSuccess } from '@/core/toast'
import { useFuturesI18n } from '@/modules/futures/i18n'
import type { ReverseStep } from '@/modules/futures/reverse'
import type { FuturesPosition } from '@/modules/futures/types'
import { useContractQuote } from '@/modules/futures/use-contract-quote'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import FuturesDialog from './FuturesDialog.vue'

/** 反手 confirmation (Binance "Reverse"): what will be sent, then 「反手中 1/2 · 2/2」 while the two orders run. */
const props = defineProps<{ position: FuturesPosition; contractName: string; size: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()
const market = useFuturesMarketStore()
/** The position's own contract book / last (not the page's contract, L640). */
const quote$ = useContractQuote(() => market.contracts.find((entry) => entry.id === props.position.contractId))

const step = ref<ReverseStep | null>(null)
const running = computed(() => step.value !== null)
const sideText = computed(() => (props.position.orderSide === 'BUY' ? t('fut.long') : t('fut.short')))
const otherText = computed(() => (props.position.orderSide === 'BUY' ? t('fut.short') : t('fut.long')))
const stepText = computed(() => (step.value === null ? '' : t('fut.pos.reverseStep', { step: step.value, text: step.value === 1 ? t('fut.pos.reverseStepClose') : t('fut.pos.reverseStepOpen') })))

async function go(): Promise<void> {
  if (running.value) return
  step.value = 1
  const result = await account.reversePosition(props.position, (next) => { step.value = next }, { readLevels: quote$.readLevels, last: () => quote$.last.value })
  step.value = null
  if (result.ok) {
    toastSuccess(t(result.visible ? 'fut.pos.reverseDone' : 'fut.pos.reverseDonePending', { side: sideText.value, other: otherText.value }), 'fut-reverse')
    emit('close')
    return
  }
  if (result.message === '') {
    // Nothing was sent: another action is running, or the position / contract data is incomplete — say which.
    toastError(account.busy !== null ? t('fut.pm.busy') : t('fut.err.incomplete'), 'fut-reverse')
    return
  }
  if (result.step === 2) {
    toastError(t('fut.pos.reverseOpenFailed', { reason: result.message }), 'fut-reverse')
    emit('close')
  } else {
    toastError(result.message, 'fut-reverse')
  }
}
</script>

<template>
  <FuturesDialog :title="`${t('fut.pos.reverseTitle')} · ${contractName}`" :busy="running" @close="emit('close')">
    <p class="rv-body" data-testid="fut-reverse-body">
      {{ t('fut.pos.reverseBody', { side: sideText, other: otherText, size, lever: position.leverageLevel ?? '--' }) }}
    </p>
    <p class="rv-note">{{ t('fut.pos.reverseNote') }}</p>
    <p class="rv-step" role="status" :class="{ hidden: !running }">{{ stepText || '\u00a0' }}</p>
    <template #footer>
      <button class="btn btn-ghost" type="button" :disabled="running" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" type="button" data-testid="fut-reverse-go" :disabled="running || account.busy !== null" @click="go">
        {{ running ? t('fut.submitting') : t('fut.pos.reverseGo') }}
      </button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.rv-body { margin: 0 0 10px; line-height: 1.6; }
.rv-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--color-text-muted); }
.rv-step { margin: 10px 0 0; min-height: 20px; font-size: 13px; color: var(--color-accent); }
.rv-step.hidden { visibility: hidden; }
</style>
