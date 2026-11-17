<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { isFeatureEnabled } from '@/core/feature-flags'
import { BarChart3, CandlestickChart, WifiOff } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import ChartPanel from '@/components/trade/ChartPanel.vue'
import OrderBook from '@/components/trade/OrderBook.vue'
import TradesPanel from '@/components/trade/TradesPanel.vue'
import { MARKET_SOURCE } from '@/components/trade/market-source'
import { useTerminalFit } from '@/components/trade/terminal-fit'
import FuturesAccountPanel from '@/components/futures/FuturesAccountPanel.vue'
import FuturesContractPicker from '@/components/futures/FuturesContractPicker.vue'
import FuturesOrderPanel from '@/components/futures/FuturesOrderPanel.vue'
import FuturesOrdersTabs from '@/components/futures/FuturesOrdersTabs.vue'
import FuturesTickerBar from '@/components/futures/FuturesTickerBar.vue'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { countdownText, fundingRateView, nextFundingTime } from '@/modules/futures/math'
import { createSizedMarketSource } from '@/modules/futures/sized-market-source'
import { bookSuggestion, type BookPick, type PriceSuggestion } from '@/modules/trade/book-fill'
import { useSizeUnit } from '@/modules/futures/size-unit'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesLiveStore } from '@/stores/futures-live'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useSessionStore } from '@/stores/session'

/**
 * USDT-margined perpetual terminal (layout contract: comment block in views/TradeView.vue; Binance futures arrangement
 * 'header header form' / 'chart book form' / 'orders orders account'). Same widgets as the spot terminal: the shared order
 * book, depth chart, recent trades and chart read the futures market store through `MARKET_SOURCE`.
 */
const { t } = useFuturesI18n()
const market = useFuturesMarketStore()
const account = useFuturesAccountStore()
/** User data stream (listenKey + socket): positions, balances, open orders and fills are pushed (2026-10-01). */
const live = useFuturesLiveStore()
const sessionStore = useSessionStore()
provide(MARKET_SOURCE, createSizedMarketSource(market, useSizeUnit(), () => market.currentContract, () => t('fut.contracts')))

/** Binance web: 订单簿 | 最新成交 are tabs of the left column (2026-09-30; the trades card under the account overflowed). */
const bookTab = ref<'book' | 'trades'>('book')
const priceSuggestion = ref<PriceSuggestion>()
/**
 * Book click: price, plus (for a level) the cumulative size in whole contracts, read from the raw store (the book
 * shows the chosen size unit, the store keeps contracts; both hold the same levels in the same order).
 */
function selectPrice(price: string, pick?: BookPick): void {
  priceSuggestion.value = bookSuggestion(priceSuggestion.value, price, pick, { asks: market.asks, bids: market.buys })
}

/** Phones: the chart is hidden by default and toggled from the top-bar candle button. */
const chartOpen = ref(false)
const tradingOpen = isFeatureEnabled('futuresTrading')
function tradeFromChart(): void {
  chartOpen.value = false
  window.scrollTo({ top: 0 })
}

/** Order book drops to the compact H5 form at the phone breakpoint (matches the CSS `max-width: 768px`). */
const compactBook = ref(typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)
let compactQuery: MediaQueryList | null = null
const onCompactChange = (event: MediaQueryListEvent): void => { compactBook.value = event.matches }

/** Funding rate + settlement countdown for the compact book header (reuses the ticker-bar maths). */
const clock = ref(market.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
const funding = computed(() => fundingRateView(market.marketInfo.currentFundRate))
const fundingCountdown = computed(() => {
  const contract = market.currentContract
  const target = nextFundingTime(clock.value, contract?.capitalStartTime ?? null, contract?.capitalFrequency ?? null)
  return countdownText(target, clock.value)
})

const ready = computed(() => market.loaded && market.currentContract !== undefined)
const feedDown = computed(() => market.connectionState !== 'open' && market.bookConnectionState !== 'open')

let active = true

async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    return
  }
  if (!active) return
  market.start()
  if (sessionStore.isAuthenticated) {
    await account.refresh()
    if (!active) return
    account.startPolling()
    live.start()
  }
}

watch(() => sessionStore.isAuthenticated, (signedIn) => {
  if (signedIn && ready.value) {
    void account.refresh().then(() => { if (active) live.start() })
    account.startPolling()
  } else if (!signedIn) {
    live.stop({ logout: true })
    account.reset()
  }
})

watch(() => market.selectedName, (next, previous) => {
  if (previous !== undefined && previous !== '' && next !== previous && sessionStore.isAuthenticated) void account.loadConfig()
})

/** Coming back online after a failed load retries by itself instead of leaving the error up. */
function retryWhenOnline(): void {
  if (market.error !== null) void bootstrap()
}

