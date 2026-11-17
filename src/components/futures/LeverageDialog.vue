<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Minus, Plus } from '@lucide/vue'
import * as api from '@/modules/futures/api'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { planLeverageChange } from '@/modules/futures/leverage-change'
import { liquidationInfo, liquidationView, validateLeverage } from '@/modules/futures/math'
import { signedDisplay } from '@/modules/futures/signed'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'
import FuturesDialog from './FuturesDialog.vue'

/**
 * Leverage picker for the current contract; saves through `user/level_edit`. Before saving it shows what the change
 * does to this contract's positions (cross: 可用 change, liquidation unchanged; isolated: margin moved from 可用 and
 * the new liquidation price) and refuses what mainstream exchanges refuse (`planLeverageChange`).
 */
const props = defineProps<{ current: number; min: number; max: number }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()
const market = useFuturesMarketStore()
const orders = useFuturesOrdersStore()

const raw = ref(String(props.current))
const error = ref<string | null>(null)
const restingOrders = ref<number | null>(null)
const cancelling = ref(false)
const saving = computed(() => account.busy === 'leverage')

const contract = computed(() => market.currentContract)
const coin = computed(() => contract.value?.marginCoin ?? 'USDT')
const coinDp = computed(() => contract.value?.marginCoinPrecision ?? 2)
const priceDp = computed(() => contract.value?.pricePrecision ?? 2)

const value = computed(() => (/^\d+$/.test(raw.value.trim()) ? Number.parseInt(raw.value.trim(), 10) : Number.NaN))
const invalid = computed(() => validateLeverage(value.value, props.min, props.max))
const presets = computed(() => {
  const marks = [1, 2, 5, 10, 20, 50, 75, 100, 125].filter((mark) => mark >= props.min && mark <= props.max)
  if (!marks.includes(props.max)) marks.push(props.max)
  return marks.slice(-6)
})
const fill = computed(() => {
  const span = props.max - props.min
  if (!Number.isFinite(value.value) || span <= 0) return '0%'
  return `${Math.min(100, Math.max(0, ((value.value - props.min) / span) * 100))}%`
})

const plan = computed(() => {
  if (invalid.value !== null || contract.value === undefined) return null
  return planLeverageChange({
    current: props.current,
    next: value.value,
    positions: account.contractPositions,
    available: account.available,
    restingOrders: restingOrders.value,
    multiplier: contract.value.multiplier,
    ceiling: account.config?.leverCeiling ?? {},
    precision: coinDp.value,
  })
})

/** Estimates read better at 2 decimals; the isolated top-up is sent (and shown) at the coin precision. */
const money = (amount: string, dp = Math.min(coinDp.value, 2)): string => signedDisplay(amount.replace(/^-/, ''), dp, false)
function liqText(price: string): string {
  const info = liquidationInfo(price, priceDp.value)
  return info.kind === 'none' ? t('fut.noLiquidation') : info.text
}
const blockText = computed(() => {
  const block = plan.value?.block
  if (!block) return null
  if (block.key === 'restingOrders') return t('fut.lev.block.restingOrders', { n: block.params.n, current: props.current })
  if (block.key === 'tierLimit') return t('fut.lev.block.tierLimit', { lever: block.params.lever, value: money(block.params.value), limit: money(block.params.limit), coin: coin.value })
  const hint = block.params.minLever !== null ? t('fut.lev.block.hintMin', { min: block.params.minLever }) : t('fut.lev.block.hintNone')
  return t(`fut.lev.block.${block.key}`, { lever: block.params.lever, need: money(block.params.need), available: money(block.params.available), coin: coin.value, hint })
})
const previewLines = computed(() => {
  const p = plan.value
  if (p === null || p.direction === 'same') return []
  const lever = value.value
  if (!p.hasPositions) return [t('fut.lev.noPosition')]
  const lines: string[] = []
  if (p.hasCross) {
    lines.push(p.direction === 'up'
      ? t('fut.lev.crossUp', { lever, amount: money(p.crossMarginDelta), coin: coin.value })
      : t('fut.lev.crossDown', { lever, amount: money(p.crossMarginDelta), after: money(p.availableAfter === '' || p.availableAfter.startsWith('-') ? '0' : p.availableAfter), coin: coin.value }))
    p.crossLiq.forEach((entry) => lines.push(`${entry.side === 'SELL' ? t('fut.short') : t('fut.long')} · ${t('fut.lev.liqNow', { price: liqText(entry.price) })}`))
  }
  if (p.hasIsolated) {
    if (p.direction === 'up') lines.push(t('fut.lev.isoUp', { lever }))
    else if (p.isolatedTopUps.length === 0) lines.push(t('fut.lev.isoDownNone', { lever }))
    else p.isolatedTopUps.forEach((topUp) => lines.push(t('fut.lev.isoDown', { lever, amount: money(topUp.amount, coinDp.value), coin: coin.value, before: liquidationView(topUp.liqBefore, priceDp.value), after: liquidationView(topUp.liqAfter, priceDp.value) })))
  }
  return lines
})
const topUpTotal = computed(() => plan.value?.topUpTotal ?? '0')
const hasTopUp = computed(() => (plan.value?.isolatedTopUps.length ?? 0) > 0)
const blocked = computed(() => plan.value?.block != null)

