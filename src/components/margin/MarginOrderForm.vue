<script setup lang="ts">
import { SKIN } from '@/core/skin'
import PercentSlider from '@/components/common/PercentSlider.vue'
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { LocateFixed } from '@lucide/vue'
import { toastError, toastInfo, toastSuccess } from '@/core/toast'
import { i18n } from '@/i18n'
import TicketSelect from '@/components/futures/TicketSelect.vue'
import { applySpotFilter, loadSpotFilters, type SpotSymbolFilter } from '@/modules/api/exchange-filters'
import { canonicalDecimal, cmp, div, isPositive, mul, toFixedString } from '@/modules/finance/decimal'
import { validateOrderDraft, type DraftValidation, type FieldError, type OrderSide, type OrderType } from '@/modules/finance/precision'
import { useMarginI18n } from '@/modules/margin/i18n'
import {
  checkSpotFilters, effectiveStep, floorToStep, percentToAmount, readSpotUnit, saveSpotUnit, toSpotWire, wireToPercent,
  type SpotEntryMarket, type SpotUnit, type SpotWire,
} from '@/modules/trade/spot-size-unit'
import { checkSpotPrice } from '@/modules/trade/order-rules'
import { useMarginStore } from '@/stores/margin'
import { useMarginOrdersStore } from '@/stores/marginOrders'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { coinMeta } from '@/modules/wallet/coins'
import { formatCoinAmount } from '@/modules/wallet/valuation'

/**
 * Margin order ticket. Same rules as spot (public-info precision / minimums via `validateOrderDraft`),
 * but spendable balances are the pair's margin-account normal balances and the order goes to
 * POST lever/order/create.
 */
const props = defineProps<{ side: OrderSide; orderType: OrderType; priceSuggestion?: { price: string; sequence: number } }>()

const { t } = useMarginI18n()
const market = useMarketStore()
const margin = useMarginStore()
const orders = useMarginOrdersStore()
const sessionStore = useSessionStore()

const price = ref('')
const volume = ref('')
const touched = reactive({ price: false, volume: false })
const submitting = ref(false)
const activePercent = ref(0)
let interaction = 0

const symbol = computed(() => market.currentSymbol)
// lever/order/create is checked by the same spot guard (step, minimum notional, price band): use the exchange filters
// like the spot ticket, otherwise 100 % filled 0.00018559 BTC and price 1 passed until the server refused (QA-055).
const spotFilters = shallowRef<Record<string, SpotSymbolFilter>>({})
void loadSpotFilters().then((filters) => { spotFilters.value = filters })
const spotFilter = computed(() => spotFilters.value[symbol.value?.symbol ?? ''])
const rules = computed(() => {
  const configured = symbol.value?.rules ?? null
  return configured === null ? null : applySpotFilter(configured, spotFilter.value)
})
const quotePrecision = computed(() => symbol.value?.pricePrecision ?? 2)
const isBuy = computed(() => props.side === 'BUY')
const isMarket = computed(() => props.orderType === '2')
const baseAvailable = computed(() => margin.account?.baseNormalBalance ?? '')
const quoteAvailable = computed(() => margin.account?.quoteNormalBalance ?? '')
const relevant = computed(() => (isBuy.value ? quoteAvailable.value : baseAvailable.value))
const relevantCoin = computed(() => (isBuy.value ? symbol.value?.quote ?? '' : symbol.value?.base ?? ''))
const relevantDisplay = computed(() => formatCoinAmount(relevant.value, coinMeta(market.publicInfo, relevantCoin.value).showPrecision))
const balanceReady = computed(() => sessionStore.isAuthenticated && margin.account !== null && relevant.value !== '')

