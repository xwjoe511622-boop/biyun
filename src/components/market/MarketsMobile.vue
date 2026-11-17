<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Star } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { vTick } from '@/components/home/fx/fx'
import { useFavorites } from '@/components/trade/favorites'
import { cmp, cmpSigned, groupDigits, isDecimalString, isSignedDecimalString } from '@/modules/finance/decimal'
import { compactDecimal, percentView, type PercentView } from '@/modules/finance/display'
import type { MarketSymbol } from '@/modules/market/symbols'
import { useMarketStore } from '@/stores/market'

/**
 * Phone spot market list (owner 2026-11-17). One row of categories — 自选 / 全部 / 涨幅榜 / 跌幅榜 / 成交额 / 新币 (sectors live on 探索) — then an edge-to-edge list: coin, 24h turnover, last price and a solid change block, like the home
 * and explore lists. Search lives in the page header (components/layout/MobileSearch.vue), not here.
 */
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      fav: '自选', all: '全部', gainers: '涨幅榜', losers: '跌幅榜', volume: '成交额', fresh: '新币', name: '名称 / 成交额', last: '最新价', change: '24h 涨跌',
      vol: '成交额 {v}', loading: '正在加载交易对…', unavailable: '暂无已上线交易对', none: '暂无数据', star: '移出自选',
      favTitle: '添加自选，行情一目了然', favSub: '已为你选好热门币种，可点选取消', favAdd: '添加到自选',
    },
    'en-US': {
      fav: 'Favorites', all: 'All', gainers: 'Gainers', losers: 'Losers', volume: 'Volume', fresh: 'New', name: 'Name / Turnover', last: 'Last price', change: '24h change',
      vol: 'Vol {v}', loading: 'Loading pairs…', unavailable: 'No pairs published', none: 'No data yet', star: 'Remove favorite',
      favTitle: 'Add favorites to follow them here', favSub: 'Popular coins are preselected; tap to deselect', favAdd: 'Add to favorites',
    },
  },
})
type Tab = 'fav' | 'all' | 'gainers' | 'losers' | 'fresh' | 'volume'
type SortKey = 'amount' | 'last' | 'change'
interface Row { entry: MarketSymbol; last: string; rawLast: string; rose: string; amount: string; change: PercentView }

const market = useMarketStore()
const router = useRouter()
const { favorites, toggleFavorite } = useFavorites()
const tab = ref<Tab>('all')
const sortKey = ref<SortKey | null>(null)
const sortDesc = ref(true)
watch(tab, () => { sortKey.value = null; sortDesc.value = true })

const fresh = computed(() => {
  const set = new Set<string>()
  Object.values(market.publicInfo?.market?.market ?? {}).forEach((group) => Object.entries(group ?? {}).forEach(([pair, info]) => {
    if (String((info as { newcoinFlag?: unknown } | undefined)?.newcoinFlag ?? '0') === '1') set.add(pair.toUpperCase())
  }))
  return set
})
const tabs = computed<{ id: Tab; label: string }[]>(() => [
  { id: 'fav', label: t('fav') }, { id: 'all', label: t('all') }, { id: 'gainers', label: t('gainers') }, { id: 'losers', label: t('losers') }, { id: 'volume', label: t('volume') },
  ...(fresh.value.size > 0 ? [{ id: 'fresh' as const, label: t('fresh') }] : []),
])

function toRow(entry: MarketSymbol): Row {
  const tick = market.tickers[entry.symbol.toLowerCase()]
  const rose = tick?.rose ?? ''
  const close = tick?.close ?? ''
  return {
    entry, rawLast: close, rose, amount: tick?.amount ?? '',
    last: isDecimalString(close) ? groupDigits(close, Math.min(entry.pricePrecision, 8)) : '--',
    change: rose === '' ? { text: '--', direction: 'flat' } : percentView(rose),
  }
}
/** Descending by a decimal field; rows without a value sink to the bottom. */
function ordered(list: Row[], key: SortKey, desc: boolean): Row[] {
  const pick = (row: Row): string => (key === 'last' ? row.rawLast : key === 'change' ? row.rose : row.amount)
  const valid = key === 'change' ? isSignedDecimalString : isDecimalString
  return [...list].sort((left, right) => {
    const a = pick(left)
    const b = pick(right)
    if (!valid(a) && !valid(b)) return 0
    if (!valid(a)) return 1
    if (!valid(b)) return -1
    return (key === 'change' ? cmpSigned(a, b) : cmp(a, b)) * (desc ? -1 : 1)
  })
}
const rows = computed<Row[]>(() => {
  const list = market.symbols.filter((entry) => {
    if (tab.value === 'fav') return favorites.value.has(entry.pair)
    if (tab.value === 'fresh') return fresh.value.has(entry.pair.toUpperCase())
    return true
  }).map(toRow)
  if (sortKey.value !== null) return ordered(list, sortKey.value, sortDesc.value)
  if (tab.value === 'gainers') return ordered(list, 'change', true)
  if (tab.value === 'losers') return ordered(list, 'change', false)
  return tab.value === 'volume' ? ordered(list, 'amount', true) : list
})
function sortBy(key: SortKey): void {
  if (sortKey.value !== key) { sortKey.value = key; sortDesc.value = true } else if (sortDesc.value) sortDesc.value = false
  else sortKey.value = null
}
function sortIcon(key: SortKey): typeof ArrowDown {
  return sortKey.value === key ? (sortDesc.value ? ArrowDown : ArrowUp) : ChevronsUpDown
}
function open(pair: string): void {
  market.selectPair(pair)
  void router.push('/trade')
}

