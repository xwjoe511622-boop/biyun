<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ArrowLeftRight, ClipboardList, Info, Pencil, RotateCw } from '@lucide/vue'
import RefreshBar from '@/components/common/RefreshBar.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isPendingId } from '@/core/swr'
import { toastError, toastSuccess } from '@/core/toast'
import type { FuturesContract } from '@/modules/futures/contracts'
import { fetchFeeRows, fetchPositionTpsl, fetchPublicMarketInfo } from '@/modules/futures/api'
import { nearestTpsl } from '@/modules/futures/tpsl-summary'
import { positionTpslRows } from '@/modules/futures/fapi-conditional'
import { amountText, formatDateTime } from '@/modules/futures/format'
import { breakEvenPrice, crossMaintenance, estimatedFunding, positionMarginColumns } from '@/modules/futures/position-metrics'
import { SKIN } from '@/core/skin'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { liquidationInfo, pnlView, rateView, roeView } from '@/modules/futures/math'
import { signedDisplay } from '@/modules/futures/signed'
import type { ClosedPosition } from '@/modules/futures/position-history'
import { isSignedDecimal } from '@/modules/futures/signed'
import type { FeeRow, FuturesAccount, FuturesOrder, FuturesPosition, FuturesTrade, FuturesTriggerOrder } from '@/modules/futures/types'
import { isMarketOrder } from '@/modules/futures/types'
import { Decimal } from '@/modules/finance/decimal'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { FUTURES_PAGE_SIZE, useFuturesOrdersStore, type ListKey } from '@/stores/futures-orders'
import { useSessionStore } from '@/stores/session'
import AdjustMarginDialog from './AdjustMarginDialog.vue'
import LeverageDialog from './LeverageDialog.vue'
import PositionCloseDialog from './PositionCloseDialog.vue'
import ReverseDialog from './ReverseDialog.vue'
import TicketSelect from './TicketSelect.vue'
import TransferDialog from './TransferDialog.vue'
import ArchiveNotice from '@/components/history-export/ArchiveNotice.vue'
import ExportDialog from '@/components/history-export/ExportDialog.vue'
import { useHistoryExport } from '@/components/history-export/state'
import type { ExportKind } from '@/modules/api/history-export.api'
import SizeUnitSelect from './SizeUnitSelect.vue'
import TpslDialog from './TpslDialog.vue'

type TabKey = 'positions' | 'current' | 'trigger' | 'history' | 'trades' | 'transactions' | 'positionHistory' | 'assets'

const { t, te } = useFuturesI18n()
const market = useFuturesMarketStore()
const account = useFuturesAccountStore()
const orders = useFuturesOrdersStore()
const sessionStore = useSessionStore()

const tab = ref<TabKey>('positions')
const historyKind = ref<'history' | 'historyTrigger'>('history')
const marginTarget = ref<FuturesPosition | null>(null)
const tpslTarget = ref<FuturesPosition | null>(null)
/** 平仓 sheet (Binance app: the position card's 「平仓」 opens it). */
const closeTarget = ref<FuturesPosition | null>(null)
/** Which row button opened the close sheet (Binance 平仓 column: 市价 / 限价). */
const closeKind = ref<'market' | 'limit'>('market')
function openClose(position: FuturesPosition, kind: 'market' | 'limit'): void {
  closeKind.value = kind
  closeTarget.value = position
}
/** 反手 confirmation (Binance "Reverse"). */
const reverseTarget = ref<FuturesPosition | null>(null)
const transferOpen = ref(false)
/** 杠杆 acts on the selected contract: select the position's contract first, the dialog opens once it is current. */
const leverageTarget = ref<FuturesPosition | null>(null)
const leverageReady = computed(() => leverageTarget.value !== null && contract.value?.id === leverageTarget.value.contractId && account.config !== null)

const HIDE_OTHERS_KEY = 'picat.futures.hideOtherPositions'
function readHideOthers(): boolean {
  try {
    return localStorage.getItem(HIDE_OTHERS_KEY) === '1'
  } catch {
    return false
  }
}
/** 「隐藏其他交易对」: only the selected contract's positions (remembered per browser). */
const hideOthers = ref(readHideOthers())
watch(hideOthers, (value) => {
  try {
    localStorage.setItem(HIDE_OTHERS_KEY, value ? '1' : '0')
  } catch {
    // Private mode: not remembered.
  }
})
const shownPositions = computed(() => (hideOthers.value ? account.positions.filter((position) => position.contractId === contract.value?.id) : account.positions))

/* 损益两平价 needs the open/close taker fees (`common/getMakerAndTaker`, same rows the ticket uses). */
const feeRows = shallowRef<FeeRow[]>([])
void fetchFeeRows().then((rows) => { feeRows.value = rows }).catch(() => { feeRows.value = [] })
function feesFor(position: FuturesPosition): { open: string; close: string } {
  const own = contractFor(position.contractId)
  const same = (a: string | undefined, b: string | undefined): boolean => (a ?? '').toUpperCase() === (b ?? '').toUpperCase()
  const row = feeRows.value.find((entry) => same(entry.multiplierCoin, own?.multiplierCoin) && same(entry.marginCoin, own?.marginCoin)) ?? feeRows.value[0]
  return { open: row?.openTakerFee ?? '', close: row?.closeTakerFee ?? '' }
}
function breakEvenText(position: FuturesPosition): string {
  if (position.orderSide === '') return '--'
  const fees = feesFor(position)
  const value = breakEvenPrice({ side: position.orderSide, entry: position.openAvgPrice, openFee: fees.open, closeFee: fees.close, dp: priceDp(position.contractId) })
  return value === '' ? '--' : amountText(value, priceDp(position.contractId))
}
/*
 * Funding rates of every contract the user holds (10-01 owner bug: on the ETH page the BTC rows showed 预估资金费用 --,
 * because only the page contract's rate was known). The page contract uses the live market info; the others are read
 * with `common/public_market_info` when the held contracts change and every FUNDING_POLL_MS.
 */
const FUNDING_POLL_MS = 45_000
const heldRates = shallowRef(new Map<number, string>())
let ratesLoad = 0
async function loadHeldRates(): Promise<void> {
  const load = ++ratesLoad
  const ids = [...new Set(account.positions.map((position) => position.contractId))]
  const next = new Map<number, string>()
  await Promise.all(ids.map(async (id) => {
    try {
      next.set(id, (await fetchPublicMarketInfo(id)).currentFundRate)
    } catch {
      // Keep the previous rate for this contract; the cell shows it until the next poll.
      const previous = heldRates.value.get(id)
      if (previous !== undefined) next.set(id, previous)
    }
  }))
  if (load === ratesLoad) heldRates.value = next
}
watch(() => [...new Set(account.positions.map((position) => position.contractId))].sort().join(','), (key) => {
  if (key !== '') void loadHeldRates()
}, { immediate: true })
const ratesTimer = setInterval(() => { if (account.positions.length > 0 && document.visibilityState === 'visible') void loadHeldRates() }, FUNDING_POLL_MS)
onBeforeUnmount(() => clearInterval(ratesTimer))

function fundingRateFor(contractId: number): string {
  if (contractId === contract.value?.id && market.marketInfo.currentFundRate !== '') return market.marketInfo.currentFundRate
  return heldRates.value.get(contractId) ?? ''
}

