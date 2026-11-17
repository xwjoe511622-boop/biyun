<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, Search } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { percentView } from '@/modules/finance/display'
import { useMarginI18n } from '@/modules/margin/i18n'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'

/** Pair picker limited to margin-enabled pairs (public_info_v4 `is_open_lever`). */
const { t } = useMarginI18n()
const market = useMarketStore()
const margin = useMarginStore()

const root = ref<HTMLDivElement>()
const input = ref<HTMLInputElement>()
const open = ref(false)
const keyword = ref('')

const current = computed(() => margin.currentMarket)

const rows = computed(() => {
  const term = keyword.value.trim().toUpperCase()
  return margin.markets
    .filter(entry => term === '' || entry.symbol.pair.includes(term) || entry.symbol.symbol.toUpperCase().includes(term))
    .map((entry) => {
      const tick = market.tickers[entry.symbol.symbol]
      const close = canonicalDecimal(tick?.close ?? '')
      return {
        entry,
        price: isDecimalString(close) ? groupDigits(close, entry.symbol.pricePrecision) : '--',
        change: percentView(tick?.rose ?? ''),
      }
    })
})

function toggle(): void {
  open.value = !open.value
  keyword.value = ''
  if (open.value) void nextTick(() => input.value?.focus())
}

function choose(pair: string): void {
  market.selectPair(pair)
  open.value = false
  keyword.value = ''
}

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value !== undefined && !root.value.contains(event.target as Node)) open.value = false
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="symbol-picker">
    <button class="picker-trigger" type="button" :aria-expanded="open" aria-haspopup="listbox" @click="toggle">
      <CoinMark :symbol="current?.symbol.base ?? '--'" :icon-url="current?.symbol.coin?.icon ?? ''" :size="34" />
      <span class="pair-block">
        <span class="pair">{{ current?.symbol.base ?? '--' }}<small>/{{ current?.symbol.quote ?? '' }}</small></span>
        <span class="pair-tags">
          <span class="tag">{{ t('margin.isolated') }}</span>
          <span v-if="current !== undefined && current.multiple !== ''" class="tag tag-accent">{{ t('margin.leverage', { n: current.multiple }) }}</span>
        </span>
      </span>
      <ChevronDown :size="16" class="caret" :class="{ open }" />
    </button>

    <div v-if="open" class="picker-panel" role="listbox" :aria-label="t('margin.pairs')">
      <label class="picker-search">
        <Search :size="14" aria-hidden="true" />
        <input ref="input" v-model="keyword" :placeholder="t('margin.search')" :aria-label="t('margin.search')" type="text" />
      </label>
      <div class="picker-cols"><span>{{ t('trade.pair') }}</span><span>{{ t('trade.lastPrice') }}</span><span>{{ t('trade.change24h') }}</span></div>
      <div v-vertical-scroll-boundary class="picker-list scroll-y">
        <button
          v-for="row in rows"
          :key="row.entry.symbol.pair"
          class="picker-item"
          :class="{ active: row.entry.symbol.pair === market.selectedPair }"
          type="button"
          role="option"
          :aria-selected="row.entry.symbol.pair === market.selectedPair"
          @click="choose(row.entry.symbol.pair)"
        >
          <span class="item-pair">
            <CoinMark :symbol="row.entry.symbol.base" :icon-url="row.entry.symbol.coin?.icon ?? ''" :size="20" />
            <b>{{ row.entry.symbol.base }}</b><small>/{{ row.entry.symbol.quote }}</small>
            <em v-if="row.entry.multiple !== ''">{{ row.entry.multiple }}x</em>
          </span>
          <span class="num">{{ row.price }}</span>
          <span class="num" :class="row.change.direction">{{ row.change.text }}</span>
        </button>
        <p v-if="rows.length === 0" class="picker-empty">{{ t('common.empty') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.symbol-picker { position: relative; flex: 0 0 auto; }
.picker-trigger { display: inline-flex; align-items: center; gap: 10px; height: 48px; padding: 0 12px 0 6px; border-radius: 12px; transition: background-color 0.15s; }
.picker-trigger:hover { background: var(--color-hover); }
.pair-block { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.pair { font-family: var(--font-display); font-size: 19px; font-weight: 750; line-height: 1.15; white-space: nowrap; }
.pair small { color: var(--color-text-muted); font-size: 14px; font-weight: 500; }
.pair-tags { display: flex; gap: 4px; }
.tag { height: 16px; padding: 0 5px; border-radius: 4px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 10px; font-weight: 700; line-height: 16px; }
.tag-accent { background: var(--color-accent-soft); color: var(--color-accent-text); font-family: var(--font-mono); }
.caret { color: var(--color-text-muted); transition: transform 0.2s; }
.caret.open { transform: rotate(180deg); }
.picker-panel {
  position: absolute; z-index: 50; top: 54px; left: 0; width: 360px; padding: 10px;
  border: 1px solid var(--color-border-strong); border-radius: 14px; background: var(--color-elevated);
  box-shadow: var(--shadow-pop); animation: rise-in 0.18s var(--ease-out);
}
.picker-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt); color: var(--color-text-muted); }
.picker-search:focus-within { border-color: var(--color-accent); }
.picker-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 13px; }
.picker-cols, .picker-item { display: grid; grid-template-columns: 1.4fr 1fr 0.8fr; gap: 8px; align-items: center; }
.picker-cols { padding: 10px 10px 4px; color: var(--color-text-muted); font-size: 11px; }
.picker-cols span:not(:first-child), .picker-item > span:not(:first-child) { text-align: right; }
.picker-list { max-height: 320px; }
.picker-item { width: 100%; height: 38px; padding: 0 10px; border-radius: 8px; font-size: 13px; text-align: left; }
.picker-item:hover { background: var(--color-hover); }
.picker-item.active { background: var(--color-accent-soft); }
.item-pair { display: flex; align-items: center; gap: 7px; min-width: 0; }
.item-pair small { margin-left: -5px; color: var(--color-text-muted); }
.item-pair em { font-style: normal; font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: var(--color-accent-text); }
.picker-empty { margin: 12px 0; text-align: center; color: var(--color-text-muted); font-size: 13px; }
@media (max-width: 480px) { .picker-panel { width: calc(100vw - 32px); } }
</style>
