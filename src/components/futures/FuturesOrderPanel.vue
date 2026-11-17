<script setup lang="ts">
import PercentSlider from '@/components/common/PercentSlider.vue'
import { isFeatureEnabled } from '@/core/feature-flags'
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { ArrowLeftRight, ChevronDown, Info, LocateFixed, Percent, Settings2 } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { SKIN } from '@/core/skin'
import { toastError, toastSuccess } from '@/core/toast'
import { Decimal, canonicalDecimal, groupDigits, isDecimalString, isPositive, ratioToPercent, toFixedString } from '@/modules/finance/decimal'
import { filterDecimal, loadFuturesFilters, minOpenOrder, minOpenValue as minOpenValueOf, minValueText, type FuturesContractFilter } from '@/modules/api/exchange-filters'
import { checkFuturesMaxQty, checkFuturesPrice } from '@/modules/trade/order-rules'
import { fetchFeeRows, fetchLadder, fetchLeverTiers, type CreateOrderPayload } from '@/modules/futures/api'
import { maxPositionValue, type LeverTier } from '@/modules/futures/lever-tiers'
import { maxOpenValue, positionAvgPrice, tierRoomFor, tierUsedValue } from '@/modules/futures/open-limits'
import { estimateLiqPrice, type LadderTier } from '@/modules/futures/liq-estimate'
import { marketOpenValue } from '@/modules/futures/market-open'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { isSignedDecimal, sCmp } from '@/modules/futures/signed'
import {
  isValueVolume,
  needsPrice,
  normalizeInput,
  openCost,
  percentOf,
  valueWireDp,
  type FuturesDraft,
  type FuturesField,
  type OrderOpen,
  type OrderSide,
} from '@/modules/futures/math'
import {
  BBO_OPTIONS,
  TICKET_ORDER_TYPES,
  TIME_IN_FORCE,
  draftMode,
  maxOpenNotional,
  notionalToContracts,
  orderTypeCode,
  pickTakerFee,
  readTimeInForce,
  resolveBboPrice,
  saveTimeInForce,
  useQuoteMode,
  type BboOption,
  type BboResolution,
  type BookTop,
  type MarginBasis,
  type TicketOrderType,
  type TimeInForce,
} from '@/modules/futures/order-entry'
import {
  isMarginEntry,
  unitDp,
  unitToContracts,
  unitToValue,
  useSizeUnit,
  validateSizedOrder,
  wireToEntry,
  type SizeMarket,
  type SizeUnit,
  type SizedValidation,
} from '@/modules/futures/size-unit'
import { holdingsOf, isHedgeConflict, oneWayMaxContracts, oneWayPlan, usePositionMode, type OneWayLeg } from '@/modules/futures/position-mode'
import type { FeeRow } from '@/modules/futures/types'
import { capContracts, type PriceSuggestion } from '@/modules/trade/book-fill'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'
import { useSessionStore } from '@/stores/session'
import FuturesPreferencesDialog from './FuturesPreferencesDialog.vue'
import LeverageDialog from './LeverageDialog.vue'
import MarginModeDialog from './MarginModeDialog.vue'
import OrderTypeSelect from './OrderTypeSelect.vue'
import SizeUnitSheet from './SizeUnitSheet.vue'
import TicketSelect from './TicketSelect.vue'
import type { TicketOption } from './ticket-option'
import TransferDialog from './TransferDialog.vue'

/**
 * Futures ticket (Binance style): open/close; order type sheet (限价单 with GTC/IOC/FOK, 市价单,
 * 条件委托; 只做Maker is not offered because the matching engine does not execute POST_ONLY);
 * 最优价 shortcuts (对手价1/5, 同向价1/5) resolved from the live book at submit time; size typed in
 * the base coin or in USDT as 订单金额 (notional) or 初始保证金 (margin), converted to the wire
 * volume (whole contracts, or value for market opens) by `validateSizedOrder`; fee-aware 最大.
 *
 * Position mode (偏好设置 → 持仓模式, 2026-09-30): Hedge (双向) shows 开仓/平仓 tabs and 开多/开空/平空/平多; One-way (单向)
 * shows 「买入/做多」「卖出/做空」 + 「只减仓」 and maps each order onto the hedge-only server with `oneWayPlan`
 * (`position-mode.ts`): an opposite position is closed first (CLOSE), the remainder opens the other way (OPEN) as a
 * second, sequential order. A contract that already holds both sides falls back to the Hedge ticket with a notice.
 */
const props = defineProps<{ priceSuggestion?: PriceSuggestion }>()
const { t } = useFuturesI18n()
const market = useFuturesMarketStore()
const account = useFuturesAccountStore()
const orders = useFuturesOrdersStore()
const sessionStore = useSessionStore()

const openKind = ref<OrderOpen>('OPEN')
const mode = ref<TicketOrderType>('limit')
const tif = ref<TimeInForce>(readTimeInForce())
const price = ref('')
const bboOn = ref(false)
const bboOption = ref<BboOption>('opp1')
const triggerPrice = ref('')
const triggerAtMarket = ref(false)
/** 条件委托 trigger price type (Binance 最新价格 / 标记价格); `/fapi` only — the classic engine watches the last price. */
const triggerWorking = ref<'CONTRACT_PRICE' | 'MARK_PRICE'>('CONTRACT_PRICE')
/** Attached TP/SL (OTO on `/fapi`, fgw 0.6.12): the price the legs watch. */
const tpslWorking = ref<'CONTRACT_PRICE' | 'MARK_PRICE'>('CONTRACT_PRICE')
const triggerWorkingOptions = computed(() => [
  { value: 'CONTRACT_PRICE' as const, label: t('fut.web.last') },
  { value: 'MARK_PRICE' as const, label: t('fut.cond.markShort') },
])
const volume = ref('')
const percent = ref(0)
const withTpsl = ref(false)
const tp = ref('')
const sl = ref('')
const touched = reactive({ price: false, triggerPrice: false, volume: false, tp: false, sl: false })
const lastSide = ref<OrderSide>('BUY')
const leverageOpen = ref(false)
const marginOpen = ref(false)
const transferOpen = ref(false)
const feeRows = shallowRef<FeeRow[]>([])
const prefsOpen = ref(false)
const reduceOnly = ref(false)
/** Two-leg One-way order in flight: which leg is being placed (shown over the buttons, never in the flow). */
const splitProgress = ref<{ step: 1 | 2; text: string } | null>(null)
/** Wire size a book click chose (exact contracts), valid while the typed text is unchanged and for that side only. */
const bookFill = ref<{ side: OrderSide; wire: string; text: string } | null>(null)

const contract = computed(() => market.currentContract)
const signedIn = computed(() => sessionStore.isAuthenticated)
const ready = computed(() => signedIn.value && account.isOpened)
const submitting = computed(() => account.busy === 'order')
const leverage = computed(() => account.leverage ?? contract.value?.minLever ?? 1)
/** Highest leverage this contract allows for this user (e.g. 10x on stock perps). */
const maxLeverage = computed(() => (contract.value ? Math.min(contract.value.maxLever, account.config?.userMaxLevel ?? contract.value.maxLever) : null))
/**
 * A saved leverage above the contract maximum makes the server reject every order, opening AND closing (10012: the
 * range check uses the saved leverage before it looks at positions); positions are never force-closed. Fix it first.
 */
const leverageTooHigh = computed(() => maxLeverage.value !== null && leverage.value > maxLeverage.value)
const leverageFixing = ref(false)
async function clampLeverage(): Promise<void> {
  if (maxLeverage.value === null) return
  leverageFixing.value = true
  notifyError(await account.setLeverage(maxLeverage.value))
  leverageFixing.value = false
}
const marginModel = computed(() => account.marginModel)
// Binance's asset-mode chip (S = single-asset, M = multi-assets). Hidden until multi-assets margin exists: a static
// "S" nobody can click only confuses users.
const MULTI_ASSETS_MODE = false
const positionMode = usePositionMode(() => sessionStore.user?.id)
const holdings = computed(() => holdingsOf(account.contractPositions, marginModel.value))
/** Legacy data: this contract holds a long AND a short, which One-way cannot show. */
const hedgeConflict = computed(() => isHedgeConflict(holdings.value.long, holdings.value.short))
/** One-way ticket: the preference is One-way and this contract does not hold both sides. */
const oneWay = computed(() => signedIn.value && positionMode.mode.value === 'oneWay' && !hedgeConflict.value)
const oneWayConflict = computed(() => signedIn.value && positionMode.mode.value === 'oneWay' && hedgeConflict.value)
/** One-way always sizes in whole contracts (the plan may split a size into CLOSE + OPEN legs). */
const sizingKind = computed<OrderOpen>(() => (oneWay.value ? 'CLOSE' : openKind.value))
const isOpen = computed(() => oneWay.value || openKind.value === 'OPEN')
/** Post-only follows the limit rules for price and size. */
const baseMode = computed(() => draftMode(mode.value))
const byValue = computed(() => isValueVolume({ mode: baseMode.value, open: sizingKind.value, triggerAtMarket: triggerAtMarket.value }))
const showPrice = computed(() => needsPrice({ mode: baseMode.value, triggerAtMarket: triggerAtMarket.value }))
const coin = computed(() => contract.value?.marginCoin ?? 'USDT')
const coinDp = computed(() => contract.value?.marginCoinPrecision ?? 4)
/** Decimals the server accepts for a value-sized volume (market opens); see `valueWireDp`. */
const valueDp = computed(() => (contract.value === undefined ? 2 : valueWireDp(contract.value)))
const priceDp = computed(() => contract.value?.pricePrecision ?? 2)
const contractsUnit = computed(() => t('fut.contracts'))
const unit = useSizeUnit()
const quoteMode = useQuoteMode()
const marginEntry = computed(() => isMarginEntry(unit.value, quoteMode.value))
const baseCoin = computed(() => contract.value?.multiplierCoin || contract.value?.base || '')
const takerFee = computed(() => pickTakerFee(feeRows.value, contract.value === undefined ? undefined : { multiplierCoin: contract.value.multiplierCoin, marginCoin: contract.value.marginCoin }))
/** Best-price shortcuts apply to limit and post-only orders (not to a conditional order's limit leg). */
const bboAvailable = computed(() => mode.value === 'limit' || mode.value === 'postOnly')
const bboActive = computed(() => bboOn.value && bboAvailable.value)
const bboOptions = computed<TicketOption<BboOption>[]>(() => BBO_OPTIONS.map((entry) => ({ value: entry, label: t(`fut.bboOption.${entry}`), desc: t(`fut.bboHelp.${entry}`) })))
/** 生效方式 selector: GTC / IOC / FOK, plus 只做Maker (which flips `mode` to `postOnly`). */
type TifChoice = TimeInForce | 'postOnly'
const tifOptions = computed<TicketOption<TifChoice>[]>(() => [
  ...TIME_IN_FORCE.map((entry) => ({ value: entry, label: entry, desc: t(`fut.tifDesc.${entry}`) })),
  { value: 'postOnly', label: t('fut.web.postOnlyTif'), desc: t('fut.typeDesc.postOnly') },
])
const tifModel = computed<TifChoice>({
  get: () => (mode.value === 'postOnly' ? 'postOnly' : tif.value),
  set: (value) => {
    if (value === 'postOnly') mode.value = 'postOnly'
    else {
      mode.value = 'limit'
      tif.value = value
    }
  },
})

/** 条件委托 execution leg: 限价 (false) or 市价 (true). */
const triggerTypeOptions = computed<TicketOption<'limit' | 'market'>[]>(() => [
  { value: 'limit', label: t('fut.limit') },
  { value: 'market', label: t('fut.market') },
])
const triggerTypeModel = computed<'limit' | 'market'>({
  get: () => (triggerAtMarket.value ? 'market' : 'limit'),
  set: (value) => { triggerAtMarket.value = value === 'market' },
})

/** ⓘ tooltip: the four order types with their one-line descriptions (same keys OrderTypeSelect shows). */
const typeInfoTitle = computed(() => TICKET_ORDER_TYPES.map((entry) => `${t(`fut.typeName.${entry}`)}: ${t(`fut.typeDesc.${entry}`)}`).join('\n'))

function unitLabel(value: SizeUnit): string {
  if (value === 'quote') return coin.value
  if (value === 'base') return baseCoin.value
  return contractsUnit.value
}

