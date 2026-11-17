<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CandlestickChart, Landmark } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import ChartPanel from '@/components/trade/ChartPanel.vue'
import OrderBook from '@/components/trade/OrderBook.vue'
import PairListPanel from '@/components/trade/PairListPanel.vue'
import TickerBar from '@/components/trade/TickerBar.vue'
import TradesPanel from '@/components/trade/TradesPanel.vue'
import BookTradesTabs from '@/components/trade/BookTradesTabs.vue'
import { useTerminalFit } from '@/components/trade/terminal-fit'
import { SKIN } from '@/core/skin'
import BorrowDialog from '@/components/margin/BorrowDialog.vue'
import MarginAccountPanel from '@/components/margin/MarginAccountPanel.vue'
import MarginOrderPanel from '@/components/margin/MarginOrderPanel.vue'
import MarginPairPicker from '@/components/margin/MarginPairPicker.vue'
import MarginRecordsTabs from '@/components/margin/MarginRecordsTabs.vue'
import RepayDialog from '@/components/margin/RepayDialog.vue'
import TransferDialog from '@/components/transfer/TransferDialog.vue'
import { useMarginI18n } from '@/modules/margin/i18n'
import { useMarginStore } from '@/stores/margin'
import { useMarginOrdersStore } from '@/stores/marginOrders'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

/**
 * Margin (杠杆) terminal (layout contract: comment block in views/TradeView.vue; same arrangement as spot). Lever orders match in the spot engine, so the K-line, depth, book and trades
 * come from the same spot market store and components as /trade; only pairs with `is_open_lever`
 * are selectable. Account, orders and loans use the lever/* endpoints (see `@/modules/margin/api`).
 */
const { t } = useMarginI18n()
const market = useMarketStore()
const margin = useMarginStore()
const marginOrders = useMarginOrdersStore()
const sessionStore = useSessionStore()

/** OKX skin: pair bar + chart + ticket fill the viewport (terminal-fit.ts). */
const terminalRoot = ref<HTMLElement>()
useTerminalFit(terminalRoot, ['.terminal__header', '.terminal__form'])

const chartOpen = ref(false)
function tradeFromChart(): void {
  chartOpen.value = false
  window.scrollTo({ top: 0 })
}
// Both skins use the compact phone terminal (OKX skin since 2026-11-17: ticket beside the book, chart behind the toggle).
const phoneQuery = typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 768px)') : undefined
const compactBook = ref(phoneQuery?.matches ?? false)
function updateLayout(event: MediaQueryListEvent): void {
  compactBook.value = event.matches
}

const priceSuggestion = ref<{ price: string; sequence: number }>()
const borrowOpen = ref(false)
const borrowCoin = ref('')
const repayOpen = ref(false)
const repayId = ref('')
const transferOpen = ref(false)
const transferCoin = ref('')

const status = computed<'error' | 'loading' | 'closed' | 'empty' | 'ready'>(() => {
  if (market.publicInfoError !== null) return 'error'
  if (market.publicInfo === null) return 'loading'
  if (!margin.leverOpen) return 'closed'
  if (margin.markets.length === 0) return 'empty'
  return margin.currentMarket === undefined ? 'loading' : 'ready'
})

/** Right-hand pair list: only lever-enabled pairs, tagged with their max leverage (Binance's `5x` badge). */
const marginSymbols = computed(() => margin.markets.map((entry) => entry.symbol))
const marginTags = computed<Record<string, string>>(() => Object.fromEntries(margin.markets.filter((entry) => entry.multiple !== '').map((entry) => [entry.symbol.pair, `${entry.multiple}x`])))

function selectPrice(price: string): void {
  priceSuggestion.value = { price, sequence: (priceSuggestion.value?.sequence ?? 0) + 1 }
}

function loadPrivate(): void {
  if (!sessionStore.isAuthenticated || margin.currentSymbol === '') return
  void margin.loadAccount()
  void margin.loadBorrows('open')
}

let stopStream: (() => void) | null = null

async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    return
  }
  if (stopStream === null) return
  const first = margin.markets[0]
  if (first === undefined) return
  if (margin.currentMarket === undefined) {
    market.selectPair(first.symbol.pair)
  } else {
    market.resubscribe()
  }
  loadPrivate()
}

function openBorrow(coin: string): void {
  borrowCoin.value = coin
  borrowOpen.value = true
}

function openRepay(id = ''): void {
  repayId.value = id
  repayOpen.value = true
}

function openTransfer(coin: string): void {
  transferCoin.value = coin
  transferOpen.value = true
}

function afterTransfer(): void {
  void margin.loadAccount()
  void margin.loadTransfers()
}

watch(() => market.selectedPair, () => {
  if (status.value === 'ready') loadPrivate()
})
watch(() => sessionStore.isAuthenticated, (authenticated) => {
  if (authenticated) loadPrivate()
  else {
    margin.reset()
    marginOrders.reset()
  }
})

