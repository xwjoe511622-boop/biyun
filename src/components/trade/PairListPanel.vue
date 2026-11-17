<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, Star } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { SKIN } from '@/core/skin'
import { canonicalDecimal, cmp, cmpSigned, groupDigits, isDecimalString, isSignedDecimalString } from '@/modules/finance/decimal'
import { percentView, type PercentView } from '@/modules/finance/display'
import type { MarketSymbol } from '@/modules/market/symbols'
import { useMarketStore } from '@/stores/market'
import { apiLanguage } from '@/i18n'
import { useFavorites } from './favorites'
import { categoryTabs as buildCategoryTabs, inCategory, isPairCategory, type CategoryTab } from './pair-category'

/**
 * Terminal pair list (Binance's right-hand market panel): search, favorites / quote tabs, sortable last price and
 * 24h change from the spot `review` stream. Picking a row calls `market.selectPair` exactly like the pair picker.
 * `symbols` narrows the list (margin passes its lever-enabled pairs); `tags` adds a badge per pair (e.g. `5x`).
 * Favorites share the markets page's storage key, so a star set here shows there too.
 * OKX skin (`SKIN === 'okx'`): OKX's market column instead — 市场 title, search, category tabs from the admin's coin tags
 * and new-listing flags (`pair-category.ts`, no coin list in code), two-line rows (star, coin icon, base + long name, last price over 24h change).
 */
const props = withDefaults(defineProps<{ symbols?: MarketSymbol[]; tags?: Record<string, string> }>(), { symbols: undefined, tags: () => ({}) })

const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      search: '搜索', fav: '自选', all: '全部', pair: '交易对', last: '最新价', change: '24h 涨跌', noFav: '点击星标添加自选', empty: '没有匹配的交易对', star: '加入/移出自选',
      markets: '市场', searchPair: '搜索币对', name: '名称', lastChange: '最新价/24h 涨跌', cat: { new: '新币种' },
    },
    'en-US': {
      search: 'Search', fav: 'Favorites', all: 'All', pair: 'Pair', last: 'Last Price', change: '24h Chg', noFav: 'Star a pair to add it here', empty: 'No matching pair', star: 'Toggle favorite',
      markets: 'Markets', searchPair: 'Search pairs', name: 'Name', lastChange: 'Last / 24h chg', cat: { new: 'New' },
    },
  },
})
const market = useMarketStore()

const { favorites, toggleFavorite } = useFavorites()

const tab = ref<string>('all')
const keyword = ref('')
type SortKey = 'pair' | 'last' | 'change'
const sortKey = ref<SortKey | null>(null)
const sortDesc = ref(true)
function sortBy(key: SortKey): void {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDesc.value = key !== 'pair'
  } else if (sortDesc.value === (key !== 'pair')) {
    sortDesc.value = !sortDesc.value
  } else {
    sortKey.value = null
  }
}

const source = computed<MarketSymbol[]>(() => props.symbols ?? market.symbols)
const quoteTabs = computed(() => [...new Set(source.value.map((entry) => entry.quoteGroup))])

/** OKX skin: pairs the admin flagged as new listings (`newcoinFlag` on public_info_v4), keyed `BTC/USDT`. */
const newPairs = computed<Set<string>>(() => {
  const out = new Set<string>()
  if (SKIN !== 'okx') return out
  Object.values(market.publicInfo?.market?.market ?? {}).forEach((group) => {
    Object.entries(group).forEach(([pair, info]) => {
      if (String(info?.newcoinFlag ?? '0') === '1') out.add(pair.toUpperCase())
    })
  })
  return out
})
/** OKX skin: the admin's coin-tag categories (and `new`) that hold at least one pair of this list. */
const categoryTabs = computed<CategoryTab[]>(() => (SKIN === 'okx'
  ? buildCategoryTabs(source.value, newPairs.value, market.publicInfo?.market?.coinTagLangs, apiLanguage(locale.value))
  : []))
/** OKX skin: the quote tabs only matter when the list spans more than one quote market. */
const okxQuoteTabs = computed(() => (quoteTabs.value.length > 1 ? quoteTabs.value : []))

interface Row {
  entry: MarketSymbol
  name: string
  last: string
  close: string
  rose: string
  change: PercentView
  favorite: boolean
}