/** 预估资金费用 of a row: its OWN contract's current funding rate and mark (any page). `''` when unknown. */
/** Position value at the live mark: contracts × multiplier × mark (`''` when unknown). */
function notionalOf(position: FuturesPosition): string {
  const multiplier = contractFor(position.contractId)?.multiplier ?? ''
  // The risk columns share the server's risk snapshot. Funding/PnL below keep their public live mark.
  const mark = position.markPrice
  if (!isSignedDecimal(position.positionVolume) || !isSignedDecimal(multiplier) || !isSignedDecimal(mark)) return position.positionBalance
  return new Decimal(position.positionVolume).abs().times(multiplier).times(mark).toFixed()
}
/** Cross maintenance and cross margin balance (equity minus isolated margins), shared by every cross row. */
const crossBasis = computed(() => {
  const cross = account.positions.filter((position) => position.positionType !== 2)
  const maintenance = crossMaintenance(cross.map((position) => ({ notional: notionalOf(position), keepRate: position.keepRate, maintenanceMargin: position.maintenanceMargin })))
  const equity = account.account?.totalAmount ?? ''
  if (!isSignedDecimal(equity)) return { maintenance, balance: '' }
  let balance = new Decimal(equity)
  for (const position of account.positions) {
    if (position.positionType === 2 && isSignedDecimal(position.holdAmount)) balance = balance.minus(position.holdAmount)
  }
  return { maintenance, balance: balance.toFixed() }
})
/** 保证金 / 保证金比率 columns (Binance semantics on www, OKX 保证金率 on pro), see `positionMarginColumns`. */
function marginCols(position: FuturesPosition): { margin: string; ratio: string; risk: 'safe' | 'warn' | 'danger' | 'unknown' } {
  return positionMarginColumns({
    isolated: position.positionType === 2,
    notional: notionalOf(position),
    leverage: position.leverageLevel,
    keepRate: position.keepRate,
    maintenanceMargin: position.maintenanceMargin,
    holdAmount: position.holdAmount,
    crossMaintenance: crossBasis.value.maintenance,
    crossBalance: crossBasis.value.balance,
    style: SKIN === 'okx' ? 'okx' : 'binance',
    dp: moneyDp,
  })
}

function fundingText(position: FuturesPosition): string {
  if (position.orderSide === '') return ''
  const rate = fundingRateFor(position.contractId)
  if (rate === '') return ''
  return estimatedFunding({
    side: position.orderSide,
    volume: position.positionVolume,
    multiplier: contractFor(position.contractId)?.multiplier ?? '',
    mark: account.positionPnls.get(position.id)?.mark || position.markPrice,
    rate,
    dp: moneyDp,
  })
}

/*
 * 止盈/止损 column: the position's open TP/SL orders (the server fills `takeProfitPrice` / `stopLossPrice` only for
 * copy-trading followers, so a normal user's TP/SL never showed). Reloaded when the positions change and after the
 * TP/SL dialog closes.
 */
const tpslPrices = shallowRef(new Map<number, { tp: string; sl: string }>())
let tpslLoad = 0
async function loadTpslPrices(): Promise<void> {
  if (account.fapiOrdersActive()) {
    // `/fapi/v1/openOrders` → the shared conditional map (one request for every position); the watch below renders it.
    orders.refreshConditionals(0)
    return
  }
  const load = ++tpslLoad
  const next = new Map<number, { tp: string; sl: string }>()
  await Promise.all(account.positions.map(async (position) => {
    if (position.orderSide === '') return
    try {
      next.set(position.id, nearestTpsl(await fetchPositionTpsl(position.contractId, position.orderSide), position.orderSide))
    } catch {
      // Keep the server fields for this row.
    }
  }))
  if (load === tpslLoad) tpslPrices.value = next
}
watch(() => account.positions.map((position) => `${position.id}:${position.positionVolume}`).join(','), (key) => {
  if (key !== '' && sessionStore.isAuthenticated) void loadTpslPrices()
}, { immediate: true })
watch(tpslTarget, (target, previous) => { if (target === null && previous !== null) void loadTpslPrices() })
watch(() => [orders.conditionalsKnown, orders.conditionalRows, account.positions] as const, ([known, rows, positions]) => {
  if (!known || !account.fapiOrdersActive()) return
  const next = new Map<number, { tp: string; sl: string }>()
  for (const position of positions) {
    if (position.orderSide === '') continue
    next.set(position.id, nearestTpsl(positionTpslRows(rows, position), position.orderSide))
  }
  tpslPrices.value = next
}, { immediate: true })
function tpslPrice(position: FuturesPosition, kind: 'tp' | 'sl'): string {
  const own = tpslPrices.value.get(position.id)?.[kind] ?? ''
  if (own !== '') return own
  const server = kind === 'tp' ? position.takeProfitPrice : position.stopLossPrice
  return positive(server) ? server : ''
}

/** The 持仓数量 ⇆: USDT ↔ base coin (the app-wide size unit). */
function flipUnit(): void {
  sizes.unit.value = sizes.unit.value === 'quote' ? 'base' : 'quote'
}

function openLeverage(position: FuturesPosition): void {
  const own = contractFor(position.contractId)
  if (own !== undefined && contract.value?.id !== own.id) market.selectContract(own.contractName)
  leverageTarget.value = position
}

const contract = computed(() => market.currentContract)
const listKey = computed<ListKey | null>(() => {
  if (tab.value === 'positions' || tab.value === 'assets') return null
  if (tab.value === 'history') return historyKind.value
  return tab.value
})
const list = computed(() => (listKey.value === null ? null : orders.lists[listKey.value]))
const totalPages = computed(() => Math.max(1, Math.ceil((list.value?.count ?? 0) / FUTURES_PAGE_SIZE)))

const tabs = computed(() => [
  { key: 'positions' as const, label: t('fut.positions'), count: account.positions.length },
  { key: 'current' as const, label: t('fut.openOrders'), count: orders.lists.current.count },
  { key: 'trigger' as const, label: t('fut.triggerOrders'), count: orders.lists.trigger.count },
  { key: 'history' as const, label: t('fut.history'), count: 0 },
  { key: 'trades' as const, label: t('fut.trades'), count: 0 },
  { key: 'transactions' as const, label: t('fut.transactions'), count: 0 },
  { key: 'positionHistory' as const, label: t('fut.posHistory'), count: 0 },
  { key: 'assets' as const, label: t('fut.assetsTab'), count: 0 },
])

function contractFor(id: number | null): FuturesContract | undefined {
  return market.allContracts.find((entry) => entry.id === id)
}
function contractName(id: number | null, fallback = ''): string {
  return contractFor(id)?.displayName ?? (fallback.replace(/^[A-Z]-/, '').replace('-', '') || '--')
}
function priceDp(id: number | null): number {
  return contractFor(id)?.pricePrecision ?? contract.value?.pricePrecision ?? 2
}
const coinDp = computed(() => contract.value?.marginCoinPrecision ?? 4)
/**
 * Money shown in positions / position history / assets: 2 decimals (Binance), never truncated. Fees, flows and order
 * history keep the margin coin precision (small amounts).
 */
const moneyDp = 2
const sizes = useSizeFormat()

/*
 * Quantities in the futures size unit (USDT / base coin / 张). Each row converts at its own price:
 * live positions at the mark price, orders at their order (or average fill) price, fills at the fill
 * price. A market OPEN order's `volume` is its USDT value (the server sizes it by value), so it is
 * converted from value, not from contracts; `dealVolume` is always whole contracts.
 */
