<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import RefreshBar from '@/components/common/RefreshBar.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { ClipboardList, RotateCw } from '@lucide/vue'
import { isPendingId, listPhase } from '@/core/swr'
import { toastError, toastInfo, toastSuccess } from '@/core/toast'
import { canonicalDecimal, groupDigits } from '@/modules/finance/decimal'
import { exactAmount } from '@/modules/margin/risk'
import { useMarketStore } from '@/stores/market'
import { useOrdersStore, type OrderSideFilter } from '@/stores/orders'
import { useSessionStore } from '@/stores/session'

type TabKey = 'open' | 'history' | 'trades'

const { t } = useI18n()
const orders = useOrdersStore()
const market = useMarketStore()
const sessionStore = useSessionStore()

const tab = ref<TabKey>('open')

const symbol = computed(() => market.currentSymbol)

const tabs = computed(() => [
  { key: 'open' as TabKey, label: t('trade.openOrders'), count: orders.openCount },
  { key: 'history' as TabKey, label: t('trade.historyOrders'), count: orders.historyCount },
  { key: 'trades' as TabKey, label: t('trade.myTrades'), count: orders.tradesCount },
])

const activePage = computed(() => {
  if (tab.value === 'open') {
    return orders.openPage
  }
  return tab.value === 'history' ? orders.historyPage : orders.tradesPage
})

const activeCount = computed(() => {
  if (tab.value === 'open') {
    return orders.openCount
  }
  return tab.value === 'history' ? orders.historyCount : orders.tradesCount
})

const activeLoading = computed(() => orders.loading[tab.value])
const activeError = computed(() => orders.errors[tab.value])
/** Stale-while-revalidate: rows stay while refetching; the loading block is for the first answer only. */
const phase = computed(() => listPhase({ rows: rows.value.length, loaded: orders.loaded[tab.value], error: activeError.value }))
const refreshing = computed(() => activeLoading.value && phase.value !== 'loading')
const totalPages = computed(() => Math.max(1, Math.ceil(activeCount.value / orders.pageSize)))

const rows = computed(() => {
  if (tab.value === 'open') {
    return orders.openOrders
  }
  return tab.value === 'history' ? orders.historyOrders : orders.myTrades
})

function price(value: string | undefined): string {
  const precision = symbol.value?.pricePrecision ?? 2
  const normalized = canonicalDecimal(value ?? '')
  return normalized === '' ? '--' : groupDigits(normalized, precision)
}

function amount(value: string | undefined): string {
  const precision = symbol.value?.volumePrecision ?? 8
  const normalized = canonicalDecimal(value ?? '')
  return normalized === '' ? '--' : groupDigits(normalized, Math.min(precision, 8))
}

function orderStatus(item: { status: number; status_text?: string }): string {
  const text = item.status_text
  if (typeof text === 'string' && text !== '') {
    return text
  }
  return t(`orderStatus.${String(item.status)}`)
}

function sideLabel(side: string | undefined): string {
  const normalized = (side ?? '').toUpperCase()
  if (normalized === 'BUY') {
    return t('common.buy')
  }
  if (normalized === 'SELL') {
    return t('common.sell')
  }
  return '--'
}

function typeLabel(type: number | undefined): string {
  return type === 2 ? t('trade.marketPrice') : t('trade.limitPrice')
}

function progress(item: { volume?: string; deal_volume?: string }): string {
  const volume = canonicalDecimal(item.volume ?? '')
  const dealt = canonicalDecimal(item.deal_volume ?? '')
  if (volume === '' || dealt === '') {
    return '--'
  }
  return `${amount(dealt)} / ${amount(volume)}`
}

async function load(): Promise<void> {
  if (tab.value === 'open') {
    await orders.loadOpenOrders()
  } else if (tab.value === 'history') {
    await orders.loadHistoryOrders()
  } else {
    await orders.loadMyTrades()
  }
}