const rows = computed<Row[]>(() => {
  const term = keyword.value.trim().toUpperCase()
  let list = source.value
  if (tab.value === 'fav') list = list.filter((entry) => favorites.value.has(entry.pair))
  else if (isPairCategory(tab.value)) {
    const category = tab.value
    list = list.filter((entry) => inCategory(entry, category, newPairs.value))
  } else if (tab.value !== 'all') list = list.filter((entry) => entry.quoteGroup === tab.value)
  if (term !== '') list = list.filter((entry) => entry.pair.includes(term) || entry.showPair.toUpperCase().includes(term) || entry.symbol.toUpperCase().includes(term))
  const mapped = list.map((entry) => {
    const tick = market.tickers[entry.symbol.toLowerCase()]
    const close = canonicalDecimal(tick?.close ?? '')
    const rose = canonicalDecimal(tick?.rose ?? '')
    return {
      entry,
      name: entry.coin?.showName ?? entry.base,
      close: isDecimalString(close) ? close : '',
      last: isDecimalString(close) ? groupDigits(close, entry.pricePrecision) : '--',
      // Signed: a falling pair must keep its change, or sorting by 24h change drops it to the bottom.
      rose: isSignedDecimalString(rose) ? rose : '',
      change: percentView(tick?.rose ?? ''),
      favorite: favorites.value.has(entry.pair),
    }
  })
  const key = sortKey.value
  if (key === null) return mapped
  const sign = sortDesc.value ? -1 : 1
  return [...mapped].sort((left, right) => {
    if (key === 'pair') return sign * left.entry.showPair.localeCompare(right.entry.showPair)
    const a = key === 'last' ? left.close : left.rose
    const b = key === 'last' ? right.close : right.rose
    // Pairs without a ticker always sink to the bottom.
    if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1
    return sign * (key === 'last' ? cmp(a, b) : cmpSigned(a, b))
  })
})

function sortIcon(key: SortKey): typeof ArrowUp {
  if (sortKey.value !== key) return ChevronsUpDown
  return sortDesc.value ? ArrowDown : ArrowUp
}
</script>

