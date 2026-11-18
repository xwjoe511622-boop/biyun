<script setup lang="ts">
import { isFeatureEnabled } from '@/core/feature-flags'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ChevronDown, CircleCheck, CircleAlert, History, Search } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { applySpotFilter, loadSpotFilters, type SpotSymbolFilter } from '@/modules/api/exchange-filters'
import { fetchTradesByOrder } from '@/modules/api/order.api'
import { fetchSpotFees, rateToPercent } from '@/modules/content/fees.api'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { validateOrderDraft, type OrderSide } from '@/modules/finance/precision'
import type { MarketSymbol } from '@/modules/market/symbols'
import type { SpotOrderPayload } from '@/modules/spot/spot-order'
import { QUICK_RATIOS, bestPrice, hasLiquidity, quickEstimate, ratioAmount, summarizeFills, type FillSummary, type QuickRatio } from '@/modules/trade/quick-buy'
import { checkSpotFilters, effectiveStep, toSpotWire } from '@/modules/trade/spot-size-unit'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore, type PlacedOrder } from '@/stores/orders'
import { fetchSpotOrder } from '@/modules/spot/spot-api'
import { v3Symbol } from '@/modules/spot/spot-stream-model'
import { isFinalQuickOrderStatus, quickOrderSnapshot } from '@/modules/trade/quick-order-result'
import { useSessionStore } from '@/stores/session'
import { coinMeta } from '@/modules/wallet/coins'
import { formatCoinAmount } from '@/modules/wallet/valuation'
import '@/styles/quick-buy.css'

/**
 * 快捷买币 / Quick buy (owner 10-22: 「其实就是市价单买币」): one card that places a spot MARKET order through the
 * same path as the spot ticket (`orders.submitOrder` → `/api/v3/order`, classic `order/create` fallback; signing
 * and error mapping live there). Buy = USDT to spend (quoteOrderQty), sell = coin quantity. The amount is checked
 * with the ticket's own rules (`validateOrderDraft` + exchange filters); what the user receives is an order-book
 * estimate (`modules/trade/quick-buy.ts`). Only USDT-quoted pairs are offered.
 */