const volumeLabel = computed(() => (unit.value === 'base' ? t('fut.baseAmount') : marginEntry.value ? t('fut.quoteMargin') : t('fut.quoteNotional')))

/* ---------------------------------------------------------------- best price (最优价) */

function bboFor(side: OrderSide, top: BookTop = market.bookTop): BboResolution {
  return resolveBboPrice(bboOption.value, side, top)
}
const bboBuy = computed(() => (bboActive.value ? bboFor('BUY') : null))
const bboSell = computed(() => (bboActive.value ? bboFor('SELL') : null))

function bboText(resolution: BboResolution | null): string {
  return resolution?.ok ? groupDigits(resolution.price, priceDp.value) : '--'
}

function bboErrorText(resolution: BboResolution | null, top: BookTop = market.bookTop): string {
  if (resolution === null || resolution.ok) return ''
  const option = t(`fut.bboOption.${bboOption.value}`)
  if (market.bookConnectionState === 'connecting') return t('fut.wsConnecting')
  if (market.bookConnectionState !== 'open') return t('fut.err.bboNoMarket', { option })
  if (!top.asks.length && !top.bids.length) return t('trade.noDepthData')
  return t('fut.err.bboNoDepth', { book: resolution.bookSide === 'ask' ? t('fut.bookAsk') : t('fut.bookBid'), level: resolution.level, option })
}

const bboError = computed(() => bboErrorText(lastSide.value === 'BUY' ? bboBuy.value : bboSell.value))

/** Limit price used for `side`: the typed price, or the resolved best price. */
function priceFor(side: OrderSide): string {
  if (!bboActive.value) return price.value
  const resolution = side === 'BUY' ? bboBuy.value : bboSell.value
  return resolution?.ok ? resolution.price : ''
}

/* ---------------------------------------------------------------- reference price & limits */

function lastOrMark(): string {
  const last = canonicalDecimal(market.ticker.close)
  if (isPositive(last)) return last
  return isPositive(market.marketInfo.tagPrice) ? market.marketInfo.tagPrice : ''
}

/** Price used for estimates for `side`: the order price for limit legs, otherwise trigger / last / mark. */
function referenceFor(side: OrderSide): string {
  const own = canonicalDecimal(priceFor(side))
  if (showPrice.value && isPositive(own)) return own
  if (mode.value === 'trigger' && isPositive(canonicalDecimal(triggerPrice.value))) return canonicalDecimal(triggerPrice.value)
  return lastOrMark()
}
const referencePrice = computed(() => referenceFor(lastSide.value))

/** Leverage a `side` order uses: the account setting for opens, the position's for closes. */
function levelFor(side: OrderSide): number {
  if (openKind.value === 'OPEN' || oneWay.value) return leverage.value
  const holding = side === 'SELL' ? 'BUY' : 'SELL'
  const position = account.contractPositions.find((entry) => entry.orderSide === holding)
  return position?.leverageLevel ? position.leverageLevel : leverage.value
}

function basisFor(side: OrderSide): MarginBasis {
  return { leverage: levelFor(side), marginRate: contract.value?.marginRate ?? '1' }
}

function sizeMarketFor(side: OrderSide): SizeMarket {
  return { multiplier: contract.value?.multiplier ?? '', price: referenceFor(side), coinDp: valueDp.value }
}
const sizeMarket = computed(() => sizeMarketFor(lastSide.value))
const sizeDp = computed(() => unitDp(unit.value, sizeMarket.value))

/** Leverage tiers of the contract (largest position value per leverage, `@/modules/futures/lever-tiers`). */
const leverTiers = shallowRef<LeverTier[]>([])
watch(() => contract.value?.id, (id) => {
  leverTiers.value = []
  if (id !== undefined) fetchLeverTiers(id).then((tiers) => { if (contract.value?.id === id) leverTiers.value = tiers }).catch(() => { /* no cap applied */ })
}, { immediate: true })

/** Largest position value the current leverage allows (`''` unknown). */
const tierCap = computed(() => maxPositionValue(leverTiers.value, leverage.value))

/**
 * Value the order service already counts against the tier cap on this contract (`@/modules/futures/open-limits`):
 * positions on BOTH sides at avg_price + resting OPEN orders.
 */
const tierUsed = computed(() => {
  const current = contract.value
  if (current === undefined) return '0'
  return tierUsedValue({
    positions: account.contractPositions,
    orders: orders.lists.current.rows.filter((order) => order.contractId === current.id),
    multiplier: current.multiplier,
  })
})

/** Room under the tier cap for a new opening order (`''` = no cap known). */
const tierRoomValue = computed(() => tierRoomFor(tierCap.value, tierUsed.value))

/**
 * One-way flip: the opening leg is sent after the closing leg, when the opposite position no longer counts — room for
 * that leg = cap − (used − the opposite position's value).
 */
function tierRoomAfterClose(side: OrderSide): string {
  const current = contract.value
  if (!oneWay.value || current === undefined) return tierRoomValue.value
  const opposite = account.contractPositions.find((entry) => entry.orderSide !== '' && entry.orderSide !== side)
  if (opposite === undefined) return tierRoomValue.value
  const avg = positionAvgPrice(opposite, current.multiplier)
  const freed = isDecimalString(canonicalDecimal(avg)) && isDecimalString(canonicalDecimal(opposite.positionVolume))
    ? new Decimal(canonicalDecimal(opposite.positionVolume)).times(avg).times(current.multiplier)
    : new Decimal(0)
  const used = new Decimal(canonicalDecimal(tierUsed.value) || '0').minus(freed)
  return tierRoomFor(tierCap.value, used.gt(0) ? used.toFixed() : '0')
}

/** Largest opening notional after the opening taker fee (`maxOpenNotional`), capped by the leverage tier (Binance). */
const marginNotional = computed(() => {
  const current = contract.value
  if (!ready.value || current === undefined || account.available === '') return ''
  return maxOpenNotional({ available: account.available, leverage: leverage.value, marginRate: current.marginRate, takerFee: takerFee.value, dp: valueDp.value })
})
const maxNotional = computed(() => (marginNotional.value === '' ? '' : maxOpenValue(marginNotional.value, tierRoomValue.value, valueDp.value)))

/** Max opening value for `side` (one-way: after its closing leg frees the opposite position's tier value). */
function maxNotionalFor(side: OrderSide): string {
  if (marginNotional.value === '') return ''
  return maxOpenValue(marginNotional.value, oneWay.value ? tierRoomAfterClose(side) : tierRoomValue.value, valueDp.value)
}

/** 「当前杠杆 125x 最大仓位价值 50,000 USDT…」 when an opening order of `value` (USDT) exceeds the tier room. */
function tierCapError(value: string): string {
  const room = tierRoomValue.value
  if (room === '' || !isOpen.value) return ''
  // Positions + orders already at the cap: no opening order is accepted at all (the server refuses before sizing).
  if (new Decimal(room).lte(0)) return t('fut.err.tierFull', { used: groupDigits(new Decimal(tierUsed.value).toFixed(0), 0), lever: leverage.value, max: groupDigits(tierCap.value, 0), coin: coin.value })
  const size = canonicalDecimal(value)
  if (!isDecimalString(size) || new Decimal(size).lte(room)) return ''
  return t('fut.err.tierCap', { lever: leverage.value, max: groupDigits(tierCap.value, 0), coin: coin.value })
}

/** Wire maximum for an opening order on `side` (value for market opens, else contracts at that side's price). */
function maxOpenFor(side: OrderSide): string {
  const current = contract.value
  if (maxNotional.value === '' || current === undefined) return ''
  if (byValue.value) return maxNotional.value
  return notionalToContracts(maxNotional.value, referenceFor(side), current.multiplier)
}

function canCloseFor(side: OrderSide): string {
  return ready.value ? account.canCloseFor(side) : ''
}

/** Whole contracts that can be opened on `side` at that side's price (`''` when unknown). */
function maxOpenContracts(side: OrderSide): string {
  const current = contract.value
  const notional = maxNotionalFor(side)
  if (notional === '' || current === undefined) return ''
  return notionalToContracts(notional, referenceFor(side), current.multiplier)
}

/** One-way 最大 in contracts: closable opposite position + openable (reduce-only: closable only). */
function oneWayMaxFor(side: OrderSide): string {
  if (!ready.value) return ''
  return oneWayMaxContracts({ side, reduceOnly: reduceOnly.value, maxOpen: maxOpenContracts(side), long: holdings.value.long, short: holdings.value.short })
}

/** Largest wire size for `side` in the current ticket (contracts unless a hedge market open). */
function maxWireFor(side: OrderSide): string {
  if (oneWay.value) return oneWayMaxFor(side)
  return isOpen.value ? maxOpenFor(side) : canCloseFor(side)
}

/** Wire volume → the entry unit (coin, USDT notional or USDT margin) for `side`. */
function toEntry(wire: string, side: OrderSide, contracts = !byValue.value): string {
  if (wire === '') return ''
  return wireToEntry(wire, !contracts, unit.value, sizeMarketFor(side), { quoteMode: quoteMode.value, marginBasis: basisFor(side) })
}

const maxBuy = computed(() => toEntry(maxWireFor('BUY'), 'BUY'))
const maxSell = computed(() => toEntry(maxWireFor('SELL'), 'SELL'))

function canCloseInUnit(side: OrderSide): string {
  return toEntry(canCloseFor(side), side, true)
}

const feeNote = computed(() => (takerFee.value === '' ? '' : t('fut.maxFeeNote', { rate: `${ratioToPercent(takerFee.value, 3)}%` })))

/**
 * Wire volume picked by the slider for `side` (close sizes differ per side), computed from the wire
 * maximum so 100% never loses a contract to unit rounding; `undefined` when the user typed a size.
 */
function presetFor(side: OrderSide): string | undefined {
  const fill = bookFill.value
  if (percent.value <= 0) return fill !== null && fill.side === side && fill.text === volume.value ? fill.wire : undefined
  const dp = byValue.value ? valueDp.value : 0
  return percentOf(maxWireFor(side), percent.value, dp)
}

function draftFor(side: OrderSide, limitPrice = priceFor(side)): FuturesDraft {
  return {
    mode: baseMode.value,
    open: sizingKind.value,
    side,
    price: limitPrice,
    triggerPrice: triggerPrice.value,
    triggerAtMarket: triggerAtMarket.value,
    volume: volume.value,
    leverage: leverage.value,
    tpTrigger: isOpen.value && withTpsl.value && mode.value !== 'trigger' ? tp.value : '',
    slTrigger: isOpen.value && withTpsl.value && mode.value !== 'trigger' ? sl.value : '',
  }
}

