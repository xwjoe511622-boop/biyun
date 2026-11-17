<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, BarChart3, TrendingUp } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import MarketTable from '@/components/market/MarketTable.vue'
import { canonicalDecimal, cmpSigned, groupDigits, isDecimalString, isSignedDecimalString, sum } from '@/modules/finance/decimal'
import { compactDecimal, percentView } from '@/modules/finance/display'
import type { MarketSymbol } from '@/modules/market/symbols'
import { useMarketStore } from '@/stores/market'

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '行情中心', subtitle: '所有已上线现货交易对的实时 24 小时行情，数据来自交易所行情推送。',
      pairs: '已上线交易对', turnover: '24h 成交额', top: '24h 涨幅领先', none: '暂无推送', spot: '现货', futures: '合约', kind: '市场类型',
    },
    'en-US': {
      title: 'Markets', subtitle: 'Live 24-hour statistics for every listed spot pair, streamed from the exchange.',
      pairs: 'Listed pairs', turnover: '24h turnover', top: 'Top gainer (24h)', none: 'No data yet', spot: 'Spot', futures: 'Futures', kind: 'Market type',
    },
  },
})
const market = useMarketStore()

/** Phones (≤720px, owner 2026-11-17): the list comes first — no heading or stat cards — with a 现货 | 合约 switch. */
const FuturesQuoteList = defineAsyncComponent(() => import('@/components/market/FuturesQuoteList.vue'))
const MarketsMobile = defineAsyncComponent(() => import('@/components/market/MarketsMobile.vue'))
const PHONE = '(max-width: 720px)'
const phone = ref(typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches)
const kind = ref<'spot' | 'futures'>('spot')
let phoneQuery: MediaQueryList | null = null
const onPhoneChange = (event: MediaQueryListEvent): void => { phone.value = event.matches }

const quote = computed(() => market.symbols[0]?.quote ?? 'USDT')
const turnover = computed(() => {
  const values = market.symbols
    .filter((entry) => entry.quote === quote.value)
    .map((entry) => market.tickers[entry.symbol.toLowerCase()]?.amount ?? '')
    .filter(isDecimalString)
  return values.length === 0 ? '' : sum(values)
})
const topGainer = computed<{ entry: MarketSymbol; rose: string; close: string } | null>(() => {
  let best: { entry: MarketSymbol; rose: string; close: string } | null = null
  market.symbols.forEach((entry) => {
    const tick = market.tickers[entry.symbol.toLowerCase()]
    // `rose` is a signed ratio: on a day when every pair is down the leader is the smallest fall, not "no data".
    if (tick === undefined || !isSignedDecimalString(tick.rose)) return
    if (best === null || cmpSigned(tick.rose, best.rose) > 0) best = { entry, rose: tick.rose, close: tick.close }
  })
  return best
})

let stopStream: (() => void) | null = null

async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    return
  }
  if (stopStream !== null) market.loadTrend()
}

onMounted(() => {
  if (typeof window.matchMedia === 'function') {
    phoneQuery = window.matchMedia(PHONE)
    phone.value = phoneQuery.matches
    phoneQuery.addEventListener('change', onPhoneChange)
  }
  // Overview only: every pair's ticker from the review channel, plus one trend request.
  stopStream = market.start('overview')
  void bootstrap()
})
onBeforeUnmount(() => {
  phoneQuery?.removeEventListener('change', onPhoneChange)
  stopStream?.()
  stopStream = null
})
</script>