const QUOTE = 'USDT'

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '用 USDT 一步买入数字货币',
      lead: '选好币种、输入金额，按当前市价立即成交。无需看盘口，也无需挂单。',
      stepsTitle: '三步完成',
      step1: '选择币种', step1d: '支持所有以 USDT 计价、正在交易的币种。',
      step2: '输入金额', step2d: '买入时输入要支付的 USDT，卖出时输入要卖出的币数量。',
      step3: '确认并成交', step3d: '确认预估结果后下单，成交明细随即显示，也可在订单中心查看。',
      buy: '买入', sell: '卖出',
      spend: '支付', sellAmount: '卖出', receive: '预计获得',
      available: '可用 {amount} {coin}', max: '最大',
      chooseCoin: '选择币种', searchCoin: '搜索币种', noCoin: '没有匹配的币种',
      refPrice: '参考价', refBook: '按当前盘口估算', refLast: '盘口暂无挂单，按最新成交价估算',
      thinBook: '盘口深度不足以完全成交，超出部分按最差一档价格估算',
      fee: '手续费率', feeNote: '{rate}%（VIP 0 吃单费率）',
      estimateNote: '预估值未扣除手续费。市价单按成交瞬间的盘口逐档成交，实际数量可能与预估不同。',
      buyCoin: '买入 {coin}', sellCoin: '卖出 {coin}',
      loginToBuy: '登录后买币', loginToSell: '登录后卖币', register: '注册账户',
      noAsk: '当前没有卖单，暂时无法按市价买入 {coin}',
      noBid: '当前没有买单，暂时无法按市价卖出 {coin}',
      bookLoading: '正在读取盘口…',
      enterAmount: '请输入金额',
      minSpend: '最少支付 {min} {coin}',
      belowStep: '可用 {amount} {coin} 不足最小下单单位 {step} {coin}，无法{action}。可用余额需满足最小数量和最小金额（订单页可查看规则）',
      ratioLabel: '按可用余额比例填入',
      marketUnavailable: '行情暂不可用，请稍后重试',
      noPairs: '暂无以 USDT 计价的交易对',
      history: '订单记录', c2c: '用法币买 USDT',
      confirmTitle: '确认订单', orderType: '订单类型', marketOrder: '市价单',
      pay: '支付', avgPrice: '预估均价', cancel: '取消', confirm: '确认下单', placing: '下单中…',
      resultTitle: '订单已提交', resultFilled: '已成交', resultSpent: '成交金额', resultAvg: '成交均价',
      resultPending: '正在读取成交结果…', resultUnknown: '成交明细暂未返回，可稍后在订单中心查看。',
      resultOngoing: '订单尚未结束，成交和状态仍可能更新。请刷新或到订单中心核对。',
      resultStatusUnknown: '最新订单状态尚未确认，成交区仅显示已收到的明细。请刷新或到订单中心核对。',
      resultNoFills: '该订单未报告成交。', resultRefresh: '刷新成交结果',
      resultStatus: '订单状态', viewOrders: '查看订单记录', done: '完成', again: '再来一笔',
      status: { FILLED: '全部成交', PARTIALLY_FILLED: '部分成交', NEW: '已提交，等待撮合', PENDING_CANCEL: '撤销处理中', EXPIRED_IN_MATCH: '撮合中过期', CANCELED: '已撤销', EXPIRED: '已过期', REJECTED: '已拒绝' },
      failed: '下单失败',
      faqTitle: '常见问题',
      q1: '快捷买币和现货市价单有什么区别？',
      a1: '没有区别。快捷买币就是一笔现货市价单，只是把下单简化为输入金额。成交规则、手续费和订单记录都与现货交易相同。',
      q2: '为什么实际成交数量和预估不一样？',
      a2: '预估按下单前看到的盘口计算。市价单在成交瞬间按盘口逐档成交，盘口变化或深度不足都会让成交均价与预估不同。',
      q3: '手续费怎么计算？',
      a3: '按现货吃单费率收取，具体费率见费率标准，并以您账户的 VIP 等级为准。',
      q4: '账户里没有 USDT 怎么办？',
      a4: '可以先充值 USDT，或在 C2C 交易中向商家用法币购买 USDT。',
      q5: '在哪里查看订单？',
      a5: '订单中心的现货历史委托和成交明细会记录每一笔快捷买币订单。',
      feesLink: '费率标准', c2cLink: 'C2C 交易', ordersLink: '订单中心',
    },
    'en-US': {
      title: 'Buy crypto with USDT in one step',
      lead: 'Pick a coin, enter an amount and the order fills at the current market price. No order book, no limit orders.',
      stepsTitle: 'Three steps',
      step1: 'Choose a coin', step1d: 'Every coin trading against USDT is available.',
      step2: 'Enter an amount', step2d: 'Buying: the USDT you want to spend. Selling: the coin amount you want to sell.',
      step3: 'Confirm and fill', step3d: 'Check the estimate and place the order. The fill shows right away and in your order history.',
      buy: 'Buy', sell: 'Sell',
      spend: 'Spend', sellAmount: 'Sell', receive: 'Receive (estimated)',
      available: 'Available {amount} {coin}', max: 'Max',
      chooseCoin: 'Choose a coin', searchCoin: 'Search coins', noCoin: 'No matching coin',
      refPrice: 'Reference price', refBook: 'Estimated from the live order book', refLast: 'Order book is empty on this side; estimated from the last price',
      thinBook: 'The order book is not deep enough to fill this; the rest is estimated at the worst visible price',
      fee: 'Fee rate', feeNote: '{rate}% (VIP 0 taker rate)',
      estimateNote: 'Estimates are before fees. A market order fills level by level at the moment it executes, so the final amount can differ.',
      buyCoin: 'Buy {coin}', sellCoin: 'Sell {coin}',
      loginToBuy: 'Log in to buy', loginToSell: 'Log in to sell', register: 'Create account',
      noAsk: 'No sell orders on the book right now, so {coin} cannot be bought at market',
      noBid: 'No buy orders on the book right now, so {coin} cannot be sold at market',
      bookLoading: 'Loading the order book…',
      enterAmount: 'Enter an amount',
      minSpend: 'Spend at least {min} {coin}',
      belowStep: 'Available {amount} {coin} is below the minimum order unit {step} {coin}, so it cannot be traded. Orders must meet the minimum quantity and value.',
      ratioLabel: 'Fill a share of the available balance',
      marketUnavailable: 'Market data is unavailable. Try again shortly.',
      noPairs: 'No USDT pairs are trading right now',
      history: 'Order\nhistory', c2c: 'Buy USDT\nwith fiat',
      confirmTitle: 'Confirm order', orderType: 'Order type', marketOrder: 'Market',
      pay: 'Pay', avgPrice: 'Estimated average price', cancel: 'Cancel', confirm: 'Place order', placing: 'Placing…',
      resultTitle: 'Order placed', resultFilled: 'Filled', resultSpent: 'Value', resultAvg: 'Average price',
      resultPending: 'Reading the fill…', resultUnknown: 'Fill details are not back yet. Check your order history shortly.',
      resultOngoing: 'The order is still open; fills and status can change. Refresh or check order history.',
      resultStatusUnknown: 'The latest order status is unconfirmed. The fill section shows only details received so far. Refresh or check order history.',
      resultNoFills: 'No fills were reported for this order.', resultRefresh: 'Refresh order result',
      resultStatus: 'Status', viewOrders: 'View order history', done: 'Done', again: 'New order',
      status: { FILLED: 'Filled', PARTIALLY_FILLED: 'Partially filled', NEW: 'Placed, awaiting execution', PENDING_CANCEL: 'Cancellation pending', EXPIRED_IN_MATCH: 'Expired during matching', CANCELED: 'Cancelled', EXPIRED: 'Expired', REJECTED: 'Rejected' },
      failed: 'Order failed',
      faqTitle: 'Questions',
      q1: 'How is Quick buy different from a spot market order?',
      a1: 'It is one. Quick buy places a spot market order and only simplifies sizing it. Matching, fees and order records are the same as spot trading.',
      q2: 'Why does the filled amount differ from the estimate?',
      a2: 'The estimate uses the order book you saw before ordering. A market order fills level by level when it executes, so a moving or thin book changes the average price.',
      q3: 'How are fees charged?',
      a3: 'At the spot taker rate. See the fee schedule; your account’s VIP tier applies.',
      q4: 'What if I have no USDT?',
      a4: 'Deposit USDT first, or buy USDT with fiat from merchants in C2C trading.',
      q5: 'Where can I see my orders?',
      a5: 'Every Quick buy order is listed in the order history with its spot fills.',
      feesLink: 'Fee schedule', c2cLink: 'C2C trading', ordersLink: 'Order history',
    },
  },
})
const { t: gt } = useI18n({ useScope: 'global' })
const route = useRoute()
const market = useMarketStore()
const account = useAccountStore()
const orders = useOrdersStore()
const sessionStore = useSessionStore()

