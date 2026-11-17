<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, Star, X } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { vTick } from '@/components/home/fx/fx'
import Sparkline from '@/components/market/Sparkline.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { cmp, cmpSigned, groupDigits, isDecimalString, isSignedDecimalString } from '@/modules/finance/decimal'
import { compactDecimal, percentView, type PercentView } from '@/modules/finance/display'
import type { MarketSymbol } from '@/modules/market/symbols'
import { ROW_TREND_POINTS, useMarketStore } from '@/stores/market'
import { useFavorites } from '@/components/trade/favorites'

/**
 * Spot market list. Prices come from the `review` channel (all pairs) and the subscribed pair's
 * ticker; a pair without a pushed ticker shows `--`. The trend column shows each visible pair's
 * real hourly closes (last 24 of `market.trends`, one-shot K-line requests issued by the store for
 * the rows on screen only, two at a time, at most every five minutes). A pair whose K-line answer
 * is empty shows `—`, never an invented flat line.
 */
const props = withDefaults(defineProps<{ limit?: number; compact?: boolean }>(), { limit: 0, compact: false })
const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      favorites: '自选', all: '全部', search: '搜索币种', clear: '清除', pair: '交易对', last: '最新价',
      change: '24h 涨跌', high: '24h 最高', low: '24h 最低', volume: '24h 成交量', turnover: '24h 成交额',
      trend: '走势', action: '操作', trade: '交易', loading: '正在加载交易对…', none: '没有匹配的交易对',
      noFav: '还没有自选交易对，点击星标添加', unavailable: '暂无已上线交易对', star: '加入/移出自选', noTrend: '暂无走势数据',
    },
    'en-US': {
      favorites: 'Favorites', all: 'All', search: 'Search coin', clear: 'Clear', pair: 'Pair', last: 'Last price',
      change: '24h change', high: '24h high', low: '24h low', volume: '24h volume', turnover: '24h turnover',
      trend: 'Trend', action: 'Action', trade: 'Trade', loading: 'Loading pairs…', none: 'No matching pair',
      noFav: 'No favorites yet — tap the star to add one', unavailable: 'No pairs published', star: 'Toggle favorite', noTrend: 'No trend data',
    },
  },
})

type SortKey = 'pair' | 'last' | 'change' | 'turnover'
interface Row {
  entry: MarketSymbol
  name: string
  last: string
  change: PercentView
  rose: string
  high: string
  low: string
  vol: string
  amount: string
  favorite: boolean
  trend: number[]
  /** `loading` until the pair's trend answered; `none` = the pair has no K-line data. */
  trendState: 'loading' | 'ready' | 'none'
}

const market = useMarketStore()
const router = useRouter()
const tab = ref<string>('all')
const keyword = ref('')
const sortKey = ref<SortKey | null>(null)
const sortDesc = ref(true)
const { favorites, toggleFavorite } = useFavorites()

function rowTrend(symbol: string): Pick<Row, 'trend' | 'trendState'> {
  const values = market.trends[symbol]
  if (values === undefined) return { trend: [], trendState: 'loading' }
  if (values.length < 2) return { trend: [], trendState: 'none' }
  return { trend: values.slice(-ROW_TREND_POINTS), trendState: 'ready' }
}

function dp(entry: MarketSymbol): number {
  return Math.min(entry.pricePrecision, 8)
}

function show(value: string, digits: number): string {
  return isDecimalString(value) ? groupDigits(value, digits) : '--'
}

const rows = computed<Row[]>(() => {
  const term = keyword.value.trim().toUpperCase()
  return market.symbols
    .filter((entry) => {
      if (tab.value === 'fav' && !favorites.value.has(entry.pair)) return false
      if (tab.value !== 'fav' && tab.value !== 'all' && entry.quoteGroup !== tab.value) return false
      if (term === '') return true
      const name = `${entry.coin?.showName ?? ''} ${entry.coin?.name ?? ''}`.toUpperCase()
      return entry.pair.includes(term) || entry.showPair.toUpperCase().includes(term) || name.includes(term)
    })
    .map((entry) => {
      const tick = market.tickers[entry.symbol.toLowerCase()]
      const rose = tick?.rose ?? ''
      return {
        entry,
        name: entry.coin?.showName ?? entry.coin?.name ?? entry.base,
        last: tick?.close ?? '',
        rose,
        change: rose === '' ? { text: '--', direction: 'flat' } : percentView(rose),
        high: tick?.high ?? '',
        low: tick?.low ?? '',
        vol: tick?.vol ?? '',
        amount: tick?.amount ?? '',
        favorite: favorites.value.has(entry.pair),
        ...rowTrend(entry.symbol),
      }
    })
})

