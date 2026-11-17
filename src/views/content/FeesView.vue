<script setup lang="ts">
import { vScrollFade } from '@/core/scroll-fade'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowDownToLine, ArrowUpFromLine, CandlestickChart, Info, Percent, Search, Wallet } from '@lucide/vue'
import PageHead from '@/components/content/PageHead.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import {
  configuredLevels,
  fetchCoinFees,
  fetchFuturesFees,
  fetchSpotFees,
  rateToPercent,
  type CoinFeeRow,
  type FuturesFeeRow,
  type SpotFeeRow,
} from '@/modules/content/fees.api'
import { errorMessage } from '@/modules/content/api-helpers'
import { useContentI18n } from '@/modules/content/i18n'
import { canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { useMarketStore } from '@/stores/market'

/**
 * Public fee schedule — see `modules/content/fees.api.ts` for the exact contracts:
 * spot `fee_info` (per pair × VIP), futures `common/getMakerAndTaker` (futures-web-api) and
 * `coins_info` + `coins_fee` for deposit/withdrawal. Every value is from the API; missing rows show "Not set".
 */
type Tab = 'spot' | 'futures' | 'wallet'
const TABS: Tab[] = ['spot', 'futures', 'wallet']

const { t } = useContentI18n()
const route = useRoute()
const router = useRouter()
const market = useMarketStore()

const tab = computed<Tab>(() => (TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'spot'))
const keyword = ref('')
const level = ref(0)

interface Section<T> { rows: T[]; loading: boolean; error: string; loaded: boolean }
const spot = ref<Section<SpotFeeRow>>({ rows: [], loading: false, error: '', loaded: false })
const futures = ref<Section<FuturesFeeRow>>({ rows: [], loading: false, error: '', loaded: false })
const wallet = ref<Section<CoinFeeRow>>({ rows: [], loading: false, error: '', loaded: false })
const controllers = new Set<AbortController>()

async function run<T>(section: typeof spot | typeof futures | typeof wallet, loader: (signal: AbortSignal) => Promise<T[]>): Promise<void> {
  const controller = new AbortController()
  controllers.add(controller)
  const target = section as unknown as { value: Section<T> }
  target.value = { ...target.value, loading: true, error: '' }
  try {
    const rows = await loader(controller.signal)
    target.value = { rows, loading: false, error: '', loaded: true }
  } catch (failure) {
    if (controller.signal.aborted) return
    target.value = { rows: [], loading: false, error: errorMessage(failure), loaded: true }
  } finally {
    controllers.delete(controller)
  }
}

const loadSpot = (): Promise<void> => run(spot, fetchSpotFees)
const loadFutures = (): Promise<void> => run(futures, fetchFuturesFees)
const loadWallet = (): Promise<void> => run(wallet, fetchCoinFees)

function ensureLoaded(value: Tab): void {
  if (value === 'spot' && !spot.value.loaded && !spot.value.loading) void loadSpot()
  if (value === 'futures' && !futures.value.loaded && !futures.value.loading) void loadFutures()
  if (value === 'wallet' && !wallet.value.loaded && !wallet.value.loading) void loadWallet()
}

function selectTab(value: Tab): void {
  keyword.value = ''
  void router.replace({ query: value === 'spot' ? {} : { tab: value } })
}

const levels = computed(() => configuredLevels(spot.value.rows))
watch(levels, (value) => {
  if (!value.includes(level.value)) level.value = value[0] ?? 0
})

const symbolMeta = computed(() => new Map(market.symbols.map((entry) => [entry.symbol, entry])))
function pairLabel(symbol: string): { pair: string; base: string } {
  const meta = symbolMeta.value.get(symbol)
  if (meta !== undefined) return { pair: meta.showPair, base: meta.base }
  return { pair: symbol.toUpperCase(), base: '' }
}

const needle = computed(() => keyword.value.trim().toLowerCase())
const spotRows = computed(() => spot.value.rows.filter((row) => needle.value === '' || pairLabel(row.symbol).pair.toLowerCase().includes(needle.value) || row.symbol.includes(needle.value)))
const futuresRows = computed(() => futures.value.rows.filter((row) => needle.value === '' || row.label.toLowerCase().includes(needle.value)))
const walletRows = computed(() => wallet.value.rows.filter((row) => needle.value === '' || row.coin.toLowerCase().includes(needle.value) || row.name.toLowerCase().includes(needle.value) || row.network.toLowerCase().includes(needle.value)))

function pct(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const percent = rateToPercent(value)
  return percent === '' ? '' : `${percent}%`
}

function amount(value: string): string {
  const normalized = canonicalDecimal(value)
  return isDecimalString(normalized) ? groupDigits(normalized) : ''
}

const current = computed(() => (tab.value === 'spot' ? spot.value : tab.value === 'futures' ? futures.value : wallet.value))
const visibleCount = computed(() => (tab.value === 'spot' ? spotRows.value.length : tab.value === 'futures' ? futuresRows.value.length : walletRows.value.length))
const emptyTitle = computed(() => {
  if (current.value.rows.length > 0) return t('content.fees.noMatch')
  return tab.value === 'spot' ? t('content.fees.emptySpot') : tab.value === 'futures' ? t('content.fees.emptyFutures') : t('content.fees.emptyWallet')
})
const retry = (): void => {
  if (tab.value === 'spot') void loadSpot()
  else if (tab.value === 'futures') void loadFutures()
  else void loadWallet()
}

watch(tab, (value) => ensureLoaded(value), { immediate: true })
onMounted(() => {
  if (market.publicInfo === null) void market.loadPublicInfo().catch(() => undefined)
})
onBeforeUnmount(() => controllers.forEach((controller) => controller.abort()))
</script>

<template>
  <div class="page fees-page">
    <PageHead :icon="Percent" :eyebrow="t('content.fees.eyebrow')" :title="t('content.fees.title')" :lead="t('content.fees.lead')" />

    <div class="toolbar">
      <div class="seg" role="tablist">
        <button v-for="value in TABS" :key="value" class="seg-btn" :class="{ active: tab === value }" type="button" role="tab" :aria-selected="tab === value" @click="selectTab(value)">
          <CandlestickChart v-if="value === 'spot'" :size="15" aria-hidden="true" />
          <Percent v-else-if="value === 'futures'" :size="15" aria-hidden="true" />
          <Wallet v-else :size="15" aria-hidden="true" />
          {{ t(`content.fees.${value}`) }}
        </button>
      </div>
      <label class="search">
        <Search :size="15" aria-hidden="true" />
        <input v-model="keyword" type="search" maxlength="30" :placeholder="t('content.fees.search')" :aria-label="t('content.fees.search')" />
      </label>
    </div>

    <p class="note"><Info :size="14" aria-hidden="true" />{{ t(`content.fees.${tab}Note`) }}</p>

    <div v-if="tab === 'spot' && levels.length > 1" class="levels" role="radiogroup" :aria-label="t('content.fees.level')">
      <button v-for="n in levels" :key="n" class="chip level" :class="{ active: level === n }" type="button" role="radio" :aria-checked="level === n" @click="level = n">{{ t('content.fees.vip', { n }) }}</button>
    </div>

    <ErrorBanner v-if="current.error !== ''" class="error" :message="tab === 'futures' ? t('content.fees.futuresUnavailable', { msg: current.error }) : current.error" retryable @retry="retry" />

    <section v-else class="panel table-panel" :aria-busy="current.loading">
      <div v-if="current.loading && current.rows.length === 0" class="sk-rows"><span v-for="n in 6" :key="n"></span></div>
      <EmptyState v-else-if="visibleCount === 0" :icon="Percent" :title="emptyTitle" />
      <div v-else v-scroll-fade class="table-wrap x-scroll">
        <table v-if="tab === 'spot'" class="table fee-table table-cards">
          <thead><tr><th>{{ t('content.fees.pair') }}</th><th v-if="levels.length > 1">{{ t('content.fees.level') }}</th><th>{{ t('content.fees.maker') }}</th><th>{{ t('content.fees.taker') }}</th></tr></thead>
          <tbody>
            <tr v-for="row in spotRows" :key="row.symbol">
              <td class="card-title" data-label=""><span class="asset"><CoinMark v-if="pairLabel(row.symbol).base" :symbol="pairLabel(row.symbol).base" :size="22" /><strong>{{ pairLabel(row.symbol).pair }}</strong></span></td>
              <td v-if="levels.length > 1" class="muted" :data-label="t('content.fees.level')">{{ t('content.fees.vip', { n: level }) }}</td>
              <td class="num" :data-label="t('content.fees.maker')">{{ pct(row.maker[level]) || t('content.fees.notSet') }}</td>
              <td class="num" :data-label="t('content.fees.taker')">{{ pct(row.taker[level]) || t('content.fees.notSet') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="tab === 'futures'" class="table fee-table table-cards">
          <thead><tr><th>{{ t('content.fees.contract') }}</th><th>{{ t('content.fees.openMaker') }}</th><th>{{ t('content.fees.openTaker') }}</th><th>{{ t('content.fees.closeMaker') }}</th><th>{{ t('content.fees.closeTaker') }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in futuresRows" :key="`${row.label}-${index}`">
              <td class="card-title" data-label=""><span class="asset"><CoinMark :symbol="row.label.split('/')[0] ?? ''" :size="22" /><strong>{{ row.label }}</strong></span></td>
              <td class="num" :data-label="t('content.fees.openMaker')">{{ pct(row.openMaker) || t('content.fees.notSet') }}</td>
              <td class="num" :data-label="t('content.fees.openTaker')">{{ pct(row.openTaker) || t('content.fees.notSet') }}</td>
              <td class="num" :data-label="t('content.fees.closeMaker')">{{ pct(row.closeMaker) || t('content.fees.notSet') }}</td>
              <td class="num" :data-label="t('content.fees.closeTaker')">{{ pct(row.closeTaker) || t('content.fees.notSet') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else class="table fee-table wallet-table">
          <thead>
            <tr>
              <th>{{ t('content.fees.coin') }}</th><th>{{ t('content.fees.network') }}</th>
              <th><ArrowDownToLine :size="13" aria-hidden="true" /> {{ t('content.fees.deposit') }}</th><th>{{ t('content.fees.depositMin') }}</th>
              <th><ArrowUpFromLine :size="13" aria-hidden="true" /> {{ t('content.fees.withdraw') }}</th><th>{{ t('content.fees.withdrawMin') }}</th><th>{{ t('content.fees.withdrawFee') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in walletRows" :key="`${row.coin}-${row.network}`">
              <td><span class="asset"><CoinMark :symbol="row.coin" :size="22" /><span class="asset-text"><strong>{{ row.coin }}</strong><small v-if="row.name" class="ellipsis">{{ row.name }}</small></span></span></td>
              <td class="network">{{ row.network || '--' }}</td>
              <td><span class="state" :class="row.depositOpen ? 'on' : 'off'">{{ row.depositOpen ? t('content.fees.open') : t('content.fees.closed') }}</span></td>
              <td class="num">{{ amount(row.depositMin) || '--' }}</td>
              <td><span class="state" :class="row.withdrawOpen ? 'on' : 'off'">{{ row.withdrawOpen ? t('content.fees.open') : t('content.fees.closed') }}</span></td>
              <td class="num">{{ amount(row.withdrawMin) || '--' }}</td>
              <td class="num fee-cell">
                <template v-if="row.withdrawFee !== ''">{{ amount(row.withdrawFee) }} <small>{{ row.coin }}</small></template>
                <span v-else class="muted">{{ t('content.fees.notSet') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.fees-page { max-width: 1180px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.seg { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface); overflow-x: auto; max-width: 100%; }
.seg-btn { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 16px; border-radius: 9px; color: var(--color-text-secondary); font-size: 13px; font-weight: 600; white-space: nowrap; transition: background-color .15s, color .15s; }
.seg-btn:hover { color: var(--color-text); }
.seg-btn.active { background: var(--color-accent-soft); color: var(--color-accent-text); }
.search { display: flex; align-items: center; gap: 8px; width: 260px; max-width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text-muted); }
.search:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); }
.note { display: flex; align-items: flex-start; gap: 8px; margin: 14px 0 0; color: var(--color-text-muted); font-size: 12.5px; line-height: 1.6; }
.note svg { flex: 0 0 auto; margin-top: 3px; }
.levels { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.level { height: 28px; padding: 0 12px; cursor: pointer; }
.level.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); }
.error { margin-top: 14px; }
.table-panel { margin-top: 14px; overflow: hidden; }
.fee-table { min-width: 560px; }
.wallet-table { min-width: 960px; table-layout: auto; }
.wallet-table td.network { max-width: 200px; white-space: normal; line-height: 1.4; }
.fee-table th { padding-top: 14px; padding-bottom: 14px; }
.fee-table th, .fee-table td { padding-left: 20px; padding-right: 20px; }
.fee-table td { height: 58px; }
.fee-table tbody tr:last-child td { border-bottom: 0; }
.fee-table th svg { vertical-align: -2px; }
.asset { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.asset strong { color: var(--color-text); font-weight: 650; }
.asset-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.asset-text small { max-width: 220px; color: var(--color-text-muted); font-size: 11px; }
.state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.state.on { color: var(--color-up); }
.state.off { color: var(--color-text-muted); }
.fee-cell small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; }
.sk-rows { padding: 12px 20px; }
.sk-rows span { display: block; height: 20px; margin: 18px 0; border-radius: 6px; background: var(--color-surface-alt); }
@media (max-width: 640px) {
  .seg { width: 100%; }
  .seg-btn { flex: 1 1 auto; justify-content: center; height: auto; min-height: 36px; padding: 4px; gap: 4px; white-space: normal; }
  .seg-btn svg { flex-shrink: 0; }
  .search { width: 100%; }
  .fee-table th, .fee-table td { padding-left: 14px; padding-right: 14px; }
}
</style>