const side = ref<OrderSide>('BUY')
const amount = ref('')
const touched = ref(false)
const isBuy = computed(() => side.value === 'BUY')

/* ------------------------------------------------------------------ pair + rules */
const pairs = computed<MarketSymbol[]>(() => market.symbols.filter((entry) => entry.quote.toUpperCase() === QUOTE))
const symbol = computed<MarketSymbol | undefined>(() => {
  const current = market.currentSymbol
  return current !== undefined && current.quote.toUpperCase() === QUOTE ? current : undefined
})
const coin = computed(() => symbol.value?.base ?? '')
const spotFilters = shallowRef<Record<string, SpotSymbolFilter>>({})
void loadSpotFilters().then((filters) => { spotFilters.value = filters })
const filter = computed(() => spotFilters.value[symbol.value?.symbol ?? ''])
const rules = computed(() => (symbol.value === undefined ? null : applySpotFilter(symbol.value.rules, filter.value)))
const quotePrecision = computed(() => symbol.value?.pricePrecision ?? 2)
const step = computed(() => effectiveStep(filter.value?.stepSize, rules.value?.volumePrecision ?? 8))
const book = computed(() => ({
  asks: market.asks,
  bids: market.buys,
  lastPrice: canonicalDecimal(market.ticker.close),
  step: step.value,
  quotePrecision: quotePrecision.value,
}))

function choosePair(pair: string): void {
  if (pair !== market.selectedPair) {
    market.selectPair(pair)
    if (!isBuy.value) {
      amount.value = ''
      touched.value = false
    }
    showShortcutNotice.value = false
  }
  pickerOpen.value = false
}

/** Default pair: ?coin=ETH, else the selected pair when it is USDT-quoted, else BTC/USDT, else the first USDT pair. */
function ensurePair(): void {
  const wanted = typeof route.query.coin === 'string' ? route.query.coin.toUpperCase() : ''
  const byCoin = wanted === '' ? undefined : pairs.value.find((entry) => entry.base.toUpperCase() === wanted)
  if (byCoin !== undefined) return choosePair(byCoin.pair)
  if (symbol.value !== undefined) return
  const fallback = pairs.value.find((entry) => entry.base.toUpperCase() === 'BTC') ?? pairs.value[0]
  if (fallback !== undefined) choosePair(fallback.pair)
}

/* ------------------------------------------------------------------ book readiness */
/** The book arrives a moment after a pair is subscribed: "no sell orders" is only claimed after this grace. */
const bookWaited = ref(false)
let bookTimer: ReturnType<typeof setTimeout> | null = null
function armBookWait(): void {
  bookWaited.value = false
  if (bookTimer !== null) clearTimeout(bookTimer)
  bookTimer = setTimeout(() => { bookWaited.value = true }, 4000)
}
watch(() => market.selectedPair, armBookWait)
const liquid = computed(() => hasLiquidity(side.value, book.value))
const bookPending = computed(() => !liquid.value && !bookWaited.value)

/* ------------------------------------------------------------------ amount, estimate, validation */
const available = computed(() => {
  if (!sessionStore.isAuthenticated || account.data === null || symbol.value === undefined) return ''
  return isBuy.value ? account.quoteAvailable : account.baseSellable
})
const inputCoin = computed(() => (isBuy.value ? QUOTE : coin.value))
const outputCoin = computed(() => (isBuy.value ? coin.value : QUOTE))