function validate(side: OrderSide, limitPrice?: string): SizedValidation | null {
  const current = contract.value
  if (current === undefined) return null
  const draft = draftFor(side, limitPrice)
  const reference = limitPrice !== undefined && isPositive(canonicalDecimal(limitPrice)) ? canonicalDecimal(limitPrice) : referenceFor(side)
  const preset = presetFor(side)
  const result = validateSizedOrder({
    draft,
    context: { contract: current, canClose: sizingKind.value === 'OPEN' || oneWay.value ? '' : canCloseFor(side), referencePrice: reference },
    unit: unit.value,
    presetWire: preset,
    unitLabel: marginEntry.value ? `${coin.value} ${t('fut.quoteMargin')}` : unitLabel(unit.value),
    coin: coin.value,
    contractsLabel: contractsUnit.value,
    quoteMode: quoteMode.value,
    marginBasis: basisFor(side),
  })
  // A slider percentage of nothing (no closable position on this side): say so instead of 「请输入数值」.
  if (percent.value > 0 && preset === '' && !isOpen.value && maxWireFor(side) === '') {
    return { ...result, ok: false, errors: [...result.errors.filter((entry) => entry.field !== 'volume'), { field: 'volume', key: 'noClosable' }] }
  }
  // 建议-028: PRICE_FILTER (tick, fixed min / max) and the PERCENT_PRICE band around the mark price, as the guard checks
  // them (opens and closes alike) — before, a price over the fixed maximum only showed 「可用保证金不足」.
  const filter = futuresFilters.value[String(current.id)]
  if (showPrice.value && !result.errors.some((entry) => entry.field === 'price')) {
    const rule = checkFuturesPrice(side, canonicalDecimal(draft.price), market.marketInfo.tagPrice, filter)
    if (rule !== null) return { ...result, ok: false, errors: [{ field: 'price', key: `rule.${rule.key}`, params: { ...rule.params, coin: coin.value } }, ...result.errors] }
  }
  // Restate both minimum checks in the active entry unit, using the same floor as the placeholder.
  if (isOpen.value && !oneWay.value && (unit.value === 'quote' || (byValue.value && unit.value === 'base'))) {
    const belowWireMin = result.errors.some(e => ['belowMinUnit', 'belowMinValue'].includes(e.key))
    if (belowWireMin || (result.ok && belowMinimum(side, result))) {
      const amount = openingMinimum(side, reference)
      if (isPositive(amount)) {
        const label = marginEntry.value ? `${coin.value} ${t('fut.quoteMargin')}` : unitLabel(unit.value)
        return { ...result, ok: false, errors: [...result.errors.filter(e => e.field !== 'volume'),
          { field: 'volume', key: 'belowEntryMin', params: { amount, unit: label } }] }
      }
    }
  }
  // LOT_SIZE maxQty on an opening order (closes are exempt on the server).
  if (result.ok && isOpen.value && !oneWay.value && filter !== undefined) {
    const rule = checkFuturesMaxQty(result.contracts, current.multiplier, filter.maxQty)
    if (rule !== null) return { ...result, ok: false, errors: [...result.errors, { field: 'volume', key: `rule.${rule.key}`, params: { ...rule.params, base: baseCoin.value } }] }
  }
  // Binance MIN_NOTIONAL / LOT_SIZE for an opening order, checked here (inline, live) instead of a server -1013
  // toast (10-01 owner: 「订单金额太小…」 floated truncated over 可开).
  const minValue = minOpenValue.value
  if (result.ok && isOpen.value && !oneWay.value && isPositive(minValue) && belowMinimum(side, result)) {
    // 建议-020: whole contracts — at 4000 with 0.001 XAUT per contract, 5 or 7.99 USDT is 1 张 (4 USDT); the effective
    // minimum is 2 张 = 8 USDT. Name it when it is above the configured minimum value.
    const whole = minOpenOrder(filter, referenceFor(side))
    const params = { usdt: minValueText(minValue), coin: coin.value }
    if (whole !== null && new Decimal(whole.usdt).gt(minValueText(minValue))) {
      return { ...result, ok: false, errors: [...result.errors, { field: 'volume', key: 'belowMinOrderWhole', params: { ...params, contracts: whole.contracts, whole: whole.usdt, face: canonicalDecimal(current.multiplier), base: baseCoin.value } }] }
    }
    return { ...result, ok: false, errors: [...result.errors, { field: 'volume', key: 'belowMinOrder', params }] }
  }
  return result
}

/**
 * The guard's two minimums for an opening order: LOT_SIZE on the QUANTITY (coin = contracts × multiplier ≥ minQty) and
 * MIN_NOTIONAL on the value. Tickets with a known quantity (contracts, or a market open typed in the base coin) compare
 * the quantity itself; pricing minQty with one reference and the order with another refused exactly 0.001 BTC at market
 * (10-01 live: 83.915 < 83.92). A value-sized ticket (USDT / margin / slider) has no quantity yet: its value must reach
 * minQty × the side's reference price.
 */
function belowMinimum(side: OrderSide, check: SizedValidation): boolean {
  const current = contract.value
  const filter = current === undefined ? undefined : futuresFilters.value[String(current.id)]
  if (current === undefined || filter === undefined) return false
  const value = canonicalDecimal(openValueOf(side, check))
  if (!isDecimalString(value)) return false
  const minNotional = filterDecimal(filter.minNotional)
  const minQty = filterDecimal(filter.minQty)
  if (new Decimal(value).lt(minNotional)) return true
  if (byValue.value) {
    // A market open typed in the base coin is a value on the wire but its quantity is known: compare that.
    const exact = canonicalDecimal(exactOpenContracts())
    if (isDecimalString(exact) && isDecimalString(current.multiplier)) return new Decimal(exact).times(current.multiplier).lt(minQty)
    const reference = canonicalDecimal(referenceFor(side))
    return isDecimalString(reference) && new Decimal(value).lt(minQty.times(reference))
  }
  const contracts = canonicalDecimal(check.volume)
  return isDecimalString(contracts) && isDecimalString(current.multiplier) && new Decimal(contracts).times(current.multiplier).lt(minQty)
}

/**
 * Smallest opening order VALUE exactly as the guard checks it (MIN_NOTIONAL on the order value, LOT_SIZE minQty × price):
 * not the whole-contract rounding of `minOpen` (that would refuse a valid 50 USDT order as 50.08). Exact decimal
 * string; '0' = unknown.
 */
const minOpenValue = computed(() => {
  const current = contract.value
  if (current === undefined) return '0'
  return minOpenValueOf(futuresFilters.value[String(current.id)], referenceFor(lastSide.value))
})

/* ---------------------------------------------------------------- One-way (单向持仓) plan */

interface LegCheck { leg: OneWayLeg; check: SizedValidation }
type OneWayResult =
  | { ok: true; legs: LegCheck[] }
  | { ok: false; message: string }

/** Validates one backend order of a One-way plan with the regular rules (price, min/max, closable, TP/SL). */
function legCheck(side: OrderSide, leg: OneWayLeg, limitPrice?: string): SizedValidation | null {
  const current = contract.value
  if (current === undefined) return null
  const draft: FuturesDraft = { ...draftFor(side, limitPrice), open: leg.open, tpTrigger: '', slTrigger: '' }
  const reference = limitPrice !== undefined && isPositive(canonicalDecimal(limitPrice)) ? canonicalDecimal(limitPrice) : referenceFor(side)
  let wire = leg.contracts
  if (leg.open === 'OPEN' && isValueVolume(draft)) {
    // Market opens are sized by value on the wire: the leg's contracts at the reference price, rounded down.
    wire = unitToValue(leg.contracts, 'cont', { multiplier: current.multiplier, price: reference, coinDp: valueDp.value })
  }
  if (leg.open === 'OPEN' && withTpsl.value && !reduceOnly.value && mode.value !== 'trigger') {
    draft.tpTrigger = tp.value
    draft.slTrigger = sl.value
  }
  return validateSizedOrder({
    draft,
    context: { contract: current, canClose: leg.open === 'CLOSE' ? canCloseFor(side) : '', referencePrice: reference },
    unit: 'cont',
    presetWire: wire,
    unitLabel: contractsUnit.value,
    coin: coin.value,
    contractsLabel: contractsUnit.value,
  })
}

function legLabel(leg: OneWayLeg): string {
  if (leg.open === 'OPEN') return leg.side === 'BUY' ? t('fut.openLong') : t('fut.openShort')
  return leg.side === 'BUY' ? t('fut.closeShort') : t('fut.closeLong')
}

function legAmount(leg: OneWayLeg): string {
  const amount = toEntry(leg.contracts, leg.side, true)
  return amount === '' ? `${leg.contracts} ${contractsUnit.value}` : `${groupDigits(amount)} ${unitLabel(unit.value)}`
}

/** The orders a One-way buy/sell becomes, each validated; `null` while the size itself is invalid. */
function planFor(side: OrderSide, check: SizedValidation | null, limitPrice?: string): OneWayResult | null {
  if (check === null || !check.ok || !isPositive(canonicalDecimal(check.volume))) return null
  const plan = oneWayPlan({ side, reduceOnly: reduceOnly.value, contracts: check.volume, long: holdings.value.long, short: holdings.value.short })
  if (!plan.ok) return { ok: false, message: t(`fut.pm.err.${plan.key}`, plan.params ?? {}) }
  if (plan.legs.length > 1 && mode.value === 'trigger') return { ok: false, message: t('fut.pm.err.conditionalSplit') }
  const legs: LegCheck[] = []
  for (const [index, leg] of plan.legs.entries()) {
    const validation = legCheck(side, leg, limitPrice)
    if (validation === null) return null
    if (!validation.ok) {
      const error = validation.errors.find((entry) => entry.field === 'volume') ?? validation.errors[0]
      if (index > 0 && error?.field === 'volume' && error.key === 'belowMinVolume') {
        return { ok: false, message: t('fut.pm.err.reverseBelowMin', { min: `${String(error.params?.min ?? '')} ${contractsUnit.value}` }) }
      }
      return { ok: false, message: error === undefined ? '' : t(`fut.err.${error.key}`, error.params ?? {}) }
    }
    legs.push({ leg, check: validation })
  }
  return { ok: true, legs }
}

/** One-way header: 「单向持仓 · 多 0.012 BTC」 (the one net position of this contract) or 「无持仓」. */
const netPosition = computed(() => {
  const long = holdings.value.long
  const short = holdings.value.short
  const held = long !== null && isPositive(canonicalDecimal(long.volume)) ? { side: 'BUY' as const, h: long } : short !== null && isPositive(canonicalDecimal(short.volume)) ? { side: 'SELL' as const, h: short } : null
  if (held === null) return { text: t('fut.pm.flat'), cls: '' }
  const amount = toEntry(canonicalDecimal(held.h.volume), held.side === 'BUY' ? 'SELL' : 'BUY', true)
  const size = amount === '' ? `${held.h.volume} ${contractsUnit.value}` : `${groupDigits(amount)} ${unitLabel(unit.value)}`
  return { text: `${held.side === 'BUY' ? t('fut.long') : t('fut.short')} ${size}`, cls: held.side === 'BUY' ? 'up' : 'down' }
})

const buyCheck = computed(() => validate('BUY'))
const sellCheck = computed(() => validate('SELL'))
const buyPlan = computed(() => (oneWay.value ? planFor('BUY', buyCheck.value) : null))
const sellPlan = computed(() => (oneWay.value ? planFor('SELL', sellCheck.value) : null))
/** Plan problem for the last side (floats under the size like any other size error). */
const planError = computed(() => {
  const plan = lastSide.value === 'BUY' ? buyPlan.value : sellPlan.value
  return plan !== null && !plan.ok ? plan.message : ''
})
/**
 * 「卖出/做空：将先平多 …，再开空 …」 for a two-leg One-way order (size hint line). Only the side opposite the held
 * position can split, so at most one side has a note.
 */
const splitNote = computed(() => {
  const split = [buyPlan.value, sellPlan.value].find((plan) => plan !== null && plan.ok && plan.legs.length > 1)
  if (split === undefined || split === null || !split.ok) return ''
  const [first, second] = split.legs
  const button = first.leg.side === 'BUY' ? t('fut.pm.buyLong') : t('fut.pm.sellShort')
  return `${button}：` + t('fut.pm.splitNote', { close: legLabel(first.leg), closeAmount: legAmount(first.leg), open: legLabel(second.leg), openAmount: legAmount(second.leg) })
})

function errorFor(field: FuturesField): string {
  if (field === 'price' && bboActive.value) return ''
  // The shared price field is invalid only if neither direction accepts it.
  if (field === 'price') {
    const buyError = buyCheck.value?.errors.find(entry => entry.field === 'price')
    const sellError = sellCheck.value?.errors.find(entry => entry.field === 'price')
    return buyError === undefined || sellError === undefined ? '' : t(`fut.err.${buyError.key}`, buyError.params ?? {})
  }
  const check = lastSide.value === 'BUY' ? buyCheck.value : sellCheck.value
  const error = check?.errors.find((entry) => entry.field === field)
  if (error === undefined && field === 'volume' && oneWay.value) return planError.value
  if (error === undefined && (field === 'tp' || field === 'sl') && oneWay.value) return tpslErrorFor(field)
  return error === undefined ? '' : t(`fut.err.${error.key}`, error.params ?? {})
}

function sidePriceError(side: OrderSide): string {
  if (!showPrice.value || bboActive.value || price.value.trim() === '' || errorFor('price') !== '') return ''
  const check = side === 'BUY' ? buyCheck.value : sellCheck.value
  const error = check?.errors.find(entry => entry.field === 'price')
  return error === undefined ? '' : t(`fut.err.${error.key}`, error.params ?? {})
}

