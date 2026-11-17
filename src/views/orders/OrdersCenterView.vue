<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { ClipboardList, Download, ExternalLink, FileDown, RotateCw, SlidersHorizontal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import GuestGate from '@/components/common/GuestGate.vue'
import { BRAND_ID } from '@/core/brand'
import StateBlock from '@/components/common/StateBlock.vue'
import FeedTable from '@/components/orders/FeedTable.vue'
import OrderFillsDrawer from '@/components/orders/OrderFillsDrawer.vue'
import WalletTabs from '@/components/wallet/WalletTabs.vue'
import ArchiveNotice from '@/components/history-export/ArchiveNotice.vue'
import ExportDialog from '@/components/history-export/ExportDialog.vue'
import ExportRecords from '@/components/history-export/ExportRecords.vue'
import { useHistoryExport } from '@/components/history-export/state'
import { downloadCsv, toCsv } from '@/components/orders/csv'
import { useOrdersI18n } from '@/components/orders/i18n'
import { dateBoundary, filterRows, formatDateTime, paginate, toServerDate, type FeedColumn, type FeedRow } from '@/components/orders/model'
import { useMergedFeed } from '@/components/orders/useMergedFeed'
import { isApiError } from '@/core/errors'
import * as orderApi from '@/modules/api/order.api'
import { EXPORT_KINDS, reachesArchive, type ExportKind } from '@/modules/api/history-export.api'
import type { OrderItem, TradeItem } from '@/modules/api/types'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import * as marginApi from '@/modules/margin/api'
import { displayAmount, exactAmount, formatDailyRate } from '@/modules/margin/risk'
import { orderAmountText } from '@/components/orders/display'
import { coinMeta } from '@/modules/wallet/coins'
import { formatCoinAmount } from '@/modules/wallet/valuation'
import type { BorrowRecord } from '@/modules/margin/types'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

/**
 * Orders centre. Spot endpoints (OrderAct) and lever endpoints (LeverOrderAct / LeverBorrowAct) are
 * read per pair and merged client-side (see components/orders/model.ts); futures orders stay on the
 * futures page and are linked, not duplicated. History older than the hot window is archived: a date range that
 * reaches before it shows the "generate statement" notice, and the export records tab lists the statements.
 */
type TabId = 'spotOpen' | 'spotHistory' | 'spotTrades' | 'marginOrders' | 'marginLoans' | 'futures' | 'exports'
const TAB_IDS: TabId[] = ['spotOpen', 'spotHistory', 'spotTrades', 'marginOrders', 'marginLoans', 'futures', 'exports']
const SPOT_EXPORTS: readonly ExportKind[] = ['spot_orders', 'spot_trades', 'spot_funds']
const FUTURES_EXPORTS: readonly ExportKind[] = ['futures_orders', 'futures_trades', 'futures_funds']
const PAGE_SIZE = 15
const FETCH_SIZE = 50

const { t } = useOrdersI18n()
const market = useMarketStore()
const margin = useMarginStore()
const sessionStore = useSessionStore()

const tab = ref<TabId>('spotOpen')
/** Phones: the filter row opens from a 筛选 button. */
const filtersOpen = ref(false)
const { locale: uiLocale } = useI18n({ useScope: 'global' })
const filterLabel = computed(() => (uiLocale.value === 'zh-CN' ? '筛选' : 'Filters'))
const filters = reactive({
  pair: '',
  side: '' as '' | 'BUY' | 'SELL',
  from: '',
  to: '',
  showCanceled: true,
  marginList: 'open' as 'open' | 'history',
  loanList: 'open' as 'open' | 'history',
})
const page = ref(1)
const actionError = ref<string | null>(null)
const cancelingId = ref<string | null>(null)
const drawer = shallowRef<{ kind: 'spot' | 'margin'; row: FeedRow<OrderItem> } | null>(null)
const hx = useHistoryExport()
const exportDialog = shallowRef<{ kinds: readonly ExportKind[]; kind: ExportKind; from: string; to: string } | null>(null)

const tabs = computed(() => TAB_IDS.map(id => ({ id, label: t(`orders.tabs.${id}`) })))
const isMarginTab = computed(() => tab.value === 'marginOrders' || tab.value === 'marginLoans')
const symbolInfo = computed(() => new Map(market.allSymbols.map(entry => [entry.symbol, entry])))
const pairOptions = computed(() => (isMarginTab.value ? margin.markets.map(entry => entry.symbol) : market.allSymbols))

function time(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

const spotOrders = useMergedFeed<OrderItem>({
  pageSize: FETCH_SIZE,
  timeOf: item => time(item.time_long),
  fetcher: async (symbol, pageNo, pageSize) => {
    const data = tab.value === 'spotHistory'
      ? await orderApi.fetchHistoryOrders({ symbol, page: pageNo, pageSize, side: filters.side, isShowCanceled: filters.showCanceled ? 1 : 0 })
      : await orderApi.fetchOpenOrders({ symbol, page: pageNo, pageSize, side: filters.side })
    return { count: data.count ?? 0, rows: data.orderList ?? [] }
  },
})
const spotTrades = useMergedFeed<TradeItem>({
  pageSize: FETCH_SIZE,
  timeOf: item => time(item.time_long),
  fetcher: async (symbol, pageNo, pageSize) => {
    const data = await orderApi.fetchMyTrades({ symbol, page: pageNo, pageSize })
    return { count: data.count ?? 0, rows: data.trade_list ?? [] }
  },
})
const marginOrders = useMergedFeed<OrderItem>({
  pageSize: FETCH_SIZE,
  timeOf: item => time(item.time_long),
  fetcher: async (symbol, pageNo, pageSize) => {
    const query = { symbol, page: pageNo, pageSize, side: filters.side }
    const data = filters.marginList === 'open' ? await marginApi.fetchMarginOpenOrders(query) : await marginApi.fetchMarginHistoryOrders(query)
    return { count: data.count ?? 0, rows: data.orderList ?? [] }
  },
})
const loans = useMergedFeed<BorrowRecord>({
  pageSize: FETCH_SIZE,
  timeOf: item => item.ctime,
  // Loans are not sharded: one cursor ('' = every pair) with server-side pair/date filters.
  fetcher: async (symbol, pageNo, pageSize) => {
    const query = { symbol, page: pageNo, pageSize, startTime: toServerDate(filters.from), endTime: toServerDate(filters.to, true) }
    const data = filters.loanList === 'open' ? await marginApi.fetchOpenBorrows(query) : await marginApi.fetchBorrowHistory(query)
    return { count: data.count, rows: data.list }
  },
})

const activeFeed = computed(() => {
  switch (tab.value) {
    case 'spotTrades': return spotTrades
    case 'marginOrders': return marginOrders
    case 'marginLoans': return loans
    default: return spotOrders
  }
})

function sideOfOrder(item: { side?: string }): string {
  return item.side ?? ''
}

function targetSymbols(): string[] {
  if (tab.value === 'marginLoans') return [filters.pair]
  if (filters.pair !== '') return [filters.pair]
  return [...new Set([...pairOptions.value.map(entry => entry.symbol), ...(!isMarginTab.value ? [...market.closedSymbols].map(symbol => symbol.toLowerCase()) : [])])]
}

async function reload(): Promise<void> {
  page.value = 1
  actionError.value = null
  if (!sessionStore.isAuthenticated || tab.value === 'futures' || tab.value === 'exports' || market.publicInfo === null) return
  ;[spotOrders, spotTrades, marginOrders, loans].forEach((feed) => {
    if (feed !== activeFeed.value) feed.clear()
  })
  await activeFeed.value.reset(targetSymbols())
}

/* ---------- display helpers ---------- */
function pairOf(symbol: string): string {
  return symbolInfo.value.get(symbol.toLowerCase())?.pair ?? (symbol === '' ? '--' : symbol.toUpperCase())
}
function pricePrecision(symbol: string): number {
  return symbolInfo.value.get(symbol.toLowerCase())?.pricePrecision ?? 8
}
function volumePrecision(symbol: string): number {
  return Math.min(symbolInfo.value.get(symbol.toLowerCase())?.volumePrecision ?? 8, 8)
}
function show(value: string | undefined, dp: number): string {
  const normalized = canonicalDecimal(value ?? '')
  return isDecimalString(normalized) ? groupDigits(normalized, dp) : '--'
}
function coinAmount(value: string | undefined, coin: string): string {
  return formatCoinAmount(value ?? '', coinMeta(market.publicInfo, coin).showPrecision)
}
function units(symbol: string): { base: string; quote: string; baseDp: number; quoteDp: number } {
  const entry = symbolInfo.value.get(symbol.toLowerCase())
  const base = entry?.base ?? ''
  const quote = entry?.quote ?? ''
  return { base, quote, baseDp: coinMeta(market.publicInfo, base).showPrecision, quoteDp: coinMeta(market.publicInfo, quote).showPrecision }
}
function sideText(side: string | undefined): string {
  const normalized = (side ?? '').toUpperCase()
  return normalized === 'BUY' ? t('common.buy') : normalized === 'SELL' ? t('common.sell') : '--'
}
function sideClass(side: string | undefined): string {
  return (side ?? '').toUpperCase() === 'BUY' ? 'up' : 'down'
}
function statusText(item: OrderItem): string {
  return item.status_text !== undefined && item.status_text !== '' ? item.status_text : t(`orderStatus.${item.status}`)
}
function orderTime(row: FeedRow<OrderItem>): string {
  return row.item.created_at ?? formatDateTime(row.time)
}

/* ---------- columns (screen + CSV) ---------- */
const orderColumns = computed<FeedColumn<OrderItem>[]>(() => {
  const withStatus = tab.value === 'spotHistory' || (tab.value === 'marginOrders' && filters.marginList === 'history')
  const columns: FeedColumn<OrderItem>[] = [
    { key: 'time', label: t('orders.col.time'), value: orderTime, align: 'left', className: () => 'muted' },
    { key: 'pair', label: t('orders.col.pair'), value: row => pairOf(row.symbol), align: 'left' },
    { key: 'side', label: t('orders.col.side'), value: row => sideText(row.item.side), className: row => sideClass(row.item.side), align: 'left' },
    { key: 'type', label: t('orders.col.type'), value: row => (row.item.type === 2 ? t('trade.marketPrice') : t('trade.limitPrice')), align: 'left' },
    { key: 'price', label: t('orders.col.price'), value: row => (row.item.type === 2 ? t('trade.marketPrice') : show(row.item.price, pricePrecision(row.symbol))) },
    { key: 'amount', label: t('orders.col.orderAmount'), value: row => orderAmountText(row.item, units(row.symbol)) },
    { key: 'filled', label: t('orders.col.filled'), value: row => coinAmount(row.item.deal_volume, units(row.symbol).base) },
    { key: 'avg', label: t('orders.col.avgPrice'), value: row => (isPositive(row.item.avg_price ?? '') ? show(row.item.avg_price, pricePrecision(row.symbol)) : '--') },
    { key: 'total', label: t('orders.col.total'), value: row => coinAmount(row.item.deal_money, units(row.symbol).quote) },
  ]
  if (withStatus) columns.push({ key: 'status', label: t('orders.col.status'), value: row => statusText(row.item), align: 'left' })
  columns.push({ key: 'id', label: t('orders.col.orderId'), value: row => row.item.id, className: () => 'muted' })
  return columns
})

const tradeColumns = computed<FeedColumn<TradeItem>[]>(() => [
  { key: 'time', label: t('orders.col.time'), value: row => row.item.ctime ?? formatDateTime(row.time), align: 'left', className: () => 'muted' },
  { key: 'pair', label: t('orders.col.pair'), value: row => pairOf(row.symbol), align: 'left' },
  { key: 'side', label: t('orders.col.side'), value: row => sideText(row.item.side), className: row => sideClass(row.item.side), align: 'left' },
  { key: 'price', label: t('orders.col.price'), value: row => show(row.item.price, pricePrecision(row.symbol)) },
  { key: 'amount', label: t('orders.col.amount'), value: row => coinAmount(row.item.volume, units(row.symbol).base) },
  { key: 'total', label: t('orders.col.total'), value: row => coinAmount(row.item.deal_price, units(row.symbol).quote) },
  { key: 'fee', label: t('orders.col.fee'), value: row => `${coinAmount(row.item.fee, row.item.feeCoin ?? '')} ${(row.item.feeCoin ?? '').toUpperCase()}`.trim() },
])

const loanColumns = computed<FeedColumn<BorrowRecord>[]>(() => {
  const open = filters.loanList === 'open'
  const columns: FeedColumn<BorrowRecord>[] = [
    { key: 'time', label: t('orders.col.time'), value: row => formatDateTime(row.time), align: 'left', className: () => 'muted' },
    { key: 'pair', label: t('orders.col.pair'), value: row => (row.item.showName !== '' ? row.item.showName : pairOf(row.item.symbol)), align: 'left' },
    { key: 'coin', label: t('orders.col.coin'), value: row => row.item.coin, align: 'left' },
    { key: 'borrow', label: t('orders.col.borrowMoney'), value: row => displayAmount(row.item.borrowMoney) },
    { key: 'rate', label: t('orders.col.rate'), value: row => formatDailyRate(row.item.interestRate) },
  ]
  if (open) columns.push({ key: 'owed', label: t('orders.col.owed'), value: row => `${displayAmount(row.item.oweAmount)} / ${displayAmount(row.item.oweInterest)}` })
  else columns.push({ key: 'interest', label: t('orders.col.interest'), value: row => displayAmount(row.item.interest) })
  columns.push({ key: 'status', label: t('orders.col.status'), value: row => (row.item.status >= 1 && row.item.status <= 7 ? t(`orders.borrowStatus.${row.item.status}`) : String(row.item.status)), align: 'left' })
  return columns
})

/* ---------- filtering / pagination ---------- */
const rowFilter = computed(() => ({ side: filters.side, from: filters.from, to: filters.to }))
const filteredOrders = computed(() => filterRows(activeFeed.value === spotOrders ? spotOrders.feed.value.rows : marginOrders.feed.value.rows, rowFilter.value, sideOfOrder))
const filteredTrades = computed(() => filterRows(spotTrades.feed.value.rows, rowFilter.value, sideOfOrder))
const filteredLoans = computed(() => filterRows(loans.feed.value.rows, { side: '', from: filters.from, to: filters.to }, () => ''))

const filteredCount = computed(() => {
  if (tab.value === 'spotTrades') return filteredTrades.value.length
  if (tab.value === 'marginLoans') return filteredLoans.value.length
  return filteredOrders.value.length
})
const pageOrders = computed(() => paginate(filteredOrders.value, page.value, PAGE_SIZE))
const pageTrades = computed(() => paginate(filteredTrades.value, page.value, PAGE_SIZE))
const pageLoans = computed(() => paginate(filteredLoans.value, page.value, PAGE_SIZE))
const pages = computed(() => {
  if (tab.value === 'spotTrades') return pageTrades.value.pages
  if (tab.value === 'marginLoans') return pageLoans.value.pages
  return pageOrders.value.pages
})
const currentPage = computed(() => Math.min(page.value, pages.value))
const loadedCount = computed(() => activeFeed.value.feed.value.rows.length)
const canCancel = computed(() => tab.value === 'spotOpen' || (tab.value === 'marginOrders' && filters.marginList === 'open'))
const hasDetail = computed(() => tab.value === 'spotOpen' || tab.value === 'spotHistory' || tab.value === 'marginOrders')

function exportCsv(): void {
  const stamp = formatDateTime(Date.now()).replace(/[-: ]/g, '').slice(0, 12)
  let csv: string
  if (tab.value === 'spotTrades') csv = toCsv(tradeColumns.value, filteredTrades.value)
  else if (tab.value === 'marginLoans') csv = toCsv(loanColumns.value, filteredLoans.value)
  else csv = toCsv(orderColumns.value, filteredOrders.value)
  downloadCsv(`${BRAND_ID}-${tab.value}-${stamp}.csv`, csv)
}

function resetFilters(): void {
  filters.pair = ''
  filters.side = ''
  filters.from = ''
  filters.to = ''
  filters.showCanceled = true
}

async function cancel(row: FeedRow<OrderItem>): Promise<void> {
  if (cancelingId.value !== null) return
  cancelingId.value = row.item.id
  actionError.value = null
  try {
    if (tab.value === 'marginOrders') await marginApi.cancelMarginOrder({ orderId: row.item.id, symbol: row.symbol })
    else await orderApi.cancelOrder({ orderId: row.item.id, symbol: row.symbol })
    await reload()
  } catch (error_) {
    actionError.value = isApiError(error_) || error_ instanceof Error ? error_.message : String(error_)
  } finally {
    cancelingId.value = null
  }
}

function selectTab(id: string): void {
  if ((TAB_IDS as string[]).includes(id)) tab.value = id as TabId
}

const drawerSymbol = computed(() => drawer.value?.row.symbol ?? '')

/* ---------- archived history (statements) ---------- */
const historyTab = computed(() => tab.value === 'spotHistory' || tab.value === 'spotTrades')
const archived = computed(() => historyTab.value && reachesArchive(dateBoundary(filters.from), hx.info.value))

function openExport(kinds: readonly ExportKind[] = SPOT_EXPORTS): void {
  const kind: ExportKind = tab.value === 'spotTrades' ? 'spot_trades' : kinds[0] ?? EXPORT_KINDS[0]
  exportDialog.value = { kinds, kind, from: archived.value ? filters.from : '', to: archived.value ? filters.to : '' }
}

/* ---------- lifecycle ---------- */
watch(tab, () => {
  if (isMarginTab.value && filters.pair !== '' && !margin.markets.some(entry => entry.symbol.symbol === filters.pair)) filters.pair = ''
  void reload()
})
// Server-side filters restart the feed; date/side on trades are client-side and only reset the page.
watch(() => [filters.pair, filters.showCanceled, filters.marginList, filters.loanList], () => void reload())
watch(() => filters.side, () => {
  if (tab.value === 'spotTrades') page.value = 1
  else void reload()
})
watch(() => [filters.from, filters.to], () => {
  if (filters.from !== '' && sessionStore.isAuthenticated) void hx.loadInfo()
  if (tab.value === 'marginLoans') void reload()
  else page.value = 1
})
watch(() => sessionStore.isAuthenticated, (authenticated) => {
  if (authenticated) void reload()
  else {
    [spotOrders, spotTrades, marginOrders, loans].forEach(feed => feed.clear())
    hx.reset()
  }
})

onMounted(async () => {
  if (market.publicInfo === null) {
    try {
      await market.loadPublicInfo()
    } catch {
      return
    }
  }
  await reload()
})
</script>

<template>
  <section class="orders-center">
    <header class="head">
      <div>
        <h1 class="title">{{ t('orders.title') }}</h1>
        <p class="subtitle">{{ t('orders.subtitle') }}</p>
      </div>
    </header>

    <GuestGate v-if="!sessionStore.isAuthenticated" :message="t('orders.loginRequired')" :icon="ClipboardList" />
    <template v-else>
      <WalletTabs :tabs="tabs" :active="tab" @select="selectTab" />

      <section v-if="tab === 'futures'" class="futures-card" data-testid="futures-link">
        <h2>{{ t('orders.futuresTitle') }}</h2>
        <p>{{ t('orders.futuresBody') }}</p>
        <div class="futures-links">
          <RouterLink class="btn btn-primary" to="/futures">{{ t('orders.futuresOpen') }} <ExternalLink :size="14" /></RouterLink>
          <RouterLink class="btn" to="/copy-trading">{{ t('orders.futuresCopy') }}</RouterLink>
          <RouterLink class="btn" to="/futures/data">{{ t('orders.futuresData') }}</RouterLink>
          <button class="btn" type="button" data-testid="futures-export" @click="openExport(FUTURES_EXPORTS)"><FileDown :size="14" />{{ t('orders.futuresExport') }}</button>
        </div>
      </section>

      <section v-else-if="tab === 'exports'" class="panel-box">
        <div class="exports-head">
          <button class="btn btn-primary" type="button" data-testid="exports-generate" @click="openExport([...SPOT_EXPORTS, ...FUTURES_EXPORTS])"><FileDown :size="14" />{{ t('orders.generate') }}</button>
        </div>
        <ExportRecords />
      </section>

      <section v-else class="panel-box">
        <button class="filters-toggle" type="button" :aria-expanded="filtersOpen" data-testid="orders-filters-toggle" @click="filtersOpen = !filtersOpen"><SlidersHorizontal :size="15" aria-hidden="true" />{{ filterLabel }}</button>
        <div class="filters" :class="{ 'is-open': filtersOpen }" role="search">
          <label class="filter">
            <span>{{ t('orders.filter.pair') }}</span>
            <select v-model="filters.pair" data-testid="filter-pair">
              <option value="">{{ t('orders.filter.allPairs') }}</option>
              <option v-for="entry in pairOptions" :key="entry.symbol" :value="entry.symbol">{{ entry.pair }}</option>
            </select>
          </label>
          <label v-if="tab !== 'marginLoans'" class="filter">
            <span>{{ t('orders.filter.side') }}</span>
            <select v-model="filters.side" data-testid="filter-side">
              <option value="">{{ t('orders.filter.allSides') }}</option>
              <option value="BUY">{{ t('common.buy') }}</option>
              <option value="SELL">{{ t('common.sell') }}</option>
            </select>
          </label>
          <label v-if="tab === 'marginOrders'" class="filter">
            <span>{{ t('orders.filter.marginList') }}</span>
            <select v-model="filters.marginList" data-testid="filter-margin-list">
              <option value="open">{{ t('orders.filter.marginOpen') }}</option>
              <option value="history">{{ t('orders.filter.marginHistory') }}</option>
            </select>
          </label>
          <label v-if="tab === 'marginLoans'" class="filter">
            <span>{{ t('orders.filter.loanList') }}</span>
            <select v-model="filters.loanList" data-testid="filter-loan-list">
              <option value="open">{{ t('orders.filter.loanOpen') }}</option>
              <option value="history">{{ t('orders.filter.loanHistory') }}</option>
            </select>
          </label>
          <label class="filter">
            <span>{{ t('orders.filter.from') }}</span>
            <input v-model="filters.from" type="date" :max="filters.to || undefined" data-testid="filter-from" />
          </label>
          <label class="filter">
            <span>{{ t('orders.filter.to') }}</span>
            <input v-model="filters.to" type="date" :min="filters.from || undefined" data-testid="filter-to" />
          </label>
          <label v-if="tab === 'spotHistory'" class="check">
            <input v-model="filters.showCanceled" type="checkbox" />
            {{ t('orders.filter.showCanceled') }}
          </label>
          <div class="filter-actions">
            <button class="btn btn-ghost" type="button" @click="resetFilters">{{ t('orders.filter.reset') }}</button>
            <button class="btn btn-ghost" type="button" :disabled="activeFeed.loading.value" :aria-label="t('common.refresh')" :title="t('common.refresh')" @click="reload"><RotateCw :size="15" /></button>
            <button class="btn" type="button" :disabled="filteredCount === 0" :title="t('orders.exportHint')" data-testid="export-csv" @click="exportCsv"><Download :size="14" />{{ t('orders.export') }}</button>
            <button v-if="historyTab" class="btn" type="button" data-testid="export-statement" @click="openExport()"><FileDown :size="14" />{{ t('orders.generate') }}</button>
          </div>
        </div>

        <p v-if="tab !== 'marginLoans' && filters.pair === ''" class="note">{{ t('orders.windowNote') }}</p>
        <p v-if="tab === 'spotTrades'" class="note">{{ t('orders.tradesNote') }}</p>
        <p v-if="actionError !== null" class="notice notice-error wrap-anywhere">{{ actionError }}</p>
        <p v-if="activeFeed.failedSymbols.value.length > 0 && activeFeed.error.value === null" class="notice wrap-anywhere">
          {{ activeFeed.failedSymbols.value.map(cursor => `${pairOf(cursor.symbol)}: ${cursor.error}`).join(' · ') }}
        </p>

        <ArchiveNotice v-if="archived" @export="openExport()" />
        <StateBlock v-if="isMarginTab && margin.markets.length === 0 && tab === 'marginOrders'" variant="empty" :message="t('orders.noMarginPairs')" />
        <StateBlock v-else-if="activeFeed.loading.value && loadedCount === 0" variant="loading" :message="t('common.loading')" />
        <StateBlock v-else-if="activeFeed.error.value !== null" variant="error" :message="activeFeed.error.value" retryable @retry="reload" />
        <StateBlock v-else-if="filteredCount === 0 && !archived" variant="empty" :message="t('orders.empty')" />
        <template v-else-if="filteredCount > 0">
          <FeedTable
            v-if="tab === 'spotTrades'"
            :columns="tradeColumns"
            :rows="pageTrades.rows"
            :row-key="row => `${row.symbol}-${String(row.item.id)}-${row.item.side ?? ''}`"
          />
          <FeedTable
            v-else-if="tab === 'marginLoans'"
            :columns="loanColumns"
            :rows="pageLoans.rows"
            :row-key="row => row.item.id"
          />
          <FeedTable
            v-else
            :columns="orderColumns"
            :rows="pageOrders.rows"
            :row-key="row => `${row.symbol}-${row.item.id}`"
            :action-label="t('orders.col.action')"
          >
            <template #action="{ row }">
              <span class="row-actions">
                <button v-if="hasDetail" class="link-btn" type="button" @click="drawer = { kind: tab === 'marginOrders' ? 'margin' : 'spot', row }">{{ t('orders.detail') }}</button>
                <button
                  v-if="canCancel"
                  class="link-btn danger"
                  type="button"
                  :disabled="cancelingId !== null"
                  @click="cancel(row)"
                >{{ cancelingId === row.item.id ? t('orders.canceling') : t('orders.cancel') }}</button>
              </span>
            </template>
          </FeedTable>
        </template>

        <footer v-if="filteredCount > 0 || activeFeed.more.value" class="pager">
          <span class="muted" data-testid="loaded-count">{{ t('orders.loaded', { loaded: loadedCount, total: Math.max(activeFeed.total.value, loadedCount) }) }}</span>
          <button v-if="activeFeed.more.value" class="btn btn-ghost" type="button" :disabled="activeFeed.loading.value" data-testid="load-more" @click="activeFeed.loadMore()">
            {{ activeFeed.loading.value ? t('common.loading') : t('orders.loadMore') }}
          </button>
          <span class="spacer"></span>
          <button class="btn btn-ghost" type="button" :disabled="currentPage <= 1" data-testid="page-prev" @click="page = currentPage - 1">{{ t('common.prev') }}</button>
          <span class="muted" data-testid="page-info">{{ t('orders.pageInfo', { page: currentPage, pages }) }}</span>
          <button class="btn btn-ghost" type="button" :disabled="currentPage >= pages" data-testid="page-next" @click="page = currentPage + 1">{{ t('common.next') }}</button>
        </footer>
      </section>
    </template>

    <ExportDialog
      :open="exportDialog !== null"
      :kinds="exportDialog?.kinds ?? SPOT_EXPORTS"
      :initial-kind="exportDialog?.kind"
      :initial-from="exportDialog?.from ?? ''"
      :initial-to="exportDialog?.to ?? ''"
      @close="exportDialog = null"
      @created="tab = 'exports'"
    />

    <OrderFillsDrawer
      :open="drawer !== null"
      :kind="drawer?.kind ?? 'spot'"
      :symbol="drawerSymbol"
      :pair="pairOf(drawerSymbol)"
      :order="drawer?.row.item ?? null"
      :pricePrecision="pricePrecision(drawerSymbol)"
      :volumePrecision="volumePrecision(drawerSymbol)"
      @close="drawer = null"
    />
  </section>
</template>

<style scoped>
.orders-center { display: flex; flex-direction: column; gap: 16px; max-width: 1280px; margin: 0 auto; padding: 28px 24px 56px; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.title { margin: 0; font-size: 30px; font-weight: 750; letter-spacing: -0.02em; }
.subtitle { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; }
.panel-box { border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); overflow: hidden; }
.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--color-border); }
.filter { display: flex; flex-direction: column; gap: 5px; min-width: 130px; color: var(--color-text-muted); font-size: 11.5px; font-weight: 600; }
.filter select, .filter input {
  height: 36px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: 9px; background: var(--color-surface-alt);
  color: var(--color-text); font-size: 13px; font-weight: 500; outline: none;
}
.filter select:focus, .filter input:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.check { display: inline-flex; align-items: center; gap: 6px; height: 36px; color: var(--color-text-secondary); font-size: 13px; }
.check input { accent-color: var(--color-accent); }
.filter-actions { display: flex; gap: 6px; margin-left: auto; }
.filter-actions .btn { height: 36px; }
.note { margin: 12px 18px 0; color: var(--color-text-muted); font-size: 12px; }
.notice { margin: 12px 18px 0; }
.row-actions { display: inline-flex; gap: 14px; }
.link-btn { color: var(--color-accent-text); font-size: 12px; font-weight: 650; }
.link-btn:hover:not(:disabled) { text-decoration: underline; }
.link-btn.danger { color: var(--color-down); }
.link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pager { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 18px; border-top: 1px solid var(--color-border); font-size: 12px; }
.pager .btn { height: 32px; }
.spacer { flex: 1 1 auto; }
.futures-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 32px; border: 1px solid var(--color-border); border-radius: 18px;
  background: radial-gradient(ellipse 50% 140% at 100% 0%, var(--color-accent-soft), transparent 60%), var(--color-surface);
}
.futures-card h2 { margin: 0; font-size: 20px; }
.futures-card p { margin: 0; max-width: 620px; color: var(--color-text-secondary); font-size: 14px; }
.futures-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.futures-links .btn { height: 40px; }
.exports-head { display: flex; justify-content: flex-end; padding: 14px 18px 0; }
.exports-head .btn { height: 36px; }
@media (max-width: 720px) {
  /* Filters open from the 筛选 button so the list starts at the top (owner 2026-11-17). */
  .filters-toggle { display: inline-flex; align-items: center; gap: 6px; height: 34px; margin: 12px 14px 0; padding: 0 14px; border: 1px solid var(--color-border-strong); border-radius: 999px; color: var(--color-text-secondary); font-size: 13px; font-weight: 600; }
  .filters-toggle[aria-expanded='true'] { border-color: var(--color-accent); color: var(--color-accent-text); }
  .filters:not(.is-open) { display: none; }
  .note { display: none; }
  /* The phone header bar already names the page. */
  .head { display: none; }
  .orders-center { padding: 12px 14px 40px; }
  .title { font-size: 24px; }
  .filter { min-width: calc(50% - 6px); flex: 1 1 calc(50% - 6px); }
  .filter-actions { width: 100%; margin-left: 0; }
  .filter-actions .btn:last-child { margin-left: auto; }
  .futures-card { padding: 22px; }
}
.filters-toggle { display: none; }
@media (max-width: 720px) { .filters-toggle { display: inline-flex; } }
</style>