// 货币单位 (2026-09-30, same as the spot ticket, `modules/trade/spot-size-unit.ts`): the amount is typed in the base
// coin or in the quote coin and converted to the wire volume (rounded DOWN to the quantity step). The choice is shared
// with the spot ticket (per order type and side, per browser).
const unit = ref<SpotUnit>(readSpotUnit(props.orderType, props.side))
/** Exact base quantity of a percent fill on a SELL ticket shown in the quote coin (so 100 % sells the whole balance). */
const pinnedSellQty = ref('')
const baseCoin = computed(() => symbol.value?.base ?? '')
const quoteCoin = computed(() => symbol.value?.quote ?? '')
const unitCoin = computed(() => (unit.value === 'quote' ? quoteCoin.value : baseCoin.value))
const unitOptions = computed(() => [
  { value: 'base' as const, label: baseCoin.value, desc: t('trade.unit.baseDesc', { base: baseCoin.value }) },
  {
    value: 'quote' as const,
    label: quoteCoin.value,
    desc: t(isMarket.value ? (isBuy.value ? 'trade.unit.quoteMarketBuyDesc' : 'trade.unit.quoteMarketSellDesc') : 'trade.unit.quoteLimitDesc', { quote: quoteCoin.value, base: baseCoin.value }),
  },
])
/** Market conversions use the best ask (buy) / best bid (sell), else the last price. */
const marketRef = computed(() => {
  let best = ''
  for (const level of isBuy.value ? market.asks : market.buys) {
    const levelPrice = canonicalDecimal(level.price)
    if (!isPositive(levelPrice)) continue
    if (best === '' || (isBuy.value ? cmp(levelPrice, best) < 0 : cmp(levelPrice, best) > 0)) best = levelPrice
  }
  return best !== '' ? best : canonicalDecimal(market.ticker.close)
})
const limitPrice = computed(() => {
  const typed = canonicalDecimal(price.value)
  return isPositive(typed) ? typed : ''
})
const entryMarket = computed<SpotEntryMarket>(() => ({
  step: effectiveStep(spotFilter.value?.stepSize, rules.value?.volumePrecision ?? 8),
  quotePrecision: quotePrecision.value,
  refPrice: isMarket.value ? marketRef.value : limitPrice.value,
}))
/** Percent fills on a limit ticket fall back to the last price until a price is typed. */
const sizingMarket = computed<SpotEntryMarket>(() => (isMarket.value || limitPrice.value !== ''
  ? entryMarket.value
  : { ...entryMarket.value, refPrice: canonicalDecimal(market.ticker.close) }))
const wire = computed<SpotWire>(() => {
  const converted = toSpotWire(props.orderType, props.side, unit.value, volume.value, entryMarket.value)
  const pinned = pinnedSellQty.value
  if (pinned === '' || props.side !== 'SELL' || unit.value !== 'quote' || converted.needsPrice) return converted
  const reference = entryMarket.value.refPrice
  return { ...converted, volume: pinned, baseQty: pinned, quoteTotal: isPositive(reference) ? mul(pinned, reference) : converted.quoteTotal }
})
/** The wire volume, or the raw text when it cannot be converted yet (so the validator still reports the problem). */
const wireVolume = computed(() => (unit.value === defaultUnit.value ? volume.value : wire.value.volume))
/** The unit the wire itself is in: quote for a market buy, base otherwise. */
const defaultUnit = computed<SpotUnit>(() => (isMarket.value && isBuy.value ? 'quote' : 'base'))

const validation = computed<DraftValidation>(() => {
  if (rules.value === null) return { ok: false, errors: [], price: '', volume: '', total: '' }
  return validateOrderDraft(
    { side: props.side, type: props.orderType, price: price.value, volume: wireVolume.value },
    { rules: rules.value, baseAvailable: baseAvailable.value, quoteAvailable: quoteAvailable.value, quotePrecision: quotePrecision.value },
  )
})

function firstError(field: FieldError['field']): string {
  const error = validation.value.errors.find(entry => entry.field === field)
  if (error === undefined) return ''
  return t(error.key, { ...(error.params ?? {}), quote: symbol.value?.quote ?? '', base: symbol.value?.base ?? '' })
}