/** One-way sizes as closes, so TP/SL is checked on an opening draft of the same side. */
function tpslErrorFor(field: 'tp' | 'sl'): string {
  const current = contract.value
  if (current === undefined || !withTpsl.value || reduceOnly.value || mode.value === 'trigger') return ''
  const side = lastSide.value
  const draft: FuturesDraft = { ...draftFor(side), open: 'OPEN', mode: 'limit', volume: '1', price: referenceFor(side), tpTrigger: tp.value, slTrigger: sl.value }
  const result = validateSizedOrder({ draft, context: { contract: current, canClose: '', referencePrice: referenceFor(side) }, unit: 'cont', presetWire: '1', unitLabel: contractsUnit.value, coin: coin.value, contractsLabel: contractsUnit.value })
  const error = result.errors.find((entry) => entry.field === field)
  return error === undefined ? '' : t(`fut.err.${error.key}`, error.params ?? {})
}

/** Margin needed for the current size of `side`. */
function costFor(side: OrderSide): string {
  const current = contract.value
  if (current === undefined || !isOpen.value) return ''
  if (oneWay.value) {
    const plan = side === 'BUY' ? buyPlan.value : sellPlan.value
    const open = plan?.ok ? plan.legs.find((entry) => entry.leg.open === 'OPEN') : undefined
    const reference = referenceFor(side)
    if (open === undefined || reference === '') return ''
    return openCost({ contracts: open.leg.contracts, price: reference, multiplier: current.multiplier, leverage: leverage.value, marginRate: current.marginRate })
  }
  const size = (side === 'BUY' ? buyCheck.value : sellCheck.value)?.volume ?? ''
  if (!isPositive(canonicalDecimal(size))) return ''
  if (byValue.value) return openCost({ value: canonicalDecimal(size), multiplier: current.multiplier, leverage: leverage.value, marginRate: current.marginRate })
  const reference = referenceFor(side)
  if (reference === '') return ''
  return openCost({ contracts: canonicalDecimal(size), price: reference, multiplier: current.multiplier, leverage: leverage.value, marginRate: current.marginRate })
}
const costBuy = computed(() => costFor('BUY'))
const costSell = computed(() => costFor('SELL'))

/*
 * 预估强平价 under each button (Binance "Liq Price"): the vendor formula (`liq-estimate.ts`) on the contracts this
 * button would open, merged with a same-side position of the same margin mode. `--` when closing, reduce-only, no
 * liquidation (≤ 0) or inputs missing.
 */
const ladder = shallowRef<LadderTier[]>([])
watch(() => contract.value?.id, (id) => {
  ladder.value = []
  if (id !== undefined) fetchLadder(id).then((tiers) => { if (contract.value?.id === id) ladder.value = tiers }).catch(() => { /* estimate stays -- */ })
}, { immediate: true })
const feeRow = computed(() => {
  const current = contract.value
  if (current === undefined) return undefined
  const same = (a: string | undefined, b: string): boolean => (a ?? '').toUpperCase() === b.toUpperCase()
  return feeRows.value.find((row) => same(row.multiplierCoin, current.multiplierCoin) && same(row.marginCoin, current.marginCoin))
})
function liqFor(side: OrderSide): string {
  const current = contract.value
  const row = feeRow.value
  if (current === undefined || row === undefined || !isOpen.value) return ''
  let contracts = ''
  let merge = true
  if (oneWay.value) {
    const plan = side === 'BUY' ? buyPlan.value : sellPlan.value
    if (plan === null || !plan.ok) return ''
    const open = plan.legs.find((entry) => entry.leg.open === 'OPEN')
    if (open === undefined) return ''
    contracts = open.leg.contracts
    // A split plan closes the held opposite side first: the reversed position starts fresh.
    merge = plan.legs.length === 1
  } else {
    contracts = (side === 'BUY' ? buyCheck.value : sellCheck.value)?.contracts ?? ''
  }
  const price = referenceFor(side)
  if (!isPositive(canonicalDecimal(contracts)) || price === '') return ''
  const model = marginModel.value
  const same = merge ? account.contractPositions.find((entry) => entry.orderSide === side && entry.positionType === model) : undefined
  const closeFee = [row.closeMakerFee, row.closeTakerFee].filter((fee) => isPositive(canonicalDecimal(fee))).sort((a, b) => new Decimal(canonicalDecimal(b)).comparedTo(canonicalDecimal(a)))[0] ?? '0'
  return estimateLiqPrice({
    side,
    contracts,
    price,
    multiplier: current.multiplier,
    leverage: leverage.value,
    marginModel: model,
    openFeeRate: mode.value === 'postOnly' ? row.openMakerFee : row.openTakerFee,
    closeFeeRate: closeFee,
    ladder: ladder.value,
    existing: same === undefined ? null : { contracts: same.positionVolume, value: same.positionBalance, holdAmount: same.holdAmount },
    crossEquity: account.account?.totalMargin ?? '',
    others: account.positions
      .filter((entry) => entry.positionType === 1 && entry !== same && !(!merge && entry.contractId === current.id && entry.orderSide !== side))
      .map((entry) => ({ value: entry.positionBalance, keepRate: entry.keepRate })),
    dp: priceDp.value,
  })
}
const liqBuy = computed(() => liqFor('BUY'))
const liqSell = computed(() => liqFor('SELL'))
/** Estimated liquidation price ≤ 0 (the balance covers the position): shown as `--` with an explaining icon. */
function liqNone(side: OrderSide): boolean {
  return (side === 'BUY' ? liqBuy.value : liqSell.value) === 'none'
}
function liqText(side: OrderSide): string {
  const value = side === 'BUY' ? liqBuy.value : liqSell.value
  return value === '' || value === 'none' ? '--' : groupDigits(value, priceDp.value)
}

function insufficientFor(side: OrderSide): boolean {
  const cost = side === 'BUY' ? costBuy.value : costSell.value
  return isOpen.value && isSignedDecimal(cost) && isSignedDecimal(account.available) && sCmp(cost, account.available) > 0
}
const insufficient = computed(() => insufficientFor(lastSide.value))
/**
 * A trading-rule refusal of the current ticket (price range / band, max quantity, whole-contract minimum): shown in
 * the slot under the buttons before 「可用保证金不足」, which an out-of-range draft also triggers (建议-028).
 */
const ruleMessage = computed(() => {
  const check = lastSide.value === 'BUY' ? buyCheck.value : sellCheck.value
  if (check === null || check.ok) return ''
  const rule = check.errors.find((entry) => entry.field !== 'price' && (entry.key.startsWith('rule.') || ['belowEntryMin', 'belowMinOrder', 'belowMinOrderWhole'].includes(entry.key)))
  return rule === undefined ? '' : checkMessage({ ...check, errors: [rule] })
})

/** What the size amounts to, e.g. `≈ 0.012 BTC · 12 张` (plus the order value in margin mode). */
const sizeHint = computed(() => {
  const side = lastSide.value
  const check = side === 'BUY' ? buyCheck.value : sellCheck.value
  if (check === null || !isPositive(canonicalDecimal(check.volume))) return ''
  const current = contract.value
  const parts: string[] = []
  const money = (value: string): string => groupDigits(toFixedString(value, valueDp.value), valueDp.value)
  if (percent.value > 0) {
    const amount = toEntry(check.volume, side)
    if (amount !== '') parts.push(`${groupDigits(amount)} ${marginEntry.value ? `${coin.value} ${t('fut.quoteMargin')}` : unitLabel(unit.value)}`)
  }
  if (marginEntry.value && check.value !== '') parts.push(t('fut.marginHint', { value: money(check.value), coin: coin.value }))
  if (unit.value === 'base' && check.value !== '') parts.push(`${money(check.value)} ${coin.value}`)
  if (unit.value === 'quote' && check.contracts !== '' && current !== undefined) {
    const base = wireToEntry(check.contracts, false, 'base', sizeMarket.value)
    if (base !== '') parts.push(`${groupDigits(base)} ${baseCoin.value}`)
  }
  if (unit.value === 'quote' && !marginEntry.value && !byValue.value && !isPositive(check.price) && check.value !== '') {
    parts.push(t('fut.web.notionalHint', { value: money(check.value), coin: coin.value }))
  }
  if (check.contracts !== '') parts.push(t('fut.contractsPlain', { value: groupDigits(check.contracts) }))
  return parts.length === 0 ? '' : `≈ ${parts.join(' · ')}`
})

const actualOrderAmount = computed(() => {
  if (unit.value !== 'quote' || marginEntry.value || byValue.value || percent.value > 0) return ''
  const requested = normalizeInput(volume.value)
  const check = lastSide.value === 'BUY' ? buyCheck.value : sellCheck.value
  if (!isDecimalString(requested) || !check || !isPositive(check.price) || !isPositive(check.value) || new Decimal(requested).eq(check.value)) return ''
  return t('fut.web.actualOrderAmount', { value: groupDigits(check.value), coin: coin.value })
})

// Binance-style contract filters (2026-09-29): the smallest opening order = max(LOT_SIZE minQty, MIN_NOTIONAL / price),
// e.g. BTC 0.001 BTC = 10 contracts (≈ 83 USDT). The server refuses smaller OPEN orders with -1013; closes are exempt.
const futuresFilters = shallowRef<Record<string, FuturesContractFilter>>({})
void loadFuturesFilters().then((filters) => { futuresFilters.value = filters })
function contractsForMoneyFloor(money: string, multiplier: string, price: string): Decimal {
  if (!isPositive(multiplier) || !isPositive(price)) return new Decimal(0)
  return filterDecimal(money).dividedBy(new Decimal(multiplier).times(price)).ceil()
}

function openingMinimum(side: OrderSide, price = referenceFor(side)): string {
  const current = contract.value
  if (!current || !isOpen.value) return ''
  const filter = futuresFilters.value[String(current.id)]
  const whole = minOpenOrder(filter, price)
  const marketSize = { ...sizeMarketFor(side), price }
  if (byValue.value && unit.value === 'base') {
    // A coin-sized market open targets whole contracts but the wire value rounds down.
    // Round the value minimum up first so the minimum coin amount survives that conversion.
    const wireMinimum = Decimal.max(filterDecimal(current.minOrderMoney), filterDecimal(filter?.minNotional))
      .toFixed(valueDp.value, Decimal.ROUND_UP)
    const moneyFloor = contractsForMoneyFloor(wireMinimum, current.multiplier, price)
    const count = Decimal.max(whole?.contracts ?? 0, moneyFloor)
    return wireToEntry(count.toFixed(), false, 'base', marketSize)
  }
  const wire = byValue.value
    ? Decimal.max(filterDecimal(current.minOrderMoney), minOpenValueOf(filter, price)).toFixed(valueDp.value, Decimal.ROUND_UP)
    : Decimal.max(filterDecimal(current.minOrderVolume), whole?.contracts ?? 0).ceil().toFixed()
  return wireToEntry(wire, byValue.value, unit.value, marketSize, { quoteMode: quoteMode.value, marginBasis: basisFor(side) }, 'up')
}

const volumePlaceholder = computed(() => {
  if (percent.value > 0) return `${percent.value}%`
  const amount = openingMinimum(lastSide.value)
  if (!isPositive(amount)) return ''
  return t('fut.web.minPlaceholder', { coin: amount, base: unitLabel(unit.value) })
})
const faceValue = computed(() => (contract.value === undefined ? '' : t('fut.faceValue', { value: canonicalDecimal(contract.value.multiplier), coin: contract.value.multiplierCoin })))

function display(value: string, dp: number): string {
  return value === '' ? '--' : groupDigits(toFixedString(canonicalDecimal(value), dp), dp)
}

/** 保证金 estimate under a button: `--` when closing (no margin reserved on a close). */
function costText(side: OrderSide): string {
  if (!isOpen.value) return `-- ${coin.value}`
  const cost = side === 'BUY' ? costBuy.value : costSell.value
  return `${display(cost, valueDp.value)} ${coin.value}`
}

/** 可开 (open) / 可平 (close) estimate under a button, in the chosen size unit. */
function maxLabel(): string {
  if (oneWay.value) return t('fut.pm.max')
  return isOpen.value ? t('fut.web.canOpen') : t('fut.web.canClose')
}

function maxText(side: OrderSide): string {
  const value = isOpen.value ? (side === 'BUY' ? maxBuy.value : maxSell.value) : canCloseInUnit(side)
  return `${display(value, sizeDp.value)} ${unitLabel(unit.value)}`
}

