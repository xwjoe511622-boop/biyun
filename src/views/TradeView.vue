<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CandlestickChart } from '@lucide/vue'
import ExtensionSlot from '@/components/common/ExtensionSlot.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import BalancePanel from '@/components/trade/BalancePanel.vue'
import BookTradesTabs from '@/components/trade/BookTradesTabs.vue'
import ChartPanel from '@/components/trade/ChartPanel.vue'
import OrderBook from '@/components/trade/OrderBook.vue'
import SpotOrderPanel from '@/components/trade/SpotOrderPanel.vue'
import OrdersTabs from '@/components/trade/OrdersTabs.vue'
import PairListPanel from '@/components/trade/PairListPanel.vue'
import SymbolPicker from '@/components/trade/SymbolPicker.vue'
import TickerBar from '@/components/trade/TickerBar.vue'
import TradesPanel from '@/components/trade/TradesPanel.vue'
import { useTerminalFit } from '@/components/trade/terminal-fit'
import { SKIN } from '@/core/skin'
import { session } from '@/core/session'
import { bookSuggestion, type BookPick, type PriceSuggestion } from '@/modules/trade/book-fill'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore } from '@/stores/orders'
import { useSessionStore } from '@/stores/session'
import { useSpotLiveStore } from '@/stores/spot-live'

const { t } = useI18n()
const market = useMarketStore()
const account = useAccountStore()
const orders = useOrdersStore()
const sessionStore = useSessionStore()
const spotLive = useSpotLiveStore()
const priceSuggestion = ref<PriceSuggestion>()
/** Book click: price, plus (for a level) the cumulative base amount for the ticket that takes it (`book-fill.ts`). */
function selectPrice(price: string, pick?: BookPick): void {
  priceSuggestion.value = bookSuggestion(priceSuggestion.value, price, pick, { asks: market.asks, bids: market.buys })
}

/** OKX skin: pair bar + chart + ticket fill the viewport (terminal-fit.ts); the chart row takes what is left. */
const terminalRoot = ref<HTMLElement>()
useTerminalFit(terminalRoot, ['.terminal__header', '.terminal__form'])

/** Phones: the chart is hidden by default and toggled from the top-bar candle button. */
const chartOpen = ref(false)
/** Phone chart view: 买入 / 卖出 at the bottom return to the ticket on that side. */
const sideRequest = ref<{ side: 'BUY' | 'SELL'; at: number } | undefined>(undefined)
function tradeFromChart(side: 'BUY' | 'SELL'): void {
  sideRequest.value = { side, at: Date.now() }
  chartOpen.value = false
  window.scrollTo({ top: 0 })
}

/** Order book drops to the compact H5 form at the phone breakpoint (matches the CSS `max-width: 768px`). */
const compactBook = ref(typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)
let compactQuery: MediaQueryList | null = null
const onCompactChange = (event: MediaQueryListEvent): void => { compactBook.value = event.matches }

const ready = computed(() => market.publicInfo !== null && market.currentSymbol !== undefined)

let stopStream: (() => void) | null = null

async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    return
  }
  if (stopStream === null) return
  market.resubscribe()
  if (session.isAuthenticated()) {
    spotLive.start()
    await Promise.all([account.load(), orders.refreshAll()])
  }
}

onMounted(() => {
  compactQuery = window.matchMedia('(max-width: 768px)')
  compactBook.value = compactQuery.matches
  compactQuery.addEventListener('change', onCompactChange)
  // The review stream starts at once; the pair channels follow as soon as public info is known.
  stopStream = market.start('terminal')
  void bootstrap()
})

// Open orders can fill or be cancelled without any action on this page. With the spot user stream live
// (`stores/spot-live.ts`) the stream says so at once and nothing is polled; without it (unavailable, reconnecting),
// re-read them every 5 s while the tab is visible and there is something open, so a filled order never lingers.
const openPoll = setInterval(() => {
  if (orders.live || !session.isAuthenticated() || document.visibilityState !== 'visible' || orders.openOrders.length === 0) return
  void orders.refreshAfterAction('open', 'trades', 'account')
}, 5000)

