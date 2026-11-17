<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronRight, ClipboardList } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import OtcPager from '@/components/otc/OtcPager.vue'
import OtcStatusBadge from '@/components/otc/OtcStatusBadge.vue'
import OtcSubnav from '@/components/otc/OtcSubnav.vue'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { fetchMyOrders, type OtcOrderRow } from '@/modules/otc/api'
import { coinDpFor, fiatDpFor } from '@/modules/otc/coins'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { ORDER_TABS, orderTabQuery, type OrderTabId } from '@/modules/otc/order-state'
import { useOtcStore } from '@/stores/otc'
import { useSessionStore } from '@/stores/session'

/**
 * My C2C orders (exchange-web-api `order/otc/bystatus` OrderAct.java:1516 per status, and
 * `order/otc/complete` OrderAct.java:1473 for the finished bucket).
 */
const PAGE_SIZE = 10
const { t } = useOtcI18n()
const otc = useOtcStore()
const sessionStore = useSessionStore()
const route = useRoute()
const router = useRouter()

function tabFromQuery(value: unknown): OrderTabId {
  return typeof value === 'string' && (ORDER_TABS as readonly string[]).includes(value) ? value as OrderTabId : 'pending'
}

const tab = ref<OrderTabId>(tabFromQuery(route.query.tab))
const page = ref(1)
const rows = ref<OtcOrderRow[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
let generation = 0

const authed = computed(() => sessionStore.isAuthenticated)

function fiat(row: OtcOrderRow, value: string): string {
  return isDecimalString(value) ? groupDigits(value, fiatDpFor(otc.coinMeta(row.coin), row.payCoin)) : '--'
}
function coinAmount(row: OtcOrderRow): string {
  return isDecimalString(row.volume) ? groupDigits(row.volume, coinDpFor(otc.coinMeta(row.coin))) : '--'
}
function time(value: number | null): string {
  return value === null ? '--' : new Date(value).toLocaleString()
}

async function load(): Promise<void> {
  if (!authed.value) return
  const gen = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await fetchMyOrders(orderTabQuery(tab.value), page.value, PAGE_SIZE)
    if (gen !== generation) return
    rows.value = result.items
    total.value = result.count
  } catch (err) {
    if (gen !== generation) return
    rows.value = []
    total.value = 0
    error.value = describeOtcError(t, err)
  } finally {
    if (gen === generation) loading.value = false
  }
}

function selectTab(next: OrderTabId): void {
  if (tab.value === next) return
  tab.value = next
  page.value = 1
  void router.replace({ query: { ...route.query, tab: next } })
}

function open(row: OtcOrderRow): void {
  void router.push({ name: 'otc-order', params: { id: row.sequence } })
}

watch([tab, page], () => { void load() })
watch(authed, (value) => {
  rows.value = []
  total.value = 0
  if (value) void load()
}, { immediate: true })
void otc.ensureMarketInfo()
onBeforeUnmount(() => { generation += 1 })
</script>