<template>
  <section v-if="SKIN === 'okx'" class="pair-list okx-pl" :aria-label="t('markets')">
    <div class="opl-top"><span class="opl-title">{{ t('markets') }}</span></div>
    <label class="pl-search opl-search">
      <Search :size="15" aria-hidden="true" />
      <input v-model="keyword" type="text" :placeholder="t('searchPair')" :aria-label="t('searchPair')" data-testid="pair-list-search" />
    </label>
    <div class="opl-tabs" role="tablist">
      <button class="opl-tab" :class="{ active: tab === 'fav' }" role="tab" type="button" :aria-selected="tab === 'fav'" @click="tab = 'fav'">{{ t('fav') }}</button>
      <button class="opl-tab" :class="{ active: tab === 'all' }" role="tab" type="button" :aria-selected="tab === 'all'" @click="tab = 'all'">{{ t('all') }}</button>
      <button v-for="category in categoryTabs" :key="category.id" class="opl-tab" :class="{ active: tab === category.id }" role="tab" type="button" :aria-selected="tab === category.id" @click="tab = category.id">{{ category.label ?? t(`cat.${category.id}`) }}</button>
      <button v-for="quote in okxQuoteTabs" :key="quote" class="opl-tab" :class="{ active: tab === quote }" role="tab" type="button" :aria-selected="tab === quote" @click="tab = quote">{{ quote }}</button>
    </div>
    <div class="opl-cols">
      <button type="button" @click="sortBy('pair')">{{ t('name') }}<component :is="sortIcon('pair')" :size="11" /></button>
      <span class="opl-sorts">
        <button type="button" @click="sortBy('last')">{{ t('last') }}</button>
        <i>/</i>
        <button type="button" @click="sortBy('change')">{{ t('change') }}<component :is="sortIcon(sortKey === 'last' ? 'last' : 'change')" :size="11" /></button>
      </span>
    </div>
    <div v-vertical-scroll-boundary class="pl-body">
      <div
        v-for="row in rows"
        :key="row.entry.pair"
        class="opl-row"
        :class="{ active: row.entry.pair === market.selectedPair }"
        role="button"
        tabindex="0"
        @click="market.selectPair(row.entry.pair)"
        @keydown.enter="market.selectPair(row.entry.pair)"
      >
        <button class="pl-star opl-star" :class="{ on: row.favorite }" type="button" :aria-label="t('star')" :aria-pressed="row.favorite" @click.stop="toggleFavorite(row.entry.pair)"><Star :size="14" /></button>
        <CoinMark :symbol="row.entry.base" :icon-url="row.entry.coin?.icon ?? ''" :size="22" />
        <span class="opl-name">
          <b>{{ row.entry.base }}<i v-if="props.tags[row.entry.pair]" class="pl-tag">{{ props.tags[row.entry.pair] }}</i></b>
          <small>{{ row.name }}</small>
        </span>
        <span class="opl-price">
          <b class="num">{{ row.last }}</b>
          <small class="num" :class="row.change.direction">{{ row.change.text }}</small>
        </span>
      </div>
      <p v-if="rows.length === 0" class="pl-empty">{{ tab === 'fav' && keyword === '' ? t('noFav') : t('empty') }}</p>
    </div>
  </section>
  <section v-else class="pair-list" :aria-label="t('pair')">
    <label class="pl-search">
      <Search :size="14" aria-hidden="true" />
      <input v-model="keyword" type="text" :placeholder="t('search')" :aria-label="t('search')" data-testid="pair-list-search" />
    </label>
    <div class="pl-tabs" role="tablist">
      <button class="pl-tab pl-tab-star" :class="{ active: tab === 'fav' }" role="tab" type="button" :aria-selected="tab === 'fav'" :title="t('fav')" :aria-label="t('fav')" @click="tab = 'fav'"><Star :size="13" /></button>
      <button class="pl-tab" :class="{ active: tab === 'all' }" role="tab" type="button" :aria-selected="tab === 'all'" @click="tab = 'all'">{{ t('all') }}</button>
      <button v-for="quote in quoteTabs" :key="quote" class="pl-tab" :class="{ active: tab === quote }" role="tab" type="button" :aria-selected="tab === quote" @click="tab = quote">{{ quote }}</button>
    </div>
    <div class="pl-cols">
      <button type="button" @click="sortBy('pair')">{{ t('pair') }}<component :is="sortIcon('pair')" :size="11" /></button>
      <button type="button" @click="sortBy('last')">{{ t('last') }}<component :is="sortIcon('last')" :size="11" /></button>
      <button type="button" @click="sortBy('change')">{{ t('change') }}<component :is="sortIcon('change')" :size="11" /></button>
    </div>
    <div v-vertical-scroll-boundary class="pl-body">
      <div
        v-for="row in rows"
        :key="row.entry.pair"
        class="pl-row"
        :class="{ active: row.entry.pair === market.selectedPair }"
        role="button"
        tabindex="0"
        @click="market.selectPair(row.entry.pair)"
        @keydown.enter="market.selectPair(row.entry.pair)"
      >
        <span class="pl-pair">
          <button class="pl-star" :class="{ on: row.favorite }" type="button" :aria-label="t('star')" :aria-pressed="row.favorite" @click.stop="toggleFavorite(row.entry.pair)"><Star :size="12" /></button>
          <b>{{ row.entry.base }}</b><small>/{{ row.entry.quote }}</small>
          <i v-if="props.tags[row.entry.pair]" class="pl-tag">{{ props.tags[row.entry.pair] }}</i>
        </span>
        <span class="num">{{ row.last }}</span>
        <span class="num" :class="row.change.direction">{{ row.change.text }}</span>
      </div>
      <p v-if="rows.length === 0" class="pl-empty">{{ tab === 'fav' && keyword === '' ? t('noFav') : t('empty') }}</p>
    </div>
  </section>
</template>

