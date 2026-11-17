<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, Search } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { percentView } from '@/modules/finance/display'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { useFuturesMarketStore } from '@/stores/futures-market'

const { t } = useFuturesI18n()
const market = useFuturesMarketStore()

const root = ref<HTMLDivElement>()
const input = ref<HTMLInputElement>()
const open = ref(false)
const keyword = ref('')

const filtered = computed(() => {
  const term = keyword.value.trim().toUpperCase()
  const list = term === ''
    ? market.contracts
    : market.contracts.filter((entry) => entry.displayName.includes(term) || entry.contractName.includes(term))
  return list.map((entry) => {
    const tick = market.tickers[entry.wsSymbol]
    const close = canonicalDecimal(tick?.close ?? '')
    return {
      entry,
      price: isDecimalString(close) ? groupDigits(close, entry.pricePrecision) : '--',
      change: percentView(tick?.rose ?? ''),
    }
  })
})

function toggle(): void {
  open.value = !open.value
  if (!open.value) keyword.value = ''
  else void nextTick(() => input.value?.focus())
}

function choose(name: string): void {
  market.selectContract(name)
  open.value = false
  keyword.value = ''
}

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value !== undefined && !root.value.contains(event.target as Node)) {
    open.value = false
    keyword.value = ''
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    open.value = false
    keyword.value = ''
  }
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
  <div ref="root" class="contract-picker">
    <button class="picker-trigger" type="button" :aria-expanded="open" @click="toggle">
      <CoinMark :symbol="market.currentContract?.base ?? '--'" :size="34" />
      <span class="pair-block">
        <span class="pair">{{ market.currentContract?.displayName ?? '--' }}<em class="tag">{{ t('fut.perpetual') }}</em></span>
        <span class="pair-name ellipsis">{{ t('fut.title') }}</span>
      </span>
      <ChevronDown :size="16" class="caret" :class="{ open }" />
    </button>

    <div v-if="open" class="picker-panel">
      <label class="picker-search">
        <Search :size="14" aria-hidden="true" />
        <input ref="input" v-model="keyword" :placeholder="t('fut.searchContract')" :aria-label="t('fut.searchContract')" type="text" />
      </label>
      <div class="picker-cols"><span>{{ t('fut.contract') }}</span><span>{{ t('fut.lastPrice') }}</span><span>{{ t('fut.change24h') }}</span></div>
      <div v-vertical-scroll-boundary class="picker-list scroll-y">
        <button
          v-for="row in filtered"
          :key="row.entry.contractName"
          class="picker-item"
          :class="{ active: row.entry.contractName === market.selectedName }"
          type="button"
          @click="choose(row.entry.contractName)"
        >
          <span class="item-pair">
            <CoinMark :symbol="row.entry.base" :size="20" />
            <b>{{ row.entry.displayName }}</b>
          </span>
          <span class="num">{{ row.price }}</span>
          <span class="num" :class="row.change.direction">{{ row.change.text }}</span>
        </button>
        <p v-if="filtered.length === 0" class="picker-empty">{{ t('fut.noContracts') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.contract-picker { position: relative; flex: 0 0 auto; }
.picker-trigger { display: inline-flex; align-items: center; gap: 10px; height: 48px; padding: 0 12px 0 6px; border-radius: 12px; transition: background-color 0.15s; }
.picker-trigger:hover { background: var(--color-hover); }
.pair-block { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.pair { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-display); font-size: 19px; font-weight: 750; line-height: 1.15; white-space: nowrap; }
.tag { padding: 1px 6px; border-radius: 5px; background: var(--color-accent-soft); color: var(--color-accent-text); font-family: var(--font-sans); font-size: 10px; font-style: normal; font-weight: 700; letter-spacing: 0.02em; }
.pair-name { max-width: 170px; color: var(--color-text-muted); font-size: 11px; }
.caret { color: var(--color-text-muted); transition: transform 0.2s; }
.caret.open { transform: rotate(180deg); }
.picker-panel {
  position: absolute; z-index: 50; top: 54px; left: 0; width: 360px; padding: 10px;
  border: 1px solid var(--color-border-strong); border-radius: 14px; background: var(--color-elevated);
  box-shadow: var(--shadow-pop); animation: rise-in 0.18s var(--ease-out);
}
.picker-search {
  display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px;
  border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt); color: var(--color-text-muted);
}
.picker-search:focus-within { border-color: var(--color-accent); }
.picker-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 13px; }
.picker-cols, .picker-item { display: grid; grid-template-columns: 1.3fr 1fr 0.8fr; gap: 8px; align-items: center; }
.picker-cols { padding: 10px 10px 4px; color: var(--color-text-muted); font-size: 11px; }
.picker-cols span:not(:first-child), .picker-item > span:not(:first-child) { text-align: right; }
.picker-list { max-height: 320px; }
.picker-item { width: 100%; height: 38px; padding: 0 10px; border-radius: 8px; font-size: 13px; text-align: left; }
.picker-item:hover { background: var(--color-hover); }
.picker-item.active { background: var(--color-accent-soft); }
.item-pair { display: flex; align-items: center; gap: 7px; min-width: 0; }
.picker-empty { margin: 12px 0; text-align: center; color: var(--color-text-muted); font-size: 13px; }
@media (max-width: 480px) { .picker-panel { width: calc(100vw - 32px); } }
</style>
