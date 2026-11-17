<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import CoinMark from '@/components/common/CoinMark.vue'
import Sparkline from '@/components/market/Sparkline.vue'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { byDecimalDesc } from '@/components/home/binance/use-home-markets'
import { compactDecimal, percentView, type PercentView } from '@/modules/finance/display'
import type { MarketSymbol } from '@/modules/market/symbols'
import { ROW_TREND_POINTS, useMarketStore } from '@/stores/market'
import { vTick } from '@/components/home/fx/fx'

/**
 * Spot markets on the home page, OKX-style: four tabs over the live `review` tickers.
 *   热门 hot      — the admin's configured order (`sort`)
 *   涨幅 gainers  — 24h change, highest first
 *   新币 new      — pairs flagged `newcoinFlag`, otherwise by `tradingStartTime` (both from public_info_v4)
 *   成交额 volume — 24h turnover, highest first
 * Rows without a ticker show `--`; sparklines are the store's real hourly closes.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '实时行情', sub: '现货市场 24 小时实时数据，点击即可交易。', hot: '热门', gainers: '涨幅榜', fresh: '新币', volume: '成交额',
      pair: '币种', last: '最新价', change: '24h 涨跌', turnover: '24h 成交额', trend: '24h 走势', trade: '交易', all: '查看全部行情', none: '暂无数据',
    },
    'en-US': {
      title: 'Markets', sub: 'Live 24-hour spot market data. Pick a pair to trade.', hot: 'Popular', gainers: 'Top gainers', fresh: 'New listings', volume: 'Top volume',
      pair: 'Name', last: 'Last price', change: '24h change', turnover: '24h turnover', trend: '24h trend', trade: 'Trade', all: 'View all markets', none: 'No data yet',
    },
  },
})

type TabKey = 'hot' | 'gainers' | 'fresh' | 'volume'
const tabs: TabKey[] = ['hot', 'gainers', 'fresh', 'volume']
const tab = ref<TabKey>('hot')
const market = useMarketStore()
const router = useRouter()
const LIMIT = 6

interface Row {
  entry: MarketSymbol
  name: string
  last: string
  rose: string
  change: PercentView
  amount: string
  turnover: string
  trend: number[]
}

/** Listing facts from public_info_v4 (`newcoinFlag`, `tradingStartTime`) keyed by `BTC/USDT`. */
const listing = computed<Record<string, { isNew: boolean; start: string }>>(() => {
  const groups = market.publicInfo?.market?.market ?? {}
  const out: Record<string, { isNew: boolean; start: string }> = {}
  Object.values(groups).forEach((group) => {
    Object.entries(group).forEach(([pair, info]) => {
      const start = info?.tradingStartTime
      out[pair.toUpperCase()] = {
        isNew: String(info?.newcoinFlag ?? '0') === '1',
        start: start === undefined || start === null ? '' : String(start),
      }
    })
  })
  return out
})

function priceDp(entry: MarketSymbol): number {
  return Math.min(entry.pricePrecision, 8)
}

const rows = computed<Row[]>(() =>
  market.symbols.map((entry) => {
    const tick = market.tickers[entry.symbol.toLowerCase()]
    const rose = tick?.rose ?? ''
    const values = market.trends[entry.symbol]
    return {
      entry,
      name: entry.coin?.showName ?? entry.coin?.name ?? entry.base,
      last: tick !== undefined && isDecimalString(tick.close) ? groupDigits(tick.close, priceDp(entry)) : '--',
      rose,
      change: rose === '' ? { text: '--', direction: 'flat' } : percentView(rose),
      amount: tick?.amount ?? '',
      turnover: tick !== undefined ? compactDecimal(tick.amount) : '--',
      trend: values === undefined ? [] : values.slice(-ROW_TREND_POINTS),
    }
  }),
)

const shown = computed<Row[]>(() => {
  const list = [...rows.value]
  if (tab.value === 'gainers') list.sort(byDecimalDesc((row: Row) => row.rose))
  else if (tab.value === 'volume') list.sort(byDecimalDesc((row: Row) => row.amount))
  else if (tab.value === 'fresh') {
    const info = listing.value
    const flagged = list.filter((row) => info[row.entry.pair.toUpperCase()]?.isNew === true)
    const pool = flagged.length > 0 ? flagged : list
    pool.sort(byDecimalDesc((row: Row) => info[row.entry.pair.toUpperCase()]?.start ?? ''))
    return pool.slice(0, LIMIT)
  }
  return list.slice(0, LIMIT)
})

const visible = computed(() => shown.value.map((row) => row.entry.symbol).join(','))
watch(visible, (list) => market.loadTrends(list === '' ? [] : list.split(',')), { immediate: true })

function open(pair: string): void {
  market.selectPair(pair)
  void router.push('/trade')
}
</script>