onMounted(() => {
  phoneQuery?.addEventListener('change', updateLayout)
  stopStream = market.start('terminal')
  void bootstrap()
})
onBeforeUnmount(() => {
  phoneQuery?.removeEventListener('change', updateLayout)
  stopStream?.()
  stopStream = null
})
</script>

<template>
  <div ref="terminalRoot" class="trade-page margin-page terminal terminal--margin" :class="{ compact: compactBook, 'chart-open': chartOpen }">
    <section class="top-bar terminal__header">
      <MarginPairPicker v-if="status === 'ready'" />
      <div v-else class="top-title"><Landmark :size="20" aria-hidden="true" /><span>{{ t('margin.title') }}</span></div>
      <span class="top-divider" aria-hidden="true"></span>
      <TickerBar v-if="status === 'ready'" :compact="compactBook" />
      <button v-if="compactBook && status === 'ready'" type="button" class="chart-toggle" aria-controls="margin-chart" :aria-expanded="chartOpen" :aria-label="t('trade.chart')" @click="chartOpen = !chartOpen"><CandlestickChart :size="18" /></button>
    </section>

    <StateBlock v-if="status === 'error'" class="terminal__state" variant="error" :message="market.publicInfoError ?? ''" retryable @retry="bootstrap" />
    <StateBlock v-else-if="status === 'loading'" class="terminal__state" variant="loading" :message="t('common.loading')" />
    <section v-else-if="status === 'closed' || status === 'empty'" class="empty-state terminal__state" data-testid="margin-empty">
      <span class="empty-icon"><Landmark :size="28" aria-hidden="true" /></span>
      <h2>{{ status === 'closed' ? t('margin.closedTitle') : t('margin.noPairsTitle') }}</h2>
      <p>{{ status === 'closed' ? t('margin.closedSwitch') : t('margin.noPairs') }}</p>
      <RouterLink class="btn btn-primary" to="/trade">{{ t('margin.goSpot') }}</RouterLink>
    </section>

    <template v-else>
      <section id="margin-chart" class="cell chart-cell terminal__chart">
        <ChartPanel :scales="market.klineScales" :scale="market.klineScale" @scale="market.setKlineScale" />
      </section>

      <div class="cell book-cell terminal__book">
        <!-- OKX skin: book and trades are two tabs of one full-height panel; Binance keeps them as separate areas. -->
        <BookTradesTabs v-if="SKIN === 'okx'" :compact="compactBook" @price="selectPrice" />
        <OrderBook v-else :compact="compactBook" @price="selectPrice" />
      </div>

      <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
      <div class="cell form-cell terminal__form"><MarginOrderPanel :compact="compactBook" :price-suggestion="priceSuggestion" /></div>

      <div class="cell pairs-cell terminal__pairs"><PairListPanel :symbols="marginSymbols" :tags="marginTags" /></div>
      <div v-if="SKIN !== 'okx'" class="cell trades-cell terminal__trades"><TradesPanel /></div>

      <aside class="side-cell terminal__account">
        <div v-if="sessionStore.isAuthenticated" class="cell account-cell">
          <MarginAccountPanel @borrow="openBorrow" @repay="openRepay()" @transfer="openTransfer" />
        </div>
        <div v-else class="cell guest-cell">
          <p>{{ t('margin.loginToTrade') }}</p>
          <div class="guest-actions">
            <RouterLink class="btn btn-primary" to="/register">{{ t('trade.register') }}</RouterLink>
            <RouterLink class="btn" to="/login">{{ t('nav.login') }}</RouterLink>
          </div>
        </div>
      </aside>

      <div class="cell orders-cell terminal__orders"><MarginRecordsTabs @repay="openRepay" /></div>

      <div v-if="compactBook && chartOpen" class="chart-actions">
        <button class="chart-action buy" type="button" @click="tradeFromChart">{{ t('common.buy') }}</button>
        <button class="chart-action sell" type="button" @click="tradeFromChart">{{ t('common.sell') }}</button>
      </div>
    </template>

    <BorrowDialog v-model:open="borrowOpen" :coin="borrowCoin" @done="margin.loadBorrows('open')" />
    <RepayDialog v-model:open="repayOpen" :record-id="repayId" />
    <TransferDialog
      v-model:open="transferOpen"
      from="spot"
      to="margin"
      :coin="transferCoin"
      :marginSymbol="margin.currentSymbol"
      :accounts="['spot', 'margin']"
      @transferred="afterTransfer"
    />
  </div>
</template>

<style scoped>
/* Same arrangement as the spot terminal (contract: views/TradeView.vue). */
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

.top-bar { display: flex; align-items: center; gap: 18px; min-height: 64px; padding: 6px 16px 6px 8px; border-radius: 8px; background: var(--color-surface); min-width: 0; }
.top-title { display: inline-flex; align-items: center; gap: 10px; padding-left: 10px; font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--color-text); }
.top-title svg { color: var(--color-accent-text); }
.top-divider { width: 1px; height: 32px; background: var(--color-border); flex: 0 0 1px; }