// Sign-in on this page starts the stream; sign-out / account switch is handled by the store itself.
watch(() => sessionStore.isAuthenticated, (authenticated) => { if (authenticated) spotLive.start() })

onBeforeUnmount(() => {
  clearInterval(openPoll)
  spotLive.stop()
  compactQuery?.removeEventListener('change', onCompactChange)
  stopStream?.()
  stopStream = null
})
</script>

<!--
  Terminal layout contract (spot /trade, margin /margin, futures /futures; owner 10-21, two skins share one markup).
  Every terminal is ONE CSS grid on `.terminal` (+ `.terminal--spot` | `.terminal--margin` | `.terminal--futures`).
  Each area is a direct child with a stable class; a skin re-arranges them with grid-template-areas/columns/rows only:
    area      class               content
    header    .terminal__header   pair picker + 24h ticker bar (futures: mark / index / funding + countdown)
    book      .terminal__book     order book (futures: order book | market trades tabs)
    chart     .terminal__chart    ChartPanel: interval toolbar, K-line / depth
    pairs     .terminal__pairs    PairListPanel: search, favorites / quote tabs, pair list (spot, margin)
    trades    .terminal__trades   market trades (spot, margin)
    form      .terminal__form     order entry (spot/margin: buy + sell side by side; futures: ticket column)
    orders    .terminal__orders   bottom tabs: open orders / history / trades (futures: positions …)
    account   .terminal__account  balances or guest sign-in (futures: contract account)
  State blocks (loading / error) render as `.terminal__state` spanning all columns.
  Default arrangement = Binance (scoped styles below; restated for the Binance skin in styles/skin-binance-terminal.css):
    spot / margin  'header header pairs' 'book chart pairs' 'book form trades' 'orders orders account'
    futures        'header header form' 'chart book form' 'orders orders account'
  ≤1180px: two columns; ≤768px (phones): 'header' / 'form book' / 'chart' / 'orders' (chart behind the top-bar toggle).