function useLastPrice(): void {
  const last = canonicalDecimal(market.ticker.close)
  if (isPositive(last)) {
    bboOn.value = false
    price.value = toFixedString(last, priceDp.value)
    touched.price = true
  }
}

/**
 * 可开 below the smallest allowed order: say which limit binds — the leverage tier (lower the leverage) or the balance
 * (transfer in). `''` when an order is possible. 10-01 owner: 可开 5.3 USDT < min 50 USDT at 125x near the tier cap.
 */
const openBelowMin = computed(() => {
  const minUsdt = minOpenValue.value
  if (!isOpen.value || oneWay.value || !isPositive(minUsdt) || maxNotional.value === '') return ''
  if (new Decimal(canonicalDecimal(maxNotional.value) || '0').gte(minUsdt)) return ''
  const min = { usdt: minValueText(minUsdt) }
  const room = tierRoomValue.value
  const tierBinds = room !== '' && marginNotional.value !== '' && new Decimal(room).lt(canonicalDecimal(marginNotional.value) || '0')
  return tierBinds
    ? t('fut.err.tierBelowMin', { lever: leverage.value, max: groupDigits(tierCap.value, 0), room: groupDigits(new Decimal(room).toFixed(1), 1), min: min.usdt, coin: coin.value })
    : t('fut.err.balanceBelowMin', { min: min.usdt, coin: coin.value })
})
const openBelowMinByBalance = computed(() => openBelowMin.value !== '' && !openBelowMin.value.startsWith(t('fut.err.tierBelowMinPrefix')))

function choosePercent(value: number): void {
  // Nothing valid to size: explain instead of filling an amount the server would refuse.
  if (value > 0 && openBelowMin.value !== '') {
    percent.value = 0
    explain(openBelowMin.value)
    return
  }
  percent.value = value
  volume.value = ''
  touched.volume = true
  // 平仓 tab (2026-09-30 owner bug): the size check and its error follow the last side; when that side has nothing to
  // close (e.g. 平空 without a short) but the other side does, the slider is about the other side — show its check,
  // not a false 「请输入数值」.
  if (value > 0 && !isOpen.value && canCloseFor(lastSide.value) === '') {
    const other: OrderSide = lastSide.value === 'BUY' ? 'SELL' : 'BUY'
    if (canCloseFor(other) !== '') lastSide.value = other
  }
}

function onVolumeInput(): void {
  percent.value = 0
  bookFill.value = null
  // Show the size rules while typing (min order, max, precision), not only on submit; nothing for an empty box.
  touched.volume = volume.value.trim() !== ''
}

/**
 * Order-book click (Binance): the cumulative size from the best level through the clicked one, for the side that takes
 * it (ask → 买/开多, bid → 卖/开空), capped by that side's 可开 / 可平 / 最大 and shown in the chosen unit. The exact
 * contracts are kept (`bookFill`) so a unit that rounds (USDT) never changes the order.
 */
function fillFromBook(side: OrderSide, contracts: string): void {
  lastSide.value = side
  percent.value = 0
  const capped = capContracts(contracts, ready.value ? maxWireFor(side) : '')
  const text = capped === '' ? '' : toEntry(capped, side, true)
  if (capped === '' || text === '' || byValue.value) {
    volume.value = ''
    bookFill.value = null
    touched.volume = false
    return
  }
  volume.value = text
  bookFill.value = { side, wire: capped, text }
  touched.volume = true
}

function resetDraft(): void {
  bookFill.value = null
  price.value = ''
  triggerPrice.value = ''
  volume.value = ''
  percent.value = 0
  tp.value = ''
  sl.value = ''
  Object.assign(touched, { price: false, triggerPrice: false, volume: false, tp: false, sl: false })
}

/**
 * Action results are toasts in a fixed overlay (`@/core/toast`): an inline 「委托已提交」 used to grow the ticket and
 * push the orders panel down, then shrink it again (owner, 2026-09-29).
 */
/** The first reason a ticket check failed, as shown under the field (「请输入数值」, 超过可平数量 …). */
function checkMessage(check: SizedValidation): string {
  const error = check.errors[0]
  if (error !== undefined) {
    // The slot under the buttons names the field (「委托价格：请输入数值」); the field bubble itself stays short.
    const labels: Record<string, string> = { price: t('fut.web.orderPrice'), triggerPrice: t('fut.web.triggerPrice'), volume: t('fut.web.qty'), tp: t('fut.takeProfit'), sl: t('fut.stopLoss') }
    const label = labels[error.field] ?? ''
    const text = t(`fut.err.${error.key}`, error.params ?? {})
    return label === '' ? text : `${label}: ${text}`
  }
  return (oneWay.value ? planError.value : '') || t('fut.err.required')
}

/**
 * The last submit failure, also shown right under the buy/sell buttons until the ticket changes: a toast alone sits at
 * the top of the page, far from the button, and was missed (10-01 owner bug 「点击开空没有反应没有委托没有报错」).
 */
const submitError = ref('')

function notifyError(message: string | null): void {
  if (message === null || message.trim() === '') return
  submitError.value = message
  toastError(message, 'fut-submit')
}

/**
 * A rule the ticket checks itself (min size, tier cap, balance …): shown inline in the reserved line under the buttons
 * (and on the field), never as a floating toast — toasts are for server / network answers (10-01 owner feedback).
 */
function explain(message: string): void {
  if (message.trim() !== '') submitError.value = message
}

watch([volume, price, percent, mode, openKind, leverage, () => contract.value?.id], () => { submitError.value = '' })

/** USDT value of an opening order in the ticket (value for a market open by value, else contracts × price × multiplier). */
function openValueOf(side: OrderSide, check: SizedValidation): string {
  const current = contract.value
  if (current === undefined || !isOpen.value) return ''
  if (byValue.value) return check.volume
  const price = canonicalDecimal(check.price) || referenceFor(side)
  if (!isDecimalString(canonicalDecimal(check.volume)) || !isDecimalString(price)) return ''
  return new Decimal(canonicalDecimal(check.volume)).times(price).times(current.multiplier).toFixed()
}

/**
 * Contracts a hedge market OPEN must fill: the typed coin amount in whole contracts (Binance: a market order in BTC
 * fills that quantity). `''` for USDT / margin sizing and slider presets, which are values by nature.
 */
function exactOpenContracts(): string {
  if (unit.value !== 'base' || marginEntry.value || percent.value > 0) return ''
  return unitToContracts(normalizeInput(volume.value), 'base', sizeMarket.value)
}

function buildPayload(side: OrderSide, check: SizedValidation, open: OrderOpen = openKind.value, targetContracts = ''): CreateOrderPayload | null {
  const current = contract.value
  if (current === undefined) return null
  const orderType = orderTypeCode(mode.value, triggerAtMarket.value, tif.value)
  const holding = side === 'SELL' ? 'BUY' : 'SELL'
  const position = account.contractPositions.find((entry) => entry.orderSide === holding && entry.positionType === marginModel.value)
    ?? account.contractPositions.find((entry) => entry.orderSide === holding)
  const closing = open === 'CLOSE'
  const payload: CreateOrderPayload = {
    contractId: current.id,
    positionType: closing && position?.positionType ? position.positionType : marginModel.value,
    side,
    open,
    type: orderType,
    volume: check.volume,
    price: orderType === 2 ? '' : check.price,
    leverageLevel: closing && position?.leverageLevel ? position.leverageLevel : leverage.value,
    isConditionOrder: mode.value === 'trigger',
  }
  if (mode.value === 'trigger') {
    payload.triggerPrice = check.triggerPrice
    if (account.fapiOrdersActive()) payload.workingType = triggerWorking.value
  }
  if (closing && orderType === 2 && mode.value !== 'trigger' && position !== undefined) {
    // 市价平仓: an IOC one tick inside the liquidation price when the guard's market edge is past it (10058, 09-30).
    const wire = account.marketCloseWireFor(position)
    payload.type = wire.type
    payload.price = wire.price
  }
  if (!closing && orderType === 2 && mode.value !== 'trigger' && isPositive(canonicalDecimal(targetContracts))) {
    // Market OPEN by value: walk the live book for the target contracts + ½ contract so the fill is exactly that many
    // (`market-open.ts`; 09-30 a plain contracts × reference value filled one short), capped by the affordable value.
    const sized = marketOpenValue({ side, contracts: targetContracts, multiplier: current.multiplier, levels: side === 'BUY' ? market.asks : market.buys, fallbackPrice: referenceFor(side), dp: valueDp.value, cap: maxNotional.value })
    if (sized.value !== '') payload.volume = sized.value
    // `/fapi` order entry sends the exact quantity instead of the value (Binance: a market order fills that quantity).
    payload.contracts = canonicalDecimal(targetContracts)
  }
  if (!closing && withTpsl.value && !(oneWay.value && reduceOnly.value) && mode.value !== 'trigger') {
    const takeProfit = normalizeInput(tp.value)
    const stopLoss = normalizeInput(sl.value)
    if (takeProfit !== '' || stopLoss !== '') {
      payload.tpsl = { takerProfitTrigger: takeProfit, stopLossTrigger: stopLoss }
      if (account.fapiOrdersActive()) payload.tpslWorkingType = tpslWorking.value
    }
  }
  return payload
}

/** Futures order entry is closed until the owner opens it (`futuresTrading` flag): quotes, chart and book stay live. */
const tradingOpen = isFeatureEnabled('futuresTrading')
const { locale: closedLocale } = useI18n({ useScope: 'global' })
const closedCopy = computed(() => (closedLocale.value === 'zh-CN'
  ? { title: '合约交易暂未开放', body: '当前可查看行情、K 线与盘口，暂不支持下单。开放时间以平台公告为准。' }
  : { title: 'Futures trading opens soon', body: 'Quotes, charts and the order book are live. Order entry is not available yet; the opening time will be announced.' }))

async function submit(side: OrderSide): Promise<void> {
  if (!tradingOpen) return
  lastSide.value = side
  Object.assign(touched, { price: true, triggerPrice: true, volume: true, tp: true, sl: true })
  if (leverageTooHigh.value) {
    notifyError(t('fut.err.leverageTooHigh', { current: leverage.value, max: maxLeverage.value ?? '' }))
    return
  }
  let check = side === 'BUY' ? buyCheck.value : sellCheck.value
  if (bboActive.value) {
    // The best price is read from the live book at this instant, not the last published snapshot.
    const top = market.readBookTop()
    const resolution = bboFor(side, top)
    if (!resolution.ok) {
      notifyError(bboErrorText(resolution, top))
      return
    }
    check = validate(side, resolution.price)
  }
  if (!ready.value || check === null) return
  const full = isOpen.value && !oneWay.value && tierRoomValue.value !== '' && new Decimal(tierRoomValue.value).lte(0) ? tierCapError('0') : ''
  if (full !== '') {
    explain(full)
    return
  }
  // 可开 below the smallest order: the binding limit is the reason, not the empty / small amount it left.
  if (openBelowMin.value !== '') {
    explain(openBelowMin.value)
    return
  }
  if (!check.ok) {
    explain(checkMessage(check))
    return
  }
  if (oneWay.value) {
    await submitOneWay(side, check, bboActive.value ? check.price : undefined)
    return
  }
  if (insufficientFor(side)) {
    explain(t('fut.err.insufficientMargin'))
    return
  }
  // Binance: the leverage tier caps the position value; say so before sending (the server answers 10013).
  const capError = tierCapError(openValueOf(side, check))
  if (capError !== '') {
    explain(capError)
    return
  }
  const payload = buildPayload(side, check, openKind.value, isOpen.value ? exactOpenContracts() : '')
  if (payload === null) {
    notifyError(t('fut.err.incomplete'))
    return
  }
  // The margin estimate leaves 可用 at once; a resting limit order shows up in 当前委托 as a pending row.
  const result = await orders.placeOrder(payload, { reserve: isOpen.value ? (side === 'BUY' ? costBuy.value : costSell.value) : undefined })
  if (result !== null) {
    // '' = nothing was sent because another action is running: say so, never a blank / missing toast.
    notifyError(result || t('fut.pm.busy'))
    return
  }
  volume.value = ''
  percent.value = 0
  touched.volume = false
  submitError.value = ''
  toastSuccess(t('fut.orderPlaced'), 'fut-submit')
}

