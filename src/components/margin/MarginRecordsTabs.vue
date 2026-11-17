<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed, ref, shallowRef, watch } from 'vue'
import { ClipboardList, RotateCw } from '@lucide/vue'
import RefreshBar from '@/components/common/RefreshBar.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isPendingId, listPhase } from '@/core/swr'
import { toastError } from '@/core/toast'
import OrderFillsDrawer from '@/components/orders/OrderFillsDrawer.vue'
import { formatDateTime } from '@/components/orders/model'
import type { OrderItem } from '@/modules/api/types'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { fetchRepayments } from '@/modules/margin/api'
import { useMarginI18n } from '@/modules/margin/i18n'
import { displayAmount, formatDailyRate } from '@/modules/margin/risk'
import type { RepaymentRecord } from '@/modules/margin/types'
import { useMarginStore } from '@/stores/margin'
import { useMarginOrdersStore } from '@/stores/marginOrders'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

type TabKey = 'open' | 'history' | 'trades' | 'borrowOpen' | 'borrowHistory' | 'transfers'

const emit = defineEmits<{ (event: 'repay', id: string): void }>()

const { t } = useMarginI18n()
const margin = useMarginStore()
const orders = useMarginOrdersStore()
const market = useMarketStore()
const sessionStore = useSessionStore()

const tab = ref<TabKey>('open')
const fillsOrder = shallowRef<OrderItem | null>(null)
const expandedLoan = ref<string | null>(null)
const repayments = shallowRef<RepaymentRecord[]>([])
const repaymentsLoading = ref(false)
const repaymentsError = ref<string | null>(null)

const symbol = computed(() => market.currentSymbol)
const pricePrecision = computed(() => symbol.value?.pricePrecision ?? 2)
const volumePrecision = computed(() => Math.min(symbol.value?.volumePrecision ?? 8, 8))

const tabs = computed(() => [
  { key: 'open' as TabKey, label: t('margin.tabs.open'), count: orders.counts.open },
  { key: 'history' as TabKey, label: t('margin.tabs.history'), count: 0 },
  { key: 'trades' as TabKey, label: t('margin.tabs.trades'), count: 0 },
  { key: 'borrowOpen' as TabKey, label: t('margin.tabs.borrowOpen'), count: margin.borrowCounts.open },
  { key: 'borrowHistory' as TabKey, label: t('margin.tabs.borrowHistory'), count: 0 },
  { key: 'transfers' as TabKey, label: t('margin.tabs.transfers'), count: 0 },
])

const filledOrders = computed(() => orders.lists.history.filter(order => isPositive(order.deal_volume ?? '')))

const state = computed(() => {
  switch (tab.value) {
    case 'open': return { loading: orders.loading.open, loaded: orders.loaded.open, error: orders.errors.open, count: orders.counts.open, page: orders.pages.open, size: orders.pageSize, empty: orders.lists.open.length === 0 }
    case 'history': return { loading: orders.loading.history, loaded: orders.loaded.history, error: orders.errors.history, count: orders.counts.history, page: orders.pages.history, size: orders.pageSize, empty: orders.lists.history.length === 0 }
    case 'trades': return { loading: orders.loading.history, loaded: orders.loaded.history, error: orders.errors.history, count: orders.counts.history, page: orders.pages.history, size: orders.pageSize, empty: filledOrders.value.length === 0 }
    case 'borrowOpen': return { loading: margin.borrowLoading.open, loaded: !margin.borrowLoading.open, error: margin.borrowErrors.open, count: margin.borrowCounts.open, page: margin.borrowPages.open, size: margin.pageSize, empty: margin.borrows.open.length === 0 }
    case 'borrowHistory': return { loading: margin.borrowLoading.history, loaded: !margin.borrowLoading.history, error: margin.borrowErrors.history, count: margin.borrowCounts.history, page: margin.borrowPages.history, size: margin.pageSize, empty: margin.borrows.history.length === 0 }
    default: return { loading: margin.transferLoading, loaded: !margin.transferLoading, error: margin.transferError, count: margin.transferCount, page: margin.transferPage, size: margin.pageSize, empty: margin.transfers.length === 0 }
  }
})
/** Stale-while-revalidate (`@/core/swr`): rows stay during a refetch; the loading block only before the first answer. */
const phase = computed(() => listPhase({ rows: state.value.empty ? 0 : 1, loaded: state.value.loaded, error: state.value.error }))
const pages = computed(() => Math.max(1, Math.ceil(state.value.count / state.value.size)))