const filterErrors = computed(() => checkSpotFilters(props.orderType, props.side, unit.value, volume.value, price.value, wire.value, spotFilter.value))
const priceRule = computed(() => (isMarket.value ? null : checkSpotPrice(props.side, price.value, canonicalDecimal(market.ticker.close), spotFilter.value)))
function filterText(key: string, params: Record<string, string> = {}): string {
  return t(`trade.unit.error.${key}`, { step: entryMarket.value.step, base: baseCoin.value, quote: quoteCoin.value, unit: unitCoin.value, ...params })
}
const priceError = computed(() => {
  const tick = filterErrors.value.find(entry => entry.key === 'tick')
  const rule = priceRule.value
  const ruleText = rule === null ? '' : t(`trade.rule.${rule.key}`, { ...rule.params, quote: quoteCoin.value, side: t(isBuy.value ? 'trade.rule.buySide' : 'trade.rule.sellSide') })
  return firstError('price') || (tick === undefined ? ruleText : filterText(tick.key, tick.params))
})
const volumeError = computed(() => {
  const filter = filterErrors.value.find(entry => entry.key !== 'tick')
  if (filter !== undefined) return filterText(filter.key === 'needsPrice' && isMarket.value ? 'needsBook' : filter.key, filter.params)
  return firstError('volume')
})
const totalError = computed(() => firstError('total'))
const totalDisplay = computed(() => (validation.value.total === '' ? '--' : toFixedString(validation.value.total, Math.min(quotePrecision.value, 8))))
const volumeUnit = computed(() => unitCoin.value)
/** The other unit of the typed amount (≈ for market-order estimates). */
const convertedText = computed(() => {
  const current = wire.value
  const value = unit.value === 'quote' ? current.baseQty : current.quoteTotal
  if (value === '') return ''
  const shown = unit.value === 'quote' ? canonicalDecimal(value) : toFixedString(value, Math.min(quotePrecision.value, 8))
  return `${current.estimated ? '≈ ' : ''}${shown} ${unit.value === 'quote' ? baseCoin.value : quoteCoin.value}`
})
const heading = computed(() => t(isBuy.value ? 'margin.form.buy' : 'margin.form.sell', { base: symbol.value?.base ?? '' }))
const canSubmit = computed(() => validation.value.ok && volumeError.value === '' && priceError.value === '' && balanceReady.value && !submitting.value && !orders.submitting)
const pricePlaceholder = computed(() => {
  const close = canonicalDecimal(market.ticker.close)
  return close === '' ? t('common.price') : toFixedString(close, quotePrecision.value)
})

/** A newer interaction makes an in-flight submit's answer irrelevant for this ticket (results are toasts). */
function resetMessages(): void {
  interaction += 1
}

function resetDraft(): void {
  resetMessages()
  price.value = ''
  volume.value = ''
  pinnedSellQty.value = ''
  activePercent.value = 0
  touched.price = false
  touched.volume = false
}

watch(() => props.priceSuggestion, (selection) => {
  if (selection === undefined || isMarket.value || submitting.value || !isPositive(selection.price)) return
  price.value = canonicalDecimal(selection.price)
  touched.price = true
  resetMessages()
})
watch(() => market.selectedPair, resetDraft)
watch(() => props.orderType, () => {
  resetMessages()
  unit.value = readSpotUnit(props.orderType, props.side)
  pinnedSellQty.value = ''
  volume.value = ''
  activePercent.value = 0
  touched.volume = false
})
watch(() => sessionStore.token, resetMessages)
onBeforeUnmount(resetMessages)

function useMarketPrice(): void {
  const close = canonicalDecimal(market.ticker.close)
  if (close !== '') {
    price.value = toFixedString(close, quotePrecision.value)
    touched.price = true
  }
}

function setPercent(percent: number): void {
  if (rules.value === null || !balanceReady.value) return
  pinnedSellQty.value = ''
  if (percent <= 0) {
    volume.value = ''
    activePercent.value = 0
    return
  }
  // Buy: share of the quote balance; sell: share of the base balance — shown in the selected unit, rounded down.
  const amount = percentToAmount(percent, props.side, unit.value, relevant.value, sizingMarket.value)
  if (amount === '') {
    // 0 available: say so (borrow / transfer first) instead of a slider that does not move (10-01 monkey test).
    if (!isPositive(canonicalDecimal(relevant.value))) toastInfo(i18n.global.t('trade.zeroBalance', { coin: isBuy.value ? quoteCoin.value : baseCoin.value }), 'margin-zero-balance')
    return
  }
  volume.value = amount
  if (!isBuy.value && unit.value === 'quote') {
    pinnedSellQty.value = floorToStep(div(mul(relevant.value, String(percent)), '100', 16), entryMarket.value.step)
  }
  touched.volume = true
  activePercent.value = percent
}

