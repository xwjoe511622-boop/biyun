<script setup lang="ts">
import { computed } from 'vue'

import { useI18n } from 'vue-i18n'
import { SKIN } from '@/core/skin'
import { canonicalDecimal, groupDigits, isDecimalString, isPositive, sub } from '@/modules/finance/decimal'
import { compactDecimal, percentView } from '@/modules/finance/display'
import { useMarketStore } from '@/stores/market'

const { t } = useI18n()
const { t: tl } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { low: '24h 最低', high: '24h 最高', vol: '24h 量', amount: '24h 额' },
    'en-US': { low: '24h low', high: '24h high', vol: '24h volume', amount: '24h turnover' },
  },
})
defineProps<{ compact?: boolean }>()
const market = useMarketStore()

const symbol = computed(() => market.currentSymbol)

const change = computed(() => percentView(market.ticker.rose))

/** The review stream can deliver the price before public info (the pair's precision) has loaded. */
const lastPrice = computed(() => {
  const value = canonicalDecimal(market.ticker.close)
  if (value === '') {
    return '--'
  }
  return symbol.value === undefined ? groupDigits(value) : groupDigits(value, symbol.value.pricePrecision)
})

function formatStat(value: string): string {
  const normalized = canonicalDecimal(value)
  if (normalized === '') {
    return '--'
  }
  return symbol.value === undefined ? groupDigits(normalized) : groupDigits(normalized, Math.min(symbol.value.pricePrecision, 8))
}

/** OKX skin: absolute 24h change (close − open, exact decimals) shown under the last price with the percentage. */
const changeLine = computed(() => {
  const close = canonicalDecimal(market.ticker.close)
  const open = canonicalDecimal(market.ticker.open)
  // No usable 24h open (empty or 0 on a fresh market): the percentage alone, never `close − 0`.
  if (!isDecimalString(close) || !isDecimalString(open) || !isPositive(open)) return change.value.text
  const delta = sub(close, open)
  const text = symbol.value === undefined ? groupDigits(delta) : groupDigits(delta, symbol.value.pricePrecision)
  return `${isPositive(delta) ? '+' : ''}${text} (${change.value.text})`
})

function formatTurnover(value: string): string {
  const normalized = canonicalDecimal(value)
  return normalized === '' ? '--' : compactDecimal(normalized, 2)
}

function formatVolume(value: string): string {
  const normalized = canonicalDecimal(value)
  return normalized === '' ? '--' : groupDigits(normalized, 4)
}
</script>

<template>
  <div v-if="SKIN === 'okx'" class="ticker okx-ticker">
    <div class="ticker-main">
      <span class="last-price num" :class="change.direction">{{ lastPrice }}</span>
      <span class="change-line num" :class="change.direction">{{ changeLine }}</span>
    </div>
    <dl class="ticker-stats">
      <div class="stat">
        <dt>{{ tl('low') }}</dt>
        <dd class="num">{{ formatStat(market.ticker.low) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ tl('high') }}</dt>
        <dd class="num">{{ formatStat(market.ticker.high) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ tl('vol') }}<template v-if="symbol"> ({{ symbol.base }})</template></dt>
        <dd class="num">{{ formatVolume(market.ticker.vol) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ tl('amount') }}<template v-if="symbol"> ({{ symbol.quote }})</template></dt>
        <dd class="num">{{ formatTurnover(market.ticker.amount) }}</dd>
      </div>
    </dl>
    <div class="ticker-status">
      <span v-if="!market.tickerReceived" class="muted">{{ t('status.never') }}</span>
    </div>
  </div>
  <div v-else-if="compact" class="mobile-ticker">
    <div class="quote-main">
      <span class="quote"><small>{{ t('trade.lastPrice') }}</small><strong class="last-price num" :class="change.direction">{{ lastPrice }}</strong></span>
      <span class="quote"><small>{{ t('trade.change24h') }}</small><span class="num" :class="change.direction">{{ change.text }}</span></span>

    </div>
    <dl>
      <div><dt>{{ t('trade.high24h') }}</dt><dd>{{ formatStat(market.ticker.high) }}</dd></div>
      <div><dt>{{ t('trade.low24h') }}</dt><dd>{{ formatStat(market.ticker.low) }}</dd></div>
      <div><dt>{{ t('trade.volume24h') }}<template v-if="symbol"> ({{ symbol.base }})</template></dt><dd>{{ formatVolume(market.ticker.vol) }}</dd></div>
      <div><dt>{{ t('trade.amount24h') }}<template v-if="symbol"> ({{ symbol.quote }})</template></dt><dd>{{ formatVolume(market.ticker.amount) }}</dd></div>
    </dl>
  </div>
  <div v-else class="ticker">
    <div class="ticker-main">
      <span class="last-price num" :class="change.direction">{{ lastPrice }}</span>
      <span class="stat-label">{{ t('trade.lastPrice') }}</span>
    </div>
    <dl class="ticker-stats">
      <div class="stat">
        <dt>{{ t('trade.change24h') }}</dt>
        <dd class="num" :class="change.direction">{{ change.text }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('trade.high24h') }}</dt>
        <dd class="num">{{ formatStat(market.ticker.high) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('trade.low24h') }}</dt>
        <dd class="num">{{ formatStat(market.ticker.low) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('trade.volume24h') }}<template v-if="symbol"> ({{ symbol.base }})</template></dt>
        <dd class="num">{{ formatVolume(market.ticker.vol) }}</dd>
      </div>
      <div class="stat">
        <dt>{{ t('trade.amount24h') }}<template v-if="symbol"> ({{ symbol.quote }})</template></dt>
        <dd class="num">{{ formatVolume(market.ticker.amount) }}</dd>
      </div>
    </dl>
    <div class="ticker-status">
      <span v-if="!market.tickerReceived" class="muted">{{ t('status.never') }}</span>
    </div>
  </div>