/**
 * One-way order: the plan's orders one after another (CLOSE first, then OPEN), with 「下单中 1/2…」 over the buttons.
 * Stops at the first refusal; a refused second leg says the first one was placed.
 */
async function submitOneWay(side: OrderSide, check: SizedValidation, limitPrice?: string): Promise<void> {
  const plan = planFor(side, check, limitPrice)
  if (plan === null) return
  if (!plan.ok) {
    notifyError(plan.message)
    return
  }
  if (insufficientFor(side)) {
    explain(t('fut.err.insufficientMargin'))
    return
  }
  const split = plan.legs.length > 1
  for (const [index, entry] of plan.legs.entries()) {
    const payload = buildPayload(side, entry.check, entry.leg.open, entry.leg.open === 'OPEN' ? entry.leg.contracts : '')
    if (payload === null) {
      // Never fall through to 「委托已提交」 with nothing sent (10-01 audit).
      splitProgress.value = null
      notifyError(t('fut.err.incomplete'))
      return
    }
    if (split) splitProgress.value = { step: index === 0 ? 1 : 2, text: t('fut.pm.splitting', { step: index + 1 }) + ` ${legLabel(entry.leg)} ${legAmount(entry.leg)}` }
    const reserve = entry.leg.open === 'OPEN' ? (side === 'BUY' ? costBuy.value : costSell.value) : undefined
    const result = await orders.placeOrder(payload, { reserve })
    if (result !== null) {
      splitProgress.value = null
      if (index > 0) notifyError(t('fut.pm.err.openLegFailed', { close: `${legLabel(plan.legs[0].leg)} ${legAmount(plan.legs[0].leg)}`, reason: result || t('fut.pm.busy') }))
      else notifyError(result || t('fut.pm.busy'))
      return
    }
  }
  splitProgress.value = null
  volume.value = ''
  percent.value = 0
  bookFill.value = null
  touched.volume = false
  if (split) {
    const [first, second] = plan.legs
    toastSuccess(t('fut.pm.splitPlaced', { close: legLabel(first.leg), closeAmount: legAmount(first.leg), open: legLabel(second.leg), openAmount: legAmount(second.leg) }), 'fut-submit')
  } else {
    toastSuccess(t('fut.orderPlaced'), 'fut-submit')
  }
}

const buttons = computed(() => (oneWay.value
  ? [{ side: 'BUY' as const, label: t('fut.pm.buyLong'), cls: 'btn-buy' }, { side: 'SELL' as const, label: t('fut.pm.sellShort'), cls: 'btn-sell' }]
  : isOpen.value
  ? [{ side: 'BUY' as const, label: t('fut.openLong'), cls: 'btn-buy' }, { side: 'SELL' as const, label: t('fut.openShort'), cls: 'btn-sell' }]
  : [{ side: 'BUY' as const, label: t('fut.closeShort'), cls: 'btn-buy' }, { side: 'SELL' as const, label: t('fut.closeLong'), cls: 'btn-sell' }]))

/** The two action columns (BUY / SELL), or login / register when logged out. */
type ActionButton = { side: OrderSide; label: string; cls: string; href?: string }
const actionButtons = computed<ActionButton[]>(() => {
  if (!signedIn.value) {
    // OKX: both action buttons read 登录/注册 while logged out.
    if (SKIN === 'okx') {
      const label = `${t('nav.login')}/${t('nav.register')}`
      return [{ side: 'BUY', label, cls: 'btn-buy', href: '/login' }, { side: 'SELL', label, cls: 'btn-sell', href: '/login' }]
    }
    return [
      { side: 'BUY', label: t('fut.loginToTrade'), cls: 'btn-buy', href: '/login' },
      { side: 'SELL', label: t('nav.register'), cls: 'btn-sell', href: '/register' },
    ]
  }
  return buttons.value.map((entry) => ({ side: entry.side, label: entry.label, cls: entry.cls }))
})

function canSubmit(side: OrderSide): boolean {
  const check = side === 'BUY' ? buyCheck.value : sellCheck.value
  if (!ready.value || submitting.value || splitProgress.value !== null || check === null) return false
  // An invalid ticket stays clickable and the click says why (toast): a greyed button that "does nothing" hid the
  // reason (2026-09-30 owner bug). Only a 平仓 side with nothing to close stays disabled (可平 shows it).
  if (!check.ok) return isOpen.value || oneWay.value || isPositive(canCloseFor(side))
  if (oneWay.value) {
    // A refused plan keeps the button clickable: the click explains why for that side (toast), Binance style.
    const plan = side === 'BUY' ? buyPlan.value : sellPlan.value
    if (plan === null) return false
    return !plan.ok || (!insufficientFor(side) && account.available !== '')
  }
  if (isOpen.value) return !insufficientFor(side) && account.available !== ''
  return isPositive(canCloseFor(side))
}

function onTransferDone(): void {
  void account.loadAssets()
}

watch(() => props.priceSuggestion, (selection) => {
  if (selection === undefined || !showPrice.value || submitting.value || splitProgress.value !== null || !isPositive(selection.price)) return
  bboOn.value = false
  price.value = canonicalDecimal(selection.price)
  touched.price = true
  if (selection.side !== undefined && selection.amount !== undefined) fillFromBook(selection.side, selection.amount)
})
// Entering One-way: the ticket is always 「开仓」-shaped (no tabs); leaving it clears 只减仓.
watch(oneWay, (next) => {
  if (next) openKind.value = 'OPEN'
  reduceOnly.value = false
  volume.value = ''
  percent.value = 0
  bookFill.value = null
  touched.volume = false
})
watch(reduceOnly, (next) => {
  if (next) withTpsl.value = false
  percent.value = 0
})
watch(() => market.selectedName, resetDraft)
watch([openKind, mode], () => {
  volume.value = ''
  percent.value = 0
  touched.volume = false
})
watch(triggerAtMarket, () => { volume.value = ''; percent.value = 0 })
watch([unit, quoteMode], () => {
  bookFill.value = null
  volume.value = ''
  touched.volume = false
})
watch(tif, saveTimeInForce)
onMounted(() => {
  fetchFeeRows().then((rows) => { feeRows.value = rows }).catch(() => { feeRows.value = [] })
})
</script>