function onAmountInput(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.replace(/,/g, '.').replace(/[^\d.]/g, '')
  const [head, ...rest] = raw.split('.')
  const next = rest.length === 0 ? head : `${head}.${rest.join('')}`
  amount.value = next
  ;(event.target as HTMLInputElement).value = next
  touched.value = true
  showShortcutNotice.value = false
}
const RATIO_LABEL: Record<QuickRatio, string> = { '0.25': '25%', '0.5': '50%', '0.75': '75%', '1': '100%' }
/** QA-004: set when a shortcut rounds to zero (dust below the step), so the click is never silent. */
const showShortcutNotice = ref(false)
const shortcutNotice = computed(() => t('belowStep', {
  amount: available.value,
  coin: inputCoin.value,
  step: isBuy.value ? (quotePrecision.value > 0 ? `0.${'0'.repeat(quotePrecision.value - 1)}1` : '1') : step.value,
  action: t(isBuy.value ? 'buy' : 'sell'),
}))
function fillRatio(ratio: QuickRatio): void {
  const value = ratioAmount(side.value, available.value, ratio, book.value)
  if (value === '') {
    showShortcutNotice.value = isPositive(canonicalDecimal(available.value))
    return
  }
  showShortcutNotice.value = false
  amount.value = value
  touched.value = true
}
function fillMax(): void {
  fillRatio('1')
}
function setSide(next: OrderSide): void {
  if (next === side.value) return
  side.value = next
  amount.value = ''
  touched.value = false
  showShortcutNotice.value = false
}

const estimate = computed(() => quickEstimate(side.value, amount.value, book.value))
const reference = computed(() => {
  const best = bestPrice(side.value, book.value)
  return best !== '' ? best : book.value.lastPrice
})
const wire = computed(() => toSpotWire('2', side.value, isBuy.value ? 'quote' : 'base', amount.value, {
  step: step.value,
  quotePrecision: quotePrecision.value,
  refPrice: reference.value,
}))
const validation = computed(() => {
  const current = rules.value
  if (current === null) return null
  const typed = canonicalDecimal(amount.value)
  const volume = isDecimalString(typed) && isPositive(typed) && wire.value.volume !== '' ? wire.value.volume : amount.value
  return validateOrderDraft(
    { side: side.value, type: '2', price: '', volume },
    {
      rules: current,
      baseAvailable: sessionStore.isAuthenticated ? account.baseSellable : '',
      quoteAvailable: sessionStore.isAuthenticated ? account.quoteAvailable : '',
      quotePrecision: quotePrecision.value,
    },
  )
})
const amountError = computed(() => {
  const typed = canonicalDecimal(amount.value)
  if (typed === '' || !touched.value) return ''
  const filterError = checkSpotFilters('2', side.value, isBuy.value ? 'quote' : 'base', amount.value, '', wire.value, filter.value)
    .find((entry) => entry.key !== 'tick' && entry.key !== 'needsPrice')
  if (filterError !== undefined) {
    return gt(`trade.unit.error.${filterError.key}`, { step: step.value, base: coin.value, quote: QUOTE, unit: inputCoin.value, ...(filterError.params ?? {}) })
  }
  const error = validation.value?.errors.find((entry) => entry.field !== 'price')
  if (error === undefined) return ''
  if (error.key === 'error.belowVolumeMin' && isBuy.value) return t('minSpend', { min: String(error.params?.min ?? ''), coin: QUOTE })
  const params = { ...(error.params ?? {}) }
  if (typeof params.available === 'string' && isDecimalString(params.available)) params.available = groupDigits(params.available)
  return gt(error.key, { ...params, quote: QUOTE, base: coin.value })
})

/** Why the action is unavailable (shown under the button), '' when it can be used. */
const blockReason = computed(() => {
  if (symbol.value === undefined) return ''
  if (!liquid.value) return bookPending.value ? t('bookLoading') : t(isBuy.value ? 'noAsk' : 'noBid', { coin: coin.value })
  return ''
})
const canSubmit = computed(() => sessionStore.isAuthenticated
  && symbol.value !== undefined
  && liquid.value
  && touched.value
  && canonicalDecimal(amount.value) !== ''
  && validation.value?.ok === true
  && amountError.value === ''
  && account.data !== null
  && !orders.submitting)

/* ------------------------------------------------------------------ fee (public schedule, VIP 0 taker) */
const takerRate = ref('')
async function loadFee(): Promise<void> {
  try {
    const rows = await fetchSpotFees()
    const sym = symbol.value?.symbol.toLowerCase() ?? ''
    takerRate.value = rows.find((row) => row.symbol === sym)?.taker[0] ?? ''
  } catch {
    takerRate.value = '' // no fee line rather than a guessed one
  }
}
watch(() => symbol.value?.symbol, () => void loadFee())
const feePercent = computed(() => (takerRate.value === '' ? '' : rateToPercent(takerRate.value)))