function show(value: string | undefined, dp: number): string {
  const normalized = canonicalDecimal(value ?? '')
  return isDecimalString(normalized) ? groupDigits(normalized, dp) : '--'
}

function sideLabel(side: string): string {
  return side.toUpperCase() === 'BUY' ? t('common.buy') : side.toUpperCase() === 'SELL' ? t('common.sell') : '--'
}

function statusLabel(order: OrderItem): string {
  return order.status_text !== undefined && order.status_text !== '' ? order.status_text : t(`orderStatus.${order.status}`)
}

async function load(): Promise<void> {
  if (!sessionStore.isAuthenticated || margin.currentSymbol === '') return
  switch (tab.value) {
    case 'open': await orders.load('open'); break
    case 'history':
    case 'trades': await orders.load('history'); break
    case 'borrowOpen': await margin.loadBorrows('open'); break
    case 'borrowHistory': await margin.loadBorrows('history'); break
    default: await margin.loadTransfers()
  }
}

function changeTab(next: TabKey): void {
  tab.value = next
  expandedLoan.value = null
  void load()
}

function changePage(delta: number): void {
  const next = state.value.page + delta
  if (next < 1 || next > pages.value) return
  if (tab.value === 'open') orders.setPage('open', next)
  else if (tab.value === 'history' || tab.value === 'trades') orders.setPage('history', next)
  else if (tab.value === 'borrowOpen') margin.setBorrowPage('open', next)
  else if (tab.value === 'borrowHistory') margin.setBorrowPage('history', next)
  else margin.setTransferPage(next)
  void load()
}

/** The store drops the row on confirmation and runs the one follow-up refresh; a refusal is a toast. */
async function cancel(id: string): Promise<void> {
  if (!(await orders.cancel(id))) {
    const reason = orders.cancelError
    toastError(reason === null ? t('error.unknownResult') : /^(error|common)\./.test(reason) ? t(reason) : reason, 'margin-cancel')
  }
}

async function toggleRepayments(id: string): Promise<void> {
  if (expandedLoan.value === id) {
    expandedLoan.value = null
    return
  }
  expandedLoan.value = id
  repayments.value = []
  repaymentsError.value = null
  repaymentsLoading.value = true
  try {
    const list = await fetchRepayments(id)
    if (expandedLoan.value === id) repayments.value = list
  } catch (error_) {
    if (expandedLoan.value === id) repaymentsError.value = error_ instanceof Error ? error_.message : String(error_)
  } finally {
    if (expandedLoan.value === id) repaymentsLoading.value = false
  }
}

watch(() => [market.selectedPair, sessionStore.isAuthenticated, margin.currentSymbol], () => {
  expandedLoan.value = null
  void load()
}, { immediate: true })

defineExpose({ load })
</script>

