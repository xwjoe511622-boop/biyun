<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { canonicalDecimal, groupDigits } from '@/modules/finance/decimal'
import { compactDecimal, percentView } from '@/modules/finance/display'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { countdownText, fundingRateView, nextFundingTime } from '@/modules/futures/math'
import { contractsAmount } from '@/modules/futures/size-unit'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { useFuturesMarketStore } from '@/stores/futures-market'

/** Last / mark / index price, funding rate with the settlement countdown and the 24h stats. */
const { t } = useFuturesI18n()
const market = useFuturesMarketStore()
const scroller = ref<HTMLDivElement | null>(null)
const stats = ref<HTMLElement | null>(null)
const overflow = ref(false)
let resize: ResizeObserver | null = null
onMounted(() => {
  const measure = (): void => { overflow.value = scroller.value !== null && scroller.value.scrollWidth > scroller.value.clientWidth + 1 }
  if (typeof ResizeObserver !== 'undefined') {
    resize = new ResizeObserver(measure)
    if (scroller.value !== null) resize.observe(scroller.value)
    if (stats.value !== null) resize.observe(stats.value)
  }
  measure()
})
onBeforeUnmount(() => resize?.disconnect())

const clock = ref(market.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { clock.value = market.now() }, 1000) })
onBeforeUnmount(() => { if (timer !== null) clearInterval(timer) })

const contract = computed(() => market.currentContract)
const change = computed(() => percentView(market.ticker.rose))
const sizes = useSizeFormat()
/** 24h volume in the size unit: contracts, contracts × face value, or (USDT) the 24h turnover. */
const volume24h = computed(() => {
  if (sizes.unit.value === 'quote') return { text: compactDecimal(market.ticker.amount), unit: sizes.label(contract.value) }
  const result = contractsAmount(canonicalDecimal(market.ticker.vol), sizes.unit.value, contract.value)
  return { text: result.amount === '' ? '--' : compactDecimal(result.amount), unit: sizes.label(contract.value, result.unit) }
})

function price(value: string): string {
  const normalized = canonicalDecimal(value)
  return normalized === '' || contract.value === undefined ? '--' : groupDigits(normalized, contract.value.pricePrecision)
}

const funding = computed(() => fundingRateView(market.marketInfo.currentFundRate))
const nextFunding = computed(() => fundingRateView(market.marketInfo.nextFundRate))
const countdown = computed(() => {
  const target = nextFundingTime(clock.value, contract.value?.capitalStartTime ?? null, contract.value?.capitalFrequency ?? null)
  return countdownText(target, clock.value)
})
const liveClass = computed(() => (market.connectionState === 'open' ? 'on' : market.connectionState === 'connecting' ? 'wait' : 'off'))
const liveText = computed(() => {
  if (market.connectionState === 'open') return t('fut.wsLive')
  if (market.connectionState === 'connecting') return t('fut.wsConnecting')
  return t('fut.wsDisconnected')
})
</script>

<template>
  <div class="fticker-shell">
  <div ref="scroller" class="fticker" role="region" tabindex="0" :aria-label="t('fut.marketStatsScroll')" :title="t('fut.marketStatsScroll')">
    <div class="fticker-main">
      <span class="last-price num" :class="change.direction">{{ price(market.ticker.close) }}</span>
      <span class="feed" :class="liveClass" :title="market.connectionState === 'open' ? '' : t('fut.wsHint')"><i></i>{{ liveText }}</span>
    </div>
    <dl ref="stats" class="fticker-stats">
      <div class="stat">
        <dt>{{ t('fut.markPrice') }}</dt>
        <dd class="num">{{ price(market.marketInfo.tagPrice) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.indexPrice') }}</dt>
        <dd class="num">{{ price(market.marketInfo.indexPrice) }}</dd>
      </div>
      <div class="stat funding">
        <dt>{{ t('fut.fundingRate') }} / {{ t('fut.countdown') }}</dt>
        <dd class="num"><span :class="funding.direction">{{ funding.text }}</span><span class="sep">/</span><span class="cd">{{ countdown }}</span></dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.nextFundingRate') }}</dt>
        <dd class="num" :class="nextFunding.direction">{{ nextFunding.text }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.change24h') }}</dt>
        <dd class="num" :class="change.direction">{{ change.text }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.high24h') }}</dt>
        <dd class="num">{{ price(market.ticker.high) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.low24h') }}</dt>
        <dd class="num">{{ price(market.ticker.low) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.volume24h', { unit: volume24h.unit }) }}</dt>
        <dd class="num">{{ volume24h.text }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('fut.amount24h') }}<template v-if="contract"> ({{ contract.quote }})</template></dt>
        <dd class="num">{{ compactDecimal(market.ticker.amount) }}</dd>
      </div>
    </dl>
  </div>
  <span v-if="overflow" class="scroll-cue" aria-hidden="true">↔</span>
  </div>
</template>

<style scoped>
.fticker-shell { position: relative; flex: 1; min-width: 0; }
.scroll-cue { position: absolute; right: 0; top: 0; bottom: 4px; display: flex; align-items: center; padding: 0 3px 0 12px; background: linear-gradient(90deg, transparent, var(--color-surface) 45%); color: var(--color-accent-text); pointer-events: none; font-size: 14px; }
.fticker { display: flex; align-items: center; gap: 26px; min-width: 0; overflow-x: auto; flex: 1; scrollbar-width: thin; scrollbar-color: var(--color-border-strong) transparent; padding-bottom: 4px; }
.fticker::-webkit-scrollbar { height: 5px; }
.fticker::-webkit-scrollbar-thumb { border-radius: 4px; background: var(--color-border-strong); }
.fticker:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
.fticker-main { flex-shrink: 0; display: flex; flex-direction: column; gap: 2px; min-width: 116px; }
.last-price { font-size: 22px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; }
.last-price.flat { color: var(--color-text); }
.feed { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.feed i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.feed.on { color: var(--color-up); }
.feed.on i { animation: pulse-dot 2s infinite; }
.feed.wait { color: var(--color-warning); }
.feed.off { color: var(--color-down); }
.fticker-stats { flex-shrink: 0; display: flex; align-items: center; gap: 26px; margin: 0; min-width: 0; }
.stat dt { color: var(--color-text-muted); font-size: 11px; white-space: nowrap; margin-bottom: 3px; }
.stat dd { margin: 0; font-size: 13px; font-weight: 550; white-space: nowrap; }
.stat dd.up, .stat .up { color: var(--color-up); }
.stat dd.down, .stat .down { color: var(--color-down); }
.funding .sep { margin: 0 5px; color: var(--color-text-muted); }
.funding .cd { color: var(--color-accent-text); }
@media (max-width: 760px) {
  .fticker-shell { flex-basis: 100%; }
  .scroll-cue { display: none; }
  .fticker { flex-basis: 100%; gap: 14px; overflow: visible; align-items: flex-start; }
  .fticker-main { min-width: 104px; }
  .fticker-stats { flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
  .stat:nth-child(n + 5) { display: none; }
  .stat.funding { grid-column: 1 / -1; order: 5; }
  .stat dt { white-space: normal; }
  .last-price { font-size: 20px; }
}
</style>