/** OKX skin: pair bar + chart / book / ticket row fill the viewport (terminal-fit.ts). */
const terminalRoot = ref<HTMLElement>()
useTerminalFit(terminalRoot, ['.terminal__header', '.terminal__notice'])

onMounted(() => {
  window.addEventListener('online', retryWhenOnline)
  compactQuery = window.matchMedia('(max-width: 768px)')
  compactBook.value = compactQuery.matches
  compactQuery.addEventListener('change', onCompactChange)
  clockTimer = setInterval(() => { clock.value = market.now() }, 1000)
  void bootstrap()
})
onBeforeUnmount(() => {
  active = false
  if (clockTimer !== null) clearInterval(clockTimer)
  compactQuery?.removeEventListener('change', onCompactChange)
  window.removeEventListener('online', retryWhenOnline)
  account.stopPolling()
  live.stop()
  market.disconnect()
})
</script>

<template>
  <div ref="terminalRoot" class="trade-page terminal terminal--futures" :class="{ 'chart-open': chartOpen }">
    <section class="top-bar terminal__header">
      <FuturesContractPicker />
      <span class="top-divider" aria-hidden="true"></span>
      <FuturesTickerBar />
      <RouterLink class="data-link" to="/futures/data" :title="t('fut.data')"><BarChart3 :size="15" /><span>{{ t('fut.data') }}</span></RouterLink>
      <button class="chart-toggle" type="button" :aria-pressed="chartOpen" :title="t('fut.chart')" :aria-label="t('fut.chart')" @click="chartOpen = !chartOpen"><CandlestickChart :size="18" /></button>
    </section>

    <StateBlock v-if="market.error !== null" class="terminal__state" variant="error" :message="`${t('fut.loadFailed')}：${market.error}`" retryable @retry="bootstrap" />
    <StateBlock v-else-if="!ready && market.loading" class="terminal__state" variant="loading" :message="market.retry > 0 ? t('common.retrying', { n: market.retry, max: 2 }) : t('common.loading')" />
    <StateBlock v-else-if="!ready && market.loaded" class="terminal__state" variant="empty" :message="t('fut.noContracts')" />
    <StateBlock v-else-if="!ready" class="terminal__state" variant="loading" :message="t('common.loading')" />

    <template v-else>
      <p v-if="feedDown" class="feed-notice terminal__notice" role="status"><WifiOff :size="14" aria-hidden="true" /><b>{{ market.connectionState === 'connecting' ? t('fut.wsConnecting') : t('fut.wsDisconnected') }}</b><span>{{ t('fut.wsHint') }}</span></p>
      <section class="cell chart-cell terminal__chart">
        <ChartPanel :scales="market.klineScales" :scale="market.klineScale" @scale="market.setKlineScale" />
      </section>

      <div class="cell book-cell terminal__book">
        <div v-if="market.currentContract" class="funding-block">
          <span class="funding-label">{{ t('fut.h5.fundingCountdownLabel', { interval: market.currentContract.capitalFrequency ?? 8 }) }}</span>
          <span class="funding-value">
            <span class="num rate" :class="funding.direction">{{ funding.text }}</span>
            <span class="sep">/</span>
            <span class="cd num">{{ fundingCountdown }}</span>
          </span>
        </div>
        <div class="book-tabs" role="tablist">
          <button class="book-tab" :class="{ active: bookTab === 'book' }" role="tab" type="button" :aria-selected="bookTab === 'book'" data-testid="fut-book-tab-book" @click="bookTab = 'book'">{{ t('trade.orderBook') }}</button>
          <button class="book-tab" :class="{ active: bookTab === 'trades' }" role="tab" type="button" :aria-selected="bookTab === 'trades'" data-testid="fut-book-tab-trades" @click="bookTab = 'trades'">{{ t('trade.recentTrades') }}</button>
        </div>
        <div v-show="bookTab === 'book'" class="book-pane"><OrderBook :book-state="market.bookConnectionState" :compact="compactBook" @price="selectPrice" /></div>
        <div v-show="bookTab === 'trades'" class="book-pane trades-pane"><TradesPanel /></div>
      </div>

      <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
      <div class="cell form-cell terminal__form"><FuturesOrderPanel :price-suggestion="priceSuggestion" /></div>

      <aside class="side-cell terminal__account">
        <div class="cell account-cell"><FuturesAccountPanel /></div>
      </aside>

      <div class="cell orders-cell terminal__orders"><FuturesOrdersTabs /></div>

      <div v-if="chartOpen && tradingOpen" class="chart-actions">
        <button class="chart-action buy" type="button" data-testid="fchart-long" @click="tradeFromChart">{{ t('fut.openLong') }}</button>
        <button class="chart-action sell" type="button" data-testid="fchart-short" @click="tradeFromChart">{{ t('fut.openShort') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * Binance futures layout: the ticket is a full-height right column beside the ticker bar and the chart, the book sits
 * between chart and ticket, positions/orders below with the contract account on the right. The ticket (its reserved
 * height keeps it from jumping) sets the height of the first two rows; the book never grows them.
 * Contract: views/TradeView.vue.
 */
.terminal {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px 330px;
  /* The chart row is the flexible one: the full-height ticket's extra height goes there, never into the pair bar. */
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    'header header form'
    'notice notice form'
    'chart  book   form'
    'orders orders account';
  gap: 4px;
  min-width: 0;
  width: 100%;
  padding: 4px;
  background: var(--color-bg);
}
.terminal__header { grid-area: header; }
.terminal__notice { grid-area: notice; }
.terminal__chart { grid-area: chart; }
.terminal__book { grid-area: book; }
.terminal__form { grid-area: form; }
.terminal__account { grid-area: account; }
.terminal__orders { grid-area: orders; }
.terminal__state { grid-column: 1 / -1; }

.top-bar { display: flex; align-items: center; gap: 18px; min-height: 64px; padding: 6px 16px 6px 8px; border-radius: 8px; background: var(--color-surface); min-width: 0; }
.top-divider { width: 1px; height: 32px; background: var(--color-border); flex: 0 0 1px; }
.data-link { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; height: 30px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: 6px; color: var(--color-text-secondary); font-size: 12px; font-weight: 600; white-space: nowrap; }
.data-link:hover { color: var(--color-accent-text); border-color: var(--color-accent); }
/* Phone-only candle button (hidden on desktop). */
.chart-toggle { display: none; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-text-secondary); }
.chart-toggle:hover { color: var(--color-accent-text); background: var(--color-hover); }
.chart-toggle[aria-pressed='true'] { color: var(--color-accent-text); background: var(--color-accent-soft); }
/* Compact-book funding header (futures, phones only). */
.funding-block { display: none; flex-direction: column; gap: 2px; padding: 7px 10px 6px; border-bottom: 1px solid var(--color-border); }
.funding-label { color: var(--color-text-muted); font-size: 11px; text-decoration: underline dotted var(--color-text-muted); text-underline-offset: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.funding-value { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 650; white-space: nowrap; }
.funding-value .rate.up { color: var(--color-up); }
.funding-value .rate.down { color: var(--color-down); }
.funding-value .sep { color: var(--color-text-muted); }
.funding-value .cd { color: var(--color-accent-text); }
.feed-notice { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 14px; border-radius: 8px; background: var(--color-warning-soft); color: var(--color-warning); font-size: 12px; }
.feed-notice b { white-space: nowrap; }
.feed-notice span { color: var(--color-text-secondary); }

.cell { min-width: 0; overflow: hidden; border-radius: 8px; background: var(--color-surface); }
.chart-cell { display: flex; flex-direction: column; min-height: 520px; }
.chart-cell > * { flex: 1 1 auto; }
.book-cell { display: flex; flex-direction: column; min-height: 0; }
.book-tabs { display: flex; gap: 18px; flex: 0 0 40px; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
.book-tab { position: relative; height: 40px; padding: 0; color: var(--color-text-muted); font-size: 14px; font-weight: 600; }
.book-tab.active { color: var(--color-text); }
.book-tab.active::after { content: ''; position: absolute; left: 20%; right: 20%; bottom: -1px; height: 3px; border-radius: 2px; background: var(--color-accent); }
.book-pane { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.book-pane > :deep(*) { flex: 1 1 auto; min-height: 0; }
/* The tab names the pane: the pane's own title would repeat it. */
.book-cell :deep(.book-title), .book-cell :deep(.trades-title) { display: none; }
.side-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.account-cell { flex: 0 0 auto; }
.orders-cell { min-height: 280px; }

@media (min-width: 769px) {
  /* The ticket sets the first rows' height; the book never grows them. */
  .book-cell { contain: size; }
}
@media (max-width: 1360px) {
  .terminal { grid-template-columns: minmax(0, 1fr) 260px 320px; }
}
@media (max-width: 1180px) {
  .terminal { grid-template-columns: minmax(0, 1fr) 230px 300px; }
  .chart-cell { min-height: 420px; }
  /* 300px ticket: the One-way split hint + 止盈止损 wrap one line more (ui.mjs heights at 1024×768). */
  .form-cell { --fop-body-min: 648px; }
}
@media (max-width: 768px) {
  .terminal {
    grid-template-columns: minmax(0, 55fr) minmax(0, 45fr);
    grid-template-rows: none;
    grid-template-areas:
      'header header'
      'notice notice'
      'form book'
      'chart chart'
      'orders orders';
    padding: 0;
    gap: 0;
  }
  .top-bar { gap: 8px; padding: 8px 10px; border-radius: 0; border-bottom: 1px solid var(--color-border); }
  .top-divider { display: none; }
  .data-link { display: none; }
  /* Phones (owner 2026-11-17): last price + 24h change beside the contract; everything else lives in the chart view. */
  .top-bar :deep(.fticker-shell) { flex: 0 1 auto; min-width: 0; margin-left: auto; }
  .top-bar :deep(.fticker) { display: flex; flex-direction: column; align-items: flex-end; gap: 0; overflow: visible; padding: 0; }
  .top-bar :deep(.fticker-main) { align-items: flex-end; }
  .top-bar :deep(.fticker-main .last-price) { font-size: 17px; }
  .top-bar :deep(.fticker-main .feed) { display: none; }
  .top-bar :deep(.fticker-stats) { display: block; margin: 0; }
  .top-bar :deep(.fticker-stats .stat) { display: none; }
  .top-bar :deep(.fticker-stats .stat:nth-child(5)) { display: block; }
  .top-bar :deep(.fticker-stats .stat:nth-child(5) dt) { display: none; }
  .top-bar :deep(.fticker-stats .stat:nth-child(5) dd) { margin: 0; font-size: 11px; text-align: right; }
  .chart-toggle { display: inline-flex; margin-left: 4px; }
  .feed-notice { border-radius: 0; flex-wrap: wrap; }

  .cell { border-radius: 0; }
  .chart-cell { display: none; min-height: 0; height: 360px; border-bottom: 1px solid var(--color-border); }
  .terminal.chart-open .chart-cell { display: flex; }
  .form-cell { border-right: 1px solid var(--color-border); }
  .book-cell { display: flex; flex-direction: column; min-height: 0; }
  .book-cell :deep(.book) { flex: 1 1 auto; min-height: 0; height: auto; }
  /* Phones: the compact book only (trades stay hidden on H5, as before). */
  .book-tabs, .trades-pane { display: none !important; }
  .book-pane:not(.trades-pane) { display: flex !important; }
  .funding-block { display: flex; }
  .side-cell { display: none; }
  .orders-cell { border-top: 1px solid var(--color-border); }

  /* Chart view: full-width chart with the mark / index / funding figures, the book below, 开多 / 开空 pinned. */
  .terminal.chart-open { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'header' 'notice' 'chart' 'book'; padding-bottom: 84px; }
  .terminal.chart-open .form-cell, .terminal.chart-open .orders-cell { display: none; }
  .terminal.chart-open .chart-cell { height: 54vh; min-height: 340px; }
  .terminal.chart-open .top-bar { flex-wrap: wrap; row-gap: 6px; }
  .terminal.chart-open .top-bar :deep(.fticker-shell) { order: 5; flex: 1 1 100%; margin-left: 0; }
  .terminal.chart-open .top-bar :deep(.fticker) { flex-direction: row; align-items: center; gap: 16px; overflow-x: auto; }
  .terminal.chart-open .top-bar :deep(.fticker-main .last-price) { font-size: 24px; }
  .terminal.chart-open .top-bar :deep(.fticker-stats) { display: flex; gap: 14px; }
  .terminal.chart-open .top-bar :deep(.fticker-stats .stat), .terminal.chart-open .top-bar :deep(.fticker-stats .stat:nth-child(5)) { display: block; flex: 0 0 auto; }
  .terminal.chart-open .top-bar :deep(.fticker-stats .stat dt), .terminal.chart-open .top-bar :deep(.fticker-stats .stat:nth-child(5) dt) { display: block; font-size: 10px; white-space: nowrap; }
  .terminal.chart-open .top-bar :deep(.fticker-stats .stat dd), .terminal.chart-open .top-bar :deep(.fticker-stats .stat:nth-child(5) dd) { margin: 0; font-size: 11.5px; text-align: left; white-space: nowrap; }
  .terminal.chart-open .top-bar .chart-toggle { margin-left: auto; }
  .chart-actions { position: fixed; left: 0; right: 0; bottom: var(--mobile-tabbar-h, 0px); z-index: 40; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 8px 12px 22px; border-top: 1px solid var(--color-border); background: var(--color-bg); }
  .chart-action { height: 42px; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 700; }
  .chart-action.buy { background: var(--color-up); }
  .chart-action.sell { background: var(--color-down); }
}
.chart-actions { display: none; }
@media (max-width: 768px) { .chart-actions { display: grid; } }
</style>
