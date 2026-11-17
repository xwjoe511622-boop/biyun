<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { canonicalDecimal, groupDigits, toDecString } from '@/modules/finance/decimal'
import { formatClock } from '@/modules/finance/display'
import { quoteValue } from '@/modules/market/trade-value'
import { columnDecimals, formatBookAmount, useMarketSource } from './market-source'

const { t } = useI18n()
const market = useMarketSource()

const symbol = computed(() => market.currentSymbol)

function price(value: string | number): string {
  const precision = symbol.value?.pricePrecision ?? 2
  return groupDigits(canonicalDecimal(typeof value === 'number' ? String(value) : value), precision)
}

const amountDecimals = computed(() => columnDecimals(market.trades.map((trade) => canonicalDecimal(toDecString(trade.vol)))))
function amount(value: string | number): string {
  return formatBookAmount(canonicalDecimal(toDecString(value)), symbol.value, amountDecimals.value)
}

/** Hover value: `vol * multiplier * price` (futures multiplier = face value; never the futures WS `amount`, L43). */
function valueTitle(vol: string | number, tradePrice: string | number): string {
  const value = symbol.value?.volumeIsValue === true ? canonicalDecimal(toDecString(vol)) : quoteValue(vol, tradePrice, symbol.value?.valueMultiplier ?? '1')
  if (value === '') return ''
  return `${t('common.total')}: ${groupDigits(value, symbol.value?.pricePrecision ?? 2)} ${symbol.value?.quote ?? ''}`
}

function isBuy(side: string | undefined): boolean {
  return (side ?? '').toUpperCase() === 'BUY'
}
</script>

<template>
  <section class="trades" :aria-label="t('trade.recentTrades')">
    <header class="trades-head">
      <span class="trades-title">{{ t('trade.recentTrades') }}</span>
      <span class="live" :class="{ on: market.connectionState === 'open' }"><i></i>{{ t('status.live') }}</span>
    </header>
    <div class="cols">
      <span>{{ t('trade.priceUnit', { quote: symbol?.quote ?? '' }) }}</span>
      <span>{{ t('trade.amountCol', { base: symbol?.volumeUnit ?? symbol?.base ?? '' }) }}</span>
      <span>{{ t('trade.time') }}</span>
    </div>
    <div v-vertical-scroll-boundary class="trades-body">
      <!-- No TransitionGroup: in a background tab the enter transition never ends (no animation frames), so replaced rows
           were never removed and the DOM grew until the tab crashed. A CSS keyframe flash on mount never holds a node;
           keys are stable (no index), so only genuinely new rows mount and flash. -->
      <div v-for="trade in market.trades" :key="trade.id ?? `${trade.ts}-${trade.price}-${trade.vol}-${trade.side}`" class="trade-row" :title="valueTitle(trade.vol, trade.price)">
          <span class="num" :class="isBuy(trade.side) ? 'up' : 'down'">{{ price(trade.price) }}</span>
          <span class="num">{{ amount(trade.vol) }}</span>
          <span class="num muted">{{ formatClock(trade.ts) }}</span>
        </div>
      <p v-if="market.trades.length === 0" class="trades-empty">{{ t('trade.noTrades') }}</p>
    </div>
  </section>
</template>

<style scoped>
.trades { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--color-surface); }
.trades-head { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
.trades-title { font-family: var(--font-display); font-size: 14px; font-weight: 650; }
.live { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
.live i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.live.on { color: var(--color-up); }
.live.on i { animation: pulse-dot 2s infinite; }
.cols, .trade-row { display: grid; grid-template-columns: 1fr 1fr 0.9fr; gap: 6px; }
.cols { padding: 8px 12px 4px; color: var(--color-text-muted); font-size: 11px; }
.cols span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cols span:not(:first-child), .trade-row span:not(:first-child) { text-align: right; }
.trades-body { position: relative; flex: 1 1 auto; min-height: 120px; overflow-y: auto; }
.trade-row { align-items: center; height: 22px; padding: 0 12px; font-size: 12px; }
.trade-row:hover { background: var(--color-hover); }
.trade-row span { overflow: hidden; text-overflow: ellipsis; }
.trade-row { animation: tick-flash 0.8s ease-out; }
@keyframes tick-flash { from { background: var(--color-accent-soft); } to { background: transparent; } }
.trades-empty { margin: 0; padding: 28px 0; color: var(--color-text-muted); text-align: center; font-size: 12px; }
</style>