function positionSize(position: FuturesPosition, contracts: string): string {
  return sizes.sizeCell(contracts, contractFor(position.contractId), position.markPrice, contract.value)
}
function positive(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 // float-ok: "> 0" check on a validated decimal string, boolean only
}
function orderRef(order: FuturesOrder): string {
  if (positive(order.avgPrice)) return order.avgPrice
  if (positive(order.price)) return order.price
  return order.contractId === contract.value?.id ? market.ticker.close : ''
}
function orderVolume(order: FuturesOrder): string {
  const own = contractFor(order.contractId)
  if (order.type === 2 && order.open === 'OPEN' && order.volumeIsContracts !== true) return sizes.valueCell(order.volume, own, orderRef(order), contract.value)
  return sizes.sizeCell(order.volume, own, orderRef(order), contract.value)
}
function orderFilled(order: FuturesOrder): string {
  return sizes.sizeCell(order.dealVolume, contractFor(order.contractId), orderRef(order), contract.value)
}
function triggerVolume(order: FuturesTriggerOrder): string {
  const own = contractFor(order.contractId)
  const reference = order.type !== 2 && positive(order.price) ? order.price : order.triggerPrice
  if (order.closePosition === true) return t('fut.tpq.entire')
  if (order.type === 2 && order.open === 'OPEN' && order.volumeIsContracts !== true) return sizes.valueCell(order.volume, own, reference, contract.value)
  return sizes.sizeCell(order.volume, own, reference, contract.value)
}
/** Binance 「触发条件」: `标记 ≥ 80,000.0` for `/fapi` rows; the bare price for classic rows (last price). */
function triggerCondition(order: FuturesTriggerOrder): string {
  const text = amountText(order.triggerPrice, priceDp(order.contractId))
  if (order.direction === undefined) return text
  const kind = t(order.workingType === 'MARK_PRICE' ? 'fut.cond.markShort' : 'fut.cond.lastShort')
  return `${kind} ${order.direction === 'up' ? '≥' : '≤'} ${text}`
}
function tradeVolume(trade: FuturesTrade): string {
  const own = market.allContracts.find((entry) => entry.contractName === trade.contractName) ?? contract.value
  return sizes.sizeCell(trade.volume, own, trade.price, contract.value)
}
const volumeHeader = computed(() => sizes.header(t('fut.volume'), contract.value))

function sideText(side: string, open: string): string {
  if (open === 'OPEN') return side === 'BUY' ? t('fut.openLong') : t('fut.openShort')
  if (open === 'CLOSE') return side === 'BUY' ? t('fut.closeShort') : t('fut.closeLong')
  return side === 'BUY' ? t('fut.long') : side === 'SELL' ? t('fut.short') : '--'
}
function sideClass(side: string): string {
  return side === 'BUY' ? 'up' : 'down'
}
function label(prefix: string, value: number | null): string {
  const key = `fut.${prefix}.${String(value)}`
  return value !== null && te(key) ? t(key) : '--'
}
function orderPrice(price: string, type: number | null, id: number | null): string {
  return type === 2 ? t('fut.market') : amountText(price, priceDp(id))
}

/** 仓位历史 row: `价差 … 手续费 … 资金费 …` behind the net realized PnL. */
function closedPnlHint(row: ClosedPosition): string {
  const money = (value: string): string => (value === '' ? '--' : signedDisplay(value, coinDp.value))
  const share = row.shareAmount !== '' && row.shareAmount !== '0' ? t('fut.ph.shareHint', { share: money(row.shareAmount) }) : ''
  return t('fut.ph.pnlHint', { close: money(row.closeProfit), fee: money(row.tradeFee), funding: money(row.capitalFee), share })
}
function closedSize(row: ClosedPosition): string {
  return sizes.sizeCell(row.volume, contractFor(row.contractId), row.closePrice || row.openPrice, contract.value)
}

/** 仓位历史 contract filter (Binance: all symbols by default, or one). */
const historyFilterOptions = computed(() => [
  { value: 'all', label: t('fut.ph.allContracts') },
  ...market.contracts.map((entry) => ({ value: String(entry.id), label: entry.displayName })),
])
const historyFilter = computed({
  get: () => String(orders.positionHistoryContract),
  set: (value: string) => orders.setPositionHistoryContract(value === 'all' ? 'all' : Number(value)), // float-ok: not money (contract id from the select)
})

/* 资产 (Binance futures "Assets"): one row per margin coin from `get_assets_list` accountList. */
function walletBalance(entry: FuturesAccount): string {
  if (!isSignedDecimal(entry.totalAmount)) return ''
  return isSignedDecimal(entry.unRealizedAmount) ? new Decimal(entry.totalAmount).minus(entry.unRealizedAmount).toFixed() : entry.totalAmount
}
function money(value: string): string {
  return value === '' ? '--' : signedDisplay(value, moneyDp, false)
}

/** Cancel / close / bulk results are toasts (fixed overlay): an inline error used to push the table down. */
function report(message: string | null): void {
  if (message !== null && message !== '') toastError(message, 'fut-orders-action')
}

function load(): void {
  if (listKey.value === null) void account.loadAssets()
  else void orders.load(listKey.value)
}

/* Older history is archived (hexport 10-19): history / trades / transactions offer a statement export. */
const FUTURES_EXPORTS: readonly ExportKind[] = ['futures_orders', 'futures_trades', 'futures_funds']
const hx = useHistoryExport()
const exportOpen = ref(false)
const archiveKind = computed<ExportKind | null>(() => (tab.value === 'history' ? 'futures_orders' : tab.value === 'trades' ? 'futures_trades' : tab.value === 'transactions' ? 'futures_funds' : null))
watch(archiveKind, (kind) => {
  if (kind !== null && sessionStore.isAuthenticated) void hx.loadInfo()
})

function select(next: TabKey): void {
  tab.value = next
  load()
}

function changePage(delta: number): void {
  const key = listKey.value
  if (key === null) return
  const next = orders.lists[key].page + delta
  if (next < 1 || next > totalPages.value) return
  orders.setPage(key, next)
}

async function cancel(order: { id: string; contractId: number | null }, conditional: boolean): Promise<void> {
  report(await orders.cancel(order, conditional))
}


/** Bulk actions ask for an explicit second click (inline confirm strip) before touching every position/order. */
const confirmBulk = ref<'closeAll' | 'cancelAll' | null>(null)
const bulkAction = computed<'closeAll' | 'cancelAll' | null>(() => {
  if (tab.value === 'positions' && account.positions.length > 0) return 'closeAll'
  if ((tab.value === 'current' || tab.value === 'trigger') && (list.value?.rows.length ?? 0) > 0) return 'cancelAll'
  return null
})
watch(tab, () => { confirmBulk.value = null })

async function runBulk(): Promise<void> {
  const kind = confirmBulk.value
  confirmBulk.value = null
  if (kind === 'closeAll') {
    // Always a result: 「已平仓 N 个仓位」, the failures by contract, or 另一操作进行中 (never silent).
    const outcome = await account.closeAllAtMarket()
    if (outcome.busy) toastError(t('fut.pm.busy'), 'fut-orders-action')
    else if (outcome.failures.length === 0) toastSuccess(t('fut.closeAllDone', { n: outcome.closed }), 'fut-orders-action')
    else toastError(t('fut.closeAllPartial', { n: outcome.closed, failures: outcome.failures.join('; ') }), 'fut-orders-action')
  }
  else if (kind === 'cancelAll') report(await orders.cancelAll(tab.value === 'trigger'))
}

watch(() => market.selectedName, () => {
  orders.resetForContract()
  if (sessionStore.isAuthenticated && account.isOpened) load()
})
watch(() => account.isOpened, (opened) => {
  if (opened) {
    void orders.load('current')
    void orders.load('trigger')
    if (listKey.value !== null) load()
  }
}, { immediate: true })
</script>

