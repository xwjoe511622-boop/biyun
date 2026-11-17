<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import Sparkline from '@/components/market/Sparkline.vue'
import { compactDecimal } from '@/modules/finance/display'
import { ROW_TREND_POINTS, useMarketStore } from '@/stores/market'
import { byDecimalDesc, useOpenMarket, type HomeMarketRow } from './use-home-markets'
import { vTick } from '@/components/home/fx/fx'

/**
 * Live markets: four spotlight cards (BTC, ETH, XAUT, NVDA spot when listed) with the store's real hourly closes as a
 * sparkline; then the market table — spot, perpetuals, gold & US stocks across both, and top gainers, ten rows per
 * tab (the full list is one click away on /markets). Live rows only.
 */
const props = defineProps<{ spot: HomeMarketRow[]; futures: HomeMarketRow[] }>()

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '市场概览', sub: '现货与 U 本位永续的实时 24 小时行情，点击任一市场进入交易。', all: '查看更多行情',
      spot: '现货', futures: 'U 本位永续', rwa: '黄金与美股', gainers: '涨幅榜',
      name: '名称', last: '最新价', change: '24h 涨跌', high: '24h 最高', low: '24h 最低', turnover: '24h 成交额', action: '操作',
      trade: '交易', perp: '永续', gold: '黄金', stock: '美股', lever: '{n}x', empty: '暂无市场', waiting: '等待行情推送',
    },
    'en-US': {
      title: 'Market overview', sub: 'Live 24-hour figures for spot and USDT-margined perpetuals. Pick a market to trade it.', all: 'More markets',
      spot: 'Spot', futures: 'USDⓈ-M perpetuals', rwa: 'Gold & US stocks', gainers: 'Top gainers',
      name: 'Name', last: 'Last price', change: '24h change', high: '24h high', low: '24h low', turnover: '24h turnover', action: 'Action',
      trade: 'Trade', perp: 'Perp', gold: 'Gold', stock: 'US stock', lever: '{n}x', empty: 'No markets yet', waiting: 'Awaiting live prices',
    },
  },
})

const market = useMarketStore()
const SPOTLIGHT = ['BTC', 'ETH', 'XAUT', 'NVDA']
const spotlight = computed<HomeMarketRow[]>(() => {
  const picked = SPOTLIGHT.map((base) => props.spot.find((row) => row.base.toUpperCase() === base)).filter((row): row is HomeMarketRow => row !== undefined)
  for (const row of props.spot) {
    if (picked.length >= 4) break
    if (!picked.includes(row)) picked.push(row)
  }
  return picked.slice(0, 4)
})
/** Spot row key is `spot:<channel symbol>`; trends are keyed by the channel symbol. */
const symbolOf = (row: HomeMarketRow): string => row.key.slice('spot:'.length)
const spotlightList = computed(() => spotlight.value.map(symbolOf).join(','))
watch(spotlightList, (list) => market.loadTrends(list === '' ? [] : list.split(',')), { immediate: true })
const trendOf = (row: HomeMarketRow): number[] => (market.trends[symbolOf(row)] ?? []).slice(-ROW_TREND_POINTS)

type Tab = 'spot' | 'futures' | 'rwa' | 'gainers'
const tab = ref<Tab>('spot')
const open = useOpenMarket()

const tabs = computed(() => {
  const list: Tab[] = ['spot']
  if (props.futures.length > 0) list.push('futures')
  if ([...props.spot, ...props.futures].some((row) => row.assetClass !== 'crypto')) list.push('rwa')
  list.push('gainers')
  return list
})

const ROWS = 10
const rows = computed<HomeMarketRow[]>(() => {
  const all = [...props.spot, ...props.futures]
  switch (tab.value) {
    case 'futures': return props.futures.slice(0, ROWS)
    case 'rwa': return all.filter((row) => row.assetClass !== 'crypto').slice(0, ROWS)
    case 'gainers': return all.filter((row) => row.rose !== '').sort(byDecimalDesc((row: HomeMarketRow) => row.rose)).slice(0, ROWS)
    default: return props.spot.slice(0, ROWS)
  }
})
</script>

