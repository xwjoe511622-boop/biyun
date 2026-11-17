<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { X } from '@lucide/vue'
import { fetchBonusRate, followTrader, profitShare, validateFollow, type FollowMode, type FollowRecord, type FollowSettings } from '@/modules/copytrading/copytrading.api'
import { isUnset } from '@/modules/copytrading/format'
import { errorMessage } from '@/modules/content/api-helpers'
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { useCopyI18n } from '@/modules/copytrading/i18n'

/**
 * Follow / edit settings (`traderUser/create` is an upsert). Server errors are shown verbatim. Binance-style (2026-09-30):
 * copy mode (fixed ratio / fixed amount), the margin cap for this copy, optional TP/SL, the profit-share rule (rate from
 * `trader/traderBonusRate`) and a risk acknowledgement that must be ticked before following (not needed to edit).
 */
const props = defineProps<{ traderUid: string; name: string; existing?: FollowRecord | null }>()
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved'): void }>()
const { t } = useCopyI18n()

function initial(value: string | undefined): string {
  return value === undefined || isUnset(value) ? '' : value
}

const form = reactive<FollowSettings>({
  traderUid: props.traderUid,
  mode: props.existing?.type === 1 ? 'amount' : 'ratio',
  value: props.existing?.type === 1 ? initial(props.existing?.amount) : initial(props.existing?.rate),
  deposit: initial(props.existing?.deposit),
  takeProfit: initial(props.existing?.profitRatio),
  stopLoss: initial(props.existing?.lossRatio),
})
const attempted = ref(false)
const saving = ref(false)
const { text: error, set: setError } = useLocalizedNotice()
const errors = computed(() => (attempted.value ? validateFollow(form) : {}))
const dialog = ref<HTMLElement | null>(null)
const bonusRate = ref(10)
void fetchBonusRate().then((rate) => { bonusRate.value = rate }).catch(() => { /* default 10 */ })
const shareExample = computed(() => ({ profit: '10.00', share: profitShare('10', bonusRate.value) }))
/** New follows must tick the risk acknowledgement; editing an existing copy does not ask again. */
const acknowledged = ref(props.existing !== null && props.existing !== undefined)

function setMode(mode: FollowMode): void {
  if (form.mode !== mode) form.value = ''
  form.mode = mode
}