<template>
  <section class="fop" :aria-label="t('fut.open')">
    <header class="fop-head">
      <div class="chips" :class="{ 'with-asset-mode': MULTI_ASSETS_MODE }">
        <button type="button" class="cfg-chip" :disabled="!ready" @click="marginOpen = true">{{ marginModel === 2 ? t('fut.isolated') : t('fut.cross') }}<ChevronDown :size="12" /></button>
        <button type="button" class="cfg-chip" :disabled="!ready" @click="leverageOpen = true">{{ leverage }}x<ChevronDown :size="12" /></button>
        <span v-if="MULTI_ASSETS_MODE" class="cfg-chip static" :title="t('fut.web.singleAsset')">S</span>
        <button type="button" class="cfg-chip prefs" data-testid="fut-prefs" :disabled="!signedIn" :title="t('fut.pm.settings')" :aria-label="t('fut.pm.settings')" @click="prefsOpen = true"><Settings2 :size="15" /></button>
      </div>
      <!-- One-way (单向持仓): no 开仓/平仓 tabs; the same 32px row shows the mode and the one net position. -->
      <button v-if="oneWay" type="button" class="mode-row" data-testid="fut-mode-row" :title="t('fut.pm.settings')" @click="prefsOpen = true">
        <span class="mode-name">{{ t('fut.pm.oneWay') }}</span>
        <span class="mode-pos num" :class="netPosition.cls" data-testid="fut-net-position">{{ netPosition.text }}</span>
      </button>
      <div v-else class="oc-tabs" role="tablist" :aria-label="t('fut.openKind')">
        <button type="button" role="tab" class="oc-tab" :class="{ active: isOpen }" :aria-selected="isOpen" @click="openKind = 'OPEN'">{{ t('fut.open') }}</button>
        <button type="button" role="tab" class="oc-tab" :class="{ active: !isOpen }" :aria-selected="!isOpen" @click="openKind = 'CLOSE'">{{ t('fut.close') }}</button>
      </div>
    </header>

    <p v-if="signedIn && leverageTooHigh" class="notice notice-error lev-warn" data-testid="fut-leverage-too-high">
      {{ t('fut.err.leverageTooHigh', { current: leverage, max: maxLeverage ?? '' }) }}
      <button type="button" class="lev-fix" :disabled="leverageFixing" @click="clampLeverage">{{ t('fut.setLeverageTo', { max: maxLeverage ?? '' }) }}</button>
    </p>

    <!-- Every user has a futures account (created automatically); never ask the user to open one. -->
    <StateBlock v-if="signedIn && account.open.status === 'checking'" variant="loading" :message="t('fut.checkingAccount')" />
    <StateBlock v-else-if="signedIn && (account.open.status === 'unopened' || account.open.status === 'opening')" variant="loading" :message="t('fut.initializingAccount')" />
    <div v-else-if="signedIn && account.open.status === 'quiz'" class="quiz-gate" data-testid="futures-quiz-gate">
      <p class="muted">{{ t('fut.quizNeeded') }}</p>
      <button class="btn btn-primary" type="button" @click="account.ensureOpened()">{{ t('fut.quizStart') }}</button>
    </div>
    <StateBlock v-else-if="signedIn && account.open.initFailed" variant="error" :message="t('fut.initFailed')" retryable @retry="account.refresh()" />

    <div v-else class="fop-body">
      <!-- order-type text tabs (desktop) + dropdown (phone) -->
      <div class="type-row">
        <div class="type-tabs" :aria-label="t('fut.orderTypeTitle')">
          <button type="button" class="type-tab" :class="{ active: mode === 'limit' || mode === 'postOnly' }" data-testid="fut-type-tab-limit" @click="mode = 'limit'">{{ t('fut.limit') }}</button>
          <button type="button" class="type-tab" :class="{ active: mode === 'market' }" data-testid="fut-type-tab-market" @click="mode = 'market'">{{ t('fut.market') }}</button>
          <button type="button" class="type-tab" :class="{ active: mode === 'trigger' }" data-testid="fut-type-tab-trigger" @click="mode = 'trigger'">{{ t('fut.trigger') }}</button>
          <span class="type-info" tabindex="0" role="img" :aria-label="typeInfoTitle" :title="typeInfoTitle"><Info :size="14" /></span>
        </div>
        <div class="type-select">
          <OrderTypeSelect v-model="mode" :disabled="submitting" />
        </div>
      </div>

      <div class="avail-row">
        <span class="muted">{{ t('fut.available') }}</span>
        <span class="avail-value">
          <span class="num" data-testid="fut-available">{{ display(account.available, coinDp) }} {{ coin }}</span>
          <button v-if="ready && contract" type="button" class="add-funds" data-testid="fut-add-funds" :title="t('fut.addFunds')" :aria-label="t('fut.addFunds')" @click="transferOpen = true"><ArrowLeftRight :size="14" /></button>
        </span>
      </div>

      <!-- 触发价格 (条件委托 only) -->
      <div v-if="mode === 'trigger'" class="field float-anchor">
        <label class="field-label">{{ t('fut.web.triggerPrice') }}</label>
        <div class="field-input" :class="{ invalid: touched.triggerPrice && errorFor('triggerPrice') !== '' }">
          <input v-model="triggerPrice" inputmode="decimal" :aria-label="t('fut.web.triggerPrice')" :disabled="submitting" @blur="touched.triggerPrice = true" />
          <TicketSelect v-if="account.fapiOrdersActive()" v-model="triggerWorking" class="trigger-working" testid="fut-trigger-working" :label="t('fut.cond.priceType')" :options="triggerWorkingOptions" :disabled="submitting" />
          <button v-else type="button" class="trigger-last" :title="t('fut.web.triggerLastOnly')" :aria-label="t('fut.web.triggerLastOnly')" disabled>{{ t('fut.web.last') }}<ChevronDown :size="12" /></button>
        </div>
        <p v-if="touched.triggerPrice && errorFor('triggerPrice') !== ''" class="field-error float" :title="errorFor('triggerPrice')">{{ errorFor('triggerPrice') }}</p>
      </div>

      <!-- 委托价格 -->
      <div class="field float-anchor">
        <label class="field-label">{{ t('fut.web.orderPrice') }}</label>

        <div v-if="mode === 'trigger'" class="price-line" :class="{ 'conditional-limit': !triggerAtMarket }">
          <div v-if="triggerAtMarket" class="market-box" data-testid="fut-market-price">{{ t('fut.marketPriceLabel') }}</div>
          <label v-else class="field-input" :class="{ invalid: touched.price && errorFor('price') !== '' }">
            <input v-model="price" inputmode="decimal" :aria-label="t('fut.web.orderPrice')" :placeholder="market.ticker.close || ''" :disabled="submitting" @blur="touched.price = true" />
            <span class="field-suffix">{{ contract?.quote ?? '' }}</span>
          </label>
          <TicketSelect v-model="triggerTypeModel" class="trigger-type" testid="fut-trigger-type" :label="t('fut.web.orderPrice')" :options="triggerTypeOptions" :disabled="submitting" />
        </div>

        <template v-else-if="baseMode === 'limit'">
          <div class="price-line">
            <div v-if="bboActive" class="field-input bbo-field" :class="{ invalid: touched.price && bboError !== '' }">
              <TicketSelect v-model="bboOption" class="bbo-select" testid="fut-bbo-option" :label="t('fut.bbo')" :options="bboOptions" :disabled="submitting" />
              <span class="bbo-info" tabindex="0" role="img" :aria-label="t('fut.bboInfo')" :title="[t('fut.bboInfo'), ...BBO_OPTIONS.map((entry) => t(`fut.bboHelp.${entry}`))].join('\n')"><Info :size="13" /></span>
            </div>
            <label v-else class="field-input" :class="{ invalid: touched.price && errorFor('price') !== '' }">
              <input v-model="price" inputmode="decimal" :aria-label="t('fut.web.orderPrice')" :placeholder="market.ticker.close || ''" :disabled="submitting" @blur="touched.price = true" />
              <span class="field-suffix">{{ contract?.quote ?? '' }}</span>
              <button class="latest-price" type="button" :title="t('fut.lastPrice')" :aria-label="t('fut.lastPrice')" :disabled="submitting" @click.prevent="useLastPrice"><LocateFixed :size="13" /></button>
            </label>
            <button v-if="bboAvailable" type="button" class="bbo-toggle" data-testid="fut-bbo" :class="{ active: bboOn }" :aria-pressed="bboOn" :title="t('fut.bboToggle')" :disabled="submitting" @click="bboOn = !bboOn">{{ t('fut.bbo') }}</button>
          </div>
          <p v-if="bboActive" class="bbo-resolved num" data-testid="fut-bbo-resolved" :title="t(`fut.bboHelp.${bboOption}`)">{{ t('fut.bboResolved', { buy: bboText(bboBuy), sell: bboText(bboSell) }) }} {{ contract?.quote ?? '' }}</p>
        </template>

        <div v-else class="market-box" data-testid="fut-market-price">{{ t('fut.marketPriceLabel') }}</div>

        <p v-if="bboActive && bboError !== ''" class="field-error float" :title="bboError">{{ bboError }}</p>
        <p v-else-if="showPrice && touched.price && errorFor('price') !== ''" class="field-error float" :title="errorFor('price')">{{ errorFor('price') }}</p>
      </div>

      <!-- 数量 -->
      <div class="field float-anchor">
        <label class="field-label">{{ t('fut.web.qty') }}</label>
        <div class="field-input" :class="{ invalid: touched.volume && errorFor('volume') !== '' }">
          <input
            v-model="volume"
            inputmode="decimal"
            data-testid="fut-volume"
            :aria-label="t('fut.web.qty')"
            :placeholder="volumePlaceholder"
            :disabled="submitting"
            @input="onVolumeInput"
            @blur="touched.volume = true"
          />
          <SizeUnitSheet v-model:unit="unit" v-model:quote-mode="quoteMode" :base-coin="baseCoin" :quote-coin="coin" :disabled="submitting" />
        </div>
        <p v-if="touched.volume && errorFor('volume') !== ''" class="field-error volume-error" :title="errorFor('volume')">{{ errorFor('volume') }}</p>
        <p class="size-hint" :class="{ split: splitNote !== '' }">
          <span data-testid="fut-size-hint" :title="splitNote || sizeHint">{{ splitNote || sizeHint }}<span v-if="!splitNote && actualOrderAmount" class="actual-order-amount">{{ actualOrderAmount }}</span></span>
          <span v-if="splitNote === ''" class="muted">{{ faceValue }}</span>
        </p>
      </div>

      <PercentSlider :snap-taps="!isOpen" :model-value="percent" tone="accent" :disabled="!ready || submitting" @update:model-value="choosePercent" />

      <!-- Legacy long + short on this contract while One-way is chosen: shown as Hedge (tabs above) with this notice. -->
      <p v-if="oneWayConflict" class="mode-conflict" data-testid="fut-mode-conflict" :title="t('fut.pm.conflict')"><span class="full">{{ t('fut.pm.conflict') }}</span><span class="short">{{ t('fut.pm.conflictShort') }}</span></p>

      <div v-if="oneWay" class="check-row">
        <label class="check"><input v-model="reduceOnly" type="checkbox" data-testid="fut-reduce-only" :disabled="submitting" />{{ t('fut.pm.reduceOnly') }}</label>
        <label v-if="mode !== 'trigger'" class="check" :class="{ off: reduceOnly }"><input v-model="withTpsl" type="checkbox" :disabled="submitting || reduceOnly" />{{ t('fut.tpsl') }}</label>
      </div>
      <template v-if="isOpen && mode !== 'trigger'">
        <label v-if="!oneWay" class="check"><input v-model="withTpsl" type="checkbox" :disabled="submitting" />{{ t('fut.tpsl') }}</label>
        <div v-if="withTpsl" class="tpsl float-anchor">
          <label class="field-input small" :class="{ invalid: touched.tp && errorFor('tp') !== '' }">
            <span class="inline-label">TP</span>
            <input v-model="tp" inputmode="decimal" :aria-label="t('fut.takeProfit')" :placeholder="t('fut.takeProfit')" :disabled="submitting" @blur="touched.tp = true" />
          </label>
          <label class="field-input small" :class="{ invalid: touched.sl && errorFor('sl') !== '' }">
            <span class="inline-label">SL</span>
            <input v-model="sl" inputmode="decimal" :aria-label="t('fut.stopLoss')" :placeholder="t('fut.stopLoss')" :disabled="submitting" @blur="touched.sl = true" />
          </label>
          <p v-if="touched.tp && errorFor('tp') !== ''" class="field-error float tp-error" :title="errorFor('tp')">{{ errorFor('tp') }}</p>
          <p v-if="touched.sl && errorFor('sl') !== ''" class="field-error float" :title="errorFor('sl')">{{ errorFor('sl') }}</p>
          <div class="tpsl-foot">
            <p class="field-hint">{{ t('fut.tpslMarketHint') }}</p>
            <TicketSelect v-if="account.fapiOrdersActive()" v-model="tpslWorking" class="trigger-working" testid="fut-tpsl-entry-working" :label="t('fut.cond.priceType')" :options="triggerWorkingOptions" :disabled="submitting" />
          </div>
        </div>
      </template>

      <!-- 生效时间 -->
      <div class="tif-row" :class="{ hidden: mode !== 'limit' && mode !== 'postOnly' }" :title="t('fut.tifHint')">
        <span class="muted">{{ t('fut.web.tif') }}</span>
        <TicketSelect v-model="tifModel" testid="fut-tif" :label="t('fut.web.tif')" :options="tifOptions" :disabled="submitting" />
      </div>

      <div v-if="!tradingOpen" class="trading-closed" role="status" data-testid="fut-trading-closed">
        <strong>{{ closedCopy.title }}</strong>
        <span>{{ closedCopy.body }}</span>
      </div>
      <div v-else class="actions float-anchor">
        <div v-for="entry in actionButtons" :key="entry.side" class="action-col">
          <RouterLink v-if="entry.href" class="btn submit action-btn" :class="entry.cls" :to="entry.href">{{ entry.label }}</RouterLink>
          <button v-else-if="ready" class="btn submit action-btn" :class="entry.cls" type="button" :data-testid="`fut-submit-${entry.side}`" :disabled="!canSubmit(entry.side)" @click="submit(entry.side)">
            {{ submitting && lastSide === entry.side ? t('fut.submitting') : entry.label }}
          </button>
          <button v-else class="btn submit action-btn" :class="entry.cls" type="button" disabled>{{ entry.label }}</button>
          <p v-if="sidePriceError(entry.side) !== ''" class="field-error side-price-error wrap-anywhere" :data-testid="`fut-price-error-${entry.side}`">{{ sidePriceError(entry.side) }}</p>
          <div class="action-meta">
            <div class="meta-line liq" :title="t('fut.web.liqEstHint')"><span class="muted">{{ t('fut.web.liqPrice') }}</span><span class="num" :data-testid="`fut-liq-${entry.side}`" :title="liqNone(entry.side) ? t('fut.noLiquidationHint') : undefined">{{ liqText(entry.side) }}<Info v-if="liqNone(entry.side)" :size="11" class="liq-info" :aria-label="t('fut.noLiquidationHint')" /><span v-else class="meta-unit">{{ coin }}</span></span></div>
            <div class="meta-line cost"><span class="muted">{{ t('fut.cost') }}</span><span class="num" :class="{ down: isOpen && insufficientFor(entry.side) }" :data-testid="`fut-cost-${entry.side}`">{{ costText(entry.side) }}</span></div>
            <div class="meta-line max"><span class="muted">{{ maxLabel() }}</span><span class="num" :data-testid="`fut-max-${entry.side}`">{{ maxText(entry.side) }}</span></div>
          </div>
        </div>
        <p v-if="splitProgress !== null" class="split-progress" role="status" data-testid="fut-split-progress">{{ splitProgress.text }}</p>
      </div>
      <!-- Reserved two-line slot (fixed height, wraps, never truncated): the last refusal or the binding limit. -->
      <p class="submit-msg" :class="{ on: submitError !== '' || openBelowMin !== '' || ruleMessage !== '' || insufficient }" role="alert" data-testid="fut-submit-error">
        <template v-if="submitError !== ''">{{ submitError }}</template>
        <template v-else-if="openBelowMin !== ''">{{ openBelowMin }}</template>
        <template v-else-if="ruleMessage !== ''">{{ ruleMessage }}</template>
        <template v-else-if="insufficient">{{ t('fut.err.insufficientMargin') }}</template>
        <button v-if="(openBelowMinByBalance || (insufficient && ruleMessage === '') || /保证金不足|余额不足|Insufficient/.test(submitError)) && ready && contract" type="button" class="msg-link" data-testid="fut-msg-transfer" @click="transferOpen = true">{{ t('fut.transfer') }}</button>
      </p>

      <RouterLink class="fee-link" to="/fees"><Percent :size="14" />{{ t('fut.web.feeTier') }}</RouterLink>
    </div>

    <FuturesPreferencesDialog v-if="prefsOpen" @close="prefsOpen = false" />
    <LeverageDialog v-if="leverageOpen && contract" :current="leverage" :min="contract.minLever" :max="Math.min(contract.maxLever, account.config?.userMaxLevel ?? contract.maxLever)" @close="leverageOpen = false" />
    <MarginModeDialog v-if="marginOpen" :current="marginModel" :can-switch="account.config?.marginModelCanSwitch ?? true" @close="marginOpen = false" />
    <TransferDialog
      v-if="transferOpen && contract"
      :coin="coin"
      :precision="coinDp"
      :fundsIn="contract.fundsIn"
      :fundsOut="contract.fundsOut"
      initial="wallet_to_contract"
      @done="onTransferDone"
      @close="transferOpen = false"
    />
  </section>
</template>