<template>
  <section class="panel ftabs">
    <RefreshBar :active="list?.refreshing ?? false" />
    <header class="panel-header ftabs-head">
      <div class="tabs">
        <button v-for="entry in tabs" :key="entry.key" class="tab" :class="{ active: tab === entry.key }" type="button" @click="select(entry.key)">
          {{ entry.label }}<span v-if="entry.count > 0" class="muted"> ({{ entry.count }})</span>
        </button>
      </div>
      <div class="row">
        <div v-if="tab === 'history'" class="seg">
          <button type="button" :class="{ active: historyKind === 'history' }" @click="historyKind = 'history'; load()">{{ t('fut.normalOrders') }}</button>
          <button type="button" :class="{ active: historyKind === 'historyTrigger' }" @click="historyKind = 'historyTrigger'; load()">{{ t('fut.conditional') }}</button>
        </div>
        <TicketSelect v-if="tab === 'positionHistory'" v-model="historyFilter" class="ph-filter" :options="historyFilterOptions" :label="t('fut.contract')" testid="fut-poshist-filter" />
        <label v-if="tab === 'positions'" class="pos-hide"><input v-model="hideOthers" type="checkbox" data-testid="fut-pos-hide-others" /><span>{{ t('fut.pos.hideOthers') }}</span></label>
        <button v-if="bulkAction !== null" class="btn btn-ghost bulk" type="button" data-testid="fut-bulk" :disabled="account.busy !== null || orders.cancelingId !== null" @click="confirmBulk = bulkAction">
          {{ account.busy === 'closeAll' ? t('fut.closing') : orders.cancelingId === '*' ? t('fut.canceling') : t(`fut.${bulkAction}`) }}
        </button>
        <SizeUnitSelect :contract="contract" />
        <button class="btn btn-ghost refresh" type="button" :title="t('common.refresh')" :aria-label="t('common.refresh')" :disabled="list?.loading ?? account.assetsLoading" @click="load"><RotateCw :size="15" /></button>
      </div>
    </header>

    <div v-if="confirmBulk !== null" class="bulk-confirm" role="alertdialog" :aria-label="t(`fut.${confirmBulk}`)">
      <span>{{ confirmBulk === 'closeAll' ? t('fut.closeAllConfirm', { n: account.positions.length }) : t('fut.cancelAllConfirm', { n: list?.count ?? 0 }) }}</span>
      <div class="row">
        <button class="btn btn-ghost" type="button" @click="confirmBulk = null">{{ t('fut.cancel') }}</button>
        <button class="btn bulk-go" type="button" data-testid="fut-bulk-confirm" @click="runBulk">{{ t(`fut.${confirmBulk}`) }}</button>
      </div>
    </div>

    <div class="ftabs-body">
      <div v-if="!sessionStore.isAuthenticated" class="guest">
        <ClipboardList :size="34" :stroke-width="1.3" aria-hidden="true" />
        <span>{{ t('fut.signInFutures') }}</span>
        <div class="guest-actions">
          <RouterLink class="btn btn-primary" to="/login">{{ t('nav.login') }}</RouterLink>
          <RouterLink class="btn" to="/register">{{ t('nav.register') }}</RouterLink>
        </div>
      </div>
      <StateBlock v-else-if="account.open.status === 'checking'" variant="loading" :message="t('fut.checkingAccount')" />
      <StateBlock v-else-if="account.open.initFailed" variant="error" :message="t('fut.initFailed')" retryable @retry="account.refresh()" />
      <StateBlock v-else-if="!account.isOpened" variant="loading" :message="t('fut.initializingAccount')" />

      <!-- Positions (Binance app card fields; a table on desktop, cards on phones) -->
      <template v-else-if="tab === 'positions'">
        <StateBlock v-if="account.assetsLoading && !account.assetsLoaded" variant="loading" :message="t('common.loading')" />
        <StateBlock v-else-if="account.assetsError !== null && !account.assetsLoaded" variant="error" :message="account.assetsError" retryable @retry="load" />
        <StateBlock v-else-if="shownPositions.length === 0" variant="empty" :message="t('fut.noPositions')" />
        <template v-else>
          <div v-vertical-scroll-boundary class="table-scroll pos-table">
            <table class="table">
              <thead>
                <tr>
                  <th class="w-contract">{{ t('fut.contract') }}</th>
                  <th><button class="unit-flip" type="button" data-testid="fut-pos-unit" :title="t('fut.pos.flipUnit')" @click="flipUnit">{{ t('fut.pos.qty') }} ({{ sizes.label(contract) }}) <ArrowLeftRight :size="12" aria-hidden="true" /></button></th>
                  <th>{{ t('fut.pos.entry') }}</th>
                  <th :title="t('fut.pos.breakEvenHint')">{{ t('fut.pos.breakEven') }}</th>
                  <th>{{ t('fut.pos.mark') }}</th>
                  <th>{{ t('fut.pos.liq') }}</th>
                  <th>{{ t('fut.pos.marginRatio') }}</th>
                  <th>{{ t('fut.pos.margin') }}</th>
                  <th>{{ t('fut.pos.pnl') }} ({{ t('fut.pos.roe') }})</th>
                  <th :title="t('fut.pos.fundingHint')">{{ t('fut.pos.funding') }}</th>
                  <th class="w-mkt">{{ t('fut.pos.closeCol') }}</th>
                  <th class="w-tpsl">{{ t('fut.pos.pnlCloseAll') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="position in shownPositions" :key="position.id" :data-testid="`fut-pos-row-${position.id}`">
                  <td class="w-contract">
                    <span class="pos-name">
                      <i class="side-bar" :class="position.orderSide === 'BUY' ? 'up-bg' : 'down-bg'"></i>
                      <b>{{ contractName(position.contractId, position.contractName) }}</b>
                    </span>
                    <span class="pos-tags">
                      <em>{{ t('fut.pos.perp') }}</em>
                      <em class="num" :class="position.orderSide === 'BUY' ? 'up' : 'down'">{{ position.positionType === 2 ? t('fut.isolated') : t('fut.cross') }} {{ position.leverageLevel ?? '--' }}x</em>
                    </span>
                  </td>
                  <td class="num" :class="position.orderSide === 'BUY' ? 'up' : 'down'" data-testid="fut-pos-size">{{ positionSize(position, position.positionVolume) }}</td>
                  <td class="num">{{ amountText(position.openAvgPrice, priceDp(position.contractId)) }}</td>
                  <td class="num" data-testid="fut-pos-break-even">{{ breakEvenText(position) }}</td>
                  <td class="num">{{ amountText(account.positionPnls.get(position.id)?.mark || position.markPrice, priceDp(position.contractId)) }}</td>
                  <td class="num">
                    <!-- Binance: `--` when the (cross) liquidation price is ≤ 0; the icon explains why (restored 09-29 wording). -->
                    <span v-if="liquidationInfo(position.reducePrice, priceDp(position.contractId)).kind === 'none'" class="muted liq-none" data-testid="fut-pos-liq-none" :title="t('fut.noLiquidationHint')">--<Info :size="12" class="liq-info" :aria-label="t('fut.noLiquidationHint')" /></span>
                    <span v-else class="warn">{{ liquidationInfo(position.reducePrice, priceDp(position.contractId)).text }}</span>
                  </td>
                  <td class="num" :title="t('fut.marginRatioHint')"><span class="risk" :class="marginCols(position).risk" data-testid="fut-pos-margin-ratio">{{ rateView(marginCols(position).ratio) }}</span></td>
                  <td class="num">
                    {{ marginCols(position).margin === '' ? '--' : signedDisplay(marginCols(position).margin, moneyDp, false) }}
                    <button v-if="position.positionType === 2" class="edit" type="button" :title="t('fut.adjustMargin')" :aria-label="t('fut.adjustMargin')" @click="marginTarget = position"><Pencil :size="12" aria-hidden="true" /></button>
                  </td>
                  <td class="num">
                    <span :class="pnlView(account.positionPnls.get(position.id)?.pnl ?? '', moneyDp).direction" data-testid="fut-pos-pnl">{{ pnlView(account.positionPnls.get(position.id)?.pnl ?? '', moneyDp).text }}</span>
                    <span class="roe" :class="roeView(account.positionPnls.get(position.id)?.roe ?? '').direction" data-testid="fut-pos-roe">{{ roeView(account.positionPnls.get(position.id)?.roe ?? '').text }}</span>
                  </td>
                  <td class="num" :class="pnlView(fundingText(position), moneyDp).direction" data-testid="fut-pos-funding">{{ fundingText(position) === '' ? '--' : pnlView(fundingText(position), moneyDp).text }}</td>
                  <td class="w-mkt">
                    <button class="link-act" type="button" data-testid="fut-pos-close" @click="openClose(position, 'market')">{{ t('fut.pos.market') }}</button>
                    <button class="link-act" type="button" :data-testid="`fut-pos-limit-${position.id}`" @click="openClose(position, 'limit')">{{ t('fut.pos.limit') }}</button>
                    <button class="link-act" type="button" :data-testid="`fut-pos-reverse-${position.id}`" :disabled="account.busy !== null" @click="reverseTarget = position">{{ t('fut.pos.reverse') }}</button>
                  </td>
                  <td class="w-tpsl num">
                    <span class="up" data-testid="fut-pos-tp">{{ tpslPrice(position, 'tp') !== '' ? amountText(tpslPrice(position, 'tp'), priceDp(position.contractId)) : '--' }}</span>
                    <span class="muted"> / </span>
                    <span class="down" data-testid="fut-pos-sl">{{ tpslPrice(position, 'sl') !== '' ? amountText(tpslPrice(position, 'sl'), priceDp(position.contractId)) : '--' }}</span>
                    <button class="edit" type="button" data-testid="fut-pos-tpsl" :title="t('fut.tpsl')" :aria-label="t('fut.tpsl')" @click="tpslTarget = position"><Pencil :size="12" aria-hidden="true" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="pos-cards">
            <article v-for="position in shownPositions" :key="position.id" class="pos-card">
              <header class="pc-head">
                <em class="side-badge" :class="position.orderSide === 'BUY' ? 'up-bg' : 'down-bg'">{{ position.orderSide === 'BUY' ? t('fut.pos.long') : t('fut.pos.short') }}</em>
                <b>{{ contractName(position.contractId, position.contractName) }}</b>
                <em class="chip">{{ t('fut.pos.perp') }}</em>
                <em class="chip num">{{ position.positionType === 2 ? t('fut.isolated') : t('fut.cross') }} {{ position.leverageLevel ?? '--' }}x</em>
              </header>
              <div class="pc-grid">
                <div><span class="k">{{ t('fut.pos.pnl') }} (USDT)</span><b class="v big" :class="pnlView(account.positionPnls.get(position.id)?.pnl ?? '', moneyDp).direction">{{ pnlView(account.positionPnls.get(position.id)?.pnl ?? '', moneyDp).text }}</b></div>
                <div></div>
                <div class="r"><span class="k">{{ t('fut.pos.roe') }}</span><b class="v big" :class="roeView(account.positionPnls.get(position.id)?.roe ?? '').direction">{{ roeView(account.positionPnls.get(position.id)?.roe ?? '').text }}</b></div>
                <div><button class="k unit-flip" type="button" @click="flipUnit">{{ t('fut.pos.size') }} ({{ sizes.label(contractFor(position.contractId)) }}) <ArrowLeftRight :size="11" aria-hidden="true" /></button><span class="v num">{{ positionSize(position, position.positionVolume) }}</span></div>
                <div><span class="k">{{ t('fut.pos.margin') }} (USDT)</span><span class="v num">{{ marginCols(position).margin === '' ? '--' : signedDisplay(marginCols(position).margin, moneyDp, false) }}<button v-if="position.positionType === 2" type="button" class="edit mobile-margin-edit" :aria-label="t('fut.adjustMargin')" @click="marginTarget = position"><Pencil :size="14" aria-hidden="true" /></button></span></div>
                <div class="r"><span class="k">{{ t('fut.pos.marginRatio') }}</span><span class="v num risk" :class="marginCols(position).risk">{{ rateView(marginCols(position).ratio) }}</span></div>
                <div><span class="k">{{ t('fut.pos.entry') }} (USDT)</span><span class="v num">{{ amountText(position.openAvgPrice, priceDp(position.contractId)) }}</span></div>
                <div><span class="k">{{ t('fut.pos.mark') }} (USDT)</span><span class="v num">{{ amountText(account.positionPnls.get(position.id)?.mark || position.markPrice, priceDp(position.contractId)) }}</span></div>
                <div class="r"><span class="k">{{ t('fut.pos.liq') }} (USDT)</span><span class="v num"><template v-if="liquidationInfo(position.reducePrice, priceDp(position.contractId)).kind === 'none'"><span class="liq-none" :title="t('fut.noLiquidationHint')">--<Info :size="12" class="liq-info" :aria-label="t('fut.noLiquidationHint')" /></span></template><template v-else>{{ liquidationInfo(position.reducePrice, priceDp(position.contractId)).text }}</template></span></div>
              </div>
              <div class="pc-realized"><span>{{ t('fut.pos.realized') }} (USDT)</span><b class="num" :class="pnlView(position.realizedAmount, moneyDp).direction">{{ pnlView(position.realizedAmount, moneyDp).text }}</b></div>
              <div class="pc-acts">
                <button class="pos-act" type="button" @click="openLeverage(position)">{{ t('fut.pos.leverage') }}</button>
                <button class="pos-act" type="button" @click="tpslTarget = position">{{ t('fut.pos.tpsl') }}</button>
                <button class="pos-act" type="button" :disabled="account.busy !== null" @click="reverseTarget = position">{{ t('fut.pos.reverse') }}</button>
                <button class="pos-act" type="button" :data-testid="`fut-pos-card-close-${position.id}`" @click="openClose(position, 'market')">{{ t('fut.pos.close') }}</button>
              </div>
            </article>
          </div>
        </template>
      </template>

      <!-- Assets (Binance futures 资产 tab) -->
      <template v-else-if="tab === 'assets'">
        <StateBlock v-if="account.assetsLoading && !account.assetsLoaded" variant="loading" :message="t('common.loading')" />
        <StateBlock v-else-if="account.assetsError !== null && !account.assetsLoaded" variant="error" :message="account.assetsError" retryable @retry="load" />
        <StateBlock v-else-if="account.accounts.length === 0" variant="empty" />
        <div v-else v-vertical-scroll-boundary class="table-scroll as-scroll">
          <table class="table" data-testid="fut-assets-table">
            <thead>
              <tr>
                <th>{{ t('fut.as.asset') }}</th>
                <th :title="t('fut.as.hint')">{{ t('fut.as.wallet') }}</th>
                <th>{{ t('fut.as.unrealized') }}</th>
                <th>{{ t('fut.as.marginBalance') }}</th>
                <th>{{ t('fut.as.available') }}</th>
                <th>{{ t('fut.as.transferable') }}</th>
                <th>{{ t('fut.as.isolated') }}</th>
                <th>{{ t('fut.as.frozen') }}</th>
                <th>{{ t('fut.as.crossRatio') }}</th>
                <th>{{ t('fut.as.action') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in account.accounts" :key="entry.symbol">
                <td><b>{{ entry.symbol }}</b></td>
                <td class="num">{{ money(walletBalance(entry)) }}</td>
                <td class="num" :class="pnlView(entry.unRealizedAmount, moneyDp).direction">{{ entry.unRealizedAmount === '' ? '--' : pnlView(entry.unRealizedAmount, moneyDp).text }}</td>
                <td class="num">{{ money(entry.totalAmount) }}</td>
                <td class="num">{{ money(entry.canUseAmount) }}</td>
                <td class="num">{{ money(entry.transferableAmount || entry.canUseAmount) }}</td>
                <td class="num">{{ money(entry.isolateMargin) }}</td>
                <td class="num">{{ money(entry.lockAmount) }}</td>
                <td class="num">{{ rateView(entry.totalMarginRate) }}</td>
                <td><button class="link-act" type="button" data-testid="fut-assets-transfer" @click="transferOpen = true">{{ t('fut.as.transfer') }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- Phones: Binance app asset cards -->
        <div v-if="account.accounts.length > 0" class="as-cards">
          <article v-for="entry in account.accounts" :key="`card-${entry.symbol}`" class="pos-card" data-testid="fut-assets-card">
            <header class="pc-head"><b>{{ entry.symbol }}</b></header>
            <div class="pc-grid">
              <div><span class="k">{{ t('fut.as.marginBalance') }}</span><b class="v big num">{{ money(entry.totalAmount) }}</b></div>
              <div></div>
              <div class="r"><span class="k">{{ t('fut.as.unrealized') }}</span><b class="v big num" :class="pnlView(entry.unRealizedAmount, moneyDp).direction">{{ entry.unRealizedAmount === '' ? '--' : pnlView(entry.unRealizedAmount, moneyDp).text }}</b></div>
              <div><span class="k">{{ t('fut.as.wallet') }}</span><span class="v num">{{ money(walletBalance(entry)) }}</span></div>
              <div><span class="k">{{ t('fut.as.available') }}</span><span class="v num">{{ money(entry.canUseAmount) }}</span></div>
              <div class="r"><span class="k">{{ t('fut.as.transferable') }}</span><span class="v num">{{ money(entry.transferableAmount || entry.canUseAmount) }}</span></div>
              <div><span class="k">{{ t('fut.as.isolated') }}</span><span class="v num">{{ money(entry.isolateMargin) }}</span></div>
              <div><span class="k">{{ t('fut.as.frozen') }}</span><span class="v num">{{ money(entry.lockAmount) }}</span></div>
              <div class="r"><span class="k">{{ t('fut.as.crossRatio') }}</span><span class="v num">{{ rateView(entry.totalMarginRate) }}</span></div>
            </div>
            <div class="pc-acts one"><button class="pos-act" type="button" @click="transferOpen = true">{{ t('fut.as.transfer') }}</button></div>
          </article>
        </div>
      </template>

      <template v-else-if="list !== null">
        <ArchiveNotice v-if="archiveKind !== null && (hx.info.value?.hotFromMs ?? null) !== null" compact @export="exportOpen = true" />
        <StateBlock v-if="list.loading" variant="loading" :message="t('common.loading')" />
        <StateBlock v-else-if="list.error !== null && list.rows.length === 0" variant="error" :message="list.error" retryable @retry="load" />
        <StateBlock v-else-if="list.rows.length === 0" variant="empty" />
        <div v-else v-vertical-scroll-boundary class="table-scroll" :class="{ 'ph-scroll': listKey === 'positionHistory' }">
          <!-- Open / history orders -->
          <table v-if="listKey === 'current' || listKey === 'history'" class="table">
            <thead>
              <tr>
                <th>{{ t('fut.time') }}</th>
                <th>{{ t('fut.contract') }}</th>
                <th>{{ t('fut.side') }}</th>
                <th>{{ t('fut.type') }}</th>
                <th>{{ t('fut.price') }}</th>
                <th>{{ volumeHeader }}</th>
                <th>{{ sizes.header(t('fut.filled'), contract) }}</th>
                <th>{{ t('fut.avgPrice') }}</th>
                <th v-if="listKey === 'history'">{{ t('fut.realizedPnl') }}</th>
                <th>{{ listKey === 'current' ? t('fut.action') : t('fut.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in orders.lists[listKey].rows" :key="order.id" :class="{ pending: 'pending' in order && order.pending, canceling: orders.cancelingId === order.id }">
                <td class="num muted">{{ formatDateTime(order.ctime) }}</td>
                <td>{{ contractName(order.contractId, order.contractName) }}</td>
                <td :class="sideClass(order.side)">{{ sideText(order.side, order.open) }}</td>
                <td :data-testid="`fut-order-type-${order.id}`">{{ label('orderType', isMarketOrder(order) ? 2 : order.type) }}</td>
                <td class="num">{{ orderPrice(order.price, isMarketOrder(order) ? 2 : order.type, order.contractId) }}</td>
                <td class="num">{{ orderVolume(order) }}</td>
                <td class="num">{{ orderFilled(order) }}</td>
                <td class="num">{{ amountText(order.avgPrice, priceDp(order.contractId)) }}</td>
                <td v-if="listKey === 'history'" class="num" :class="pnlView(order.realizedAmount, coinDp).direction">{{ pnlView(order.realizedAmount, coinDp).text }}</td>
                <td v-if="listKey === 'current'">
                  <span v-if="'pending' in order && order.pending" class="muted row-state">{{ t('fut.submitting') }}</span>
                  <button v-else class="act danger" type="button" :disabled="orders.cancelingId !== null || isPendingId(order.id)" @click="cancel(order, false)">{{ orders.cancelingId === order.id ? t('fut.canceling') : t('fut.cancelOrder') }}</button>
                </td>
                <td v-else :title="order.liqPositionMsg || order.memo">{{ label('orderStatus', order.status) }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Conditional orders -->
          <table v-else-if="listKey === 'trigger' || listKey === 'historyTrigger'" class="table">
            <thead>
              <tr>
                <th>{{ t('fut.time') }}</th>
                <th>{{ t('fut.contract') }}</th>
                <th>{{ t('fut.side') }}</th>
                <th>{{ t('fut.type') }}</th>
                <th>{{ t('fut.triggerPrice') }}</th>
                <th>{{ t('fut.price') }}</th>
                <th>{{ volumeHeader }}</th>
                <th>{{ listKey === 'trigger' ? t('fut.expire') : t('fut.status') }}</th>
                <th v-if="listKey === 'trigger'">{{ t('fut.action') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in orders.lists[listKey].rows" :key="order.id">
                <td class="num muted">{{ formatDateTime(order.ctime) }}</td>
                <td>{{ contractName(order.contractId, order.contractName) }}</td>
                <td :class="sideClass(order.side)">{{ sideText(order.side, order.open) }}</td>
                <td>{{ label('trigType', order.triggerType) }}</td>
                <td class="num" data-testid="fut-trigger-cond">{{ triggerCondition(order) }}</td>
                <td class="num">{{ orderPrice(order.price, order.type, order.contractId) }}</td>
                <td class="num">{{ triggerVolume(order) }}</td>
                <td v-if="listKey === 'trigger'" class="num muted">{{ formatDateTime(order.expireTime) }}</td>
                <td v-else :title="order.memo">{{ label('trigStatus', order.status) }}</td>
                <td v-if="listKey === 'trigger'">
                  <button class="act danger" type="button" :disabled="orders.cancelingId !== null" @click="cancel(order, true)">{{ orders.cancelingId === order.id ? t('fut.canceling') : t('fut.cancelOrder') }}</button>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Trades -->
          <table v-else-if="listKey === 'trades'" class="table">
            <thead>
              <tr>
                <th>{{ t('fut.time') }}</th>
                <th>{{ t('fut.contract') }}</th>
                <th>{{ t('fut.side') }}</th>
                <th>{{ t('fut.price') }}</th>
                <th>{{ volumeHeader }}</th>
                <th>{{ t('fut.fee') }}</th>
                <th>{{ t('fut.role') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="trade in orders.lists.trades.rows" :key="trade.id">
                <td class="num muted">{{ formatDateTime(trade.ctime) }}</td>
                <td>{{ contractName(contract?.id ?? null, trade.contractName) }}</td>
                <td :class="sideClass(trade.side)">{{ sideText(trade.side, trade.open) }}<em v-if="trade.origType === 'MARKET'" class="type-chip" :data-testid="`fut-trade-market-${trade.id}`">{{ t('fut.market') }}</em></td>
                <td class="num">{{ amountText(trade.price, priceDp(contract?.id ?? null)) }}</td>
                <td class="num">{{ tradeVolume(trade) }}</td>
                <td class="num">{{ trade.fee === '' ? '--' : signedDisplay(trade.fee, coinDp, false) }} {{ trade.feeCoin }}</td>
                <td>{{ trade.role === 'maker' ? t('fut.maker') : trade.role === 'taker' ? t('fut.taker') : '--' }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Position history (closed positions of the selected contract) -->
          <table v-else-if="listKey === 'positionHistory'" class="table" data-testid="fut-poshist-table">
            <thead>
              <tr>
                <th>{{ t('fut.contract') }}</th>
                <th>{{ t('fut.ph.opened') }}</th>
                <th>{{ t('fut.ph.closed') }}</th>
                <th>{{ t('fut.ph.entry') }}</th>
                <th>{{ t('fut.ph.closeAvg') }}</th>
                <th>{{ sizes.header(t('fut.ph.maxSize'), contract) }}</th>
                <th>{{ t('fut.ph.pnl') }} ({{ contract?.marginCoin ?? '' }})</th>
                <th>{{ t('fut.ph.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in orders.lists.positionHistory.rows" :key="`${row.contractId}-${row.id}`">
                <td class="w-contract">
                  <span class="pos-name">
                    <i class="side-bar" :class="row.side === 'BUY' ? 'up-bg' : 'down-bg'"></i>
                    <b>{{ contractName(row.contractId) }}</b>
                  </span>
                  <span class="pos-tags">
                    <em class="num" :class="row.side === 'BUY' ? 'up' : 'down'">{{ row.side === 'BUY' ? t('fut.long') : t('fut.short') }}</em>
                    <em class="num">{{ row.positionType === 2 ? t('fut.isolated') : t('fut.cross') }} {{ row.leverageLevel ?? '--' }}x</em>
                  </span>
                </td>
                <td class="num muted">{{ formatDateTime(row.openedAt) }}</td>
                <td class="num muted">{{ formatDateTime(row.closedAt) }}</td>
                <td class="num">{{ amountText(row.openPrice, priceDp(row.contractId)) }}</td>
                <td class="num">{{ amountText(row.closePrice, priceDp(row.contractId)) }}</td>
                <td class="num">{{ closedSize(row) }}</td>
                <td class="num" :class="pnlView(row.realized, moneyDp).direction" :title="closedPnlHint(row)">{{ pnlView(row.realized, moneyDp).text }}</td>
                <td class="muted">{{ t('fut.ph.closedStatus') }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Transactions -->
          <table v-else class="table">
            <thead>
              <tr>
                <th>{{ t('fut.time') }}</th>
                <th>{{ t('fut.type') }}</th>
                <th>{{ t('fut.contract') }}</th>
                <th>{{ t('fut.amount') }} ({{ contract?.marginCoin ?? '' }})</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in orders.lists.transactions.rows" :key="`${row.id}-${index}`">
                <td class="num muted">{{ row.ctime || '--' }}</td>
                <td>{{ row.type || '--' }}</td>
                <td>{{ row.contractName || '--' }}</td>
                <td class="num" :class="pnlView(row.amount, coinDp).direction">{{ row.amount === '' ? '--' : signedDisplay(row.amount, coinDp) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- Phones: Binance app position-history cards -->
        <div v-if="listKey === 'positionHistory' && !list.loading && list.rows.length > 0" class="ph-cards">
          <article v-for="row in orders.lists.positionHistory.rows" :key="`card-${row.contractId}-${row.id}`" class="pos-card" data-testid="fut-poshist-card">
            <header class="pc-head">
              <em class="side-badge" :class="row.side === 'BUY' ? 'up-bg' : 'down-bg'">{{ row.side === 'BUY' ? t('fut.pos.long') : t('fut.pos.short') }}</em>
              <b>{{ contractName(row.contractId) }}</b>
              <em class="chip">{{ t('fut.pos.perp') }}</em>
              <em class="chip num">{{ row.positionType === 2 ? t('fut.isolated') : t('fut.cross') }} {{ row.leverageLevel ?? '--' }}x</em>
              <span class="ph-status">{{ t('fut.ph.closedStatus') }}</span>
            </header>
            <div class="pc-grid">
              <div><span class="k">{{ t('fut.ph.pnl') }} ({{ contractFor(row.contractId)?.marginCoin ?? 'USDT' }})</span><b class="v big num" :class="pnlView(row.realized, moneyDp).direction" :title="closedPnlHint(row)">{{ pnlView(row.realized, moneyDp).text }}</b></div>
              <div></div>
              <div class="r"><span class="k">{{ sizes.header(t('fut.ph.maxSize'), contract) }}</span><span class="v num">{{ closedSize(row) }}</span></div>
              <div><span class="k">{{ t('fut.ph.entry') }}</span><span class="v num">{{ amountText(row.openPrice, priceDp(row.contractId)) }}</span></div>
              <div></div>
              <div class="r"><span class="k">{{ t('fut.ph.closeAvg') }}</span><span class="v num">{{ amountText(row.closePrice, priceDp(row.contractId)) }}</span></div>
            </div>
            <div class="ph-times">
              <span>{{ t('fut.ph.opened') }} <b class="num">{{ formatDateTime(row.openedAt) }}</b></span>
              <span>{{ t('fut.ph.closed') }} <b class="num">{{ formatDateTime(row.closedAt) }}</b></span>
            </div>
          </article>
        </div>
        <p v-if="list.error !== null && list.rows.length > 0" class="field-error refresh-error wrap-anywhere">{{ list.error }}</p>
        <div v-if="list.rows.length > 0 && list.count > FUTURES_PAGE_SIZE" class="pager">
          <button class="btn btn-ghost" type="button" :disabled="list.page <= 1" @click="changePage(-1)">{{ t('common.prev') }}</button>
          <span class="muted num">{{ list.page }} / {{ totalPages }}</span>
          <button class="btn btn-ghost" type="button" :disabled="list.page >= totalPages" @click="changePage(1)">{{ t('common.next') }}</button>
        </div>
      </template>
    </div>

    <AdjustMarginDialog v-if="marginTarget !== null" :position="marginTarget" :coin="account.marginCoin" :precision="coinDp" @close="marginTarget = null" />
    <PositionCloseDialog v-if="closeTarget !== null" :key="`${closeTarget.id}-${closeKind}`" :position="closeTarget" :contract="contractFor(closeTarget.contractId)" :initial-kind="closeKind" @close="closeTarget = null" />
    <LeverageDialog v-if="leverageReady && contract" :current="account.leverage ?? leverageTarget?.leverageLevel ?? contract.minLever" :min="contract.minLever" :max="Math.min(contract.maxLever, account.config?.userMaxLevel ?? contract.maxLever)" @close="leverageTarget = null" />
    <ReverseDialog v-if="reverseTarget !== null" :position="reverseTarget" :contract-name="contractName(reverseTarget.contractId, reverseTarget.contractName)" :size="sizes.sizeWithUnit(reverseTarget.positionVolume, contractFor(reverseTarget.contractId), reverseTarget.markPrice)" @close="reverseTarget = null" />
    <ExportDialog :open="exportOpen" :kinds="FUTURES_EXPORTS" :initial-kind="archiveKind ?? 'futures_orders'" @close="exportOpen = false" />
    <!-- float-ok: not money (kebab-case prop names funds-in / funds-out) -->
    <TransferDialog v-if="transferOpen && contract" :coin="account.marginCoin" :precision="coinDp" :funds-in="contract.fundsIn" :funds-out="contract.fundsOut" @done="account.loadAssets()" @close="transferOpen = false" />
    <!-- float-ok: not money (kebab-case prop name price-precision) -->
    <TpslDialog v-if="tpslTarget !== null" :position="tpslTarget" :price-precision="priceDp(tpslTarget.contractId)" :quote="contractFor(tpslTarget.contractId)?.quote ?? 'USDT'" @close="tpslTarget = null" />
  </section>
</template>

<style scoped>
.ftabs { position: relative; border: 0; border-radius: 0; }
.type-chip { margin-left: 6px; padding: 0 4px; border-radius: var(--radius-sm); background: var(--color-surface-alt); color: var(--color-text-muted); font-size: 11px; font-style: normal; }
.ftabs-head { flex-wrap: wrap; gap: 8px; min-height: 44px; padding: 0 12px; }
.mobile-margin-edit { min-width: 28px; min-height: 28px; }
.ftabs-head .tabs { overflow-x: auto; overflow-y: hidden; gap: 2px; height: 44px; }
.ftabs-head .tab { position: relative; height: 44px; border-radius: 0; background: none; font-weight: 600; }
.ftabs-head .tab.active { background: none; }
.ftabs-head .tab.active::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; border-radius: 2px; background: var(--color-accent); }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--color-surface-alt); }
.seg button { height: 26px; padding: 0 10px; border-radius: 6px; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.seg button.active { background: var(--color-elevated); color: var(--color-text); }
.refresh { height: 30px; padding: 0 8px; }
.ftabs-body { display: flex; flex-direction: column; min-height: 206px; padding: 0 4px 6px; }
.ftabs-body > .state { flex: 1 1 auto; }
.table tbody tr.pending td, .table tbody tr.canceling td { opacity: 0.6; }
.refresh-error { margin: 6px 8px 0; }
.row-state { display: inline-block; height: 26px; line-height: 26px; font-size: 12px; }
.guest { min-height: 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--color-text-muted); font-size: 13px; }
.guest-actions { display: flex; gap: 8px; }
.guest-actions .btn { height: 34px; min-width: 88px; }
.table-scroll { max-height: 340px; overflow: auto; }
/*
 * Numbers are never truncated (2026-09-30, Binance): columns size to their content (auto layout, no ellipsis), the
 * table scrolls sideways inside its box when wider, and the contract column stays pinned on the left.
 */
.table { table-layout: auto; width: max-content; min-width: 100%; }
.table th { font-size: 11px; }
.table td { font-size: 12px; padding-top: 10px; padding-bottom: 10px; }
.table th, .table td { overflow: visible; text-overflow: clip; }
.table th:first-child, .table td:first-child { position: sticky; left: 0; z-index: 2; background: var(--color-surface); }
.table th:first-child { z-index: 3; }
.table tbody tr:hover td:first-child { background: linear-gradient(var(--color-hover), var(--color-hover)), var(--color-surface); }
.w-contract { width: 170px; }
/* Positions: Binance app fields; table on desktop, cards on phones (≤640px). Fixed widths, no reflow. */
.edit { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin-left: 4px; border-radius: 5px; color: var(--color-text-muted); vertical-align: -4px; }
.edit:hover { color: var(--color-accent); background: var(--color-surface-alt); }
.pos-hide { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: 12px; cursor: pointer; }
.side-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; color: #fff; font-size: 11px; font-style: normal; font-weight: 700; }
.unit-flip { display: inline-flex; align-items: center; gap: 3px; padding: 0; color: inherit; font: inherit; }
.unit-flip:hover { color: var(--color-accent); }
.w-mkt { width: 110px; white-space: nowrap; }
.w-tpsl { width: 170px; white-space: nowrap; }
.link-act { height: 24px; padding: 0 4px; color: var(--color-accent-text); font-size: 12px; font-weight: 650; }
.link-act:hover { text-decoration: underline; }
.pos-tags em.up { color: var(--color-up); background: var(--color-up-soft); }
.pos-tags em.down { color: var(--color-down); background: var(--color-down-soft); }
.pos-act { height: 28px; min-width: 72px; padding: 0 10px; border-radius: 6px; background: var(--color-surface-alt); color: var(--color-text); font-size: 12px; font-weight: 600; white-space: nowrap; }
.pos-act:hover { background: var(--color-hover); }
.pos-cards, .ph-cards, .as-cards { display: none; }
.ph-filter :deep(.ts-trigger) { height: 28px; font-size: 12px; }
.ph-status { margin-left: auto; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.ph-times { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--color-text-muted); font-size: 11px; }
.ph-times b { color: var(--color-text-secondary); font-weight: 500; }
@media (max-width: 640px) {
  .pos-table, .ph-scroll, .as-scroll { display: none; }
  .pos-cards, .ph-cards, .as-cards { display: flex; flex-direction: column; }
  .pc-acts.one { grid-template-columns: 1fr; }
  .pos-card { padding: 12px 8px 14px; border-bottom: 1px solid var(--color-border); }
  .pc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 15px; }
  .pc-head .chip { padding: 0 5px; border-radius: 4px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 10px; font-style: normal; font-weight: 650; line-height: 18px; }
  .pc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 8px; }
  .pc-grid > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .pc-grid .r { align-items: flex-end; text-align: right; }
  .pc-grid .k { color: var(--color-text-muted); font-size: 11px; }
  .pc-grid .v { font-size: 14px; font-variant-numeric: tabular-nums; }
  .pc-grid .v.big { font-size: 18px; font-weight: 700; }
  .pc-realized { display: flex; justify-content: space-between; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 8px; color: var(--color-text-muted); font-size: 12px; }
  .pc-acts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
  .pc-acts .pos-act { height: 34px; }
}
.pos-name { display: inline-flex; align-items: center; gap: 7px; }
.side-bar { width: 3px; height: 16px; border-radius: 2px; }
.up-bg { background: var(--color-up); }
.down-bg { background: var(--color-down); }
.pos-tags { display: flex; gap: 4px; margin-top: 4px; padding-left: 10px; }
.pos-tags em { padding: 0 5px; border-radius: 4px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 10px; font-style: normal; font-weight: 650; line-height: 17px; }
.pos-tags em.up { color: var(--color-up); background: var(--color-up-soft); }
.pos-tags em.down { color: var(--color-down); background: var(--color-down-soft); }
td.w-contract { white-space: normal; }
.warn { color: var(--color-warning); }
.roe { display: block; font-size: 11px; }
.liq-none { display: inline-flex; align-items: center; gap: 4px; color: var(--color-up); font-family: var(--font-sans); font-size: 12px; font-weight: 600; cursor: help; white-space: nowrap; }
.risk.safe { color: var(--color-up); }
.risk.warn { color: var(--color-warning); }
.risk.danger { color: var(--color-down); font-weight: 700; }
.acts { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.act { height: 26px; padding: 0 9px; border: 1px solid var(--color-border-strong); border-radius: 7px; font-size: 12px; color: var(--color-text-secondary); white-space: nowrap; }
.act:hover:not(:disabled) { color: var(--color-text); border-color: var(--color-text-muted); }
.act:disabled { opacity: 0.5; cursor: not-allowed; }
.act.danger { color: var(--color-down); border-color: var(--color-down-soft); }
.act.danger:hover:not(:disabled) { background: var(--color-down-soft); color: var(--color-down); }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 8px; font-size: 12px; }
.bulk { height: 28px; padding: 0 10px; font-size: 12px; font-weight: 650; color: var(--color-down); }
.bulk-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--color-border); background: var(--color-surface-alt); font-size: 13px; }
.bulk-go { background: var(--color-down); color: #fff; border-color: transparent; }
.liq-none { display: inline-flex; align-items: center; gap: 3px; cursor: help; }
.liq-info { color: var(--color-text-muted); }
</style>
