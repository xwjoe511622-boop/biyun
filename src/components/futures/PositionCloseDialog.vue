<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { toastError, toastSuccess } from '@/core/toast'
import { Decimal, canonicalDecimal, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { loadFuturesFilters, type FuturesContractFilter } from '@/modules/api/exchange-filters'
import type { FuturesContract } from '@/modules/futures/contracts'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { valueWireDp } from '@/modules/futures/math'
import type { FuturesPosition } from '@/modules/futures/types'
import { unitToContracts } from '@/modules/futures/size-unit'
import { useContractQuote } from '@/modules/futures/use-contract-quote'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { signedDisplay } from '@/modules/futures/signed'
import {
  closeOrderPayload,
  closeSideFor,
  contractsToEntry,
  defaultClosePrice,
  marketCloseRoute,
  validateClose,
  type CloseFieldError,
  type CloseKind,
  type CloseSide,
  type CloseValidation,
} from '@/modules/futures/position-close'
import { BBO_OPTIONS, resolveBboPrice, type BboOption } from '@/modules/futures/order-entry'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesOrdersStore } from '@/stores/futures-orders'
import FuturesDialog from './FuturesDialog.vue'
import PercentSlider from '@/components/common/PercentSlider.vue'
import TicketSelect from './TicketSelect.vue'
import type { TicketOption } from './ticket-option'

/**
 * Binance app 平仓 sheet (owner screenshots). One full-width sheet: the confirm button IS the
 * confirmation (no second dialog). Wire paths: a whole-position market close is a MARKET CLOSE order for the whole
 * position (`api.marketClosePosition`), otherwise `order/order_create`), plus a 最优价 (BBO) price shortcut.
 */
const props = defineProps<{ position: FuturesPosition; contract: FuturesContract | undefined; initialKind?: 'market' | 'limit' }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useFuturesI18n()
const account = useFuturesAccountStore()
const orders = useFuturesOrdersStore()
const sizes = useSizeFormat()

/** Order type: 市价 / 限价 / 最优价 (Binance default 市价). */
type PcdType = 'market' | 'limit' | 'bbo'

/** Row button that opened the sheet (positions table 「市价」 / 「限价」); the H5 card 「平仓」 opens it at 市价. */
const kind = ref<PcdType>(props.initialKind ?? 'market')
const bboOption = ref<BboOption>('opp1')
const price = ref('')
const qty = ref('')
const presetContracts = ref<string | ''>('')
const percent = ref(100)
const filter = ref<FuturesContractFilter | undefined>(undefined)
const priceTouched = ref(false)
const qtyFocused = ref(false)

/*
 * Book, mark and last of the POSITION's contract, not the page's (a BTC position closed from the ETH page must use the
 * BTC book, BTC mark band and BTC tick size; 09-30 owner bug, L640).
 */
const quote$ = useContractQuote(() => props.contract)
const mark = computed(() => (Number(quote$.mark.value) > 0 ? quote$.mark.value : props.position.markPrice)) // float-ok: "> 0" presence check, picks which mark string to use
const last = computed(() => quote$.last.value)
const dp = computed(() => props.contract?.pricePrecision ?? 2)
const coinDp = computed(() => (props.contract ? valueWireDp(props.contract) : 2))
const multiplier = computed(() => props.contract?.multiplier ?? '')
const side = computed<CloseSide | ''>(() => (props.position.orderSide === '' ? '' : closeSideFor(props.position.orderSide)))
const unit = computed(() => sizes.unit.value)
const unitLabel = computed(() => sizes.label(props.contract))

const quote = computed(() => props.contract?.quote ?? 'USDT')
const contractName = computed(() => props.contract?.displayName ?? props.contract?.contractName ?? '')

/* ---------------------------------------------------------------- helpers */

function validPrice(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 // float-ok: "> 0" check on a validated decimal string, boolean only
}

function sizeMarket(kind: CloseKind): { multiplier: string; price: string; coinDp: number } {
  return {
    multiplier: multiplier.value,
    price: kind === 'limit' && validPrice(price.value) ? price.value : (mark.value || last.value),
    coinDp: coinDp.value,
  }
}

function entryForContracts(contracts: string): string {
  return contractsToEntry(contracts, unit.value, sizeMarket('limit'))
}

function validateInput(kind: CloseKind, overridePrice?: string): CloseValidation {
  return validateClose({
    kind,
    side: side.value === '' ? 'SELL' : side.value,
    rawPrice: overridePrice ?? price.value,
    rawQty: qty.value,
    unit: unit.value,
    presetContracts: presetContracts.value,
    multiplier: multiplier.value,
    pricePrecision: dp.value,
    coinDp: coinDp.value,
    canClose: props.position.canCloseVolume,
    positionVolume: props.position.positionVolume,
    mark: mark.value,
    last: last.value,
    filter: filter.value,
    maxLimitVolume: props.contract?.maxLimitVolume,
    maxMarketVolume: props.contract?.maxMarketVolume,
  })
}

