<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LocateFixed } from '@lucide/vue'
import PercentSlider from '@/components/common/PercentSlider.vue'
import TicketSelect from '@/components/futures/TicketSelect.vue'
import { SKIN } from '@/core/skin'
import { toastError, toastInfo, toastSuccess } from '@/core/toast'
import { applySpotFilter, loadSpotFilters, type SpotSymbolFilter } from '@/modules/api/exchange-filters'
import { canonicalDecimal, cmp, decimalPlaces, div, groupDigits, isDecimalString, isPositive, mul, toFixedString } from '@/modules/finance/decimal'
import { validateOrderDraft, type DraftValidation, type FieldError, type OrderSide, type OrderType } from '@/modules/finance/precision'
import {
  checkSpotFilters, effectiveStep, floorToStep, maxInUnit, percentToAmount, readSpotUnit, saveSpotUnit, toSpotWire, wireToPercent,
  type SpotEntryMarket, type SpotUnit, type SpotWire,
} from '@/modules/trade/spot-size-unit'
import { spotFillAmount, type PriceSuggestion } from '@/modules/trade/book-fill'
import { checkSpotPrice, spotMinOrder, spotPriceRange } from '@/modules/trade/order-rules'
import type { SpotOrderPayload, SpotTimeInForce } from '@/modules/spot/spot-order'
import { formatCoinAmount } from '@/modules/wallet/valuation'
import { coinMeta } from '@/modules/wallet/coins'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore } from '@/stores/orders'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{
  side: OrderSide
  orderType: OrderType
  /** Limit orders: GTC / IOC / FOK (`SpotOrderPanel`); absent = GTC. */
  timeInForce?: SpotTimeInForce
  priceSuggestion?: PriceSuggestion
}>()

const { t, locale } = useI18n()
const colon = computed(() => locale.value.startsWith('zh') ? '：' : ': ')
const semicolon = computed(() => locale.value.startsWith('zh') ? '；' : '; ')
const comma = computed(() => locale.value.startsWith('zh') ? '，' : ', ')
const market = useMarketStore()
const account = useAccountStore()
const orders = useOrdersStore()
const sessionStore = useSessionStore()

const side = computed(() => props.side)
const type = computed(() => props.orderType)
const price = ref('')
const volume = ref('')
const touched = reactive({ price: false, volume: false })
const submitting = ref(false)
/** Percentage chosen from the quick-fill slider; cleared when the amount is typed by hand. */
const activePercent = ref(0)
let interactionVersion = 0

const symbol = computed(() => market.currentSymbol)
// Binance-style spot filters (2026-09-29): quantity step / minimum from GET /common/exchange_filters tighten the ticket
// rules (e.g. BTC quantity 0.00001 steps), so percentage fills and the pre-check match what the server accepts.
const spotFilters = shallowRef<Record<string, SpotSymbolFilter>>({})
void loadSpotFilters().then((filters) => { spotFilters.value = filters })
const rules = computed(() => {
  const configured = symbol.value?.rules ?? null
  return configured === null ? null : applySpotFilter(configured, spotFilters.value[symbol.value?.symbol ?? ''])
})
const quotePrecision = computed(() => symbol.value?.pricePrecision ?? 2)
const base = computed(() => symbol.value?.base ?? '')
const isBuy = computed(() => side.value === 'BUY')
const isMarket = computed(() => type.value === '2')
const sideLabel = computed(() => t(isBuy.value ? 'common.buy' : 'common.sell'))
const heading = computed(() => t(isBuy.value ? 'trade.buyButton' : 'trade.sellButton', { base: base.value }).trim())
const sectionLabel = computed(() => `${sideLabel.value} ${base.value}`.trim())
const relevantBalance = computed(() => (isBuy.value ? account.quoteAvailable : account.baseSellable))
const balanceLabel = computed(() => isBuy.value
  ? t('trade.availableQuote', { quote: symbol.value?.quote ?? '' })
  : t('trade.availableBase', { base: base.value }))
const balanceDisplay = computed(() => formatCoinAmount(relevantBalance.value, coinMeta(market.publicInfo, isBuy.value ? symbol.value?.quote ?? '' : base.value).showPrecision))