const sorted = computed<Row[]>(() => {
  const key = sortKey.value
  const list = [...rows.value]
  if (key !== null) {
    const pick = (row: Row): string => (key === 'last' ? row.last : key === 'change' ? row.rose : key === 'turnover' ? row.amount : '')
    list.sort((left, right) => {
      if (key === 'pair') return left.entry.pair.localeCompare(right.entry.pair) * (sortDesc.value ? -1 : 1)
      const a = pick(left)
      const b = pick(right)
      // 24h change is signed; price and turnover never are.
      const valid = key === 'change' ? isSignedDecimalString : isDecimalString
      if (!valid(a) && !valid(b)) return 0
      if (!valid(a)) return 1
      if (!valid(b)) return -1
      return (key === 'change' ? cmpSigned(a, b) : cmp(a, b)) * (sortDesc.value ? -1 : 1)
    })
  }
  return props.limit > 0 ? list.slice(0, props.limit) : list
})

/** Trends are requested only for the rows on screen (after filter, tab and limit). */
const visibleSymbols = computed(() => sorted.value.map((row) => row.entry.symbol).join(','))
watch(visibleSymbols, (list) => market.loadTrends(list === '' ? [] : list.split(',')), { immediate: true })

function sortBy(key: SortKey): void {
  if (sortKey.value === key) {
    if (!sortDesc.value) sortKey.value = null
    else sortDesc.value = false
  } else {
    sortKey.value = key
    sortDesc.value = true
  }
}

function open(pair: string): void {
  market.selectPair(pair)
  void router.push('/trade')
}

const loading = computed(() => market.publicInfoLoading && market.symbols.length === 0)
</script>