function errorMessage(error: CloseFieldError): string {
  return t(`fut.pc.err.${error.key}`, { ...(error.params ?? {}), unit: unitLabel.value })
}

/** `floor(canClose * p / 100)` for any integer percentage 0–100; 100 (and above) returns `canClose`. */
function contractsForPercent(canClose: string, p: number): string {
  const value = canonicalDecimal(canClose)
  if (!isDecimalString(value) || !isPositive(value)) return '0'
  if (p >= 100) return canonicalDecimal(value)
  if (p <= 0) return '0'
  return new Decimal(value).times(p).dividedBy(100).toFixed(0, Decimal.ROUND_DOWN)
}

function applyDefaultQty(): void {
  presetContracts.value = props.position.canCloseVolume
  qty.value = entryForContracts(props.position.canCloseVolume)
  percent.value = 100
}

onMounted(() => {
  price.value = defaultClosePrice(last.value, mark.value, dp.value)
  applyDefaultQty()
  void loadFuturesFilters().then((filters) => {
    filter.value = filters[String(props.position.contractId)]
  })
})

watch([last, mark], () => {
  if (price.value === '' && !priceTouched.value) price.value = defaultClosePrice(last.value, mark.value, dp.value)
})

/* ---------------------------------------------------------------- qty box (percent / plain) */

/** Amount of the slider preset, formatted in the current unit (`200.00` / `0.0040`). */
const amountInUnit = computed(() => {
  if (presetContracts.value === '') return ''
  return sizes.size(presetContracts.value, props.contract, sizeMarket('limit').price)
})

const qtyDisplay = computed(() => {
  if (qtyFocused.value) return qty.value
  if (presetContracts.value !== '') return `${percent.value}% (≈${amountInUnit.value})`
  return qty.value
})

function onQtyFocus(): void {
  qtyFocused.value = true
}

function onQtyBlur(): void {
  qtyFocused.value = false
}

function onQtyInput(event: Event): void {
  const el = event.target as HTMLInputElement
  qty.value = el.value
  presetContracts.value = ''
  const contracts = unitToContracts(qty.value, unit.value, sizeMarket('limit'))
  const can = Number(props.position.canCloseVolume) // float-ok: slider percent (UI), quantity sent stays the decimal string
  if (contracts !== '' && Number.isFinite(can) && can > 0) {
    percent.value = Math.max(0, Math.min(100, Math.floor((Number(contracts) / can) * 100))) // float-ok: slider percent (UI), quantity sent stays the decimal string
  }
}

function onPriceInput(): void {
  priceTouched.value = true
}

function pickPercent(p: number): void {
  percent.value = Math.max(0, Math.min(100, Math.round(p)))
  presetContracts.value = contractsForPercent(props.position.canCloseVolume, percent.value)
  qty.value = entryForContracts(presetContracts.value)
}

function toggleUnit(): void {
  sizes.unit.value = sizes.unit.value === 'quote' ? 'base' : 'quote'
}

/* ---------------------------------------------------------------- estimates */

/** Contracts currently selected (slider preset, else the typed amount converted). */
const estContracts = computed(() => {
  if (presetContracts.value !== '') return presetContracts.value
  return unitToContracts(qty.value, unit.value, sizeMarket('limit'))
})

/** Close price for the 预计盈亏 estimate: limit / resolved BBO / mark for market. */
const closePrice = computed(() => {
  if (kind.value === 'limit') return validPrice(price.value) ? price.value : ''
  if (kind.value === 'bbo') {
    if (side.value === '') return ''
    const resolution = resolveBboPrice(bboOption.value, side.value, quote$.bookTop.value)
    return resolution.ok ? resolution.price : ''
  }
  return mark.value
})

const estPnl = computed<{ text: string; direction: 'up' | 'down' | 'flat' }>(() => {
  const cp = closePrice.value
  const entry = props.position.openAvgPrice
  const mult = multiplier.value
  const contracts = estContracts.value
  if (
    cp === '' || !isDecimalString(cp)
    || !isDecimalString(entry) || !isDecimalString(mult) || !isDecimalString(contracts) || !isPositive(contracts)
    || props.position.orderSide === ''
  ) {
    return { text: '--', direction: 'flat' }
  }
  const coinQty = new Decimal(contracts).times(mult)
  const direction = props.position.orderSide === 'BUY' ? 1 : -1
  const pnl = new Decimal(cp).minus(entry).times(coinQty).times(direction)
  const sign = pnl.s
  return { text: signedDisplay(pnl.toFixed(), 2), direction: sign > 0 ? 'up' : sign < 0 ? 'down' : 'flat' }
})