<template>
  <div class="page orders-page">
    <header class="page-head">
      <div>
        <h1>{{ t('otc.ordersPage.title') }}</h1>
        <p>{{ t('otc.ordersPage.subtitle') }}</p>
      </div>
      <OtcSubnav />
    </header>

    <GuestGate v-if="!authed" :message="t('otc.ordersPage.login')" :icon="ClipboardList" />
    <section v-else class="panel orders-panel">
      <div class="status-tabs" role="tablist">
        <button
          v-for="id in ORDER_TABS"
          :key="id"
          class="status-tab"
          :class="{ active: tab === id }"
          type="button"
          role="tab"
          :aria-selected="tab === id"
          @click="selectTab(id)"
        >
          {{ t(`otc.ordersPage.tabs.${id}`) }}
        </button>
      </div>
      <p v-if="tab === 'completed'" class="tab-note">{{ t('otc.ordersPage.completedNote') }}</p>

      <StateBlock v-if="loading && rows.length === 0" variant="loading" :message="t('common.loading')" />
      <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="load" />
      <StateBlock v-else-if="rows.length === 0" variant="empty" :message="t('otc.ordersPage.empty')" />
      <div v-else class="table-wrap" :class="{ dim: loading }">
        <table class="orders-table">
          <thead>
            <tr>
              <th>{{ t('otc.ordersPage.type') }}</th>
              <th>{{ t('otc.ordersPage.sequence') }}</th>
              <th class="r">{{ t('otc.price') }}</th>
              <th class="r">{{ t('otc.ordersPage.amount') }}</th>
              <th class="r">{{ t('otc.ordersPage.total') }}</th>
              <th>{{ t('otc.ordersPage.counterparty') }}</th>
              <th>{{ t('otc.ordersPage.status') }}</th>
              <th class="r"><span class="sr-only">{{ t('otc.ordersPage.view') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.sequence" tabindex="0" @click="open(row)" @keydown.enter="open(row)">
              <td>
                <span class="type-cell">
                  <CoinMark :symbol="row.coin" :icon-url="otc.coinMeta(row.coin)?.icon ?? ''" :size="24" />
                  <span>
                    <strong :class="row.side === 'BUY' ? 'up' : 'down'">{{ row.side === 'BUY' ? t('otc.buy') : t('otc.sell') }}</strong>
                    {{ row.coin }}
                  </span>
                </span>
              </td>
              <td class="num mono-id" :data-label="t('otc.ordersPage.sequence')">{{ row.sequence }}</td>
              <td class="num r" :data-label="t('otc.price')"><span>{{ fiat(row, row.price) }} <small>{{ row.payCoin }}</small></span></td>
              <td class="num r" :data-label="t('otc.ordersPage.amount')"><span>{{ coinAmount(row) }} <small>{{ row.coin }}</small></span></td>
              <td class="num r strong" :data-label="t('otc.ordersPage.total')"><span>{{ fiat(row, row.totalPrice) }} <small>{{ row.payCoin }}</small></span></td>
              <td class="ellipsis" :data-label="t('otc.ordersPage.counterparty')">{{ row.counterparty || '--' }}</td>
              <td :data-label="t('otc.ordersPage.status')"><OtcStatusBadge :status="row.status" /></td>
              <td class="r"><ChevronRight :size="16" class="muted" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <OtcPager :page="page" :page-size="PAGE_SIZE" :total="total" :disabled="loading" @change="page = $event" />
    </section>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
.page-head h1 { margin: 0; font-size: 30px; font-weight: 750; }
.page-head p { margin: 6px 0 0; color: var(--color-text-secondary); font-size: 14px; }
.orders-panel { padding: 8px 18px 12px; }
.status-tabs { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--color-border); }
.status-tab {
  height: 44px; padding: 0 16px; border-bottom: 2px solid transparent; color: var(--color-text-muted);
  font-size: 14px; font-weight: 600; white-space: nowrap; transition: color 0.15s, border-color 0.15s;
}
.status-tab:hover { color: var(--color-text); }
.status-tab.active { color: var(--color-text); border-bottom-color: var(--color-accent); }
.tab-note { margin: 10px 2px 0; color: var(--color-text-muted); font-size: 12px; }
.table-wrap { overflow-x: auto; transition: opacity 0.15s; }
.table-wrap.dim { opacity: 0.55; }
.orders-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.orders-table th {
  padding: 12px 10px; color: var(--color-text-muted); font-size: 12px; font-weight: 550; text-align: left; white-space: nowrap;
  border-bottom: 1px solid var(--color-border);
}
.orders-table td { padding: 14px 10px; border-bottom: 1px solid var(--color-border); white-space: nowrap; }
.orders-table tbody tr { cursor: pointer; transition: background-color 0.12s; }
.orders-table tbody tr:hover, .orders-table tbody tr:focus-visible { background: var(--color-hover); outline: none; }
.orders-table tbody tr:last-child td { border-bottom: 0; }
.r { text-align: right !important; }
.strong { font-weight: 650; }
.orders-table small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; }
.type-cell { display: inline-flex; align-items: center; gap: 10px; }
.type-cell strong { margin-right: 4px; }
.mono-id { color: var(--color-text-secondary); font-size: 12.5px; }
.ellipsis { max-width: 160px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 820px) {
  .page-head h1 { font-size: 24px; }
  .orders-panel { padding: 6px 12px 10px; }
  .orders-table thead { display: none; }
  .orders-table, .orders-table tbody, .orders-table tr, .orders-table td { display: block; width: 100%; }
  .orders-table tr { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 14px 4px; border-bottom: 1px solid var(--color-border); }
  .orders-table td { padding: 0; border: 0; }
  .orders-table td[data-label] { display: flex; justify-content: space-between; grid-column: 1 / -1; font-size: 13px; }
  .orders-table td[data-label]::before { content: attr(data-label); color: var(--color-text-muted); font-family: var(--font-sans); font-size: 12px; }
  .orders-table td:last-child { display: none; }
  .r { text-align: left !important; }
  .ellipsis { max-width: none; }
}
</style>