async function countRestingOrders(): Promise<void> {
  const id = contract.value?.id
  if (id === undefined) return
  try {
    restingOrders.value = (await api.fetchCurrentOrders({ contractId: id, page: 1, limit: 1 })).count
  } catch {
    restingOrders.value = null
  }
}
onMounted(() => { void countRestingOrders() })

async function cancelOrders(): Promise<void> {
  cancelling.value = true
  error.value = null
  await orders.load('current')
  const result = await orders.cancelAll(false)
  if (result !== null) error.value = result
  await countRestingOrders()
  cancelling.value = false
}

function step(delta: number): void {
  const base = Number.isFinite(value.value) ? value.value : props.current
  raw.value = String(Math.min(props.max, Math.max(props.min, base + delta)))
}

async function save(): Promise<void> {
  if (invalid.value !== null || blocked.value) return
  error.value = null
  const topUps = (plan.value?.isolatedTopUps ?? []).map((entry) => ({ positionId: entry.positionId, amount: entry.amount }))
  const result = await account.setLeverage(value.value, topUps)
  if (result === null) emit('close')
  else error.value = result
}
</script>

<template>
  <FuturesDialog :title="t('fut.leverageTitle')" :busy="saving" @close="emit('close')">
    <div class="lev-input">
      <button type="button" class="lev-step" :aria-label="'-1'" :disabled="saving" @click="step(-1)"><Minus :size="16" /></button>
      <label class="lev-value">
        <input v-model="raw" class="num" inputmode="numeric" :aria-label="t('fut.leverage')" :disabled="saving" />
        <span>x</span>
      </label>
      <button type="button" class="lev-step" :aria-label="'+1'" :disabled="saving" @click="step(1)"><Plus :size="16" /></button>
    </div>
    <input
      v-model="raw"
      class="lev-range"
      type="range"
      :min="min"
      :max="max"
      step="1"
      :style="{ '--fill': fill }"
      :aria-label="t('fut.leverage')"
      :disabled="saving"
    />
    <div class="lev-presets">
      <button v-for="mark in presets" :key="mark" type="button" class="chip-btn" :class="{ active: value === mark }" :disabled="saving" @click="raw = String(mark)">{{ mark }}x</button>
    </div>
    <p class="lev-range-text">{{ t('fut.leverageRange', { min, max }) }}</p>
    <p v-if="invalid !== null" class="field-error">{{ t(`fut.err.${invalid.key}`, invalid.params ?? {}) }}</p>
    <ul v-if="previewLines.length > 0 && !blocked" class="lev-preview" data-testid="lev-preview">
      <li v-for="(line, index) in previewLines" :key="index">{{ line }}</li>
    </ul>
    <p v-if="blockText !== null" class="notice notice-error wrap-anywhere" data-testid="lev-block">
      {{ blockText }}
      <button v-if="plan?.block?.key === 'restingOrders'" type="button" class="lev-cancel" :disabled="cancelling || saving" @click="cancelOrders">{{ t('fut.lev.cancelOrders') }}</button>
    </p>
    <p class="notice">{{ t('fut.leverageWarn') }}</p>
    <p v-if="error !== null" class="notice notice-error wrap-anywhere" data-testid="lev-error">{{ error }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="saving" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="saving || invalid !== null || blocked" data-testid="lev-confirm" @click="save">
        {{ saving ? t('fut.saving') : hasTopUp ? t('fut.lev.confirmTopUp', { amount: money(topUpTotal, coinDp), coin }) : t('fut.confirm') }}
      </button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.lev-input { display: grid; grid-template-columns: 44px 1fr 44px; gap: 8px; align-items: center; }
.lev-step { height: 44px; border-radius: 10px; background: var(--color-surface-alt); color: var(--color-text-secondary); display: inline-flex; align-items: center; justify-content: center; }
.lev-step:hover:not(:disabled) { color: var(--color-text); background: var(--color-hover); }
.lev-value { display: flex; align-items: center; justify-content: center; gap: 2px; height: 44px; border-radius: 10px; background: var(--color-surface-alt); border: 1px solid transparent; }
.lev-value:focus-within { border-color: var(--color-accent); }
.lev-value input { width: 80px; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 20px; font-weight: 700; text-align: center; }
.lev-value span { color: var(--color-text-muted); font-weight: 700; }
.lev-range { width: 100%; margin: 18px 0 8px; appearance: none; height: 4px; border-radius: 4px; background: linear-gradient(to right, var(--color-accent) var(--fill), var(--color-border-strong) var(--fill)); }
.lev-range::-webkit-slider-thumb { appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--color-elevated); border: 3px solid var(--color-accent); cursor: pointer; }
.lev-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--color-elevated); border: 3px solid var(--color-accent); cursor: pointer; }
.lev-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn { height: 28px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: 7px; font-family: var(--font-mono); font-size: 12px; color: var(--color-text-secondary); }
.chip-btn:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-text-muted); }
.chip-btn.active { border-color: var(--color-accent); color: var(--color-accent-text); background: var(--color-accent-soft); }
.lev-range-text { margin: 12px 0 8px; color: var(--color-text-muted); font-size: 12px; }
.notice { margin: 8px 0 0; }
.lev-preview { margin: 10px 0 0; padding: 10px 12px 10px 26px; border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 12px; line-height: 1.6; }
.lev-cancel { display: inline-block; margin-top: 6px; padding: 0 10px; height: 26px; border: 1px solid currentColor; border-radius: 6px; font-size: 12px; color: inherit; }
.lev-cancel:disabled { opacity: .5; }
</style>