<style scoped>
.fop { display: flex; flex-direction: column; min-width: 0; background: var(--color-surface); }
.fop-head { display: flex; flex-direction: column; gap: 8px; padding: 12px 12px 10px; border-bottom: 1px solid var(--color-border); }
.chips { display: grid; grid-template-columns: repeat(2, 1fr) 30px; gap: 6px; }
.chips.with-asset-mode { grid-template-columns: repeat(3, 1fr) 30px; }
.cfg-chip.prefs { padding: 0; color: var(--color-text-secondary); }
.mode-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 32px; padding: 0 10px; border-radius: 8px; background: var(--color-surface-alt); font-size: 12px; min-width: 0; }
.mode-row:hover { color: var(--color-accent-text); }
.mode-name { font-weight: 650; white-space: nowrap; }
.mode-pos { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
.mode-pos.up { color: var(--color-up); }
.mode-pos.down { color: var(--color-down); }
.mode-conflict { margin: 0; padding: 0 0 0 8px; border-left: 2px solid var(--color-accent); color: var(--color-text-secondary); font-size: 11px; line-height: 16px; max-height: 32px; overflow: hidden; }
.mode-conflict .short { display: none; }
@media (max-width: 768px) {
  .mode-conflict .full { display: none; }
  .mode-conflict .short { display: inline; }
}
.check-row { display: flex; align-items: center; gap: 16px; }
.check.off { opacity: 0.5; }
.split-progress { position: absolute; left: 0; right: 0; top: -22px; z-index: 4; margin: 0; padding: 1px 8px; border-radius: 6px; background: var(--color-elevated); box-shadow: 0 4px 12px -6px rgba(0, 0, 0, 0.45); color: var(--color-accent-text); font-size: 11px; line-height: 18px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cfg-chip { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 9px; border-radius: 6px; background: var(--color-surface-alt); color: var(--color-text); font-size: 13px; font-weight: 600; }
.cfg-chip:hover:not(:disabled) { color: var(--color-accent-text); }
.cfg-chip:disabled { opacity: 0.55; cursor: not-allowed; }
.cfg-chip.static { cursor: default; }
.oc-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; height: 32px; padding: 3px; border-radius: 8px; background: var(--color-surface-alt); }
.oc-tab { height: 100%; border-radius: 6px; color: var(--color-text-muted); font-size: 13px; font-weight: 600; }
.oc-tab.active { background: var(--color-elevated); color: var(--color-text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); }
.fop-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; container-type: inline-size; }
@media (min-width: 641px) {
  .fop-body { min-height: var(--fop-body-min, 640px); }
}
/*
 * Phones (H5): same rule — reserve the tallest state so nothing below the ticket moves. 2026-09-30: 710px (was 680px)
 * so the One-way legacy long+short notice (two lines at ~55% width) + 止盈止损 still fits (`ui.mjs heights`).
 */
@media (max-width: 640px) {
  .fop-body { min-height: var(--fop-body-min-h5, 722px); }
  /* Thumb-sized config chips and open/close switch (were 28 / 32 px tall); +12 px reserved above. */
  .cfg-chip { height: 34px; }
  .cfg-chip.prefs { min-width: 34px; }
  .oc-tabs { height: 38px; }
}
.type-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.type-tabs { display: flex; align-items: center; gap: 14px; }
.type-tab { padding: 0; border: 0; background: transparent; color: var(--color-text-muted); font-size: 14px; font-weight: 500; cursor: pointer; }
.type-tab.active { color: var(--color-text); font-weight: 700; }
.type-info { display: inline-flex; margin-left: auto; color: var(--color-text-muted); cursor: help; }
.type-info:hover { color: var(--color-text); }
.type-select { display: none; }
@media (max-width: 640px) {
  .type-tabs { display: none; }
  .type-select { display: flex; }
}
.avail-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
.avail-value { display: inline-flex; align-items: center; gap: 4px; }
.add-funds { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; color: var(--color-accent-text); }
.add-funds:hover { background: var(--color-accent-soft); }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field-label { display: block; margin: 0; font-size: 12px; color: var(--color-text-muted); }
.field-input { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 8px; background: transparent; }
.field-input:hover { border-color: var(--color-border-strong); }
.field-input.invalid { border-color: var(--color-down); }
.field-input.small { height: 38px; }
.field-input input { width: 0; min-width: 0; flex: 1; height: 100%; padding: 0; border: 0; outline: 0; background: transparent; font-family: var(--font-mono); font-size: 14px; font-weight: 600; text-align: left; color: var(--color-text); }
.field-input input::placeholder { font-family: var(--font-sans); font-size: 12px; font-weight: 400; color: var(--color-text-muted); }
.field-input input:disabled { color: var(--color-text-muted); }
.inline-label { flex: 0 0 auto; color: var(--color-text-muted); font-size: 12px; font-weight: 550; }
.field-suffix { flex: 0 0 auto; font-size: 12px; color: var(--color-text-secondary); }
.trigger-working { flex: 0 0 auto; }
.tpsl .tpsl-foot { grid-column: 1 / -1; }
.tpsl-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.tpsl-foot .field-hint { margin: 0; min-width: 0; }
.trigger-working :deep(.ts-trigger) { height: 26px; padding: 0 8px; border: 1px solid var(--color-border-strong); border-radius: 6px; background: var(--color-elevated); font-size: 12px; }
.trigger-last { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; height: 26px; padding: 0 8px; border: 1px solid var(--color-border-strong); border-radius: 6px; background: var(--color-elevated); color: var(--color-text); font-size: 12px; font-weight: 600; opacity: 0.7; cursor: default; }
.price-line { display: flex; gap: 6px; min-width: 0; }
.price-line .field-input { flex: 1; min-width: 0; }
.price-line .market-box { flex: 1; min-width: 0; }
.trigger-type { flex: 0 0 auto; width: 96px; }
.trigger-type :deep(.ts-trigger) { width: 100%; height: 40px; padding: 0 8px; border: 1px solid var(--color-border-strong); border-radius: 8px; background: transparent; justify-content: space-between; }
.bbo-toggle { flex: 0 0 auto; height: 40px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: 8px; color: var(--color-text-secondary); font-size: 12px; font-weight: 650; }
.bbo-toggle:hover:not(:disabled) { border-color: var(--color-accent); color: var(--color-text); }
.bbo-toggle.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); }
.bbo-select { flex: 1; min-width: 0; justify-content: flex-end; }
.bbo-info { display: inline-flex; color: var(--color-text-muted); cursor: help; }
.bbo-resolved { margin: 0; font-size: 11px; color: var(--color-text-muted); font-family: var(--font-mono); }
.market-box { display: flex; align-items: center; height: 40px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 8px; background: transparent; font-family: var(--font-mono); font-size: 14px; color: var(--color-text-muted); }
.size-hint { display: flex; justify-content: space-between; gap: 8px; margin: 0; min-height: 16px; font-size: 11px; color: var(--color-text-secondary); font-family: var(--font-mono); }
.actual-order-amount { display: block; white-space: normal; }
.size-hint > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 768px) {
  .size-hint { flex-wrap: wrap; row-gap: 2px; }
  .size-hint > span:first-child:not(:empty) { flex: 1 1 100%; white-space: normal; overflow-wrap: anywhere; }
  .price-line .market-box { height: auto; min-height: 40px; padding-block: 4px; overflow-wrap: anywhere; }
}
/* The One-way close-then-reverse note may take two lines (the ticket reserves room for it; `ui.mjs heights`). */
.size-hint.split > span:first-child { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; color: var(--color-accent-text); }
.size-hint > .muted { flex: 0 0 auto; }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-secondary); cursor: pointer; }
.check input { accent-color: var(--color-accent); }
.tpsl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tpsl .field-error, .tpsl .field-hint { grid-column: 1 / -1; margin: 0; }
.tpsl .tp-error { right: auto; left: 6px; max-width: calc(50% - 10px); }
.tif-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; min-height: 26px; }
.tif-row.hidden { visibility: hidden; }
.tif-row :deep(.ts-trigger) { height: 26px; padding: 0 8px; border: 1px solid var(--color-border-strong); border-radius: 6px; background: var(--color-elevated); font-size: 12px; font-weight: 600; }
/*
 * 开多/开空 follow the inputs directly (Binance); the reserved height of `.fop-body` stays BELOW them (2026-09-30 owner:
 * the gap between 生效时间 and the buttons pushed them off screen). The panel height still never changes.
 */
.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 4px; }
.action-col { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: 'btn' 'error' 'liq' 'cost' 'max'; gap: 2px; min-width: 0; }
.side-price-error { grid-area: error; }
.action-btn { grid-area: btn; }
/* Binance keeps 开多/开空 in full colour while the ticket is incomplete; the click is simply unavailable. */
.action-btn:disabled { opacity: 1; cursor: not-allowed; }
.action-meta { display: contents; }
.meta-line { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 16px; }
.meta-line .muted { color: var(--color-text-muted); white-space: nowrap; }
.meta-line .num { min-width: 0; white-space: normal; overflow-wrap: anywhere; text-align: right; }
.meta-unit { margin-left: 0.3em; }
/* Narrow tickets (≤1360px, 300–320px): the liquidation price drops its unit so the line never wraps (height stays). */
@media (max-width: 1360px) { .meta-unit { display: none; } }
.meta-line .num { color: var(--color-text-secondary); }
.meta-line .num.down { color: var(--color-down); }
.meta-line.liq { grid-area: liq; }
.meta-line.cost { grid-area: cost; }
.meta-line.max { grid-area: max; }
.submit { height: 40px; border-radius: 8px; font-size: 14px; padding: 0 8px; }
.btn-buy.submit:not(:disabled) { box-shadow: 0 10px 24px -14px var(--color-up); }
.btn-sell.submit:not(:disabled) { box-shadow: 0 10px 24px -14px var(--color-down); }
.fee-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 12px; color: var(--color-text-secondary); }
.fee-link:hover { color: var(--color-text); }
.field-error, .field-hint { margin: 0; font-size: 11px; line-height: 16px; }
/* Quantity errors occupy their own row; they never cover the minimum size or contract face value. */
.volume-error { position: static; white-space: normal; overflow-wrap: anywhere; color: var(--color-down); }
/* Reserved two-line message slot under the buttons: fixed height (the ticket never moves), wraps, never ellipsised. */
.submit-msg {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  height: 32px; margin: 4px 0 0; font-size: 11px; line-height: 16px; color: var(--color-down); overflow-wrap: anywhere;
  visibility: hidden;
}
.submit-msg.on { visibility: visible; }
.submit-msg .msg-link { margin-left: 6px; padding: 0; border: 0; background: none; color: var(--color-accent-text); font-size: 11px; text-decoration: underline; cursor: pointer; }
.notice { margin: 0; padding: 7px 10px; font-size: 12px; }
.lev-warn { margin: 8px 0 0; font-size: 12px; }
.lev-fix { margin-left: 6px; font-weight: 700; text-decoration: underline; color: inherit; }
@media (max-width: 640px) {
  .actions { grid-template-columns: 1fr; }
  .action-col { grid-template-areas: 'max' 'cost' 'btn' 'error'; }
  .meta-line.liq { display: none; }
}
/* H5 (≤768px, ~55% width beside the book): chips stay on one line; the last-price shortcut yields room to the value. */
.cfg-chip { white-space: nowrap; }
@media (max-width: 768px) {
  .cfg-chip { padding: 0 6px; font-size: 12px; }
  .latest-price { display: none; }
}
.liq-info { margin-left: 3px; vertical-align: -1px; color: var(--color-text-muted); cursor: help; }
.quiz-gate { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px 12px; text-align: center; }
/* Narrow tickets (320–375 px phones): the size hint was cut mid-number ("最小 0.0("); smaller hint, tighter field. */
@container (max-width: 230px) {
  .conditional-limit { flex-wrap: wrap; gap: 4px; }
  .conditional-limit .field-input { flex: 1 0 min(100%, 100px); padding-inline: 3px; gap: 2px; }
  .conditional-limit .trigger-type { width: auto; }
  .conditional-limit .trigger-type :deep(.ts-trigger) { padding-inline: 5px; }
  .field-input { gap: 6px; padding: 0 8px; }
  .field-input input::placeholder { font-size: 11px; letter-spacing: -0.01em; }
}
.trading-closed { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; padding: 14px; border: 1px solid color-mix(in srgb, var(--color-accent) 40%, var(--color-border)); border-radius: 12px; background: var(--color-accent-soft); }
.trading-closed strong { color: var(--color-accent-text); font-size: 14px; }
.trading-closed span { color: var(--color-text-secondary); font-size: 12px; line-height: 1.6; }
</style>