async function save(): Promise<void> {
  attempted.value = true
  error.value = ''
  if (Object.keys(validateFollow(form)).length > 0) return
  if (!acknowledged.value) {
    setError(() => t('copy.p.ackRequired'))
    return
  }
  saving.value = true
  try {
    await followTrader(form)
    emit('saved')
  } catch (failure) {
    // Also a rejected session: say so (10-01 audit: follow/unfollow failed silently on 401).
    error.value = errorMessage(failure)
  } finally {
    saving.value = false
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !saving.value) emit('close')
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  dialog.value?.querySelector<HTMLInputElement>('input')?.focus()
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="backdrop" @click.self="!saving && emit('close')">
    <section ref="dialog" class="dialog" role="dialog" aria-modal="true" :aria-label="t('copy.dialogTitle', { name })">
      <header class="dialog-head">
        <h2 class="ellipsis">{{ t('copy.dialogTitle', { name }) }}</h2>
        <button class="icon-button" type="button" :aria-label="t('copy.cancel')" :disabled="saving" @click="emit('close')"><X :size="18" /></button>
      </header>
      <form class="dialog-body" novalidate @submit.prevent="save">
        <div class="field">
          <span class="field-label">{{ t('copy.mode') }}</span>
          <div class="modes" role="radiogroup">
            <button class="mode" :class="{ active: form.mode === 'ratio' }" type="button" role="radio" :aria-checked="form.mode === 'ratio'" @click="setMode('ratio')">{{ t('copy.modeRatio') }}</button>
            <button class="mode" :class="{ active: form.mode === 'amount' }" type="button" role="radio" :aria-checked="form.mode === 'amount'" @click="setMode('amount')">{{ t('copy.modeAmount') }}</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="copy-value">{{ form.mode === 'ratio' ? t('copy.ratio') : t('copy.amount') }}</label>
          <div class="field-input" :class="{ invalid: errors.value }"><input id="copy-value" v-model="form.value" class="num" inputmode="decimal" autocomplete="off" /></div>
          <p v-if="errors.value" class="field-error">{{ t(`copy.err.${errors.value}`) }}</p>
          <p v-else class="field-hint">{{ form.mode === 'ratio' ? t('copy.ratioHint') : t('copy.amountHint') }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="copy-deposit">{{ t('copy.deposit') }}</label>
          <div class="field-input" :class="{ invalid: errors.deposit }"><input id="copy-deposit" v-model="form.deposit" class="num" inputmode="decimal" autocomplete="off" /><span class="field-suffix">USDT</span></div>
          <p v-if="errors.deposit" class="field-error">{{ t(`copy.err.${errors.deposit}`) }}</p>
          <p v-else class="field-hint">{{ t('copy.depositHint') }}</p>
        </div>
        <div class="row2">
          <div class="field">
            <label class="field-label" for="copy-tp">{{ t('copy.takeProfit') }}<small>{{ t('copy.optional') }}</small></label>
            <div class="field-input" :class="{ invalid: errors.takeProfit }"><input id="copy-tp" v-model="form.takeProfit" class="num" inputmode="decimal" autocomplete="off" /><span class="field-suffix">%</span></div>
            <p v-if="errors.takeProfit" class="field-error">{{ t(`copy.err.${errors.takeProfit}`) }}</p>
          </div>
          <div class="field">
            <label class="field-label" for="copy-sl">{{ t('copy.stopLoss') }}<small>{{ t('copy.optional') }}</small></label>
            <div class="field-input" :class="{ invalid: errors.stopLoss }"><input id="copy-sl" v-model="form.stopLoss" class="num" inputmode="decimal" autocomplete="off" /><span class="field-suffix">%</span></div>
            <p v-if="errors.stopLoss" class="field-error">{{ t(`copy.err.${errors.stopLoss}`) }}</p>
          </div>
        </div>
        <p class="share" data-testid="copy-share-rule">{{ t('copy.p.shareRule', { rate: bonusRate }) }}<br /><span class="muted">{{ t('copy.p.shareExample', shareExample) }}</span></p>
        <section class="ack" role="group" :aria-label="t('copy.p.ackTitle')" data-testid="copy-ack">
          <h3>{{ t('copy.p.ackTitle') }}</h3>
          <ul>
            <li>{{ t('copy.p.ack1') }}</li>
            <li>{{ t('copy.p.ack2') }}</li>
            <li>{{ t('copy.p.ack3') }}</li>
            <li>{{ t('copy.p.ack4') }}</li>
          </ul>
          <label class="ack-check"><input v-model="acknowledged" type="checkbox" data-testid="copy-ack-check" /><span>{{ t('copy.p.ackCheck') }}</span></label>
        </section>
        <p v-if="error !== ''" class="notice notice-error" role="alert">{{ error }}</p>
        <div class="dialog-actions">
          <button class="btn" type="button" :disabled="saving" @click="emit('close')">{{ t('copy.cancel') }}</button>
          <button class="btn btn-primary" type="submit" data-testid="copy-follow-submit" :disabled="saving || !acknowledged">{{ saving ? t('copy.saving') : existing ? t('copy.saveEdit') : t('copy.save') }}</button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(3, 4, 6, .62); backdrop-filter: blur(3px); }
.dialog { display: flex; flex-direction: column; width: 480px; max-width: 100%; max-height: calc(100vh - 32px); border: 1px solid var(--color-border-strong); border-radius: 18px; background: var(--color-elevated); box-shadow: var(--shadow-pop); animation: rise-in .25s var(--ease-out); }
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 18px 12px 22px; border-bottom: 1px solid var(--color-border); }
.dialog-head h2 { margin: 0; font-size: 16px; min-width: 0; }
.dialog-body { display: flex; flex-direction: column; gap: 16px; padding: 18px 22px 22px; overflow-y: auto; }
.modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mode { height: 40px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13px; font-weight: 600; }
.mode.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field-label small { color: var(--color-text-muted); font-weight: 500; }
.notice { margin: 0; }
.share { margin: 0; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary); }
.ack { margin: 0; padding: 10px 12px 12px; border: 1px solid var(--color-warning-soft); border-radius: 10px; background: var(--color-warning-soft); }
.ack h3 { margin: 0 0 8px; padding: 0; font-size: 12px; font-weight: 700; color: var(--color-warning); }
.ack ul { margin: 0 0 8px; padding-left: 18px; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary); }
.ack-check { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; }
.dialog-actions .btn { min-width: 110px; height: 42px; }
@media (max-width: 480px) { .row2 { grid-template-columns: 1fr; } }
</style>