.empty-state {
  display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 72px 24px; border-radius: 8px; text-align: center;
  background: radial-gradient(ellipse 60% 70% at 50% 0%, var(--color-accent-soft), transparent 70%), var(--color-surface);
}
.empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 60px; height: 60px; border-radius: 18px; background: var(--color-accent-soft); color: var(--color-accent-text); }
.empty-state h2 { margin: 4px 0 0; font-size: 22px; }
.empty-state p { max-width: 520px; margin: 0 0 8px; color: var(--color-text-secondary); font-size: 14px; }
.empty-state .btn { min-width: 160px; height: 42px; }

.cell { min-width: 0; overflow: hidden; border-radius: 8px; background: var(--color-surface); }
.chart-cell { display: flex; flex-direction: column; min-height: 0; }
.chart-cell > * { flex: 1 1 auto; }
.book-cell { min-height: 0; }
.side-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 0; }
.account-cell { flex: 0 0 auto; }
.orders-cell { min-height: 280px; }

.guest-cell { display: flex; flex-direction: column; align-items: stretch; gap: 12px; padding: 18px 14px; text-align: center; }
.guest-cell p { margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.guest-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.guest-actions .btn { height: 36px; }

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
      'account account'
      'orders orders';
  }
  .book-cell { contain: size; }
  .pairs-cell, .trades-cell { height: 360px; }
}
@media (max-width: 760px) {
  .terminal { display: flex; flex-direction: column; padding: 0; gap: 0; }
  .top-bar { flex-wrap: wrap; gap: 8px; padding: 10px 12px; border-radius: 0; border-bottom: 1px solid var(--color-border); }
  .top-divider { display: none; }
  .cell { border-radius: 0; border-bottom: 1px solid var(--color-border); }
  .chart-cell { order: 1; height: 420px; }
  .side-cell { order: 2; gap: 0; }
  .form-cell { order: 3; }
  .book-cell { order: 4; height: 560px; contain: none; }
  .trades-cell { order: 5; height: 320px; }
  .orders-cell { order: 6; }
  .pairs-cell { display: none; }
}
.terminal.compact {
  display: grid;
  grid-template-columns: minmax(0, 55fr) minmax(0, 45fr);
  grid-template-rows: none;
  grid-template-areas: 'header header' 'form book' 'chart chart' 'orders orders' 'account account' 'trades trades';
  padding: 0;
  gap: 0;
}
.compact .top-bar { flex-wrap: wrap; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); }
.compact .top-divider, .compact .top-bar :deep(.ticker), .compact .pairs-cell { display: none; }
.compact .chart-toggle { display: inline-flex; align-items: center; justify-content: center; margin-left: auto; width: 34px; height: 34px; border-radius: 8px; color: var(--color-text-secondary); }
.compact .chart-toggle[aria-expanded='true'] { color: var(--color-accent-text); }
.compact .chart-cell { display: none; height: 360px; }
.compact.chart-open .chart-cell { display: flex; }
.compact .book-cell { display: flex; flex-direction: column; height: auto; contain: none; }
.compact .book-cell :deep(.book) { flex: 1 1 auto; min-height: 0; height: auto; }
.compact .form-cell { border-right: 1px solid var(--color-border); }
.compact .trades-cell { height: 320px; }
/* Phone chart view, same as the spot terminal (owner 2026-11-17). */
.terminal.compact.chart-open { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'header' 'chart' 'book'; padding-bottom: 84px; }
.compact.chart-open .form-cell, .compact.chart-open .orders-cell, .compact.chart-open .side-cell, .compact.chart-open .trades-cell { display: none; }
.compact.chart-open .chart-cell { height: 54vh; min-height: 340px; }
.chart-actions { position: fixed; left: 0; right: 0; bottom: var(--mobile-tabbar-h, 0px); z-index: 40; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 8px 12px 22px; border-top: 1px solid var(--color-border); background: var(--color-bg); }
.chart-action { height: 42px; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 700; }
.chart-action.buy { background: var(--color-up); }
.chart-action.sell { background: var(--color-down); }
/* OKX skin on phones: last price + 24h change beside the pair, seven book levels a side (as on the spot terminal). */
.compact .top-bar :deep(.okx-ticker) { display: flex; flex: 0 1 auto; min-width: 0; margin-left: auto; }
.compact .top-bar :deep(.okx-ticker .ticker-stats), .compact .top-bar :deep(.okx-ticker .ticker-status) { display: none; }
.compact .top-bar :deep(.okx-ticker .ticker-main) { align-items: flex-end; text-align: right; }
.compact .top-bar :deep(.okx-ticker .last-price) { font-size: 17px; }
.compact .top-bar :deep(.okx-ticker .change-line) { font-size: 11px; }
.compact .top-bar:has(.okx-ticker) .chart-toggle { margin-left: 4px; }
.terminal.compact:not(.chart-open) .book-cell { min-height: 478px; }
</style>