<template>
  <section class="okx-sec">
    <div class="okx-wrap">
      <header class="okx-sec-head okx-sec-head-row">
        <div>
          <h2 class="okx-h2">{{ t('title') }}</h2>
          <p class="okx-sub">{{ t('sub') }}</p>
        </div>
        <RouterLink class="okx-link" to="/markets">{{ t('all') }}</RouterLink>
      </header>

      <div class="okx-seg" role="tablist">
        <button v-for="key in tabs" :key="key" type="button" role="tab" :aria-selected="tab === key" :class="{ on: tab === key }" @click="tab = key">{{ t(key) }}</button>
      </div>

      <div class="okx-mkt glass" role="table">
        <div class="okx-mkt-row okx-mkt-head" role="row">
          <span role="columnheader">{{ t('pair') }}</span>
          <span role="columnheader">{{ t('last') }}</span>
          <span role="columnheader">{{ t('change') }}</span>
          <span role="columnheader" class="hide-sm">{{ t('turnover') }}</span>
          <span role="columnheader" class="hide-md">{{ t('trend') }}</span>
          <span role="columnheader" class="hide-sm"></span>
        </div>
        <p v-if="shown.length === 0" class="okx-mkt-none">{{ t('none') }}</p>
        <div v-for="row in shown" :key="row.entry.pair" class="okx-mkt-row" role="row" tabindex="0" @click="open(row.entry.pair)" @keydown.enter="open(row.entry.pair)">
          <span class="okx-mkt-pair" role="cell">
            <CoinMark :symbol="row.entry.base" :icon-url="row.entry.coin?.icon ?? ''" :size="28" />
            <span>
              <strong>{{ row.entry.base }}<small>/{{ row.entry.quote }}</small></strong>
              <em class="ellipsis">{{ row.name }}</em>
            </span>
          </span>
          <span class="num okx-mkt-last" role="cell"><span v-tick="row.last">{{ row.last }}</span></span>
          <span class="num okx-mkt-chg" :class="row.change.direction" role="cell">{{ row.change.text }}</span>
          <span class="num hide-sm okx-mkt-dim" role="cell">{{ row.turnover }}</span>
          <span class="hide-md okx-mkt-spark" role="cell">
            <Sparkline :values="row.trend" :width="120" :height="34" :fill="false" :direction="row.change.direction === 'down' ? 'down' : 'up'" />
          </span>
          <span class="hide-sm okx-mkt-act" role="cell"><span class="okx-pill okx-pill-line okx-pill-sm">{{ t('trade') }}</span></span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.okx-mkt { margin-top: 16px; padding: 6px 10px; }
.okx-mkt-row {
  display: grid; grid-template-columns: minmax(180px, 1.6fr) 1.1fr 0.9fr 1fr 140px 96px; align-items: center; gap: 16px;
  min-height: 64px; padding: 0 16px; border-radius: 10px; cursor: pointer; transition: background-color .15s;
}
.okx-mkt-row:not(.okx-mkt-head):hover, .okx-mkt-row:focus-visible { background: var(--color-hover); }
.okx-mkt-row > span:not(:first-child) { text-align: right; justify-self: end; }
.okx-mkt-head { min-height: 44px; cursor: default; color: var(--color-text-muted); font-size: 13px; }
.okx-mkt-pair { display: flex; align-items: center; gap: 14px; min-width: 0; }
.okx-mkt-pair > span { display: flex; flex-direction: column; min-width: 0; }
.okx-mkt-pair strong { font-size: 17px; font-weight: 700; }
.okx-mkt-pair small { color: var(--color-text-muted); font-size: 13px; font-weight: 500; }
.okx-mkt-pair em { color: var(--color-text-muted); font-size: 12.5px; font-style: normal; }
.okx-mkt-last { font-size: 17px; font-weight: 600; }
.okx-mkt-chg { font-size: 16px; font-weight: 600; }
.okx-mkt-chg.flat { color: var(--color-text-muted); }
.okx-mkt-dim { color: var(--color-text-secondary); font-size: 15px; }
.okx-mkt-spark { width: 120px; }
.okx-mkt-none { padding: 40px 0; color: var(--color-text-muted); text-align: center; }
.okx-mkt-row:hover .okx-pill-line { border-color: var(--color-accent); color: var(--okx-gold-ink); }

@media (max-width: 1080px) {
  .okx-mkt-row { grid-template-columns: minmax(160px, 1.6fr) 1.1fr 0.9fr 1fr 96px; }
  .hide-md { display: none; }
}
@media (max-width: 720px) {
  .okx-mkt { padding: 4px; }
  .okx-mkt-row { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) 84px; gap: 10px; min-height: 64px; padding: 0 8px; }
  .hide-sm { display: none; }
  .okx-mkt-last { font-size: 15px; }
  .okx-mkt-chg { font-size: 14px; }
  .okx-mkt-pair strong { font-size: 15px; }
  /* Long pair names ellipsise inside their column instead of running under the price (mobile audit 10-22). */
  .okx-mkt-pair strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
@media (max-width: 380px) {
  .okx-mkt-row { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 72px; gap: 8px; }
  .okx-mkt-pair { gap: 8px; }
  .okx-mkt-pair small { font-size: 11px; }
  .okx-mkt-last, .okx-mkt-chg { font-size: 13px; }
}
</style>