/* ------------------------------------------------------------------ display helpers */
function show(value: string, dp: number | null = null): string {
  return isDecimalString(value) && value !== '' ? groupDigits(value, dp) : '--'
}
const receiveDisplay = computed(() => (estimate.value.receive === '' ? '0' : groupDigits(estimate.value.receive)))
const availableDisplay = computed(() => formatCoinAmount(available.value, coinMeta(market.publicInfo, inputCoin.value).showPrecision))
const refDisplay = computed(() => (reference.value === '' ? '--' : groupDigits(reference.value)))
const amountSize = computed(() => {
  const length = amount.value.length
  return length > 14 ? 'is-xs' : length > 10 ? 'is-sm' : ''
})

/* ------------------------------------------------------------------ coin picker */
const pickerOpen = ref(false)
const pickerQuery = ref('')
const pickerInput = ref<HTMLInputElement | null>(null)
const pickerList = computed(() => {
  const query = pickerQuery.value.trim().toUpperCase()
  return pairs.value.filter((entry) => query === '' || entry.base.toUpperCase().includes(query) || (entry.coin?.showName ?? '').toUpperCase().includes(query))
})
function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value
  pickerQuery.value = ''
  if (pickerOpen.value) void nextTick(() => pickerInput.value?.focus())
}
function lastOf(entry: MarketSymbol): string {
  const close = canonicalDecimal(market.tickers[entry.symbol.toLowerCase()]?.close ?? '')
  return close === '' ? '--' : groupDigits(close, entry.pricePrecision)
}
function onDocumentPointer(event: PointerEvent): void {
  if (pickerOpen.value && !(event.target as Element | null)?.closest?.('.qb-picker')) pickerOpen.value = false
}
function onDocumentKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') pickerOpen.value = false
}

/* ------------------------------------------------------------------ confirm + place + result */
type Stage = 'closed' | 'confirm' | 'result'
const stage = ref<Stage>('closed')
interface Draft { side: OrderSide; coin: string; pay: string; payCoin: string; receive: string; receiveCoin: string; avgPrice: string; volume: string }
const draft = shallowRef<Draft | null>(null)
const submitError = ref('')
interface Result { status: string; fill: FillSummary | null; loading: boolean; orderId: string | null; statusCurrent: boolean }
const result = ref<Result | null>(null)
let resultVersion = 0
let resultTarget: PlacedOrder | null = null
let resultController: AbortController | null = null

function openConfirm(): void {
  touched.value = true
  if (!canSubmit.value || validation.value === null) return
  draft.value = {
    side: side.value,
    coin: coin.value,
    pay: canonicalDecimal(amount.value),
    payCoin: inputCoin.value,
    receive: estimate.value.receive,
    receiveCoin: outputCoin.value,
    avgPrice: estimate.value.avgPrice,
    volume: validation.value.volume,
  }
  submitError.value = ''
  stage.value = 'confirm'
}

function translateError(message: string | null): string {
  if (message === null) return gt('error.unknownResult')
  return message.startsWith('error.') || message.startsWith('common.') ? gt(message) : message
}

async function place(): Promise<void> {
  const current = draft.value
  if (current === null || orders.submitting) return
  submitError.value = ''
  const payload: SpotOrderPayload = { side: current.side, type: '2', price: '', volume: current.volume }
  const version = resultVersion
  const placed = await orders.submitOrder(payload)
  if (version !== resultVersion) return
  if (!placed) {
    submitError.value = translateError(orders.submitError)
    return
  }
  amount.value = ''
  touched.value = false
  stage.value = 'result'
  result.value = null
  resultTarget = orders.lastPlaced
  void readFill()
}

/** Query the accepted order until terminal; receiving one fill never proves all execution is finished. */
async function readFill(): Promise<void> {
  const version = ++resultVersion
  resultController?.abort()
  const active = new AbortController(); resultController = active
  const placed = resultTarget
  const initial = placed?.id ? quickOrderSnapshot(placed.v3, placed.id, v3Symbol(placed.symbol)) : null
  result.value = result.value === null
    ? { status: initial?.status ?? '', fill: initial?.fill ?? null, loading: true, orderId: placed?.id ?? null, statusCurrent: initial !== null }
    : { ...result.value, loading: true }
  if (placed === null || placed.id === null || (initial !== null && isFinalQuickOrderStatus(initial.status))) {
    result.value = { ...result.value, loading: false }
    return
  }
  for (const wait of [0, 300, 1200, 2500]) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    if (version !== resultVersion) return
    let snapshot: ReturnType<typeof quickOrderSnapshot> = null
    try { snapshot = quickOrderSnapshot(await fetchSpotOrder(v3Symbol(placed.symbol), placed.id, active.signal), placed.id, v3Symbol(placed.symbol)) }
    catch { /* Read failure never changes an accepted order into a failed or filled order. */ }
    if (version !== resultVersion) return
    // The authoritative cumulative totals are complete. A slow or paginated trade list must not block or replace them.
    let fill: FillSummary | null = snapshot !== null ? snapshot.fill : result.value?.fill ?? null
    if (snapshot === null) {
      try {
        const trades = await fetchTradesByOrder(placed.symbol, placed.id, 1, 100)
        if (version !== resultVersion) return
        if ((trades.trade_list?.length ?? 0) > 0) fill = summarizeFills(trades.trade_list ?? [])
      } catch { /* Received fills stay visible while order status remains explicitly unconfirmed. */ }
    }
    if (version !== resultVersion) return
    result.value = { status: snapshot?.status ?? result.value?.status ?? '', fill, loading: true, orderId: placed.id, statusCurrent: snapshot !== null }
    if (snapshot !== null && isFinalQuickOrderStatus(snapshot.status)) {
      result.value = { ...result.value, loading: false }
      return
    }
  }
  if (version === resultVersion && result.value !== null) result.value = { ...result.value, loading: false }
}