const positionSizeInUnit = computed(() => sizes.size(props.position.positionVolume, props.contract, mark.value))

function formatPrice(value: string): string {
  if (!isDecimalString(value)) return '--'
  return groupDigits(value, dp.value)
}

/* ---------------------------------------------------------------- options */

const typeOptions = computed<TicketOption<PcdType>[]>(() => [
  { value: 'market', label: t('fut.pcd.typeMarket') },
  { value: 'limit', label: t('fut.pcd.typeLimit') },
  { value: 'bbo', label: t('fut.pcd.typeBbo') },
])

const bboOptions = computed<TicketOption<BboOption>[]>(() =>
  BBO_OPTIONS.map((entry) => ({ value: entry, label: t(`fut.bboOption.${entry}`) })),
)

/* ---------------------------------------------------------------- submit */

/*
 * Disabled only when nothing can be closed or another action runs. Not on `percent === 0`: a typed quantity under 1 %
 * of the position floors the slider to 0 % while the quantity itself is valid (10-01 audit: confirm greyed out, no
 * reason). An empty / zero quantity stays clickable and the click says 「请输入平仓数量」.
 */
const disabled = computed(() => account.busy !== null || Number(props.position.canCloseVolume) <= 0) // float-ok: "<= 0" check disables the button, boolean only

async function runClose(kind: CloseKind, check: CloseValidation): Promise<void> {
  let result: string | null
  if (kind === 'market' && marketCloseRoute({ full: check.full }) === 'closeWhole') {
    result = await account.closeAtMarket(props.position)
  } else {
    const wire = kind === 'market' ? account.marketCloseWireFor(props.position) : undefined
    result = await orders.placeOrder(closeOrderPayload({ position: props.position, kind, price: check.price, contracts: check.contracts, wire }))
  }
  // '' = nothing was sent (another action is running): say so, never close silently or do nothing.
  if (result !== null) {
    toastError(result || t('fut.pm.busy'), 'fut-pcd')
    return
  }
  toastSuccess(kind === 'limit' ? t('fut.pc.limitPlaced') : t('fut.pc.marketPlaced'), 'fut-pcd')
  emit('close')
}

async function submit(): Promise<void> {
  if (side.value === '') return
  const closeSide = side.value
  const runKind: CloseKind = kind.value === 'market' ? 'market' : 'limit'
  let check: CloseValidation
  if (kind.value === 'bbo') {
    const resolution = resolveBboPrice(bboOption.value, closeSide, await quote$.readBookTop())
    if (!resolution.ok) {
      toastError(t('fut.pcd.noDepth'), 'fut-pcd')
      return
    }
    check = validateInput('limit', resolution.price)
  } else {
    check = validateInput(runKind)
  }
  if (!check.ok) {
    const first = check.errors[0]
    toastError(first !== undefined ? errorMessage(first) : t('fut.pc.err.qtyRequired', { unit: unitLabel.value }), 'fut-pcd')
    return
  }
  void runClose(runKind, check)
}
</script>