<template>
  <section class="bn-section market-overview" data-fx>
    <div class="bn-section-inner">
      <header class="bn-section-head">
        <div>
          <h2>{{ t('title') }}</h2>
          <p>{{ t('sub') }}</p>
        </div>
        <RouterLink class="bn-link-more" to="/markets">{{ t('all') }}<ChevronRight :size="16" /></RouterLink>
      </header>

      <ul v-if="spotlight.length > 0" class="spot-cards">
        <li v-for="row in spotlight" :key="row.key">
          <button type="button" class="spot-card glass" @click="open(row)">
            <span class="spot-top">
              <CoinMark :symbol="row.base" :icon-url="row.icon" :size="28" />
              <strong>{{ row.base }}<small>/{{ row.quote }}</small></strong>
              <span class="num spot-chg" :class="row.change.direction">{{ row.change.text }}</span>
            </span>
            <span v-tick="row.last" class="num spot-px">{{ row.last }}</span>
            <span class="spot-spark"><Sparkline :values="trendOf(row)" :width="220" :height="44" :direction="row.change.direction === 'down' ? 'down' : 'up'" /></span>
          </button>
        </li>
      </ul>

      <div class="market-panel glass">
      <div class="tabs" role="tablist">
        <button v-for="key in tabs" :key="key" type="button" role="tab" class="tab" :class="{ 'is-active': tab === key }" :aria-selected="tab === key" @click="tab = key">{{ t(key) }}</button>
      </div>

      <table v-if="rows.length > 0" class="market-table">
        <thead>
          <tr>
            <th>{{ t('name') }}</th>
            <th class="r">{{ t('last') }}</th>
            <th class="r">{{ t('change') }}</th>
            <th class="r hide-sm">{{ t('high') }}</th>
            <th class="r hide-sm">{{ t('low') }}</th>
            <th class="r hide-md">{{ t('turnover') }}</th>
            <th class="r hide-sm">{{ t('action') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" tabindex="0" @click="open(row)" @keydown.enter="open(row)">
            <td>
              <span class="pair">
                <CoinMark :symbol="row.base" :icon-url="row.icon" :size="28" />
                <span class="pair-text">
                  <span class="pair-line">
                    <strong>{{ row.kind === 'futures' ? row.label : row.base }}</strong>
                    <small v-if="row.kind === 'spot'" class="quote">/{{ row.quote }}</small>
                    <small v-if="row.kind === 'futures'" class="tag">{{ t('perp') }}</small>
                    <small v-if="row.maxLever > 0" class="tag accent">{{ t('lever', { n: row.maxLever }) }}</small>
                    <small v-if="row.assetClass !== 'crypto'" class="tag gold">{{ t(row.assetClass) }}</small>
                  </span>
                  <span class="pair-name ellipsis">{{ row.name }}</span>
                </span>
              </span>
            </td>
            <td class="r num strong"><span v-tick="row.last">{{ row.last }}</span></td>
            <td class="r num" :class="row.change.direction">{{ row.change.text }}</td>
            <td class="r num hide-sm">{{ row.high }}</td>
            <td class="r num hide-sm">{{ row.low }}</td>
            <td class="r num hide-md">{{ row.turnover === '' ? '--' : compactDecimal(row.turnover) }}</td>
            <td class="r hide-sm"><span class="trade-link">{{ t('trade') }}</span></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">{{ tab === 'gainers' ? t('waiting') : t('empty') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.spot-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 16px; padding: 0; list-style: none; }
.spot-card {
  display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 16px 20px 0; overflow: hidden; text-align: left;
}
.spot-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.spot-top strong { color: var(--color-text); font-size: 16px; font-weight: 650; }
.spot-top small { color: var(--color-text-muted); font-size: 13px; font-weight: 500; }
.spot-chg { margin-left: auto; font-size: 14px; font-weight: 600; }
.spot-px { margin-top: 6px; color: var(--color-text); font-size: 24px; font-weight: 650; letter-spacing: -0.01em; }
.spot-spark { display: block; height: 44px; margin: 6px -20px 0; opacity: 0.85; }
.spot-spark :deep(svg) { display: block; width: 100%; height: 100%; }
.spot-card { transition: border-color 0.15s; }
.spot-card:hover, .spot-card:focus-visible { border-color: var(--color-border-strong); }
.market-panel { padding: 16px 12px 12px; }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; overflow-x: auto; scrollbar-width: none; }
.tab {
  height: 32px; padding: 0 14px; border-radius: 6px; color: var(--color-text-secondary); font-size: 14px; font-weight: 500; white-space: nowrap;
  transition: color 0.15s, background-color 0.15s;
}
.tab:hover { color: var(--color-text); }
.tab.is-active { background: var(--color-surface-alt); color: var(--color-text); }

.market-table { width: 100%; border-collapse: collapse; table-layout: auto; }
.market-table th {
  height: 40px; padding: 0 16px; color: var(--color-text-secondary); font-size: 12px; font-weight: 400; text-align: left; white-space: nowrap;
}
.market-table td { height: 60px; padding: 0 16px; color: var(--color-text); font-size: 15px; white-space: nowrap; }
.market-table tbody tr { cursor: pointer; transition: background-color 0.12s; }
.market-table tbody tr:hover, .market-table tbody tr:focus-visible { background: var(--color-hover); }
.market-table tbody td:first-child { border-radius: 8px 0 0 8px; }
.market-table tbody td:last-child { border-radius: 0 8px 8px 0; }
.r { text-align: right !important; }
.strong { font-weight: 500; }
.up { color: var(--color-up) !important; }
@media (max-width: 1000px) { .spot-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.down { color: var(--color-down) !important; }
.flat { color: var(--color-text-secondary) !important; }
.pair { display: flex; align-items: center; gap: 12px; min-width: 0; }
.pair-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pair-line { display: flex; align-items: baseline; gap: 6px; }
.pair-line strong { font-size: 15px; font-weight: 600; }
.quote { color: var(--color-text-secondary); font-size: 13px; }
.pair-name { max-width: 260px; color: var(--color-text-secondary); font-size: 12px; }
.tag { align-self: center; padding: 1px 5px; border-radius: 4px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 11px; font-weight: 500; }
.tag.accent { background: var(--color-accent-soft); color: var(--color-accent-text); }
.tag.gold { background: color-mix(in srgb, #c99400 16%, transparent); color: var(--color-text); }
.trade-link { color: var(--color-accent-text); font-size: 14px; font-weight: 500; }
tr:hover .trade-link { text-decoration: underline; }
.empty { padding: 48px 0; margin: 0; color: var(--color-text-secondary); text-align: center; }

@media (max-width: 1000px) { .hide-md { display: none; } }
@media (max-width: 720px) {
  .hide-sm { display: none; }
  /* Phones: six rows per tab; the full list is behind "More markets". */
  .market-table tbody tr:nth-child(n + 7) { display: none; }
  .market-table { table-layout: fixed; }
  .market-table th:nth-child(2) { width: 31%; }
  .market-table th:nth-child(3) { width: 25%; }
  .market-table th, .market-table td { padding: 0 4px; }
  .market-table td { height: 60px; font-size: 14px; }
  .market-table td.num { white-space: normal; overflow-wrap: anywhere; }
  .pair { gap: 6px; }
  .pair-line { flex-wrap: wrap; gap: 2px 4px; white-space: normal; overflow-wrap: anywhere; }
  .pair-name { max-width: 100%; }
  .tag.accent { display: none; }
  .spot-cards { gap: 10px; }
  .spot-card { padding: 14px 14px 0; }
  .spot-px { font-size: 18px; margin-top: 4px; }
  .spot-top small { display: none; }
  .spot-spark { height: 36px; margin: 4px -14px 0; }
  .market-panel { padding: 8px 4px; }
}
</style>