/* Empty favorites: the six pairs with the largest turnover, preselected, added with one tap. */
const suggestions = computed(() => ordered(market.symbols.map(toRow), 'amount', true).slice(0, 6))
const unpicked = ref<Set<string>>(new Set())
function togglePick(pair: string): void {
  const next = new Set(unpicked.value)
  if (next.has(pair)) next.delete(pair)
  else next.add(pair)
  unpicked.value = next
}
const picks = computed(() => suggestions.value.filter((row) => !unpicked.value.has(row.entry.pair)))
function addPicks(): void {
  picks.value.forEach((row) => { if (!favorites.value.has(row.entry.pair)) toggleFavorite(row.entry.pair) })
}
const loading = computed(() => market.publicInfoLoading && market.symbols.length === 0)
</script>

<template>
  <div class="mm">
    <div class="mm-tabs" role="tablist">
      <button v-for="entry in tabs" :key="entry.id" type="button" role="tab" class="mm-tab" :class="{ active: tab === entry.id }" :aria-selected="tab === entry.id" :data-testid="`markets-tab-${entry.id}`" @click="tab = entry.id">
        <Star v-if="entry.id === 'fav'" :size="13" aria-hidden="true" />{{ entry.label }}
      </button>
    </div>

    <StateBlock v-if="market.publicInfoError !== null" variant="error" :message="market.publicInfoError" retryable @retry="emit('retry')" />
    <StateBlock v-else-if="loading" variant="loading" :message="t('loading')" />
    <StateBlock v-else-if="market.symbols.length === 0" variant="empty" :message="t('unavailable')" />
    <section v-else-if="tab === 'fav' && rows.length === 0" class="mm-pick">
      <strong>{{ t('favTitle') }}</strong>
      <p>{{ t('favSub') }}</p>
      <div class="mm-pick-grid">
        <button v-for="row in suggestions" :key="row.entry.pair" type="button" :class="{ on: !unpicked.has(row.entry.pair) }" :aria-pressed="!unpicked.has(row.entry.pair)" @click="togglePick(row.entry.pair)">
          <CoinMark :symbol="row.entry.base" :icon-url="row.entry.coin?.icon ?? ''" :size="26" />
          <span><b>{{ row.entry.base }}</b><i class="num" :class="row.change.direction">{{ row.change.text }}</i></span>
          <em><Check :size="12" aria-hidden="true" /></em>
        </button>
      </div>
      <button type="button" class="mm-pick-add" :disabled="picks.length === 0" data-testid="markets-fav-add" @click="addPicks">{{ t('favAdd') }}</button>
    </section>
    <template v-else>
      <div class="mm-head">
        <button type="button" @click="sortBy('amount')">{{ t('name') }}<component :is="sortIcon('amount')" :size="11" /></button>
        <button type="button" @click="sortBy('last')">{{ t('last') }}<component :is="sortIcon('last')" :size="11" /></button>
        <button type="button" @click="sortBy('change')">{{ t('change') }}<component :is="sortIcon('change')" :size="11" /></button>
      </div>
      <p v-if="rows.length === 0" class="mm-none">{{ t('none') }}</p>
      <ul v-else class="mm-list">
        <li v-for="row in rows" :key="row.entry.pair" class="mm-row" :data-testid="`markets-row-${row.entry.symbol}`" @click="open(row.entry.pair)">
          <button v-if="tab === 'fav'" type="button" class="mm-star" :aria-label="t('star')" @click.stop="toggleFavorite(row.entry.pair)"><Star :size="14" /></button>
          <span class="mm-name">
            <CoinMark :symbol="row.entry.base" :icon-url="row.entry.coin?.icon ?? ''" :size="30" />
            <span><strong>{{ row.entry.base }}<small>/{{ row.entry.quote }}</small></strong><small>{{ t('vol', { v: compactDecimal(row.amount) }) }}</small></span>
          </span>
          <span v-tick="row.last" class="mm-last num">{{ row.last }}</span>
          <span class="mm-chg num" :class="row.change.direction">{{ row.change.text }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.mm { min-width: 0; }
.mm-tabs { display: flex; justify-content: space-between; padding: 2px 12px 10px; }
.mm-tab { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 30px; padding: 0 10px; border-radius: 999px; color: var(--color-text-secondary); font-size: 13.5px; font-weight: 600; white-space: nowrap; }
.mm-tab.active { background: var(--color-accent); color: var(--color-on-accent); font-weight: 700; }
.mm-head, .mm-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) 84px; align-items: center; gap: 10px; padding-left: 16px; padding-right: 16px; }
.mm-head { height: 28px; border-bottom: 1px solid var(--color-border); }
.mm-head button { display: inline-flex; align-items: center; gap: 3px; color: var(--color-text-muted); font-size: 11.5px; white-space: nowrap; }
.mm-head button:nth-child(n + 2) { justify-content: flex-end; }
.mm-list { margin: 0; padding: 0; list-style: none; }
.mm-row { position: relative; height: 58px; }
.mm-row:active { background: var(--color-hover); }
.mm-row + .mm-row::before { content: ''; position: absolute; top: 0; left: 56px; right: 0; height: 1px; background: var(--color-border); opacity: .6; }
.mm-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mm-name > span { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mm-name strong { font-family: var(--font-display); font-size: 15.5px; font-weight: 700; white-space: nowrap; }
.mm-name strong small { color: var(--color-text-muted); font-size: 11.5px; font-weight: 500; }
.mm-name > span > small { color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.mm-last { font-size: 15px; font-weight: 650; text-align: right; }
.mm-last::after { content: none !important; }
.mm-chg { display: inline-flex; align-items: center; justify-content: center; justify-self: end; width: 80px; height: 32px; border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13.5px; font-weight: 700; }
.mm-chg.up { background: var(--color-up); color: #fff; } .mm-chg.down { background: var(--color-down); color: #fff; }
.mm-star { position: absolute; left: 0; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: center; width: 20px; height: 100%; padding-top: 6px; color: var(--color-accent); }
.mm-star :deep(svg) { width: 10px; height: 10px; fill: currentColor; }
.mm-none { margin: 0; padding: 44px 0; color: var(--color-text-muted); font-size: 13px; text-align: center; }

.mm-pick { display: flex; flex-direction: column; align-items: center; padding: 26px 16px 20px; text-align: center; }
.mm-pick strong { font-family: var(--font-display); font-size: 17px; font-weight: 750; }
.mm-pick p { margin: 6px 0 18px; color: var(--color-text-muted); font-size: 12.5px; }
.mm-pick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; width: 100%; }
.mm-pick-grid button { position: relative; display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-surface); color: var(--color-text); text-align: left; }
.mm-pick-grid button.on { border-color: color-mix(in srgb, var(--color-accent) 70%, transparent); background: color-mix(in srgb, var(--color-accent) 9%, var(--color-surface)); }
.mm-pick-grid span { display: flex; flex-direction: column; }
.mm-pick-grid b { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
.mm-pick-grid i { font-size: 12px; font-style: normal; font-weight: 650; color: var(--color-text-muted); }
.mm-pick-grid i.up { color: var(--color-up); } .mm-pick-grid i.down { color: var(--color-down); }
.mm-pick-grid em { position: absolute; top: 50%; right: 12px; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-top: -9px; border: 1px solid var(--color-border-strong); border-radius: 50%; color: transparent; }
.mm-pick-grid button.on em { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-on-accent); }
.mm-pick-add { width: 100%; height: 46px; margin-top: 18px; border-radius: 999px; background: var(--color-accent); color: var(--color-on-accent); font-size: 15px; font-weight: 700; }
.mm-pick-add:disabled { opacity: .45; }

.mm-last.fx-tk-up1 { animation: mm-up-a .9s ease-out; } .mm-last.fx-tk-up2 { animation: mm-up-b .9s ease-out; }
.mm-last.fx-tk-dn1 { animation: mm-dn-a .9s ease-out; } .mm-last.fx-tk-dn2 { animation: mm-dn-b .9s ease-out; }
@keyframes mm-up-a { from { color: var(--color-up); } } @keyframes mm-up-b { from { color: var(--color-up); } }
@keyframes mm-dn-a { from { color: var(--color-dn, var(--color-down)); } } @keyframes mm-dn-b { from { color: var(--color-down); } }
@media (prefers-reduced-motion: reduce) { .mm-last { animation: none !important; } }
</style>