<template>
  <FuturesDialog :title="t('fut.pcd.title')" :width="420" :busy="account.busy !== null" @close="emit('close')">
    <div class="pcd">
      <div class="pcd-info">
        <div class="pcd-row">
          <span class="pcd-label">{{ t('fut.contract') }}</span>
          <span class="pcd-value pcd-contract">
            <span class="pcd-name">{{ contractName }}</span>
            <span class="pcd-chip perp">{{ t('fut.perpetual') }}</span>
            <span class="pcd-chip" :class="position.orderSide === 'BUY' ? 'long' : 'short'">
              {{ position.orderSide === 'BUY' ? t('fut.pcd.long') : t('fut.pcd.short') }} {{ position.leverageLevel != null ? `${position.leverageLevel}x` : '' }}
            </span>
          </span>
        </div>
        <div class="pcd-row">
          <span class="pcd-label">{{ t('fut.pcd.entryPrice') }} ({{ quote }})</span>
          <span class="pcd-value num">{{ formatPrice(position.openAvgPrice) }}</span>
        </div>
        <div class="pcd-row">
          <span class="pcd-label">{{ t('fut.markPrice') }} ({{ quote }})</span>
          <span class="pcd-value num">{{ formatPrice(mark) }}</span>
        </div>
      </div>

      <div class="pcd-divider"></div>

      <div class="pcd-field-label">{{ t('fut.pcd.price') }}</div>
      <div class="pcd-price-row">
        <div class="pcd-price-box">
          <input
            v-if="kind === 'market'"
            class="pcd-input num"
            type="text"
            :placeholder="t('fut.pcd.marketPrice')"
            disabled
          />
          <input
            v-else-if="kind === 'limit'"
            v-model="price"
            class="pcd-input num"
            inputmode="decimal"
            :aria-label="t('fut.pcd.price')"
            :placeholder="t('fut.pcd.price')"
            data-testid="fut-pcd-price"
            @input="onPriceInput"
          />
          <TicketSelect
            v-else
            v-model="bboOption"
            class="pcd-bbo"
            testid="fut-pcd-bbo"
            :label="t('fut.bbo')"
            :options="bboOptions"
          />
        </div>
        <TicketSelect v-model="kind" testid="fut-pcd-type" :label="t('fut.pcd.typeTitle')" :options="typeOptions" />
      </div>

      <div class="pcd-field-label">{{ t('fut.pcd.qty') }}</div>
      <div class="pcd-qty-box">
        <input
          :value="qtyDisplay"
          class="pcd-input num qty"
          inputmode="decimal"
          :aria-label="t('fut.pcd.qty')"
          data-testid="fut-pcd-qty"
          @focus="onQtyFocus"
          @blur="onQtyBlur"
          @input="onQtyInput"
        />
        <button type="button" class="pcd-unit" data-testid="fut-pcd-unit" @click="toggleUnit">{{ unitLabel }}</button>
      </div>

      <PercentSlider :model-value="percent" :marks="[0, 25, 50, 75, 100]" tone="accent" :label="t('fut.pcd.qty')" @update:model-value="pickPercent" />

      <div class="pcd-row">
        <span class="pcd-label">{{ t('fut.pcd.positionSize') }}</span>
        <span class="pcd-value num">{{ positionSizeInUnit }} {{ unitLabel }}</span>
      </div>
      <div class="pcd-row">
        <span class="pcd-label">{{ t('fut.pcd.estPnl') }}</span>
        <span class="pcd-value num pcd-pnl" :class="estPnl.direction">{{ estPnl.text }}</span>
      </div>

      <button class="pcd-confirm" type="button" data-testid="fut-pcd-confirm" :disabled="disabled" @click="submit">{{ t('fut.confirm2') }}</button>
    </div>
  </FuturesDialog>
</template>

<style scoped>
.pcd {
  display: grid;
  gap: 10px;
}

.pcd-info {
  display: grid;
  gap: 8px;
}

.pcd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
}

.pcd-label {
  color: var(--color-text-muted);
  white-space: nowrap;
}

.pcd-value {
  color: var(--color-text);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pcd-contract {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pcd-name {
  color: var(--color-text);
}

.pcd-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.pcd-chip.perp {
  background: var(--color-surface-alt);
  color: var(--color-text-muted);
}

.pcd-chip.long {
  background: var(--color-up-soft);
  color: var(--color-up);
}

.pcd-chip.short {
  background: var(--color-down-soft);
  color: var(--color-down);
}

.pcd-divider {
  height: 1px;
  background: var(--color-border);
}

.pcd-field-label {
  font-size: 14px;
  color: var(--color-text-muted);
}

.pcd-price-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pcd-price-box {
  flex: 1;
  min-width: 0;
}

.pcd-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  border: 1px solid var(--color-border-strong);
  border-radius: 8px;
  background: var(--color-surface);
  color: var(--color-text);
}

.pcd-input:disabled {
  opacity: 0.55;
}

.pcd-qty-box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 4px 0 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: 8px;
  background: var(--color-surface);
}

.pcd-qty-box .pcd-input {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  border: none;
  background: none;
}

.pcd-unit {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border-strong);
  border-radius: 6px;
  background: var(--color-surface-alt);
  cursor: pointer;
}

.pcd-pnl.up {
  color: var(--color-up);
}

.pcd-pnl.down {
  color: var(--color-down);
}

.pcd-confirm {
  width: 100%;
  height: 44px;
  margin-top: 4px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
}

.pcd-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* FuturesDialog is a centered modal; on phone widths pin it to the bottom as a full-width sheet. */
@media (max-width: 640px) {
  :deep(.fd-backdrop) {
    align-items: flex-end;
    padding: 0;
  }
  :deep(.fd-panel) {
    width: 100%;
    max-width: none;
    max-height: 85vh;
    border-radius: 16px 16px 0 0;
    border-width: 1px 0 0;
  }
}
</style>