-->
<template>
  <div ref="terminalRoot" class="trade-page terminal terminal--spot" :class="{ 'chart-open': chartOpen }">
    <section class="top-bar terminal__header">
      <SymbolPicker />
      <span class="top-divider" aria-hidden="true"></span>
      <TickerBar :compact="compactBook && SKIN === 'binance'" />
      <button class="chart-toggle" type="button" :aria-pressed="chartOpen" :title="t('trade.chart')" :aria-label="t('trade.chart')" @click="chartOpen = !chartOpen"><CandlestickChart :size="18" /></button>
    </section>

    <StateBlock
      v-if="market.publicInfoError !== null"
      class="terminal__state"
      variant="error"
      :message="market.publicInfoError"
      retryable
      @retry="bootstrap"
    />
    <StateBlock v-else-if="!ready && market.publicInfoLoading" class="terminal__state" variant="loading" :message="market.publicInfoRetry > 0 ? t('common.retrying', { n: market.publicInfoRetry, max: 2 }) : t('common.loading')" />
    <StateBlock v-else-if="!ready" class="terminal__state" variant="error" :message="t('trade.marketUnavailable')" retryable @retry="bootstrap" />

    <template v-else>
      <section class="cell chart-cell terminal__chart">
        <ChartPanel :scales="market.klineScales" :scale="market.klineScale" @scale="market.setKlineScale" />
      </section>

      <div class="cell book-cell terminal__book">
        <!-- OKX skin: book and trades are two tabs of one full-height panel; Binance keeps them as separate areas. -->
        <BookTradesTabs v-if="SKIN === 'okx'" :compact="compactBook" @price="selectPrice" />
        <OrderBook v-else :compact="compactBook" @price="selectPrice" />
      </div>

      <div class="cell form-cell terminal__form">
        <ExtensionSlot slot="trade.aboveChart" />
        <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
        <SpotOrderPanel :price-suggestion="priceSuggestion" :side-request="sideRequest" />
      </div>

      <div class="cell pairs-cell terminal__pairs"><PairListPanel /></div>
      <div v-if="SKIN !== 'okx'" class="cell trades-cell terminal__trades"><TradesPanel /></div>

      <aside class="side-cell terminal__account">
        <div v-if="sessionStore.isAuthenticated" class="cell"><BalancePanel /></div>
        <div v-else class="cell guest-cell">
          <p>{{ t('trade.loginOrRegister') }}</p>
          <div class="guest-actions">
            <RouterLink class="btn btn-primary" to="/register">{{ t('trade.register') }}</RouterLink>
            <RouterLink class="btn" to="/login">{{ t('nav.login') }}</RouterLink>
          </div>
        </div>
        <ExtensionSlot slot="trade.sidebar" />
      </aside>

      <div class="cell orders-cell terminal__orders"><OrdersTabs /></div>

      <div v-if="chartOpen" class="chart-actions">
        <button class="chart-action buy" type="button" data-testid="chart-buy" @click="tradeFromChart('BUY')">{{ t('common.buy') }}</button>
        <button class="chart-action sell" type="button" data-testid="chart-sell" @click="tradeFromChart('SELL')">{{ t('common.sell') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Layout contract: see the comment block above <template>. */
.terminal {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr) 320px;
  grid-template-rows: auto 540px auto auto;
  grid-template-areas:
    'header header pairs'
    'book   chart  pairs'
    'book   form   trades'
    'orders orders account';
  gap: 4px;
  min-width: 0;
  width: 100%;
  padding: 4px;
  background: var(--color-bg);
}
.terminal__header { grid-area: header; }
.terminal__chart { grid-area: chart; }
.terminal__book { grid-area: book; }
.terminal__form { grid-area: form; }
.terminal__pairs { grid-area: pairs; }
.terminal__trades { grid-area: trades; }
.terminal__account { grid-area: account; }
.terminal__orders { grid-area: orders; }
.terminal__state { grid-column: 1 / -1; }

.top-bar {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 64px;
  padding: 6px 16px 6px 8px;
  border-radius: 8px;
  background: var(--color-surface);
  min-width: 0;
}
.top-divider { width: 1px; height: 32px; background: var(--color-border); flex: 0 0 1px; }
/* Phone-only candle button (hidden on desktop). */
.chart-toggle { display: none; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 8px; color: var(--color-text-secondary); }
.chart-toggle:hover { color: var(--color-accent-text); background: var(--color-hover); }
.chart-toggle[aria-pressed='true'] { color: var(--color-accent-text); background: var(--color-accent-soft); }

.cell { min-width: 0; overflow: hidden; border-radius: 8px; background: var(--color-surface); }
.chart-cell { display: flex; flex-direction: column; min-height: 0; }
.chart-cell > * { flex: 1 1 auto; }
.book-cell { min-height: 0; }
.side-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 0; }
.orders-cell { min-height: 280px; }