</template>

<style scoped>
.ticker { display: flex; align-items: center; gap: 28px; min-width: 0; overflow-x: auto; flex: 1; scrollbar-width: none; }
.ticker-main { display: flex; flex-direction: column; gap: 1px; min-width: 110px; }
.stat-label { color: var(--color-text-muted); font-size: 11px; }
.last-price { font-size: 22px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; }
.last-price.flat { color: var(--color-text); }
.ticker-stats { display: flex; align-items: center; gap: 30px; margin: 0; min-width: 0; }
.stat dt { color: var(--color-text-muted); font-size: 11px; white-space: nowrap; margin-bottom: 3px; }
.stat dd { margin: 0; font-size: 13px; font-weight: 550; }
.stat dd.up { color: var(--color-up); }
.stat dd.down { color: var(--color-down); }
.okx-ticker { gap: 32px; }
.okx-ticker .ticker-main { gap: 2px; min-width: 0; }
.okx-ticker .last-price { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.change-line { font-size: 12px; font-weight: 600; white-space: nowrap; }
.change-line.up { color: var(--color-up); }
.change-line.down { color: var(--color-down); }
.change-line.flat { color: var(--color-text-secondary); }
.okx-ticker .ticker-stats { gap: 28px; }
.okx-ticker .stat dt { margin-bottom: 2px; font-size: 12px; }
.okx-ticker .stat dd { font-size: 13px; font-weight: 600; }
.ticker-status { margin-left: auto; font-size: 11px; white-space: nowrap; }
@media (max-width: 760px) {
  .ticker { flex-basis: 100%; gap: 14px; overflow: visible; }
  .ticker-main { min-width: 96px; }
  .ticker-stats { flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
  .stat:nth-child(n + 4) { display: none; }
  .stat dt { white-space: normal; }
  .last-price { font-size: 20px; }
  .ticker-status { display: none; }
}
.mobile-ticker {
  order: 1;
  flex: 0 0 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.quote-main { display: grid; gap: 6px; }
.mobile-ticker .quote { display: grid; gap: 2px; overflow-wrap: anywhere; }
.mobile-ticker small, .mobile-ticker dt { color: var(--color-text-muted); font-size: 12px; }
.mobile-ticker dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 8px; margin: 0; }
.mobile-ticker dl > div { min-width: 0; }
.mobile-ticker dt, .mobile-ticker dd { overflow-wrap: anywhere; }
.mobile-ticker dd { margin: 2px 0 0; font-size: 13px; font-variant-numeric: tabular-nums; }
</style>