function closeDialog(): void {
  if (orders.submitting) return
  stage.value = 'closed'
  resultVersion += 1
  resultController?.abort()
  resultTarget = null
}
const statusText = computed(() => {
  const status = result.value?.status ?? ''
  if (status === '') return ''
  const key = `status.${status}`
  const text = t(key)
  return text === key ? status : text
})

/* ------------------------------------------------------------------ lifecycle */
let stopStream: (() => void) | null = null
async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    return
  }
  if (stopStream === null) return
  ensurePair()
  market.resubscribe()
  armBookWait()
  void loadFee()
  if (sessionStore.isAuthenticated) void account.load()
}
watch(() => sessionStore.isAuthenticated, (authenticated) => {
  if (authenticated) void account.load()
  else {
    resultVersion += 1
    resultController?.abort()
    resultTarget = null
    result.value = null
    stage.value = 'closed'
  }
})
onMounted(() => {
  stopStream = market.start('terminal')
  document.addEventListener('pointerdown', onDocumentPointer)
  document.addEventListener('keydown', onDocumentKey)
  void bootstrap()
})
onBeforeUnmount(() => {
  resultVersion += 1
  resultController?.abort()
  if (bookTimer !== null) clearTimeout(bookTimer)
  document.removeEventListener('pointerdown', onDocumentPointer)
  document.removeEventListener('keydown', onDocumentKey)
  stopStream?.()
  stopStream = null
})

const faqs = computed(() => [1, 2, 3, 4, 5].map((index) => ({ q: t(`q${index}`), a: t(`a${index}`), index })))
const otcOpen = isFeatureEnabled('otc')
</script>