<style scoped>
.pair-list { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--color-surface); }
.pl-search {
  display: flex; flex: 0 0 auto; align-items: center; gap: 8px; height: 32px; margin: 12px 12px 6px; padding: 0 10px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius); color: var(--color-text-muted);
}
.pl-search:focus-within { border-color: var(--color-accent); }
.pl-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 12px; }
.pl-tabs { display: flex; flex: 0 0 auto; align-items: center; gap: 14px; height: 30px; padding: 0 12px; border-bottom: 1px solid var(--color-border); overflow-x: auto; scrollbar-width: none; }
.pl-tab { position: relative; display: inline-flex; align-items: center; height: 30px; padding: 0; color: var(--color-text-secondary); font-size: 12px; font-weight: 600; white-space: nowrap; }
.pl-tab:hover { color: var(--color-text); }
.pl-tab.active { color: var(--color-text); }
.pl-tab.active::after { content: ''; position: absolute; left: 25%; right: 25%; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.pl-tab-star.active { color: var(--color-accent-text); }
.pl-cols, .pl-row { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 0.8fr); gap: 6px; align-items: center; }
.pl-cols { flex: 0 0 auto; padding: 6px 12px 2px; }
.pl-cols button { display: inline-flex; align-items: center; gap: 2px; padding: 0; color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.pl-cols button:hover { color: var(--color-text-secondary); }
.pl-cols button:not(:first-child) { justify-content: flex-end; }
.pl-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.pl-row { height: 24px; padding: 0 12px; font-size: 12px; cursor: pointer; }
.pl-row:hover { background: var(--color-hover); }
.pl-row.active { background: var(--color-accent-soft); }
.pl-row:focus-visible { outline: 1px solid var(--color-accent); outline-offset: -1px; }
.pl-row > span:not(:first-child) { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-row .up { color: var(--color-up); }
.pl-row .down { color: var(--color-down); }
.pl-pair { display: flex; align-items: center; gap: 2px; min-width: 0; white-space: nowrap; overflow: hidden; }
.pl-pair b { font-weight: 550; }
.pl-pair small { color: var(--color-text-muted); font-size: 11px; }
.pl-star { display: inline-flex; padding: 0 4px 0 0; color: var(--color-text-muted); }
.pl-star:hover, .pl-star.on { color: var(--color-accent-text); }
.pl-star.on :deep(svg) { fill: currentColor; }
.pl-tag { margin-left: 4px; padding: 0 3px; border-radius: 2px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 10px; font-style: normal; line-height: 14px; }
/* OKX skin market column. */
.opl-top { display: flex; flex: 0 0 48px; align-items: center; padding: 0 16px; border-bottom: 1px solid var(--color-border); }
.opl-title { position: relative; display: inline-flex; align-items: center; height: 48px; font-size: 15px; font-weight: 700; }
.opl-title::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-text); }
.opl-search { height: 36px; margin: 12px 12px 4px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; background: var(--color-surface-alt); }
.opl-search:focus-within { border-color: var(--color-text); }
.opl-search input { font-size: 13px; }
.opl-tabs { display: flex; flex: 0 0 auto; align-items: center; gap: 16px; height: 40px; padding: 0 16px; overflow-x: auto; scrollbar-width: none; }
.opl-tab { position: relative; display: inline-flex; align-items: center; height: 40px; padding: 0; color: var(--color-text-muted); font-size: 13px; font-weight: 600; white-space: nowrap; }
.opl-tab:hover { color: var(--color-text); }
.opl-tab.active { color: var(--color-text); font-weight: 700; }
.opl-tab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: 6px; height: 2px; border-radius: 2px; background: var(--color-text); }
.opl-cols { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; padding: 6px 16px 6px 16px; color: var(--color-text-muted); font-size: 12px; }
.opl-cols button { display: inline-flex; align-items: center; gap: 2px; padding: 0; color: var(--color-text-muted); font-size: 12px; white-space: nowrap; }
.opl-cols button:hover { color: var(--color-text-secondary); }
.opl-sorts { display: inline-flex; align-items: center; gap: 2px; }
.opl-sorts i { font-style: normal; }
.opl-row { display: grid; grid-template-columns: 18px 22px minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 56px; padding: 0 16px 0 12px; cursor: pointer; }
.opl-row:hover { background: var(--color-hover); }
.opl-row.active { background: var(--color-surface-alt); }
.opl-row:focus-visible { outline: 1px solid var(--color-text); outline-offset: -1px; }
.opl-star { padding: 0; }
.opl-name, .opl-price { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.opl-name b { display: flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 700; white-space: nowrap; }
.opl-name small { overflow: hidden; color: var(--color-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.opl-price { align-items: flex-end; text-align: right; }
.opl-price b { font-size: 14px; font-weight: 600; white-space: nowrap; }
.opl-price small { font-size: 12px; font-weight: 550; white-space: nowrap; color: var(--color-text-secondary); }
.opl-price .up { color: var(--color-up); }
.opl-price .down { color: var(--color-down); }
.okx-pl .pl-tag { margin-left: 2px; }
.pl-empty { margin: 0; padding: 24px 12px; color: var(--color-text-muted); font-size: 12px; text-align: center; }
</style>