/** Typed amount → share of the available balance, so the slider mirrors manual input (display only). */
function syncPercentFromVolume(): void {
  pinnedSellQty.value = ''
  activePercent.value = balanceReady.value ? wireToPercent(props.side, toSpotWire(props.orderType, props.side, unit.value, volume.value, sizingMarket.value), relevant.value) : 0
  resetMessages()
}

function chooseUnit(next: SpotUnit): void {
  if (next === unit.value) return
  unit.value = next
  saveSpotUnit(props.orderType, props.side, next)
  pinnedSellQty.value = ''
  volume.value = ''
  activePercent.value = 0
  touched.volume = false
}

async function submit(): Promise<void> {
  touched.price = true
  touched.volume = true
  if (!canSubmit.value) return
  const version = interaction
  const pair = market.selectedPair
  const payload = { side: props.side, type: props.orderType, price: props.orderType === '1' ? validation.value.price : '', volume: validation.value.volume }
  submitting.value = true
  try {
    const error = await orders.submit(payload)
    if (version !== interaction || pair !== market.selectedPair) {
      // Pair switched while in flight: still report the outcome (global toast) — 10-01 audit.
      if (error === null) toastSuccess(t('margin.form.success'), 'margin-submit')
      else toastError(error.startsWith('error.') || error.startsWith('common.') ? t(error) : error, 'margin-submit')
      return
    }
    if (error !== null) {
      toastError(error.startsWith('error.') || error.startsWith('common.') ? t(error) : error, 'margin-submit')
      return
    }
    volume.value = ''
    pinnedSellQty.value = ''
    activePercent.value = 0
    touched.volume = false
    toastSuccess(t('margin.form.success'), 'margin-submit')
    // Pending row, balance change and the one follow-up refresh: the margin orders store.
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="order-form" :class="isBuy ? 'order-form-buy' : 'order-form-sell'" :aria-label="heading">
    <div v-if="!isMarket" class="compact-field float-anchor">
      <label class="field-input" :class="{ invalid: touched.price && priceError !== '' }">
        <span class="inline-label">{{ t('common.price') }}</span>
        <input v-model="price" :disabled="submitting" :aria-label="t('trade.priceUnit', { quote: symbol?.quote ?? '' })" type="text" inputmode="decimal" :placeholder="pricePlaceholder" @blur="touched.price = true" @input="resetMessages" />
        <span class="field-suffix">{{ symbol?.quote ?? '' }}</span>
        <button class="latest-price" type="button" :disabled="submitting" :title="t('trade.lastPrice')" :aria-label="t('trade.lastPrice')" @click.prevent="useMarketPrice"><LocateFixed :size="13" /></button>
      </label>
      <p v-if="touched.price && priceError !== ''" class="field-error float" :title="priceError">{{ priceError }}</p>
    </div>
    <div v-else class="market-price-line"><span>{{ t('common.price') }}</span><span>{{ t('trade.marketPrice') }}</span></div>

    <div class="compact-field float-anchor">
      <label class="field-input" :class="{ invalid: touched.volume && volumeError !== '' }">
        <span class="inline-label">{{ unit === 'quote' ? t('common.total') : t('common.amount') }}</span>
        <input v-model="volume" :disabled="submitting" :aria-label="unit === 'quote' ? t('trade.amountUnitQuote', { quote: volumeUnit }) : t('trade.amountUnitBase', { base: volumeUnit })" type="text" inputmode="decimal" @input="syncPercentFromVolume" @blur="touched.volume = true" />
        <span class="field-suffix unit-suffix" @click.prevent><TicketSelect :model-value="unit" :options="unitOptions" :label="t('trade.unit.title')" :testid="isBuy ? 'margin-unit-buy' : 'margin-unit-sell'" :disabled="submitting || symbol === undefined" @update:model-value="chooseUnit" /></span>
      </label>
      <p v-if="touched.volume && volumeError !== ''" class="field-error float" :title="volumeError">{{ volumeError }}</p>
    </div>

    <PercentSlider :model-value="activePercent" :tone="isBuy ? 'up' : 'down'" :disabled="!balanceReady || submitting" @update:model-value="setPercent" />
    <div class="ticket-meta float-anchor">
      <div class="meta-row"><span class="muted">{{ t('margin.form.available', { coin: relevantCoin }) }}</span><span class="num" :title="relevant">{{ relevantDisplay }}</span></div>
      <div class="meta-row"><span class="muted">{{ unit === 'quote' ? t('trade.unit.qtyWithUnit', { base: baseCoin }) : t('trade.totalWithUnit', { quote: symbol?.quote ?? '' }) }}</span><span class="num" :class="{ down: totalError !== '' }" data-testid="margin-converted">{{ unit === 'quote' ? (convertedText || '--') : totalDisplay }}</span></div>
      <p v-if="totalError !== ''" class="field-error float" :title="totalError">{{ totalError }}</p>
    </div>
    <button v-if="sessionStore.isAuthenticated" class="btn btn-block submit-button" :class="isBuy ? 'btn-buy' : 'btn-sell'" type="button" :disabled="!canSubmit" @click="submit">
      {{ submitting ? t('trade.submitting') : heading }}
    </button>
    <RouterLink v-else class="btn btn-block submit-button" :class="isBuy ? 'btn-buy' : 'btn-sell'" to="/login">{{ SKIN === 'okx' ? `${t('nav.login')}/${t('nav.register')}` : t(isBuy ? 'common.buy' : 'common.sell') }}</RouterLink>
  </section>
</template>

<style scoped>
.order-form { display: flex; flex-direction: column; min-width: 0; gap: 10px; padding: 14px 16px 16px; }
.compact-field { min-width: 0; }
.field-input { display: flex; align-items: center; gap: 8px; height: 42px; border-radius: 10px; padding: 0 12px; background: var(--color-surface-alt); border-color: transparent; }
.field-input:hover { border-color: var(--color-border-strong); }
.field-input input { width: 0; min-width: 0; flex: 1; height: 40px; padding: 0; font-family: var(--font-mono); font-size: 14px; font-weight: 600; text-align: right; }
.field-input input::placeholder { font-family: var(--font-sans); font-size: 12px; font-weight: 400; color: var(--color-text-muted); }
.inline-label { flex: 0 0 auto; color: var(--color-text-muted); font-size: 12px; font-weight: 550; }
.field-suffix { padding: 0; font-size: 12px; color: var(--color-text-secondary); }
.unit-suffix :deep(.ts-trigger) { height: 28px; font-size: 12px; color: var(--color-text-secondary); }
.unit-suffix :deep(.ts-trigger:hover:not(:disabled)) { color: var(--color-text); }
.latest-price { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; color: var(--color-text-muted); flex: 0 0 auto; }
.latest-price:hover { color: var(--color-accent-text); background: var(--color-accent-soft); }
.market-price-line { display: flex; justify-content: space-between; align-items: center; height: 42px; padding: 0 12px; color: var(--color-text-muted); background: var(--color-surface-alt); border-radius: 10px; font-size: 12px; opacity: 0.8; }
.ticket-meta { display: grid; gap: 4px; margin: 2px 0; }
.meta-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; }
.num { overflow-wrap: anywhere; text-align: right; min-width: 0; }
.submit-button { height: 42px; padding: 0 12px; border-radius: 10px; font-size: 14px; margin-top: auto; }
.order-form-buy .submit-button:not(:disabled) { box-shadow: 0 10px 24px -14px var(--color-up); }
.order-form-sell .submit-button:not(:disabled) { box-shadow: 0 10px 24px -14px var(--color-down); }
.field-error { margin: 4px 0 0; font-size: 11px; line-height: 16px; }
.notice { margin: 0; padding: 7px 10px; font-size: 12px; }
</style>