<template>
  <div class="market-table" :class="{ compact }">
    <div class="mt-toolbar">
      <div class="mt-tabs" role="tablist">
        <button class="mt-tab" :class="{ active: tab === 'fav' }" role="tab" :aria-selected="tab === 'fav'" type="button" @click="tab = 'fav'">
          <Star :size="13" aria-hidden="true" />{{ t('favorites') }}
        </button>
        <button class="mt-tab" :class="{ active: tab === 'all' }" role="tab" :aria-selected="tab === 'all'" type="button" @click="tab = 'all'">{{ t('all') }}</button>
        <button
          v-for="group in market.quoteGroups"
          :key="group"
          class="mt-tab"
          :class="{ active: tab === group }"
          role="tab"
          :aria-selected="tab === group"
          type="button"
          @click="tab = group"
        >
          {{ group }}
        </button>
      </div>
      <label class="mt-search">
        <Search :size="15" aria-hidden="true" />
        <input v-model="keyword" type="text" autocomplete="off" :placeholder="t('search')" :aria-label="t('search')" />
        <button v-if="keyword !== ''" type="button" :aria-label="t('clear')" @click="keyword = ''"><X :size="14" /></button>
      </label>
    </div>

    <StateBlock v-if="market.publicInfoError !== null" variant="error" :message="market.publicInfoError" retryable @retry="emit('retry')" />
    <StateBlock v-else-if="loading" variant="loading" :message="t('loading')" />
    <StateBlock v-else-if="market.symbols.length === 0" variant="empty" :message="t('unavailable')" />
    <div v-else class="mt-scroll">
      <table class="mt">
        <thead>
          <tr>
            <th class="c-pair"><button type="button" @click="sortBy('pair')">{{ t('pair') }}<component :is="sortKey === 'pair' ? (sortDesc ? ArrowDown : ArrowUp) : ChevronsUpDown" :size="12" /></button></th>
            <th><button type="button" @click="sortBy('last')">{{ t('last') }}<component :is="sortKey === 'last' ? (sortDesc ? ArrowDown : ArrowUp) : ChevronsUpDown" :size="12" /></button></th>
            <th><button type="button" @click="sortBy('change')">{{ t('change') }}<component :is="sortKey === 'change' ? (sortDesc ? ArrowDown : ArrowUp) : ChevronsUpDown" :size="12" /></button></th>
            <th v-if="!compact" class="hide-md">{{ t('high') }}</th>
            <th v-if="!compact" class="hide-md">{{ t('low') }}</th>
            <th class="hide-sm">{{ t('volume') }}</th>
            <th class="hide-sm"><button type="button" @click="sortBy('turnover')">{{ t('turnover') }}<component :is="sortKey === 'turnover' ? (sortDesc ? ArrowDown : ArrowUp) : ChevronsUpDown" :size="12" /></button></th>
            <th class="c-trend hide-sm">{{ t('trend') }}</th>
            <th class="c-action">{{ t('action') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sorted" :key="row.entry.pair" @click="open(row.entry.pair)">
            <td class="c-pair">
              <div class="pair-cell">
                <button class="star" :class="{ on: row.favorite }" type="button" :aria-label="t('star')" :aria-pressed="row.favorite" @click.stop="toggleFavorite(row.entry.pair)">
                  <Star :size="14" />
                </button>
                <CoinMark :symbol="row.entry.base" :icon-url="row.entry.coin?.icon ?? ''" :size="30" />
                <span class="pair-names">
                  <span class="pair-code">{{ row.entry.base }}<small>/{{ row.entry.quote }}</small></span>
                  <span class="pair-name ellipsis">{{ row.name }}</span>
                </span>
              </div>
            </td>
            <td class="num strong"><span v-tick="show(row.last, row.entry.pricePrecision)" class="mt-last">{{ show(row.last, row.entry.pricePrecision) }}</span></td>
            <td><span class="change-pill num" :class="row.change.direction">{{ row.change.text }}</span></td>
            <td v-if="!compact" class="num hide-md">{{ show(row.high, dp(row.entry)) }}</td>
            <td v-if="!compact" class="num hide-md">{{ show(row.low, dp(row.entry)) }}</td>
            <td class="num hide-sm">{{ compactDecimal(row.vol) }} <small class="unit">{{ row.entry.base }}</small></td>
            <td class="num hide-sm">{{ compactDecimal(row.amount) }} <small class="unit">{{ row.entry.quote }}</small></td>
            <td class="c-trend hide-sm">
              <span v-if="row.trendState === 'none'" class="trend-none" :title="t('noTrend')" :aria-label="t('noTrend')">—</span>
              <span v-else-if="row.trendState === 'loading'" class="trend-loading" aria-hidden="true" />
              <Sparkline v-else :values="row.trend" :width="96" :height="30" :direction="row.change.direction" />
            </td>
            <td class="c-action"><button class="trade-btn" type="button" @click.stop="open(row.entry.pair)">{{ t('trade') }}</button></td>
          </tr>
        </tbody>
      </table>
      <p v-if="sorted.length === 0" class="mt-none">{{ tab === 'fav' && keyword === '' ? t('noFav') : t('none') }}</p>
    </div>
  </div>
</template>

<style scoped>
.market-table { min-width: 0; }
.mt-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
.mt-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.mt-tab {
  display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 14px;
  border-radius: var(--radius-pill); color: var(--color-text-secondary); font-size: 13px; font-weight: 600;
  transition: background-color 0.15s, color 0.15s;
}
.mt-tab:hover { color: var(--color-text); background: var(--color-hover); }
.mt-tab.active { color: var(--color-on-accent); background: var(--color-accent); }
.mt-search {
  display: flex; align-items: center; gap: 8px; width: 240px; max-width: 100%; height: 36px; padding: 0 12px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius-pill); background: var(--color-surface-alt);
  color: var(--color-text-muted); transition: border-color 0.15s, box-shadow 0.15s;
}
.mt-search:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.mt-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 13px; }
.mt-search button { display: inline-flex; color: var(--color-text-muted); }
.mt-scroll { overflow-x: auto; }
.mt { width: 100%; border-collapse: collapse; font-size: 14px; }
.mt th {
  padding: 10px 14px; color: var(--color-text-muted); font-size: 12px; font-weight: 550; text-align: right;
  border-bottom: 1px solid var(--color-border); white-space: nowrap;
}
.mt th button { display: inline-flex; align-items: center; gap: 4px; color: inherit; font: inherit; }
.mt th button:hover { color: var(--color-text); }
.mt td { padding: 14px; text-align: right; border-bottom: 1px solid var(--color-border); white-space: nowrap; }
.mt tbody tr { cursor: pointer; transition: background-color 0.15s; }
.mt tbody tr:hover { background: var(--color-hover); }
.mt tbody tr:last-child td { border-bottom: 0; }
.mt .c-pair { text-align: left; }
.pair-cell { display: flex; align-items: center; gap: 12px; min-width: 190px; }
.star { display: inline-flex; color: var(--color-border-strong); transition: color 0.15s, transform 0.15s; }
.star:hover { color: var(--color-accent); transform: scale(1.15); }
.star.on { color: var(--color-accent); }
.star.on :deep(svg) { fill: currentColor; }
.pair-names { display: flex; flex-direction: column; min-width: 0; }
.pair-code { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.pair-code small { color: var(--color-text-muted); font-weight: 500; font-size: 13px; }
.pair-name { max-width: 220px; color: var(--color-text-muted); font-size: 12px; }
.strong { font-weight: 600; }
.unit { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; }
.change-pill {
  display: inline-block; min-width: 78px; padding: 5px 10px; border-radius: var(--radius-sm); text-align: center;
  font-size: 13px; font-weight: 600; background: var(--color-surface-alt); color: var(--color-text-secondary);
}
.change-pill.up { background: var(--color-up-soft); color: var(--color-up); }
.change-pill.down { background: var(--color-down-soft); color: var(--color-down); }
.c-trend { width: 120px; }
.c-trend :deep(svg), .c-trend :deep(span) { margin-left: auto; }
.trend-none { display: block; width: 96px; color: var(--color-text-muted); font-size: 13px; line-height: 30px; text-align: center; opacity: 0.7; }
.trend-loading {
  display: block; width: 96px; height: 30px; border-radius: var(--radius-sm); opacity: 0.5;
  background: linear-gradient(90deg, transparent, var(--color-hover), transparent) 0 0 / 200% 100%;
  animation: trend-shimmer 1.4s ease-in-out infinite;
}
@keyframes trend-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .trend-loading { animation: none; } }
.c-action { width: 92px; }
.trade-btn {
  height: 30px; padding: 0 14px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
  color: var(--color-text); font-size: 12px; font-weight: 650; transition: all 0.15s;
}
.trade-btn:hover, tr:hover .trade-btn { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-on-accent); }
.mt-none { margin: 0; padding: 36px 0; color: var(--color-text-muted); text-align: center; font-size: 13px; }
.compact .mt td { padding: 12px 14px; }
@media (max-width: 1100px) { .hide-md { display: none; } }
@media (max-width: 640px) {
  .mt { table-layout: fixed; }
  .mt th:nth-child(1) { width: 46%; }
  .mt th:nth-child(2) { width: 31%; }
  .mt th:nth-child(3) { width: 23%; }
  .mt td.strong, .pair-code, .change-pill { white-space: normal; overflow-wrap: anywhere; }
  .mt th button { max-width: 100%; white-space: normal; }
  .hide-sm { display: none; }
  /* The row itself opens the pair; the Trade button only pushed the change column off-screen. */
  .c-action { display: none; }
  .mt-tab { height: 40px; padding: 0 16px; }
  .mt-search { height: 44px; }
  .star { padding: 10px; margin: -10px -4px -10px -10px; }
  .mt-search { width: 100%; }
  .pair-cell { min-width: 0; gap: 6px; }
  /* 390 px: pair + last + change must fit without the table scrolling sideways (it clipped "24h 涨跌"). */
  .pair-name { max-width: 92px; }
  .mt td, .mt th { padding-left: 6px; padding-right: 6px; }
  .change-pill { min-width: 62px; padding: 5px 6px; font-size: 12px; }
}
@media (max-width: 360px) {
  .pair-name { display: none; }
}
.mt-last::after { content: none !important; }
@media (max-width: 720px) {
  .mt-last.fx-tk-up1 { animation: mt-up-a .9s ease-out; } .mt-last.fx-tk-up2 { animation: mt-up-b .9s ease-out; }
  .mt-last.fx-tk-dn1 { animation: mt-dn-a .9s ease-out; } .mt-last.fx-tk-dn2 { animation: mt-dn-b .9s ease-out; }
}
@keyframes mt-up-a { from { color: var(--color-up); } } @keyframes mt-up-b { from { color: var(--color-up); } }
@keyframes mt-dn-a { from { color: var(--color-down); } } @keyframes mt-dn-b { from { color: var(--color-down); } }
@media (prefers-reduced-motion: reduce) { .mt-last { animation: none !important; } }
</style>