<template>
  <div class="qb-page">
    <div class="qb-top">
      <div class="qb-top-inner">
        <span class="qb-crumb">{{ gt('quickBuyUi.buyCrypto') }} <span aria-hidden="true">/</span> <strong>{{ gt('quickBuyUi.quickBuy') }}</strong></span>
        <span class="qb-top-links">
          <RouterLink v-if="otcOpen" to="/otc"><span>{{ t('c2c') }}</span></RouterLink>
          <RouterLink v-if="sessionStore.isAuthenticated" to="/orders"><History :size="16" aria-hidden="true" /><span>{{ t('history') }}</span></RouterLink>
        </span>
      </div>
    </div>

    <section class="qb-hero">
      <div class="qb-intro">
        <h1 class="qb-title">{{ t('title') }}</h1>
        <p class="qb-lead">{{ t('lead') }}</p>
      </div>
      <div class="qb-how">
        <h2 class="qb-steps-title">{{ t('stepsTitle') }}</h2>
        <ol class="qb-steps">
          <li><span class="qb-step-n">1</span><span><strong>{{ t('step1') }}</strong>{{ t('step1d') }}</span></li>
          <li><span class="qb-step-n">2</span><span><strong>{{ t('step2') }}</strong>{{ t('step2d') }}</span></li>
          <li><span class="qb-step-n">3</span><span><strong>{{ t('step3') }}</strong>{{ t('step3d') }}</span></li>
        </ol>
      </div>

      <div class="qb-card" :class="isBuy ? 'is-buy' : 'is-sell'" data-testid="quick-buy-card">
        <div class="qb-tabs" role="tablist">
          <button type="button" role="tab" class="qb-tab" :class="{ active: isBuy }" :aria-selected="isBuy" @click="setSide('BUY')">{{ t('buy') }}</button>
          <button type="button" role="tab" class="qb-tab" :class="{ active: !isBuy }" :aria-selected="!isBuy" @click="setSide('SELL')">{{ t('sell') }}</button>
        </div>

        <p v-if="market.publicInfoError !== null" class="qb-state">{{ t('marketUnavailable') }}</p>
        <p v-else-if="market.publicInfo !== null && pairs.length === 0" class="qb-state">{{ t('noPairs') }}</p>
        <template v-else>
          <!-- Pay / sell field: the amount is the page's one big figure. -->
          <div class="qb-field qb-field-in" :class="{ invalid: amountError !== '' }">
            <div class="qb-field-head">
              <label class="qb-field-label" for="qb-amount">{{ isBuy ? t('spend') : t('sellAmount') }}</label>
              <span v-if="sessionStore.isAuthenticated" class="qb-avail" :title="available">
                {{ t('available', { amount: availableDisplay, coin: inputCoin }) }}
                <button type="button" class="qb-max" :disabled="available === '' || symbol === undefined" @click="fillMax">{{ t('max') }}</button>
              </span>
            </div>
            <div class="qb-field-row">
              <input
                id="qb-amount"
                class="qb-amount num"
                :class="amountSize"
                :value="amount"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                placeholder="0"
                :disabled="symbol === undefined"
                data-testid="quick-buy-amount"
                @input="onAmountInput"
              />
              <span v-if="isBuy" class="qb-unit"><CoinMark :symbol="QUOTE" :size="24" />{{ QUOTE }}</span>
              <div v-else class="qb-picker">
                <button type="button" class="qb-unit qb-coin-btn" :aria-expanded="pickerOpen" :aria-label="t('chooseCoin')" @click="togglePicker">
                  <CoinMark v-if="coin !== ''" :symbol="coin" :size="24" />{{ coin || '--' }}<ChevronDown :size="16" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div v-if="sessionStore.isAuthenticated" class="qb-ratios" role="group" :aria-label="t('ratioLabel')">
              <button
                v-for="ratio in QUICK_RATIOS"
                :key="ratio"
                type="button"
                class="qb-ratio"
                :disabled="available === '' || symbol === undefined"
                :data-testid="`quick-buy-ratio-${ratio}`"
                @click="fillRatio(ratio)"
              >{{ RATIO_LABEL[ratio] }}</button>
            </div>
            <p v-if="amountError !== ''" class="qb-error">{{ amountError }}</p>
            <p v-else-if="showShortcutNotice" class="qb-error" role="status" data-testid="quick-buy-notice">{{ shortcutNotice }}</p>
          </div>

          <div class="qb-field qb-field-out">
            <div class="qb-field-head"><span class="qb-field-label">{{ t('receive') }}</span></div>
            <div class="qb-field-row">
              <output class="qb-receive num" data-testid="quick-buy-receive">≈ {{ receiveDisplay }}</output>
              <div v-if="isBuy" class="qb-picker">
                <button type="button" class="qb-unit qb-coin-btn" :aria-expanded="pickerOpen" :aria-label="t('chooseCoin')" @click="togglePicker">
                  <CoinMark v-if="coin !== ''" :symbol="coin" :size="24" />{{ coin || '--' }}<ChevronDown :size="16" aria-hidden="true" />
                </button>
              </div>
              <span v-else class="qb-unit"><CoinMark :symbol="QUOTE" :size="24" />{{ QUOTE }}</span>
            </div>
          </div>

          <!-- One picker, opened from whichever field shows the coin. -->
          <div v-if="pickerOpen" class="qb-picker qb-picker-panel" role="dialog" :aria-label="t('chooseCoin')">
            <label class="qb-search"><Search :size="16" aria-hidden="true" /><input ref="pickerInput" v-model="pickerQuery" type="text" :placeholder="t('searchCoin')" /></label>
            <ul class="qb-coin-list">
              <li v-for="entry in pickerList" :key="entry.symbol">
                <button type="button" class="qb-coin-row" :class="{ active: entry.pair === symbol?.pair }" @click="choosePair(entry.pair)">
                  <CoinMark :symbol="entry.base" :size="24" />
                  <span class="qb-coin-name"><strong>{{ entry.base }}</strong><span>{{ entry.coin?.showName ?? entry.base }}</span></span>
                  <span class="qb-coin-last num">{{ lastOf(entry) }}</span>
                </button>
              </li>
              <li v-if="pickerList.length === 0" class="qb-coin-empty">{{ t('noCoin') }}</li>
            </ul>
          </div>

          <dl class="qb-meta">
            <div>
              <dt>{{ t('refPrice') }}</dt>
              <dd class="num">1 {{ coin || '--' }} ≈ {{ refDisplay }} {{ QUOTE }}</dd>
            </div>
            <div v-if="feePercent !== ''">
              <dt>{{ t('fee') }}</dt>
              <dd>{{ t('feeNote', { rate: feePercent }) }}</dd>
            </div>
          </dl>
          <p class="qb-note">
            {{ estimate.source === 'last' ? t('refLast') : estimate.partial ? t('thinBook') : t('estimateNote') }}
          </p>

          <button
            v-if="sessionStore.isAuthenticated"
            type="button"
            class="btn btn-primary btn-block qb-action"
            :disabled="!canSubmit"
            data-testid="quick-buy-submit"
            @click="openConfirm"
          >{{ t(isBuy ? 'buyCoin' : 'sellCoin', { coin }) }}</button>
          <template v-else>
            <RouterLink class="btn btn-primary btn-block qb-action" to="/login">{{ t(isBuy ? 'loginToBuy' : 'loginToSell') }}</RouterLink>
            <RouterLink class="qb-register" to="/register">{{ t('register') }}</RouterLink>
          </template>
          <p v-if="blockReason !== ''" class="qb-block" :class="{ pending: bookPending }" role="status">{{ blockReason }}</p>
        </template>
      </div>
    </section>

    <section class="qb-faq">
      <h2 class="qb-faq-title">{{ t('faqTitle') }}</h2>
      <div class="qb-faq-list">
        <details v-for="item in faqs" :key="item.index" class="qb-faq-item">
          <summary>{{ item.q }}<ChevronDown :size="18" aria-hidden="true" /></summary>
          <p>
            {{ item.a }}
            <RouterLink v-if="item.index === 3" to="/fees">{{ t('feesLink') }}</RouterLink>
            <RouterLink v-else-if="item.index === 4 && otcOpen" to="/otc">{{ t('c2cLink') }}</RouterLink>
            <RouterLink v-else-if="item.index === 5" to="/orders">{{ t('ordersLink') }}</RouterLink>
          </p>
        </details>
      </div>
    </section>

    <DialogShell :open="stage !== 'closed'" :title="stage === 'result' ? t('resultTitle') : t('confirmTitle')" width="420px" :close-label="t('cancel')" @close="closeDialog">
      <template v-if="stage === 'confirm' && draft !== null">
        <dl class="qb-confirm">
          <div><dt>{{ t('orderType') }}</dt><dd>{{ t('marketOrder') }} · {{ draft.side === 'BUY' ? t('buy') : t('sell') }} {{ draft.coin }}</dd></div>
          <div><dt>{{ t('pay') }}</dt><dd class="num">{{ show(draft.pay) }} {{ draft.payCoin }}</dd></div>
          <div><dt>{{ t('receive') }}</dt><dd class="num">≈ {{ show(draft.receive) }} {{ draft.receiveCoin }}</dd></div>
          <div><dt>{{ t('avgPrice') }}</dt><dd class="num">≈ {{ show(draft.avgPrice, quotePrecision) }} {{ QUOTE }}</dd></div>
        </dl>
        <p class="qb-note">{{ t('estimateNote') }}</p>
        <p v-if="submitError !== ''" class="qb-dialog-error" role="alert"><CircleAlert :size="16" aria-hidden="true" /><span><strong>{{ t('failed') }}</strong> {{ submitError }}</span></p>
      </template>
      <template v-else-if="stage === 'result' && result !== null && draft !== null">
        <div class="qb-result">
          <CircleCheck class="qb-result-icon" :size="36" :stroke-width="1.6" aria-hidden="true" />
          <dl class="qb-confirm">
            <div v-if="statusText !== ''"><dt>{{ t('resultStatus') }}</dt><dd>{{ statusText }}</dd></div>
            <template v-if="result.fill !== null && result.fill.baseQty !== '' && isPositive(result.fill.baseQty)">
              <div><dt>{{ t('resultFilled') }}</dt><dd class="num">{{ show(result.fill.baseQty) }} {{ draft.coin }}</dd></div>
              <div v-if="result.fill.quoteQty !== ''"><dt>{{ t('resultSpent') }}</dt><dd class="num">{{ show(result.fill.quoteQty, quotePrecision) }} {{ QUOTE }}</dd></div>
              <div v-if="result.fill.avgPrice !== ''"><dt>{{ t('resultAvg') }}</dt><dd class="num">{{ show(result.fill.avgPrice, quotePrecision) }} {{ QUOTE }}</dd></div>
            </template>
          </dl>
          <p v-if="result.loading" class="qb-note">{{ t('resultPending') }}</p>
          <p v-else-if="!result.statusCurrent" class="qb-note" role="status">{{ t('resultStatusUnknown') }}</p>
          <p v-else-if="!isFinalQuickOrderStatus(result.status)" class="qb-note" role="status">{{ t('resultOngoing') }}</p>
          <p v-else-if="result.fill === null || !isPositive(result.fill.baseQty)" class="qb-note">{{ t('resultNoFills') }}</p>
          <button v-if="!result.loading && (!result.statusCurrent || !isFinalQuickOrderStatus(result.status))" type="button" class="btn btn-ghost" data-testid="quick-buy-refresh-result" @click="readFill">{{ t('resultRefresh') }}</button>
        </div>
      </template>
      <template #footer>
        <template v-if="stage === 'confirm'">
          <button type="button" class="btn" :disabled="orders.submitting" @click="closeDialog">{{ t('cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="orders.submitting" data-testid="quick-buy-confirm" @click="place">{{ orders.submitting ? t('placing') : t('confirm') }}</button>
        </template>
        <template v-else>
          <RouterLink class="btn" to="/orders">{{ t('viewOrders') }}</RouterLink>
          <button type="button" class="btn btn-primary" @click="closeDialog">{{ t('again') }}</button>
        </template>
      </template>
    </DialogShell>
  </div>
</template>