<template>
  <div class="page markets-page">
    <header class="head">
      <h1>{{ t('title') }}</h1>
      <p>{{ t('subtitle') }}</p>
    </header>

    <section class="cards">
      <article class="card">
        <span class="card-icon"><BarChart3 :size="18" /></span>
        <span class="card-label">{{ t('pairs') }}</span>
        <strong class="card-value num">{{ market.symbols.length }}</strong>
      </article>
      <article class="card">
        <span class="card-icon"><Activity :size="18" /></span>
        <span class="card-label">{{ t('turnover') }}</span>
        <strong class="card-value num">{{ turnover === '' ? '--' : compactDecimal(turnover) }} <small>{{ quote }}</small></strong>
      </article>
      <article class="card">
        <span class="card-icon"><TrendingUp :size="18" /></span>
        <span class="card-label">{{ t('top') }}</span>
        <strong v-if="topGainer !== null" class="card-value gainer">
          <CoinMark :symbol="topGainer.entry.base" :icon-url="topGainer.entry.coin?.icon ?? ''" :size="24" />
          <span>{{ topGainer.entry.showPair }}</span>
          <span class="num" :class="percentView(topGainer.rose).direction">{{ percentView(topGainer.rose).text }}</span>
          <span class="num muted small">{{ groupDigits(canonicalDecimal(topGainer.close), topGainer.entry.pricePrecision) }}</span>
        </strong>
        <strong v-else class="card-value muted">{{ t('none') }}</strong>
      </article>
    </section>

    <nav v-if="phone" class="kind-switch" :aria-label="t('kind')">
      <button type="button" :class="{ active: kind === 'spot' }" :aria-pressed="kind === 'spot'" data-testid="markets-kind-spot" @click="kind = 'spot'">{{ t('spot') }}</button>
      <button type="button" :class="{ active: kind === 'futures' }" :aria-pressed="kind === 'futures'" data-testid="markets-kind-futures" @click="kind = 'futures'">{{ t('futures') }}</button>
    </nav>
    <section v-if="phone && kind === 'spot'" class="phone-list">
      <MarketsMobile @retry="bootstrap" />
    </section>
    <section v-else-if="!phone" class="panel table-panel">
      <MarketTable @retry="bootstrap" />
    </section>
    <section v-else class="phone-list">
      <FuturesQuoteList />
    </section>
  </div>
</template>

<style scoped>
.head h1 { margin: 0; font-size: 34px; font-weight: 750; }
.head p { margin: 8px 0 0; color: var(--color-text-secondary); }
.cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 26px 0 18px; }
.card {
  position: relative; display: flex; flex-direction: column; gap: 6px; padding: 20px 22px; overflow: hidden;
  border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface);
  animation: rise-in 0.5s var(--ease-out) both;
}
.card:nth-child(2) { animation-delay: 60ms; }
.card:nth-child(3) { animation-delay: 120ms; }
.card::after {
  content: ''; position: absolute; right: -40px; top: -40px; width: 140px; height: 140px; border-radius: 50%;
  background: radial-gradient(circle, var(--color-accent-soft), transparent 70%);
}
.card-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; margin-bottom: 6px;
  border-radius: 10px; background: var(--color-accent-soft); color: var(--color-accent-text);
}
.card-label { color: var(--color-text-muted); font-size: 13px; }
.card-value { font-size: 24px; font-weight: 650; }
.card-value small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 13px; }
.card-value.muted { font-size: 16px; font-weight: 550; }
.gainer { display: flex; align-items: center; gap: 10px; font-size: 17px; flex-wrap: wrap; }
.small { font-size: 13px; }
.table-panel { padding: 18px 18px 8px; }
@media (max-width: 820px) {
  .head h1 { font-size: 26px; }
  .head p { font-size: 14px; line-height: 1.55; }
  /* Phones: three compact figures (pairs and turnover side by side, the top gainer across), not three tall cards. */
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 18px 0 14px; }
  .card { gap: 4px; padding: 14px 16px; }
  .card:nth-child(3) { grid-column: 1 / -1; }
  .card::after { display: none; }
  .card-icon { display: none; }
  .card-value { font-size: 20px; }
  .gainer { gap: 8px; font-size: 15px; }
  .table-panel { padding: 14px 10px 4px; }
}
.kind-switch { display: flex; gap: 22px; padding: 0 4px; }
.kind-switch button { position: relative; height: 40px; color: var(--color-text-muted); font-family: var(--font-display); font-size: 18px; font-weight: 700; }
.kind-switch button.active { color: var(--color-text); }
.kind-switch button.active::after { content: ''; position: absolute; left: 15%; right: 15%; bottom: 0; height: 2px; border-radius: 2px; background: var(--color-accent); }
.futures-panel { padding: 4px 0; overflow: hidden; }
@media (max-width: 720px) {
  .head, .cards { display: none; }
  /* Edge-to-edge lists: no card around them, the rows run to the screen edges. */
  .markets-page { padding: 2px 0 24px; }
  .kind-switch { padding: 0 16px; }
  .phone-list { margin-top: 8px; }
}
</style>