/** The store removes the row on confirmation and runs the one follow-up refresh; a refusal is a toast. */
async function cancel(orderId: string): Promise<void> {
  const canceled = await orders.cancelOrder(orderId)
  if (!canceled) {
    const reason = orders.cancelError
    toastError(reason === null ? t('error.unknownResult') : /^(error|common)\./.test(reason) ? t(reason) : reason, 'spot-cancel')
  }
}

/** 全部撤单 of the current pair; the result is one toast (nothing is inserted into the panel). */
async function cancelAll(): Promise<void> {
  if (orders.openCount === 0) {
    toastInfo(t('trade.cancelAllNone'), 'spot-cancel-all')
    return
  }
  const { cancelled, failed } = await orders.cancelAll()
  const reason = orders.cancelError
  const text = reason === null ? '' : /^(error|common)\./.test(reason) ? t(reason) : reason
  if (failed === 0 && cancelled === 0 && text !== '') toastError(text, 'spot-cancel-all')
  else if (failed === 0) toastSuccess(t('trade.cancelAllDone', { n: cancelled }), 'spot-cancel-all')
  else toastError(t('trade.cancelAllPartial', { n: cancelled, failed, reason: text || t('error.unknownResult') }), 'spot-cancel-all')
}

function changeTab(next: TabKey): void {
  tab.value = next
  void load()
}

function changeSide(event: Event): void {
  const target = event.target as HTMLSelectElement
  orders.setSideFilter(target.value as OrderSideFilter)
  void load()
}

function changePage(delta: number): void {
  const next = activePage.value + delta
  if (next < 1 || next > totalPages.value) {
    return
  }
  orders.setPage(tab.value, next)
  void load()
}

function toggleShowCanceled(): void {
  orders.setShowCanceled(!orders.showCanceled)
  if (tab.value === 'history') {
    void load()
  }
}

onMounted(() => {
  void load()
})

watch(
  () => market.selectedPair,
  () => {
    orders.reset()
    if (sessionStore.isAuthenticated) {
      void load()
    }
  },
)

watch(
  () => sessionStore.isAuthenticated,
  (authenticated) => {
    if (authenticated) {
      void orders.refreshAll()
    } else {
      orders.reset()
    }
  },
)
</script>