// 货币单位 (Binance style, 2026-09-29): the amount is typed in the base coin (数量) or in the quote coin (成交额) and
// converted to the wire volume by `modules/trade/spot-size-unit.ts` (market buy by USDT is native quote-amount sizing;
// every other conversion rounds DOWN to the filter step). Remembered per order type and side.
const unit = ref<SpotUnit>(readSpotUnit(props.orderType, props.side))
/** Exact base quantity of a percent fill on a SELL ticket shown in USDT (so 100 % sells the whole balance). */
const pinnedSellQty = ref('')
const quoteCoin = computed(() => symbol.value?.quote ?? '')
const unitCoin = computed(() => (unit.value === 'quote' ? quoteCoin.value : base.value))
const spotFilter = computed(() => spotFilters.value[symbol.value?.symbol ?? ''])
const unitOptions = computed(() => [
  { value: 'base' as const, label: base.value, desc: t('trade.unit.baseDesc', { base: base.value }) },
  {
    value: 'quote' as const,
    label: quoteCoin.value,
    desc: t(isMarket.value ? (isBuy.value ? 'trade.unit.quoteMarketBuyDesc' : 'trade.unit.quoteMarketSellDesc') : 'trade.unit.quoteLimitDesc', { quote: quoteCoin.value, base: base.value }),
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
/** Percent fills and 可买/可卖 on a limit ticket fall back to the last price until a price is typed. */
const sizingMarket = computed<SpotEntryMarket>(() => (isMarket.value || limitPrice.value !== ''
  ? entryMarket.value
  : { ...entryMarket.value, refPrice: canonicalDecimal(market.ticker.close) }))
const wire = computed<SpotWire>(() => {
  const converted = toSpotWire(type.value, side.value, unit.value, volume.value, entryMarket.value)
  const pinned = pinnedSellQty.value
  if (pinned === '' || side.value !== 'SELL' || unit.value !== 'quote' || converted.needsPrice) return converted
  const reference = entryMarket.value.refPrice
  return { ...converted, volume: pinned, baseQty: pinned, quoteTotal: isPositive(reference) ? mul(pinned, reference) : converted.quoteTotal }
})
const filterErrors = computed(() => checkSpotFilters(type.value, side.value, unit.value, volume.value, price.value, wire.value, spotFilter.value))
const maxLabel = computed(() => t(isBuy.value ? 'trade.unit.maxBuy' : 'trade.unit.maxSell'))
const maxDisplay = computed(() => {
  const value = maxInUnit(side.value, unit.value, relevantBalance.value, sizingMarket.value)
  return value === '' ? '--' : `${value} ${unitCoin.value}`
})

const validation = computed<DraftValidation>(() => {
  const currentRules = rules.value
  if (currentRules === null) {
    return { ok: false, errors: [], price: '', volume: '', total: '' }
  }
  const typed = canonicalDecimal(volume.value)
  // The converted wire volume is validated (precision, minimums, balance); a malformed / zero entry is passed as typed.
  const wireVolume = isDecimalString(typed) && isPositive(typed) ? wire.value.volume : volume.value
  return validateOrderDraft(
    { side: side.value, type: type.value, price: price.value, volume: wireVolume },
    {
      rules: currentRules,
      baseAvailable: account.baseSellable,
      quoteAvailable: account.quoteAvailable,
      quotePrecision: quotePrecision.value,
    },
  )
})

/** The other unit of the typed amount: 交易额 (USDT) when typing the coin, 数量 (coin) when typing USDT; ≈ = order-book estimate. */
const convertedLabel = computed(() => (unit.value === 'quote'
  ? t('trade.unit.qtyWithUnit', { base: base.value })
  : t('trade.totalWithUnit', { quote: quoteCoin.value })))
const totalDisplay = computed(() => {
  const current = wire.value
  const value = unit.value === 'quote' ? current.baseQty : (current.quoteTotal !== '' ? current.quoteTotal : validation.value.total)
  if (value === '' || !isDecimalString(value)) {
    return '--'
  }
  const shown = unit.value === 'quote' ? canonicalDecimal(value) : toFixedString(value, Math.min(quotePrecision.value, 8))
  return `${current.estimated ? '≈ ' : ''}${shown}`
})

function filterText(key: string, params: Record<string, string> = {}): string {
  return t(`trade.unit.error.${key}`, { step: entryMarket.value.step, base: base.value, quote: quoteCoin.value, unit: unitCoin.value, ...params })
}

/** Last trade price: the reference of the guard's PERCENT_PRICE_BY_SIDE band. */
const lastPrice = computed(() => canonicalDecimal(market.ticker.close))
/** PRICE_FILTER + PERCENT_PRICE_BY_SIDE on the limit price, as the server checks it (建议-028). */
const priceRule = computed(() => (isMarket.value ? null : checkSpotPrice(side.value, price.value, lastPrice.value, spotFilter.value)))
/** Allowed limit-price range for this side right now (PRICE_FILTER ∩ band), shown before typing (建议-028). */
const priceRange = computed(() => (isMarket.value ? { min: '', max: '' } : spotPriceRange(side.value, lastPrice.value, spotFilter.value)))
const priceRangeText = computed(() => {
  const { min, max } = priceRange.value
  if (min === '' && max === '') return ''
  return `${min === '' ? '0' : groupDigits(min)} – ${max === '' ? '∞' : groupDigits(max)} ${quoteCoin.value}`
})
const priceError = computed(() => {
  const tick = filterErrors.value.find((entry) => entry.key === 'tick')
  const rule = priceRule.value
  const ruleText = rule === null ? '' : t(`trade.rule.${rule.key}`, { ...rule.params, quote: quoteCoin.value, side: t(isBuy.value ? 'trade.rule.buySide' : 'trade.rule.sellSide') })
  return firstError('price') || (tick === undefined ? ruleText : filterText(tick.key, tick.params))
})
/**
 * Smallest limit order that passes LOT_SIZE + NOTIONAL at the current limit price (or the last price before one is
 * typed): XAUT at 4000, step 0.0001, min 5 USDT → 0.0013 XAUT = 5.2 USDT (建议-020).
 */
const minOrderAtPrice = computed(() => {
  if (isMarket.value) return null
  const at = limitPrice.value !== '' ? limitPrice.value : lastPrice.value
  return spotMinOrder(at, entryMarket.value.step, spotFilter.value?.minQty, spotFilter.value?.minNotional)
})
function minAtText(): string {
  const min = minOrderAtPrice.value
  if (min === null) return ''
  return t('trade.rule.minAt', { step: entryMarket.value.step, base: base.value, quote: quoteCoin.value, qty: min.qty, total: toFixedString(min.total, Math.min(quotePrecision.value, 8)) })
}
const volumeError = computed(() => {
  const typed = canonicalDecimal(volume.value)
  if (unit.value === 'quote' && !(isMarket.value && isBuy.value) && isDecimalString(typed) && (decimalPlaces(typed) ?? 0) > quotePrecision.value) {
    return t('error.precision', { dp: quotePrecision.value })
  }
  const filter = filterErrors.value.find((entry) => entry.key !== 'tick')
  if (filter !== undefined) {
    let text = filterText(filter.key === 'needsPrice' && isMarket.value ? 'needsBook' : filter.key, filter.params)
    // Typed in USDT: say what the amount became after the step rounding (4.99 → 0.0012 XAUT ≈ 4.8 USDT).
    if (filter.key === 'minNotional' && unit.value === 'quote' && roundedOrder.value !== '') text = `${t('trade.rule.roundedTo', { value: roundedOrder.value })}${comma.value}${text}`
    // The amount rounds below the minimum: also say what works at this price (建议-020).
    const extra = (filter.key === 'minNotional' || filter.key === 'roundsToZero' || filter.key === 'minQty') ? minAtText() : ''
    return extra === '' ? text : `${text}${semicolon.value}${extra}`
  }
  return firstError('volume')
})
const totalError = computed(() => firstError('total'))

const volumeUnit = computed(() => (symbol.value === undefined ? '' : unitCoin.value))

const amountLimitHint = computed(() => {
  const currentRules = rules.value
  const currentSymbol = symbol.value
  if (currentRules === null || currentSymbol === undefined) {
    return ''
  }
  if (unit.value === 'quote') {
    const minTotal = isMarket.value && isBuy.value ? currentRules.marketBuyMin : canonicalDecimal(spotFilter.value?.minNotional ?? '')
    const atPrice = minOrderAtPrice.value
    if (atPrice !== null) return t('trade.unit.minTotal', { min: toFixedString(atPrice.total, Math.min(quotePrecision.value, 8)), quote: currentSymbol.quote })
    return minTotal === '' || minTotal === '0' ? '' : t('trade.unit.minTotal', { min: minTotal, quote: currentSymbol.quote })
  }
  if (isMarket.value && isBuy.value) {
    const minQty = canonicalDecimal(spotFilter.value?.minQty ?? '')
    return minQty === '' ? '' : t('trade.unit.minQty', { min: minQty, base: currentSymbol.base })
  }
  if (isMarket.value) {
    return t('trade.minSellVolume', { min: currentRules.marketSellMin, base: currentSymbol.base })
  }
  const atPrice = minOrderAtPrice.value
  if (atPrice !== null) return t('trade.unit.minQty', { min: atPrice.qty, base: currentSymbol.base })
  return t('trade.minVolume', { min: currentRules.limitVolumeMin })
})

const priceHint = computed(() => {
  const currentRules = rules.value
  if (currentRules === null) {
    return ''
  }
  const range = priceRangeText.value
  return `${t('trade.precision', { dp: currentRules.pricePrecision })} · ${range !== '' ? t('trade.rule.allowed', { range }) : t('trade.minPrice', { min: currentRules.limitPriceMin })}`
})

const volumeHint = computed(() => {
  const currentRules = rules.value
  if (currentRules === null) {
    return ''
  }
  const dp = unit.value === 'quote' ? quotePrecision.value : currentRules.volumePrecision
  return t('trade.precision', { dp })
})

// A background refresh (account.loading) keeps the last snapshot usable: the ticket must not flicker disabled after every order.
const balanceReady = computed(() => sessionStore.isAuthenticated && account.data !== null && account.error === null && relevantBalance.value !== '')
const canSubmit = computed(() => !market.currentTradingClosed && validation.value.ok && volumeError.value === '' && priceError.value === '' && balanceReady.value && !submitting.value && !orders.submitting)

/**
 * Why the button is disabled, in words (建议-020: 「买入禁用」 without a reason). Empty on a fresh ticket (nothing typed)
 * and while submitting.
 */
const blockReason = computed(() => {
  if (!sessionStore.isAuthenticated || symbol.value === undefined || submitting.value || orders.submitting) return ''
  if (market.currentTradingClosed) return t('trade.rule.paused')
  if (canonicalDecimal(volume.value) === '' && (isMarket.value || canonicalDecimal(price.value) === '')) return ''
  if (priceError.value !== '') return `${t('common.price')}${colon.value}${priceError.value}`
  if (volumeError.value !== '') return `${unit.value === 'quote' ? t('common.total') : t('common.amount')}${colon.value}${volumeError.value}`
  if (totalError.value !== '') return totalError.value
  if (!validation.value.ok) return t('trade.rule.incomplete')
  if (!balanceReady.value) return t('trade.rule.balanceNotReady')
  return ''
})

/** The order as it will be sent after rounding to the quantity step: 0.0012 XAUT ≈ 4.8 USDT (limit orders, 建议-020). */
const roundedOrder = computed(() => {
  if (isMarket.value) return ''
  const current = wire.value
  if (!isDecimalString(current.baseQty) || !isPositive(current.baseQty) || !isDecimalString(current.quoteTotal) || current.quoteTotal === '') return ''
  return t('trade.rule.roundedValue', { qty: canonicalDecimal(current.baseQty), base: base.value, total: toFixedString(current.quoteTotal, Math.min(quotePrecision.value, 8)), quote: quoteCoin.value })
})

/**
 * Order-book click (Binance): both tickets take the price; the ticket on the side that takes the clicked level (ask →
 * 买入, bid → 卖出) also takes the cumulative amount from the best level, in its unit, floored to the quantity step and
 * capped by the available balance (`book-fill.ts`). Market tickets ignore book clicks.
 */
watch(() => props.priceSuggestion, (selection) => {
  if (selection === undefined || isMarket.value || submitting.value || orders.submitting || !isPositive(selection.price)) return
  price.value = canonicalDecimal(selection.price)
  touched.price = true
  invalidateSubmission()
  if (selection.side !== side.value || selection.amount === undefined) return
  pinnedSellQty.value = ''
  volume.value = spotFillAmount({
    side: side.value,
    unit: unit.value,
    baseQty: selection.amount,
    price: price.value,
    available: balanceReady.value ? relevantBalance.value : '',
    step: entryMarket.value.step,
    quotePrecision: quotePrecision.value,
  })
  touched.volume = volume.value !== ''
  syncPercentFromVolume()
})

function firstError(field: FieldError['field']): string {
  const error = validation.value.errors.find((entry) => entry.field === field)
  if (error === undefined) {
    return ''
  }
  const params = {
    ...(error.params ?? {}),
    quote: symbol.value?.quote ?? '',
    base: symbol.value?.base ?? '',
  }
  return t(error.key, params)
}

function invalidateSubmission(): void {
  interactionVersion += 1
}

function resetDraft(): void {
  invalidateSubmission()
  price.value = ''
  volume.value = ''
  pinnedSellQty.value = ''
  activePercent.value = 0
  touched.price = false
  touched.volume = false
}

function clearVolumeForTypeChange(): void {
  invalidateSubmission()
  volume.value = ''
  pinnedSellQty.value = ''
  activePercent.value = 0
  touched.volume = false
}

function useMarketPrice(): void {
  const close = canonicalDecimal(market.ticker.close)
  if (close !== '') {
    price.value = toFixedString(close, quotePrecision.value)
    touched.price = true
  }
}

function setPercent(percent: number): void {
  if (symbol.value === undefined || rules.value === null || !balanceReady.value) {
    return
  }
  pinnedSellQty.value = ''
  if (percent <= 0) {
    volume.value = ''
    activePercent.value = 0
    return
  }
  // Buy: share of the quote balance; sell: share of the base balance — shown in the selected unit, rounded down.
  const amount = percentToAmount(percent, side.value, unit.value, relevantBalance.value, sizingMarket.value)
  if (amount === '') {
    // Nothing to size from (0 available): say so instead of a slider that does not move (10-01 monkey test).
    if (!isPositive(canonicalDecimal(relevantBalance.value))) toastInfo(t('trade.zeroBalance', { coin: isBuy.value ? symbol.value?.quote ?? '' : symbol.value?.base ?? '' }), 'spot-zero-balance')
    return
  }
  volume.value = amount
  if (!isBuy.value && unit.value === 'quote') {
    pinnedSellQty.value = floorToStep(div(mul(relevantBalance.value, String(percent)), '100', 16), entryMarket.value.step)
  }
  touched.volume = true
  activePercent.value = percent
}

/**
 * Typing shows the amount error at once (e.g. "不能小于 0.00001" on "0"), not only after leaving the field (10-24).
 * A trailing "." is a half-typed number ("0." on the way to "0.5"): no "invalid number" flash until the field is left.
 */
const volumeFocused = ref(false)
const showVolumeError = computed(() => touched.volume && volumeError.value !== '' && !(volumeFocused.value && volume.value.endsWith('.')))
function onVolumeInput(): void {
  if (volume.value !== '') touched.volume = true
  syncPercentFromVolume()
}
function onVolumeBlur(): void {
  touched.volume = true
  volumeFocused.value = false
}

/** Typed amount → share of the available balance, so the slider mirrors manual input (display only). */
function syncPercentFromVolume(): void {
  pinnedSellQty.value = ''
  if (!balanceReady.value) {
    activePercent.value = 0
    return
  }
  activePercent.value = wireToPercent(side.value, toSpotWire(type.value, side.value, unit.value, volume.value, sizingMarket.value), relevantBalance.value)
}

function chooseUnit(next: SpotUnit): void {
  if (next === unit.value) return
  unit.value = next
  saveSpotUnit(type.value, side.value, next)
  clearVolumeForTypeChange()
}

interface SubmitRequest {
  version: number
  token: string | null
  pair: string
  type: OrderType
}

function isCurrentRequest(request: SubmitRequest): boolean {
  return request.version === interactionVersion
    && request.token === sessionStore.token
    && request.pair === (symbol.value?.pair ?? market.selectedPair)
    && request.type === type.value
}

async function submit(): Promise<void> {
  touched.price = true
  touched.volume = true
  if (!sessionStore.isAuthenticated) {
    return
  }
  if (!canSubmit.value) {
    return
  }
  const payload: SpotOrderPayload = {
    side: side.value,
    type: type.value,
    price: type.value === '1' ? validation.value.price : '',
    volume: validation.value.volume,
    ...(type.value === '1' && props.timeInForce !== undefined && props.timeInForce !== 'GTC' ? { timeInForce: props.timeInForce } : {}),
  }
  const request: SubmitRequest = {
    version: interactionVersion,
    token: sessionStore.token,
    pair: symbol.value?.pair ?? market.selectedPair,
    type: type.value,
  }
  submitting.value = true
  try {
    const created = await orders.submitOrder(payload)
    if (!isCurrentRequest(request)) {
      // The pair or session changed while the order was in flight: still say what happened to it (toasts are global).
      if (created) toastSuccess(payload.side === 'BUY' ? t('trade.buySuccess') : t('trade.sellSuccess'), 'spot-submit')
      else if (orders.submitError !== null) toastError(orders.submitError.startsWith('error.') || orders.submitError.startsWith('common.') ? t(orders.submitError) : orders.submitError, 'spot-submit')
      return
    }
    if (!created) {
      // Results are toasts (fixed overlay), never inserted into the ticket: nothing below it may move.
      toastError(orders.submitError === null ? t('error.unknownResult') : orders.submitError.startsWith('error.') || orders.submitError.startsWith('common.') ? t(orders.submitError) : orders.submitError, 'spot-submit')
      return
    }
    volume.value = ''
    activePercent.value = 0
    touched.volume = false
    toastSuccess(payload.side === 'BUY' ? t('trade.buySuccess') : t('trade.sellSuccess'), 'spot-submit')
    // The pending row, the balance change and the one follow-up refresh are handled by the orders store.
  } finally {
    submitting.value = false
  }
}

/** Placeholder text comes from the real ticker only; nothing is invented when it is empty. */
const pricePlaceholder = computed(() => {
  const close = canonicalDecimal(market.ticker.close)
  return close === '' ? t('common.price') : toFixedString(close, quotePrecision.value)
})

watch(() => market.selectedPair, resetDraft)
watch(() => props.side, resetDraft)
watch(() => props.orderType, () => {
  unit.value = readSpotUnit(props.orderType, props.side)
  clearVolumeForTypeChange()
})
watch(() => props.side, () => { unit.value = readSpotUnit(props.orderType, props.side) })
watch(() => sessionStore.token, invalidateSubmission)
onBeforeUnmount(() => {
  interactionVersion += 1
})
</script>

<template>
  <section class="order-form" :class="isBuy ? 'order-form-buy' : 'order-form-sell'" :aria-label="sectionLabel">
    <div v-if="!isMarket" class="compact-field float-anchor">
      <label class="field-input" :class="{ invalid: touched.price && priceError !== '' }" :title="priceHint">
        <span class="inline-label">{{ t('common.price') }}</span>
        <input v-model="price" :disabled="submitting" :aria-label="t('trade.priceUnit', { quote: symbol?.quote ?? '' })" type="text" inputmode="decimal" :placeholder="pricePlaceholder" @blur="touched.price = true" />
        <span class="field-suffix">{{ symbol?.quote ?? '' }}</span>
        <button class="latest-price" type="button" :disabled="submitting" :title="t('trade.lastPrice')" :aria-label="t('trade.lastPrice')" @click.prevent="useMarketPrice"><LocateFixed :size="13" /></button>
      </label>
      <p v-if="touched.price && priceError !== ''" class="field-error float" :title="priceError">{{ priceError }}</p>
    </div>
    <div v-else class="market-price-line">
      <span>{{ t('common.price') }}</span><span>{{ t('trade.marketPrice') }}</span>
    </div>

    <div class="compact-field float-anchor">
      <label class="field-input" :class="{ invalid: showVolumeError }" :title="volumeHint + ' · ' + amountLimitHint">
        <span class="inline-label">{{ unit === 'quote' ? t('common.total') : t('common.amount') }}</span>
        <input v-model="volume" :disabled="submitting" @input="onVolumeInput" :aria-label="unit === 'quote' ? t('trade.amountUnitQuote', { quote: quoteCoin }) : t('trade.amountUnitBase', { base: volumeUnit })" type="text" inputmode="decimal" :placeholder="amountLimitHint" @focus="volumeFocused = true" @blur="onVolumeBlur" />
        <span class="field-suffix unit-suffix" @click.prevent><TicketSelect :model-value="unit" :options="unitOptions" :label="t('trade.unit.title')" :testid="isBuy ? 'spot-unit-buy' : 'spot-unit-sell'" :disabled="submitting || symbol === undefined" @update:model-value="chooseUnit" /></span>
      </label>
      <p v-if="showVolumeError" class="field-error float" :title="volumeError">{{ volumeError }}</p>
    </div>

    <PercentSlider :model-value="activePercent" :tone="isBuy ? 'up' : 'down'" :disabled="!balanceReady || submitting" :label="sectionLabel" @update:model-value="setPercent" />
    <div class="ticket-meta float-anchor">
      <div class="balance-row"><span class="muted">{{ balanceLabel }}</span><span class="num" :title="relevantBalance">{{ balanceDisplay }}</span></div>
      <div class="balance-row" :data-testid="isBuy ? 'spot-max-buy' : 'spot-max-sell'"><span class="muted">{{ maxLabel }}</span><span class="num">{{ maxDisplay }}</span></div>
      <div class="total-row"><span class="muted">{{ convertedLabel }}</span><span class="num" :class="{ down: totalError !== '' }" data-testid="spot-converted">{{ totalDisplay }}</span></div>
      <div v-if="!isMarket && priceRangeText !== ''" class="balance-row" :data-testid="isBuy ? 'spot-price-range-buy' : 'spot-price-range-sell'"><span class="muted">{{ t('trade.rule.rangeLabel') }}</span><span class="num range" :title="priceRangeText">{{ priceRangeText }}</span></div>
      <div v-if="blockReason !== ''" class="total-row block-reason" :data-testid="isBuy ? 'spot-block-buy' : 'spot-block-sell'"><span class="muted">{{ t('trade.rule.blockedLabel') }}</span><span class="num down" :title="blockReason">{{ blockReason }}</span></div>
      <div v-else-if="roundedOrder !== ''" class="total-row" :data-testid="isBuy ? 'spot-rounded-buy' : 'spot-rounded-sell'"><span class="muted">{{ t('trade.rule.roundedLabel') }}</span><span class="num" :title="roundedOrder">{{ roundedOrder }}</span></div>
      <p v-if="totalError !== ''" class="field-error float" :title="totalError">{{ totalError }}</p>
    </div>
    <p v-if="sessionStore.isAuthenticated && account.error !== null" class="notice notice-error wrap-anywhere">{{ account.error }}</p>
    <button v-if="sessionStore.isAuthenticated" class="btn btn-block submit-button" :class="isBuy ? 'btn-buy' : 'btn-sell'" type="button" :disabled="!canSubmit" :title="blockReason || undefined" @click="submit">{{ submitting ? t('trade.submitting') : heading }}</button>
    <RouterLink v-else class="btn btn-block submit-button" :class="isBuy ? 'btn-buy' : 'btn-sell'" to="/login">{{ SKIN === 'okx' ? `${t('nav.login')}/${t('trade.register')}` : sideLabel }}</RouterLink>
  </section>
</template>

<style scoped>
.order-form { display: flex; flex-direction: column; min-width: 0; gap: 10px; padding: 14px 16px 16px; container-type: inline-size; }
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
.ticket-meta { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: 4px; margin: 2px 0; }
.balance-row, .total-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; }
.num { overflow-wrap: anywhere; text-align: right; min-width: 0; }
/* Allowed price range: wraps at the spaces on a narrow ticket instead of cutting the upper bound and the unit (QA-063). */
.num.range { white-space: normal; overflow-wrap: normal; }
.block-reason .num { font-family: var(--font-sans); text-align: right; white-space: normal; overflow-wrap: anywhere; }
.submit-button { height: 42px; padding: 0 12px; border-radius: 10px; font-size: 14px; margin-top: auto; letter-spacing: 0.01em; }
.order-form-buy .submit-button:not(:disabled) { box-shadow: 0 10px 24px -14px var(--color-up); }
.order-form-sell .submit-button:not(:disabled) { box-shadow: 0 10px 24px -14px var(--color-down); }
.field-error, .field-hint { margin: 4px 0 0; font-size: 11px; line-height: 16px; }
.notice { margin: 0; padding: 7px 10px; font-size: 12px; }
/* Narrow tickets (phones, ticket beside the book): the inline label already names the field, and a hint cut to
   one or two characters ("价格 价", "Amount M") reads as a glitch — the hint stays in the field's title.
   240px: the 375px phone ticket is ~205px wide and leaves ~45px for the input, which cut "80598.53" to
   "80598.5" and "最小数量 0.00001" to "最小数量 0.0" (10-24 walkthrough P2-2). */
@container (max-width: 240px) {
  .field-input { gap: 6px; padding: 0 10px; }
  .field-input input::placeholder { color: transparent; }
}
/* On a narrow ticket, validation occupies space so it cannot cover the next input or slider. */
@container (max-width: 300px) {
  .field-error.float { position: static !important; display: block; max-width: 100%; overflow: visible; -webkit-line-clamp: unset; }
}
</style>