.guest-cell { display: flex; flex-direction: column; align-items: stretch; gap: 12px; padding: 18px 14px; text-align: center; }
.guest-cell p { margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.guest-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.guest-actions .btn { height: 36px; }

/* Book, pair list and trades take the height of the rows the chart and form set instead of stretching them. */
@media (min-width: 1181px) {
  .book-cell, .pairs-cell, .trades-cell { contain: size; }
}

@media (max-width: 1360px) {
  .terminal { grid-template-columns: 290px minmax(0, 1fr) 290px; }
}

@media (max-width: 1180px) {
  .terminal {
    grid-template-columns: minmax(0, 1fr) 290px;
    grid-template-rows: auto 480px auto auto auto auto;
    grid-template-areas:
      'header header'
      'chart  book'
      'form   book'
      'pairs  trades'
      'orders orders'
      'account account';
  }
  .book-cell { contain: size; }
  .pairs-cell, .trades-cell { height: 360px; }
}

@media (max-width: 768px) {
  .terminal {
    grid-template-columns: minmax(0, 55fr) minmax(0, 45fr);
    grid-template-rows: none;
    grid-template-areas:
      'header header'
      'form book'
      'chart chart'
      'orders orders';
    padding: 0;
    gap: 0;
  }
  .top-bar { gap: 8px; padding: 8px 10px; border-radius: 0; border-bottom: 1px solid var(--color-border); }
  .top-divider { display: none; }
  .top-bar:has(.mobile-ticker) { flex-wrap: wrap; }
  .top-bar :deep(.ticker) { display: none; }
  /* OKX skin: keep last price + 24h change beside the pair (stats stay in the chart view). */
  .top-bar :deep(.okx-ticker) { display: flex; flex: 0 1 auto; min-width: 0; margin-left: auto; }
  .top-bar :deep(.okx-ticker .ticker-stats), .top-bar :deep(.okx-ticker .ticker-status) { display: none; }
  .top-bar :deep(.okx-ticker .ticker-main) { align-items: flex-end; text-align: right; }
  .top-bar :deep(.okx-ticker .last-price) { font-size: 17px; }
  .top-bar :deep(.okx-ticker .change-line) { font-size: 11px; }
  .top-bar:has(.okx-ticker) .chart-toggle { margin-left: 4px; }
  .chart-toggle { display: inline-flex; margin-left: auto; }

  .cell { border-radius: 0; }
  .chart-cell { display: none; height: 360px; border-bottom: 1px solid var(--color-border); }
  .terminal.chart-open .chart-cell { display: flex; }
  .form-cell { border-right: 1px solid var(--color-border); }
  .book-cell { display: flex; flex-direction: column; min-height: 0; contain: none; }
  /* Seven levels a side (20 px rows). */
  .terminal:not(.chart-open) .book-cell { min-height: 478px; }
  .book-cell :deep(.book) { flex: 1 1 auto; min-height: 0; height: auto; }
  .pairs-cell, .trades-cell, .side-cell { display: none; }
  .orders-cell { border-top: 1px solid var(--color-border); }

  /* Chart view (owner 2026-11-17): the candle button swaps the ticket for a full market view — price and 24h
     figures, a tall chart, the book and trades below, and 买入 / 卖出 pinned above the navigation. */
  .terminal.chart-open { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'header' 'chart' 'book'; padding-bottom: 84px; }
  .terminal.chart-open .form-cell, .terminal.chart-open .orders-cell { display: none; }
  .terminal.chart-open .chart-cell { height: 54vh; min-height: 340px; }
  .terminal.chart-open .top-bar { flex-wrap: wrap; row-gap: 6px; }
  .terminal.chart-open .top-bar :deep(.okx-ticker) { order: 5; flex: 1 1 100%; align-items: flex-end; justify-content: space-between; gap: 12px; margin-left: 0; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .ticker-main) { align-items: flex-start; text-align: left; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .last-price) { font-size: 26px; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .change-line) { font-size: 12px; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .ticker-stats) { display: grid; grid-template-columns: repeat(2, auto); gap: 4px 14px; margin: 0; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .ticker-stats .stat) { display: flex; flex-direction: column; gap: 0; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .ticker-stats dt) { font-size: 10px; white-space: nowrap; }
  .terminal.chart-open .top-bar :deep(.okx-ticker .ticker-stats dd) { margin: 0; font-size: 11.5px; }
  .terminal.chart-open .top-bar .chart-toggle { margin-left: auto; }
  .chart-actions { position: fixed; left: 0; right: 0; bottom: var(--mobile-tabbar-h, 0px); z-index: 40; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 8px 12px 22px; border-top: 1px solid var(--color-border); background: var(--color-bg); }
  .chart-action { height: 42px; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 700; }
  .chart-action.buy { background: var(--color-up); }
  .chart-action.sell { background: var(--color-down); }
}
.chart-actions { display: none; }
@media (max-width: 768px) { .chart-actions { display: grid; } }
</style>