<template>
  <section class="panel orders-panel">
    <RefreshBar :active="refreshing" />
    <header class="panel-header orders-header">
      <div class="tabs">
        <button
          v-for="entry in tabs"
          :key="entry.key"
          class="tab"
          :class="{ active: tab === entry.key }"
          type="button"
          @click="changeTab(entry.key)"
        >
          {{ entry.label }}
          <span v-if="entry.count > 0" class="muted">({{ entry.count }})</span>
        </button>
      </div>
      <div v-if="tab !== 'trades'" class="row order-filters">
        <select class="filter-select" :value="orders.sideFilter" @change="changeSide">
          <option value="">{{ t('trade.directionAll') }}</option>
          <option value="BUY">{{ t('common.buy') }}</option>
          <option value="SELL">{{ t('common.sell') }}</option>
        </select>
        <label v-if="tab === 'history'" class="checkbox">
          <input type="checkbox" :checked="orders.showCanceled" @change="toggleShowCanceled" />
          {{ t('trade.showCanceled') }}
        </label>
        <button
          v-if="tab === 'open' && sessionStore.isAuthenticated"
          class="btn btn-ghost cancel-all-btn"
          type="button"
          data-testid="spot-cancel-all"
          :disabled="orders.cancelingAll || orders.openCount === 0"
          @click="cancelAll"
        >
          {{ t('trade.cancelAll') }}
        </button>
      </div>
      <button class="btn btn-ghost orders-refresh" type="button" :title="t('common.refresh')" :aria-label="t('common.refresh')" :disabled="activeLoading" @click="load">
        <RotateCw :size="15" />
      </button>
    </header>

    <div class="panel-body orders-body">
      <div v-if="!sessionStore.isAuthenticated" class="orders-guest">
        <ClipboardList :size="34" :stroke-width="1.3" aria-hidden="true" />
        <span>{{ t('trade.loginToView') }}</span>
        <div class="guest-actions">
          <RouterLink class="btn btn-primary" to="/login">{{ t('nav.login') }}</RouterLink>
          <RouterLink class="btn" to="/register">{{ t('trade.register') }}</RouterLink>
        </div>
      </div>
      <StateBlock v-else-if="phase === 'loading'" variant="loading" :message="t('common.loading')" />
      <StateBlock
        v-else-if="phase === 'error'"
        variant="error"
        :message="activeError ?? ''"
        retryable
        @retry="load"
      />
      <StateBlock v-else-if="phase === 'empty'" variant="empty" />

      <div v-else v-vertical-scroll-boundary class="table-scroll">
        <table class="table" :class="`rows-${tab}`">
          <thead>
            <tr v-if="tab === 'open'">
              <th>{{ t('trade.orderTime') }}</th>
              <th>{{ t('trade.side') }}</th>
              <th>{{ t('trade.type') }}</th>
              <th>{{ t('common.price') }}</th>
              <th>{{ t('common.amount') }}</th>
              <th>{{ t('trade.filled') }}</th>
              <th>{{ t('trade.filledRatio') }}</th>
              <th>{{ t('trade.action') }}</th>
            </tr>
            <tr v-else-if="tab === 'history'">
              <th>{{ t('trade.orderTime') }}</th>
              <th>{{ t('trade.side') }}</th>
              <th>{{ t('trade.type') }}</th>
              <th>{{ t('common.price') }}</th>
              <th>{{ t('common.amount') }}</th>
              <th>{{ t('trade.filled') }}</th>
              <th>{{ t('trade.status') }}</th>
            </tr>
            <tr v-else>
              <th>{{ t('trade.orderTime') }}</th>
              <th>{{ t('trade.side') }}</th>
              <th>{{ t('common.price') }}</th>
              <th>{{ t('common.amount') }}</th>
              <th>{{ t('common.total') }}</th>
              <th>{{ t('trade.fee') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="tab === 'open'">
              <tr v-for="item in orders.openOrders" :key="item.id" :class="{ pending: item.pending, canceling: orders.cancelingIds.has(item.id) }">
                <td class="c-time num muted">{{ item.created_at ?? '--' }}</td>
                <td :data-label="t('trade.side')" data-cell="c-side" :class="(item.side ?? '').toUpperCase() === 'BUY' ? 'up' : 'down'">{{ sideLabel(item.side) }}</td>
                <td :data-label="t('trade.type')" data-cell="c-type">{{ typeLabel(item.type) }}</td>
                <td :data-label="t('common.price')" class="num">{{ item.type === 2 ? t('trade.marketPrice') : price(item.price) }}</td>
                <td :data-label="t('common.amount')" class="num">{{ amount(item.volume) }}</td>
                <td :data-label="t('trade.filled')" class="num">{{ exactAmount(item.deal_volume) }}</td>
                <td :data-label="t('trade.filledRatio')" class="num">{{ progress(item) }}</td>
                <td data-cell="c-act">
                  <span v-if="item.pending" class="muted row-state">{{ t('trade.submitting') }}</span>
                  <button
                    v-else-if="!(item.isCloseCancelOrder === true || item.isCloseCancelOrder === 1 || item.isCloseCancelOrder === '1')"
                    class="btn btn-ghost cancel-btn"
                    type="button"
                    :disabled="orders.cancelingIds.has(item.id) || isPendingId(item.id)"
                    @click="cancel(item.id)"
                  >
                    {{ orders.cancelingIds.has(item.id) ? t('trade.canceling') : t('trade.cancelOrder') }}
                  </button>
                  <span v-else class="muted">--</span>
                </td>
              </tr>
            </template>
            <template v-else-if="tab === 'history'">
              <tr v-for="item in orders.historyOrders" :key="item.id">
                <td class="c-time num muted">{{ item.created_at ?? '--' }}</td>
                <td :data-label="t('trade.side')" data-cell="c-side" :class="(item.side ?? '').toUpperCase() === 'BUY' ? 'up' : 'down'">{{ sideLabel(item.side) }}</td>
                <td :data-label="t('trade.type')" data-cell="c-type">{{ typeLabel(item.type) }}</td>
                <td :data-label="t('common.price')" class="num">{{ item.type === 2 ? t('trade.marketPrice') : price(item.price) }}</td>
                <td :data-label="t('common.amount')" class="num">{{ amount(item.volume) }}</td>
                <td :data-label="t('trade.filled')" class="num">{{ exactAmount(item.deal_volume) }}</td>
                <td :data-label="t('trade.status')" data-cell="c-status">{{ orderStatus(item) }}</td>
              </tr>
            </template>
            <template v-else>
              <tr v-for="trade in orders.myTrades" :key="String(trade.id)">
                <td class="c-time num muted">{{ trade.ctime ?? '--' }}</td>
                <td :data-label="t('trade.side')" data-cell="c-side" :class="(trade.side ?? '').toUpperCase() === 'BUY' ? 'up' : 'down'">{{ sideLabel(trade.side) }}</td>
                <td :data-label="t('common.price')" class="num">{{ price(trade.price) }}</td>
                <td :data-label="t('common.amount')" class="num">{{ exactAmount(trade.volume) }}</td>
                <td :data-label="t('common.total')" class="num">{{ exactAmount(trade.deal_price) }}</td>
                <td :data-label="t('trade.fee')" class="num">{{ exactAmount(trade.fee) }} {{ trade.feeCoin ?? '' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <p v-if="phase === 'ready' && activeError !== null" class="field-error refresh-error wrap-anywhere">{{ activeError }}</p>

      <!-- The pager keeps its place (hidden, not removed) so an empty ↔ one-row change never moves the panel. -->
      <div v-if="sessionStore.isAuthenticated" class="pager" :class="{ idle: rows.length === 0 }">
        <button class="btn btn-ghost" type="button" :disabled="activePage <= 1" @click="changePage(-1)">
          {{ t('common.prev') }}
        </button>
        <span class="muted">{{ t('common.page', { page: activePage, total: activeCount }) }}</span>
        <button class="btn btn-ghost" type="button" :disabled="activePage >= totalPages" @click="changePage(1)">
          {{ t('common.next') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.orders-panel { position: relative; border: 0; border-radius: 0; }
.orders-header { flex-wrap: wrap; gap: 8px; min-height: 44px; padding: 0 12px; }
.orders-header .tabs { gap: 2px; height: 44px; }
.orders-header .tab { position: relative; height: 44px; border-radius: 0; background: none; font-weight: 600; }
.orders-header .tab.active { background: none; }
.order-filters { margin-left: auto; }
.orders-header .tab.active::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.orders-body { display: flex; flex-direction: column; min-height: 206px; padding: 0 4px 6px; }
.orders-body > .state { flex: 1 1 auto; }
.table-scroll .table tbody tr { height: 39px; }
.table-scroll .table tbody tr.pending td { opacity: 0.6; }
.table-scroll .table tbody tr.canceling td { opacity: 0.55; }
.row-state { display: inline-block; height: 26px; line-height: 26px; font-size: 12px; }
.refresh-error { margin: 6px 8px 0; }
.orders-guest { min-height: 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--color-text-muted); font-size: 13px; }
.guest-actions { display: flex; gap: 8px; }
.guest-actions .btn { height: 34px; min-width: 88px; }
.table-scroll { max-height: 320px; overflow: auto; }
.table-scroll .table th { font-size: 11px; }
.table-scroll .table td { font-size: 12px; padding-top: 10px; padding-bottom: 10px; }
.filter-select {
  height: 28px; padding: 0 8px; border: 1px solid var(--color-border-strong); border-radius: 8px;
  background: var(--color-surface-alt); font-size: 12px;
}
.checkbox { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-secondary); white-space: nowrap; }
.checkbox input { accent-color: var(--color-accent); }
.cancel-all-btn { height: 28px; padding: 0 10px; font-size: 12px; color: var(--color-down); white-space: nowrap; }
.cancel-all-btn:hover:not(:disabled) { background: var(--color-down-soft); color: var(--color-down); }
.cancel-btn { height: 26px; padding: 0 10px; font-size: 12px; color: var(--color-down); border: 1px solid var(--color-down-soft); }
.cancel-btn:hover:not(:disabled) { background: var(--color-down-soft); color: var(--color-down); }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: auto; padding: 8px; font-size: 12px; }
.pager.idle { visibility: hidden; }

@media (max-width: 768px) {
  .orders-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  .orders-header .tabs {
    grid-area: 1 / 1;
    height: auto;
    padding-bottom: 2px; /* Keep both skins' active underlines inside the scrollport. */
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .orders-header .tab { flex: none; }
  .orders-refresh { grid-area: 1 / 2; }
  .order-filters { grid-area: 2 / 1 / 3 / -1; margin-left: 0; flex-wrap: wrap; padding-bottom: 6px; }
  .table-scroll { min-width: 0; max-width: 100%; overscroll-behavior-x: none; }
  .table-scroll .table { table-layout: auto; width: max-content; min-width: 100%; }
}
/* Phones (≤720px, owner 2026-11-17): each order is a card — time with side and type on the first line, then the
   figures in three labelled columns; no sideways scrolling. */
@media (max-width: 720px) {
  .table-scroll .table { display: block; width: 100%; min-width: 0; }
  .table thead { display: none; }
  .table-scroll { max-height: none; overflow: visible; }
  .table-scroll .table tbody tr { height: auto; }
  .table tbody { display: block; }
  .table-scroll .table tbody tr { position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px; padding: 12px 14px 13px; border-bottom: 1px solid var(--color-border); }
  .table-scroll .table tbody td { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 0; border: 0; font-size: 13.500px; font-weight: 600; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .table-scroll .table tbody td::before { content: attr(data-label); color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; font-weight: 500; }
  .table-scroll .table tbody td.c-time, .table-scroll .table tbody td[data-cell='c-time'] { grid-column: 1 / -1; order: -3; flex-direction: row; padding-left: 96px; color: var(--color-text-muted); font-size: 11.500px; font-weight: 500; line-height: 22px; }
  .table-scroll .table tbody td.c-time::before, .table-scroll .table tbody td[data-cell]::before { content: none; }
  .table-scroll .table tbody td[data-cell='c-side'], .table-scroll .table tbody td[data-cell='c-type'] { position: absolute; top: 12px; height: 22px; flex-direction: row; align-items: center; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 700; }
  .table-scroll .table tbody td[data-cell='c-side'] { left: 14px; }
  .table-scroll .table tbody td[data-cell='c-side'].up { background: var(--color-up-soft); } .table tbody td[data-cell='c-side'].down { background: var(--color-down-soft); }
  .table-scroll .table tbody td[data-cell='c-type'] { left: 58px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-weight: 600; }
  .table-scroll .rows-trades tbody td.c-time, .table-scroll .rows-trades tbody td[data-cell='c-time'] { padding-left: 50px; }
  .table-scroll .table tbody td[data-cell='c-act'] { position: absolute; top: 9px; right: 12px; }
  .table-scroll .table tbody td[data-cell='c-act'] .cancel-btn { height: 28px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 999px; font-size: 12px; }
  .table-scroll .table tbody td[data-cell='c-status'] { color: var(--color-text-secondary); }
}
</style>