<template>
  <section class="records">
    <RefreshBar :active="state.loading && phase !== 'loading'" />
    <header class="records-head">
      <div class="tabs" role="tablist">
        <button
          v-for="entry in tabs"
          :key="entry.key"
          class="tab"
          :class="{ active: tab === entry.key }"
          type="button"
          role="tab"
          :aria-selected="tab === entry.key"
          @click="changeTab(entry.key)"
        >
          {{ entry.label }}<span v-if="entry.count > 0" class="muted"> ({{ entry.count }})</span>
        </button>
      </div>
      <button class="btn btn-ghost refresh" type="button" :aria-label="t('common.refresh')" :title="t('common.refresh')" :disabled="state.loading" @click="load"><RotateCw :size="15" /></button>
    </header>

    <div class="records-body">
      <div v-if="!sessionStore.isAuthenticated" class="guest">
        <ClipboardList :size="34" :stroke-width="1.3" aria-hidden="true" />
        <span>{{ t('margin.loginToTrade') }}</span>
        <div class="guest-actions">
          <RouterLink class="btn btn-primary" to="/login">{{ t('nav.login') }}</RouterLink>
          <RouterLink class="btn" to="/register">{{ t('nav.register') }}</RouterLink>
        </div>
      </div>
      <template v-else>
        <p v-if="tab === 'trades'" class="note">{{ t('margin.tradesNote') }}</p>
        <StateBlock v-if="phase === 'loading'" variant="loading" :message="t('common.loading')" />
        <StateBlock v-else-if="phase === 'error'" variant="error" :message="state.error ?? ''" retryable @retry="load" />
        <StateBlock v-else-if="phase === 'empty'" variant="empty" />
        <div v-else v-vertical-scroll-boundary class="table-scroll">
          <table class="table">
            <thead>
              <tr v-if="tab === 'open' || tab === 'history'">
                <th>{{ t('margin.col.time') }}</th><th>{{ t('trade.side') }}</th><th>{{ t('trade.type') }}</th><th>{{ t('common.price') }}</th>
                <th>{{ t('common.amount') }}</th><th>{{ t('trade.filled') }}</th><th>{{ t('margin.col.avgPrice') }}</th>
                <th>{{ tab === 'open' ? t('margin.col.action') : t('margin.col.status') }}</th>
              </tr>
              <tr v-else-if="tab === 'trades'">
                <th>{{ t('margin.col.time') }}</th><th>{{ t('trade.side') }}</th><th>{{ t('margin.col.avgPrice') }}</th><th>{{ t('trade.filled') }}</th>
                <th>{{ t('margin.col.dealMoney') }}</th><th>{{ t('margin.col.status') }}</th><th>{{ t('margin.col.detail') }}</th>
              </tr>
              <tr v-else-if="tab === 'borrowOpen' || tab === 'borrowHistory'">
                <th>{{ t('margin.col.time') }}</th><th>{{ t('margin.col.coin') }}</th><th>{{ t('margin.col.borrowMoney') }}</th><th>{{ t('margin.col.rate') }}</th>
                <th v-if="tab === 'borrowOpen'">{{ t('margin.col.oweAmount') }}</th>
                <th>{{ tab === 'borrowOpen' ? t('margin.col.oweInterest') : t('margin.col.interest') }}</th>
                <th>{{ t('margin.col.status') }}</th><th>{{ t('margin.col.action') }}</th>
              </tr>
              <tr v-else>
                <th>{{ t('margin.col.time') }}</th><th>{{ t('margin.col.pair') }}</th><th>{{ t('margin.col.coin') }}</th><th>{{ t('margin.col.direction') }}</th><th>{{ t('margin.col.amount') }}</th>
              </tr>
            </thead>
            <tbody v-if="tab === 'open' || tab === 'history'">
              <tr v-for="order in orders.lists[tab]" :key="order.id" :class="{ pending: order.pending, canceling: orders.cancelingIds.has(order.id) }">
                <td class="num muted">{{ order.created_at ?? formatDateTime(order.time_long) }}</td>
                <td :class="order.side === 'BUY' ? 'up' : 'down'">{{ sideLabel(order.side) }}</td>
                <td>{{ order.type === 2 ? t('trade.marketPrice') : t('trade.limitPrice') }}</td>
                <td class="num">{{ order.type === 2 ? t('trade.marketPrice') : show(order.price, pricePrecision) }}</td>
                <td class="num">{{ show(order.volume, volumePrecision) }}</td>
                <td class="num">{{ show(order.deal_volume, volumePrecision) }}</td>
                <td class="num">{{ isPositive(order.avg_price ?? '') ? show(order.avg_price, pricePrecision) : '--' }}</td>
                <td v-if="tab === 'open'">
                  <span v-if="order.pending" class="muted row-state">{{ t('trade.submitting') }}</span>
                  <button v-else class="btn btn-ghost cancel-btn" type="button" :disabled="orders.cancelingIds.has(order.id) || isPendingId(order.id)" @click="cancel(order.id)">
                    {{ orders.cancelingIds.has(order.id) ? t('trade.canceling') : t('trade.cancelOrder') }}
                  </button>
                </td>
                <td v-else>
                  <button class="link-btn" type="button" @click="fillsOrder = order">{{ statusLabel(order) }}</button>
                </td>
              </tr>
            </tbody>
            <tbody v-else-if="tab === 'trades'">
              <tr v-for="order in filledOrders" :key="order.id">
                <td class="num muted">{{ order.created_at ?? formatDateTime(order.time_long) }}</td>
                <td :class="order.side === 'BUY' ? 'up' : 'down'">{{ sideLabel(order.side) }}</td>
                <td class="num">{{ show(order.avg_price, pricePrecision) }}</td>
                <td class="num">{{ show(order.deal_volume, volumePrecision) }}</td>
                <td class="num">{{ displayAmount(order.deal_money) }}</td>
                <td>{{ statusLabel(order) }}</td>
                <td><button class="link-btn" type="button" @click="fillsOrder = order">{{ t('margin.col.detail') }}</button></td>
              </tr>
            </tbody>
            <tbody v-else-if="tab === 'borrowOpen' || tab === 'borrowHistory'">
              <template v-for="loan in (tab === 'borrowOpen' ? margin.borrows.open : margin.borrows.history)" :key="loan.id">
                <tr>
                  <td class="num muted">{{ formatDateTime(loan.ctime) }}</td>
                  <td>{{ loan.coin }}</td>
                  <td class="num">{{ displayAmount(loan.borrowMoney) }}</td>
                  <td class="num">{{ formatDailyRate(loan.interestRate) }}</td>
                  <td v-if="tab === 'borrowOpen'" class="num">{{ displayAmount(loan.oweAmount) }}</td>
                  <td class="num">{{ displayAmount(tab === 'borrowOpen' ? loan.oweInterest : loan.interest) }}</td>
                  <td>{{ t(`margin.borrowStatus.${loan.status}`) }}</td>
                  <td class="actions-cell">
                    <button v-if="tab === 'borrowOpen'" class="link-btn" type="button" @click="emit('repay', loan.id)">{{ t('margin.repay') }}</button>
                    <button class="link-btn muted-link" type="button" :aria-expanded="expandedLoan === loan.id" @click="toggleRepayments(loan.id)">{{ t('margin.repayments') }}</button>
                  </td>
                </tr>
                <tr v-if="expandedLoan === loan.id" class="sub-row">
                  <td :colspan="tab === 'borrowOpen' ? 8 : 7">
                    <StateBlock v-if="repaymentsLoading" variant="loading" :message="t('common.loading')" />
                    <StateBlock v-else-if="repaymentsError !== null" variant="error" :message="repaymentsError" />
                    <StateBlock v-else-if="repayments.length === 0" variant="empty" />
                    <ul v-else class="repay-list">
                      <li v-for="(entry, index) in repayments" :key="index">
                        <span class="num muted">{{ formatDateTime(entry.repaymentTime) }}</span>
                        <span>{{ t(`margin.repayType.${entry.type}`) }}</span>
                        <span class="num">{{ displayAmount(entry.returnMoney) }} {{ entry.coin }}</span>
                      </li>
                    </ul>
                  </td>
                </tr>
              </template>
            </tbody>
            <tbody v-else>
              <tr v-for="(record, index) in margin.transfers" :key="index">
                <td class="num muted">{{ formatDateTime(record.createTime) }}</td>
                <td>{{ record.showName !== '' ? record.showName : record.symbol }}</td>
                <td>{{ record.coinSymbol }}</td>
                <td :class="record.transferType === 1 ? 'up' : 'down'">{{ record.transferType === 1 ? t('margin.transferIn') : t('margin.transferOut') }}</td>
                <td class="num">{{ displayAmount(record.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="phase === 'ready' && state.error !== null" class="field-error refresh-error wrap-anywhere">{{ state.error }}</p>
        <!-- Kept in place (hidden) when there is nothing to page, so the panel height does not jump. -->
        <div class="pager" :class="{ idle: phase !== 'ready' }">
          <button class="btn btn-ghost" type="button" :disabled="state.page <= 1 || state.loading" @click="changePage(-1)">{{ t('common.prev') }}</button>
          <span class="muted">{{ t('common.page', { page: state.page, total: state.count }) }}</span>
          <button class="btn btn-ghost" type="button" :disabled="state.page >= pages || state.loading" @click="changePage(1)">{{ t('common.next') }}</button>
        </div>
      </template>
    </div>

    <OrderFillsDrawer
      :open="fillsOrder !== null"
      kind="margin"
      :symbol="margin.currentSymbol"
      :pair="market.selectedPair"
      :order="fillsOrder"
      :pricePrecision="pricePrecision"
      :volumePrecision="volumePrecision"
      @close="fillsOrder = null"
    />
  </section>
</template>

<style scoped>
.records { position: relative; background: var(--color-surface); }
.records-head { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--color-border); }
.records-head .tabs { flex: 1 1 auto; height: 44px; gap: 2px; }
.records-head .tab { position: relative; height: 44px; border-radius: 0; background: none; font-weight: 600; }
.records-head .tab.active { background: none; }
.records-head .tab.active::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.refresh { height: 32px; padding: 0 10px; }
.records-body { display: flex; flex-direction: column; min-height: 206px; padding: 0 4px 6px; }
.records-body > .state { flex: 1 1 auto; }
.table tbody tr.pending td, .table tbody tr.canceling td { opacity: 0.6; }
.row-state { display: inline-block; height: 26px; line-height: 26px; font-size: 12px; }
.refresh-error { margin: 6px 8px 0; }
.note { margin: 10px 10px 0; color: var(--color-text-muted); font-size: 12px; }
.guest { min-height: 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--color-text-muted); font-size: 13px; }
.guest-actions { display: flex; gap: 8px; }
.guest-actions .btn { height: 34px; min-width: 88px; }
.table-scroll { max-height: 340px; overflow: auto; }
.table { min-width: 760px; table-layout: auto; }
.table th { font-size: 11px; }
.table td { font-size: 12px; padding-top: 10px; padding-bottom: 10px; }
.cancel-btn { height: 26px; padding: 0 10px; font-size: 12px; color: var(--color-down); border: 1px solid var(--color-down-soft); }
.cancel-btn:hover:not(:disabled) { background: var(--color-down-soft); color: var(--color-down); }
.link-btn { color: var(--color-accent-text); font-size: 12px; font-weight: 600; }
.link-btn:hover { text-decoration: underline; }
.muted-link { color: var(--color-text-secondary); }
.actions-cell { white-space: nowrap; }
.actions-cell .link-btn + .link-btn { margin-left: 12px; }
.sub-row td { background: var(--color-surface-alt); text-align: left; }
.repay-list { display: grid; gap: 6px; margin: 0; padding: 4px 8px; list-style: none; }
.repay-list li { display: grid; grid-template-columns: 170px 1fr auto; gap: 12px; font-size: 12px; }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: auto; padding: 8px; font-size: 12px; }
.pager.idle { visibility: hidden; }

@media (max-width: 768px) {
  .records-head .tabs { overflow-y: hidden; }
  .records-head .tab.active::after { bottom: 0; }
  .records-head .tabs, .table-scroll {
    min-width: 0;
    max-width: 100%;
    overscroll-behavior-x: none;
  }
}
</style>
