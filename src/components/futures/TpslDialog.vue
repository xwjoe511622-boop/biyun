<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PercentSlider from '@/components/common/PercentSlider.vue'
import { describeApiError, describeTpslCancel, tpslCancelOutcome } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import { Decimal, canonicalDecimal, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { cancelTpsl, fetchPositionTpsl } from '@/modules/futures/api'
import { positionTpslRows, type WorkingType } from '@/modules/futures/fapi-conditional'
import TicketSelect from './TicketSelect.vue'
import { useFuturesOrdersStore } from '@/stores/futures-orders'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { valueWireDp } from '@/modules/futures/math'
import { contractsToUnit, type SizeMarket } from '@/modules/futures/size-unit'
import { contractsToPercent, percentToContracts, tpslLegs, tpslSizeCheck, tpslTriggerCheck, type TpslError, type TpslUnit } from '@/modules/futures/tpsl-size'
import type { FuturesPosition, TpslRow } from '@/modules/futures/types'
import { useContractQuote } from '@/modules/futures/use-contract-quote'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { toastSuccess } from '@/core/toast'
import { fullPositionReplacements } from '@/modules/futures/tpsl-summary'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import FuturesDialog from './FuturesDialog.vue'

/**
 * Position take-profit / stop-loss (Binance 「止盈止损」). Since 10-02 (core trigger engine, fgw 0.6.9+): TAKE_PROFIT_MARKET /
 * STOP_MARKET close orders on `/fapi/v1/order`, watching the 标记价格 or 最新价格 (`workingType`); at 100% of the
 * closable size the legs are 「全部平仓」 (`closePosition=true`: whatever is held when it fires). Listed from
 * `/fapi/v1/openOrders`, cancelled with `DELETE /fapi/v1/order`. A `-4000` account (copy trading) keeps the classic
 * `order_tpsl_create` / `take_profit_stop_loss` / `order_tpsl_cancel` (last price only). Triggers are validated against
 * the chosen price (long TP above, long SL below and above the liquidation price; short mirrored).
 */
const props = defineProps<{ position: FuturesPosition; pricePrecision: number; quote: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()
const market = useFuturesMarketStore()
const orders = useFuturesOrdersStore()
/** `/fapi` in use (else the classic path: last price only, no 全部平仓). */
const fapi = computed(() => account.fapiOrdersActive())
const workingType = ref<WorkingType>('MARK_PRICE')
const workingOptions = computed(() => [
  { value: 'MARK_PRICE' as const, label: t('fut.tpq.markPrice') },
  { value: 'CONTRACT_PRICE' as const, label: t('fut.tpq.lastPriceFull') },
])
const sizes = useSizeFormat()

const tp = ref('')
const sl = ref('')

const contract = computed(() => market.allContracts.find((entry) => entry.id === props.position.contractId))
/**
 * Last trade price of the POSITION's contract (the page may show another contract: its ticker is subscribed on demand,
 * `use-contract-quote.ts`; 09-30, L640). The server validates triggers against it.
 */
const quote$ = useContractQuote(() => contract.value)
const last = computed(() => (Number(quote$.last.value) > 0 ? quote$.last.value : '')) // float-ok: "> 0" presence check, the string itself is used
/** Price used for USDT conversion: last, else the position mark, else the entry average. */
const priceForValue = computed(() => {
  if (last.value !== '') return last.value
  if (isPositive(props.position.markPrice)) return props.position.markPrice
  return props.position.openAvgPrice
})

const long = computed(() => props.position.orderSide === 'BUY')
/** Mark price of the position's contract: the live page mark when it is that contract, else the position snapshot. */
const mark = computed(() => {
  const live = contract.value?.id === market.currentContract?.id ? canonicalDecimal(market.markPrice) : ''
  if (isPositive(live)) return live
  return isPositive(canonicalDecimal(props.position.markPrice)) ? canonicalDecimal(props.position.markPrice) : ''
})
/** The price the triggers are checked against (and fire on). */
const reference = computed(() => (fapi.value && workingType.value === 'MARK_PRICE' ? mark.value : last.value))
const referenceName = computed(() => (fapi.value && workingType.value === 'MARK_PRICE' ? t('fut.tpq.markPrice') : t('fut.tpq.lastPrice')))

/* -------------------------------------------------------------- quantity (Binance style) */

const unit = ref<TpslUnit>(sizes.unit.value === 'quote' ? 'quote' : 'base')
const percent = ref(100)
/** Whole contracts picked by the slider; `''` while the user is typing. */
const preset = ref(props.position.canCloseVolume)

const baseUnitLabel = computed(() => contract.value?.base || sizes.label(contract.value, 'base'))
const quoteUnitLabel = computed(() => props.quote)
const unitLabel = computed(() => (unit.value === 'base' ? baseUnitLabel.value : quoteUnitLabel.value))

const marketForSize = computed<SizeMarket>(() => ({
  multiplier: contract.value?.multiplier ?? '',
  price: priceForValue.value,
  coinDp: contract.value === undefined ? 2 : valueWireDp(contract.value),
}))

/** Close min: `max(1, contract.minOrderVolume)` whole contracts. */
const minContracts = computed(() => {
  const minOrder = canonicalDecimal(contract.value?.minOrderVolume ?? '')
  if (isDecimalString(minOrder) && isPositive(minOrder)) return new Decimal(minOrder).gte(1) ? minOrder : '1'
  return '1'
})

function sizeInput(raw: string, presetContracts?: string) {
  return {
    raw,
    unit: unit.value,
    presetContracts,
    multiplier: marketForSize.value.multiplier,
    price: marketForSize.value.price,
    coinDp: marketForSize.value.coinDp,
    canClose: props.position.canCloseVolume,
    minContracts: minContracts.value,
    labels: { unit: unitLabel.value, contracts: t('fut.contracts') },
  }
}

const sized = computed(() => tpslSizeCheck(sizeInput(volume.value, preset.value === '' ? undefined : preset.value)))

/** The 100% text in the current unit; the default follows it as contract / price arrive. */
const fullText = computed(() => contractsToUnit(props.position.canCloseVolume, unit.value, marketForSize.value, 'down'))
const volume = ref(fullText.value)
watch(fullText, (next, previous) => {
  if (preset.value === props.position.canCloseVolume && (volume.value === previous || volume.value === '')) volume.value = next
})

function onVolumeInput(event: Event): void {
  preset.value = ''
  const raw = (event.target as HTMLInputElement).value
  const result = tpslSizeCheck(sizeInput(raw))
  if (isPositive(canonicalDecimal(result.contracts))) percent.value = contractsToPercent(result.contracts, props.position.canCloseVolume)
}

function onPercent(next: number): void {
  percent.value = next
  preset.value = percentToContracts(props.position.canCloseVolume, next)
  volume.value = contractsToUnit(preset.value, unit.value, marketForSize.value, 'down')
}

function setUnit(next: TpslUnit): void {
  if (next === unit.value) return
  const contracts = sized.value.contracts
  unit.value = next
  if (isPositive(canonicalDecimal(contracts))) {
    preset.value = contracts
    volume.value = contractsToUnit(contracts, next, marketForSize.value, 'down')
  }
}

/* -------------------------------------------------------------- trigger / submit */

const tpCheck = computed(() => tpslTriggerCheck({ raw: tp.value, kind: 'tp', long: long.value, last: reference.value, liq: props.position.reducePrice, dp: props.pricePrecision }))
const slCheck = computed(() => tpslTriggerCheck({ raw: sl.value, kind: 'sl', long: long.value, last: reference.value, liq: props.position.reducePrice, dp: props.pricePrecision }))

function renderError(error: TpslError | null): string {
  if (error === null) return ''
  const key = error.ns === 'tpq' ? `fut.tpq.${error.key}` : `fut.err.${error.key}`
  return t(key, { refName: referenceName.value, ...(error.params ?? {}) })
}

/** 100% of the closable size on `/fapi` = 「全部平仓」 (`closePosition`). */
const entire = computed(() => fapi.value && sized.value.contracts !== '' && new Decimal(canonicalDecimal(sized.value.contracts) || '0').gte(canonicalDecimal(props.position.canCloseVolume) || '0') && isPositive(canonicalDecimal(props.position.canCloseVolume)))

const tpError = computed(() => renderError(tpCheck.value.error))
const slError = computed(() => renderError(slCheck.value.error))
const volumeError = computed(() => renderError(sized.value.error))

/** The chosen size in the other unit plus its share of the closable size, e.g. `≈ 750.00 USDT · 37%` (no 张 in the UI). */
const hint = computed(() => {
  const contracts = sized.value.contracts
  if (!isPositive(canonicalDecimal(contracts))) return ''
  const other: TpslUnit = unit.value === 'base' ? 'quote' : 'base'
  const amount = contractsToUnit(contracts, other, marketForSize.value, 'down')
  const label = other === 'base' ? baseUnitLabel.value : quoteUnitLabel.value
  const share = entire.value ? t('fut.tpq.entire') : `${percent.value}%`
  return amount === '' ? share : `≈ ${groupDigits(amount)} ${label} · ${share}`
})

const empty = computed(() => tpCheck.value.price === '' && slCheck.value.price === '')
const ok = computed(() => !empty.value && tpError.value === '' && slError.value === '' && volumeError.value === '')

const touched = ref(false)
const error = ref<string | null>(null)
const listError = ref<string | null>(null)
const existing = ref<{ takeProfit: TpslRow[]; stopLoss: TpslRow[] } | null>(null)
const canceling = ref<string | null>(null)
const saving = computed(() => account.busy === `tpsl:${props.position.id}`)

async function loadExisting(): Promise<void> {
  if (props.position.orderSide === '') return
  listError.value = null
  if (fapi.value) {
    // `/fapi/v1/openOrders` (core memory) → the shared conditional map; the list below follows it.
    orders.refreshConditionals(0)
    return
  }
  try {
    existing.value = await fetchPositionTpsl(props.position.contractId, props.position.orderSide)
  } catch (error_) {
    listError.value = describeApiError(error_, requestLanguage())
  }
}
watch(() => [fapi.value, orders.conditionalsKnown, orders.conditionalRows] as const, ([on, known, rows]) => {
  if (on && known) existing.value = positionTpslRows(rows, props.position)
}, { immediate: true })

/** Cancels TP/SL rows: `DELETE /fapi/v1/order` one by one (or the classic batch call). */
async function cancelRows(ids: string[]): Promise<void> {
  if (!fapi.value) {
    await cancelTpsl(props.position.contractId, ids)
    return
  }
  for (const id of ids) {
    orders.noteCancelled(id)
    await account.cancelConditionalRouted(props.position.contractId, id)
  }
  // Live: the CANCELED events update the list; otherwise read the snapshot.
  if (!account.live) orders.refreshConditionals(0)
}

/**
 * Binance: one entire-position TP and one SL. A new leg sized at the whole closable volume replaces the existing
 * whole-position leg of the same kind (placed first, then the old one is cancelled, so the position is never left
 * unprotected); partial legs stack. Shown under the inputs before submitting.
 */
const replacements = computed(() => fullPositionReplacements(existing.value, { tp: tpCheck.value.price !== '', sl: slCheck.value.price !== '', contracts: sized.value.contracts }, props.position.canCloseVolume))
const replaceNote = computed(() => {
  const parts = [
    ...replacements.value.takeProfit.map((row) => `${t('fut.takeProfit')} ${price(row.triggerPrice)}`),
    ...replacements.value.stopLoss.map((row) => `${t('fut.stopLoss')} ${price(row.triggerPrice)}`),
  ]
  return parts.length === 0 ? '' : t('fut.tpq.replaceNote', { list: parts.join('、') })
})

async function submit(): Promise<void> {
  touched.value = true
  if (!ok.value) return
  error.value = null
  const legs = tpslLegs({ tp: tpCheck.value.price, sl: slCheck.value.price, contracts: sized.value.contracts })
  const replaced = [...replacements.value.takeProfit, ...replacements.value.stopLoss]
  const result = await account.createTpsl(props.position, legs, { workingType: workingType.value, closePosition: entire.value })
  if (result !== null) {
    error.value = result
    // A leg may have been placed before the refusal: show the real list.
    await loadExisting()
    return
  }
  if (replaced.length > 0) {
    try {
      await cancelRows(replaced.map((row) => row.id))
      toastSuccess(t('fut.tpq.replaced', { n: replaced.length }), 'fut-tpsl')
    } catch (error_) {
      error.value = t('fut.tpq.replaceFailed', { reason: cancelFailure(error_) })
    }
  }
  tp.value = ''
  sl.value = ''
  touched.value = false
  await loadExisting()
}

async function cancelRow(row: TpslRow): Promise<void> {
  canceling.value = row.id
  error.value = null
  try {
    await cancelRows([row.id])
    await loadExisting()
  } catch (error_) {
    error.value = cancelFailure(error_)
    // Some ids may have been cancelled even when the answer is 10021 (per-id results): show the real list.
    if (tpslCancelOutcome(error_, requestLanguage()) !== null) await loadExisting()
  } finally {
    canceling.value = null
  }
}

/** 「已撤销 1 个，1 个未撤销：#123 订单已成交或已撤销」 for per-id results, else the localised error. */
function cancelFailure(error_: unknown): string {
  const outcome = tpslCancelOutcome(error_, requestLanguage())
  return outcome !== null ? describeTpslCancel(outcome, requestLanguage()) : describeApiError(error_, requestLanguage())
}

function price(value: string): string {
  return value === '' ? '--' : groupDigits(value, props.pricePrecision)
}

onMounted(() => void loadExisting())
</script>

<template>
  <FuturesDialog :title="t('fut.tpslTitle')" :width="460" :busy="saving" @close="emit('close')">
    <div class="facts">
      <div><span class="muted">{{ t('fut.entryPrice') }}</span><b class="num">{{ price(position.openAvgPrice) }}</b></div>
      <div><span class="muted">{{ t('fut.markPrice') }}</span><b class="num">{{ price(position.markPrice) }}</b></div>
      <div><span class="muted">{{ t('fut.canClose') }}</span><b class="num">{{ sizes.sizeWithUnit(position.canCloseVolume, contract, priceForValue) }}</b></div>
    </div>
    <label class="field">
      <span class="field-label">{{ t('fut.takeProfit') }}</span>
      <span class="field-input" :class="{ invalid: touched && tpError !== '' }"><input v-model="tp" data-testid="fut-tpsl-tp" class="num" inputmode="decimal" :disabled="saving" @blur="touched = true" /><span class="field-suffix">{{ quote }}</span></span>
      <span v-if="touched && tpError !== ''" class="field-error">{{ tpError }}</span>
    </label>
    <label class="field">
      <span class="field-label">{{ t('fut.stopLoss') }}</span>
      <span class="field-input" :class="{ invalid: touched && slError !== '' }"><input v-model="sl" data-testid="fut-tpsl-sl" class="num" inputmode="decimal" :disabled="saving" @blur="touched = true" /><span class="field-suffix">{{ quote }}</span></span>
      <span v-if="touched && slError !== ''" class="field-error">{{ slError }}</span>
    </label>
    <div class="tpq-trigger">
      <span class="muted">{{ t('fut.tpq.triggerBy') }}</span>
      <TicketSelect v-if="fapi" v-model="workingType" class="tpq-type" testid="fut-tpsl-working" :label="t('fut.tpq.triggerBy')" :options="workingOptions" :disabled="saving" />
      <b v-else>{{ t('fut.tpq.lastPrice') }}</b>
      <span v-if="reference !== ''" class="num muted" data-testid="fut-tpsl-ref">{{ price(reference) }}</span>
      <span class="muted tpq-note">{{ fapi ? (entire ? t('fut.tpq.entireHint') : t('fut.tpq.triggerByNoteFapi')) : t('fut.tpq.triggerByNote') }}</span>
    </div>
    <!-- A div, not a label: a click on the slider rail must not be forwarded to the input (keyboard pops up on phones). -->
    <div class="field">
      <span class="field-label">{{ t('fut.closeVolume') }}</span>
      <span class="field-input" :class="{ invalid: touched && volumeError !== '' }">
        <input v-model="volume" data-testid="fut-tpsl-qty" class="num" inputmode="decimal" :aria-label="`${t('fut.closeVolume')} (${unitLabel})`" :disabled="saving" @input="onVolumeInput" @blur="touched = true" />
        <span class="unit-toggle">
          <button type="button" data-testid="fut-tpsl-unit-base" :class="{ active: unit === 'base' }" :disabled="saving" @click="setUnit('base')">{{ baseUnitLabel }}</button>
          <button type="button" data-testid="fut-tpsl-unit-quote" :class="{ active: unit === 'quote' }" :disabled="saving" @click="setUnit('quote')">{{ quoteUnitLabel }}</button>
        </span>
      </span>
      <PercentSlider :model-value="percent" :marks="[0, 25, 50, 100]" tone="accent" :label="t('fut.tpq.percent')" :disabled="saving" @update:model-value="onPercent" />
      <span class="field-hint muted" data-testid="fut-tpsl-hint">{{ hint }}</span>
      <span v-if="touched && volumeError !== ''" class="field-error">{{ volumeError }}</span>
    </div>
    <p class="field-hint">{{ t('fut.tpslMarketHint') }}</p>
    <p class="field-hint replace-note" data-testid="fut-tpsl-replace" :class="{ hidden: replaceNote === '' }">{{ replaceNote || '\u00a0' }}</p>

    <div class="existing">
      <p class="ex-title">{{ t('fut.tpslExisting') }}</p>
      <p v-if="listError !== null" class="field-error wrap-anywhere">{{ listError }}</p>
      <template v-else-if="existing !== null">
        <div v-for="row in existing.takeProfit" :key="`tp-${row.id}`" class="ex-row">
          <span class="up">TP</span><span class="num">{{ price(row.triggerPrice) }}</span><span class="num muted">{{ sizes.sizeWithUnit(row.volume, contract, row.triggerPrice) }}</span>
          <button class="btn btn-ghost ex-cancel" type="button" :disabled="canceling !== null" @click="cancelRow(row)">{{ t('fut.tpslCancel') }}</button>
        </div>
        <div v-for="row in existing.stopLoss" :key="`sl-${row.id}`" class="ex-row">
          <span class="down">SL</span><span class="num">{{ price(row.triggerPrice) }}</span><span class="num muted">{{ sizes.sizeWithUnit(row.volume, contract, row.triggerPrice) }}</span>
          <button class="btn btn-ghost ex-cancel" type="button" :disabled="canceling !== null" @click="cancelRow(row)">{{ t('fut.tpslCancel') }}</button>
        </div>
        <p v-if="existing.takeProfit.length + existing.stopLoss.length === 0" class="muted ex-empty">{{ t('fut.tpslNone') }}</p>
      </template>
    </div>
    <p v-if="error !== null" class="notice notice-error wrap-anywhere">{{ error }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="saving" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" data-testid="fut-tpsl-submit" type="button" :disabled="saving || !ok" @click="submit">{{ saving ? t('fut.submitting') : t('fut.confirm') }}</button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; background: var(--color-surface-alt); font-size: 12px; }
.facts div { display: flex; flex-direction: column; gap: 2px; }
.field { margin-bottom: 10px; }
.field-input { height: 42px; border-radius: 10px; }
.field-input input { font-family: var(--font-mono); font-weight: 600; }
.unit-toggle { flex: 0 0 auto; display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--color-surface); }
.unit-toggle button { height: 26px; padding: 0 10px; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; color: var(--color-text-muted); background: transparent; cursor: pointer; }
.unit-toggle button.active { color: var(--color-text); background: var(--color-surface-alt); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
.unit-toggle button:disabled { cursor: not-allowed; opacity: 0.5; }
.tpq-trigger { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 8px; margin: -2px 0 10px; font-size: 12px; }
.tpq-trigger b { font-weight: 650; }
.tpq-trigger .tpq-type { align-self: center; }
.tpq-trigger .tpq-note { flex-basis: 100%; min-height: 30px; font-size: 11px; line-height: 15px; }
.existing { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.ex-title { margin: 0 0 6px; font-size: 12px; font-weight: 650; color: var(--color-text-secondary); }
.ex-row { display: grid; grid-template-columns: 34px 1fr 60px auto; align-items: center; gap: 8px; font-size: 12px; }
.ex-cancel { height: 26px; padding: 0 8px; font-size: 12px; color: var(--color-down); }
.ex-empty { margin: 0; font-size: 12px; }
.notice { margin: 10px 0 0; }
.replace-note { min-height: 18px; color: var(--color-warning); }
.replace-note.hidden { visibility: hidden; }
</style>
