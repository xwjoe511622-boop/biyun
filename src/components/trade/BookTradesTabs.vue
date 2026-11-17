<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BookPick } from '@/modules/trade/book-fill'
import OrderBook from './OrderBook.vue'
import TradesPanel from './TradesPanel.vue'

/**
 * OKX skin (spot / margin): order book and market trades as two tabs of ONE full-height panel (OKX's right column).
 * The Binance skin keeps them as separate grid areas; this wrapper only switches between the same two widgets.
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ price: [value: string, pick?: BookPick] }>()
const { t } = useI18n()
const tab = ref<'book' | 'trades'>('book')
</script>

<template>
  <div class="book-trades">
    <div class="bt-tabs" role="tablist">
      <button class="bt-tab" :class="{ active: tab === 'book' }" role="tab" type="button" :aria-selected="tab === 'book'" data-testid="book-tab-book" @click="tab = 'book'">{{ t('trade.orderBook') }}</button>
      <button class="bt-tab" :class="{ active: tab === 'trades' }" role="tab" type="button" :aria-selected="tab === 'trades'" data-testid="book-tab-trades" @click="tab = 'trades'">{{ t('trade.recentTrades') }}</button>
    </div>
    <div v-show="tab === 'book'" class="bt-pane"><OrderBook :compact="compact" @price="(value, pick) => emit('price', value, pick)" /></div>
    <div v-show="tab === 'trades'" class="bt-pane"><TradesPanel /></div>
  </div>
</template>

<style scoped>
.book-trades { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--color-surface); }
.bt-tabs { display: flex; flex: 0 0 48px; align-items: center; gap: 24px; padding: 0 16px; border-bottom: 1px solid var(--color-border); }
.bt-tab { position: relative; height: 48px; padding: 0; color: var(--color-text-muted); font-size: 15px; font-weight: 600; white-space: nowrap; }
.bt-tab:hover { color: var(--color-text); }
.bt-tab.active { color: var(--color-text); font-weight: 700; }
.bt-tab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-text); }
.bt-pane { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.bt-pane > :deep(*) { flex: 1 1 auto; min-height: 0; }
/* The tab names the pane: the pane's own title would repeat it. */
.book-trades :deep(.book-title), .book-trades :deep(.trades-title) { display: none; }
.book-trades :deep(.trades-head) { display: none; }
</style>
