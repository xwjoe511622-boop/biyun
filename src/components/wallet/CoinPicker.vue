<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { ChevronDown, Search } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { groupDigits } from '@/modules/finance/decimal'
import type { CoinRow } from '@/modules/wallet/coins'
import { readCoinList } from '@/modules/wallet/coins'
import { useWalletI18n } from '@/modules/wallet/i18n'
import { useMarketStore } from '@/stores/market'

/**
 * Searchable coin selector (combobox + listbox). Shows the available balance next to every coin so
 * the user sees what can be withdrawn before choosing. Keyboard: ↑/↓, Enter, Escape, type to search.
 */
const props = withDefaults(defineProps<{ coins: CoinRow[]; modelValue: string; label: string; disabled?: boolean }>(), {
  disabled: false,
})
const emit = defineEmits<{ (event: 'update:modelValue', coin: string): void }>()
const { t } = useWalletI18n()
const market = useMarketStore()

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const root = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const listId = `coin-list-${useId()}`

const selected = computed(() => props.coins.find(row => row.coin === props.modelValue))
const filtered = computed(() => {
  const needle = query.value.trim().toUpperCase()
  const rows = needle === ''
    ? props.coins
    : props.coins.filter(row => row.coin.includes(needle) || row.showName.toUpperCase().includes(needle))
  return rows
})

function iconUrl(coin: string): string {
  const entry = readCoinList(market.publicInfo)[coin] as Record<string, unknown> | undefined
  return typeof entry?.icon === 'string' ? entry.icon : ''
}

function balance(row: CoinRow): string {
  return row.available === '' ? '--' : groupDigits(row.available)
}

function toggle(): void {
  if (props.disabled) return
  open.value ? close() : show()
}

function show(): void {
  open.value = true
  query.value = ''
  const index = filtered.value.findIndex(row => row.coin === props.modelValue)
  activeIndex.value = index === -1 ? 0 : index
  void nextTick(() => searchInput.value?.focus())
}

function close(focusTrigger = false): void {
  open.value = false
  if (focusTrigger) {
    void nextTick(() => root.value?.querySelector<HTMLButtonElement>('.picker-trigger')?.focus())
  }
}

function choose(coin: string): void {
  if (coin !== props.modelValue) emit('update:modelValue', coin)
  close(true)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(filtered.value.length - 1, activeIndex.value + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(0, activeIndex.value - 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const row = filtered.value[activeIndex.value]
    if (row !== undefined) choose(row.coin)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
  }
}

watch(query, () => { activeIndex.value = 0 })
watch(activeIndex, (index) => {
  void nextTick(() => root.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' }))
})

function onDocument(event: MouseEvent): void {
  if (open.value && root.value !== null && !root.value.contains(event.target as Node)) close()
}
document.addEventListener('mousedown', onDocument)
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocument))
</script>

<template>
  <div ref="root" class="coin-picker" data-testid="coin-picker">
    <button
      class="picker-trigger"
      type="button"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :disabled="disabled"
      data-testid="coin-picker-trigger"
      @click="toggle"
      @keydown.down.prevent="show"
    >
      <template v-if="selected !== undefined">
        <CoinMark :symbol="selected.coin" :icon-url="iconUrl(selected.coin)" :size="26" />
        <span class="picker-main">
          <span class="picker-coin">{{ selected.coin }}</span>
          <span class="picker-name">{{ selected.showName }}</span>
        </span>
        <span class="picker-balance num"><span class="muted">{{ t('wallet.flow.balance') }}</span> {{ balance(selected) }}</span>
      </template>
      <span v-else class="picker-placeholder">{{ t('wallet.selectCoin') }}</span>
      <ChevronDown class="picker-chevron" :class="{ flipped: open }" :size="16" aria-hidden="true" />
    </button>

    <div v-if="open" class="picker-pop" @keydown="onKeydown">
      <label class="picker-search">
        <Search :size="15" aria-hidden="true" />
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="true"
          :aria-controls="listId"
          :aria-activedescendant="filtered[activeIndex] ? `${listId}-${filtered[activeIndex].coin}` : undefined"
          :aria-label="t('wallet.flow.searchCoin')"
          :placeholder="t('wallet.flow.searchCoin')"
        />
      </label>
      <ul :id="listId" class="picker-list" role="listbox" :aria-label="label">
        <li
          v-for="(row, index) in filtered"
          :id="`${listId}-${row.coin}`"
          :key="row.coin"
          class="picker-option"
          :class="{ active: index === activeIndex, selected: row.coin === modelValue }"
          role="option"
          :aria-selected="row.coin === modelValue"
          :data-index="index"
          :data-coin="row.coin"
          @mousedown.prevent
          @mouseenter="activeIndex = index"
          @click="choose(row.coin)"
        >
          <CoinMark :symbol="row.coin" :icon-url="iconUrl(row.coin)" :size="22" />
          <span class="picker-main">
            <span class="picker-coin">{{ row.coin }}</span>
            <span class="picker-name">{{ row.showName }}</span>
          </span>
          <span class="num option-balance">{{ balance(row) }}</span>
        </li>
        <li v-if="filtered.length === 0" class="picker-empty">{{ t('wallet.flow.noCoin') }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.coin-picker { position: relative; min-width: 0; }
.picker-trigger {
  display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 6px 14px;
  border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt);
  color: var(--color-text); text-align: left;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}
.picker-trigger:hover:not(:disabled) { border-color: var(--color-text-muted); }
.picker-trigger:focus-visible, .picker-trigger[aria-expanded='true'] {
  outline: none; border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); background: var(--color-surface);
}
.picker-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.picker-main { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 auto; }
.picker-coin { overflow-wrap: anywhere; font-size: 16px; font-weight: 750; letter-spacing: 0.01em; }
.picker-name { overflow: hidden; color: var(--color-text-muted); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.picker-balance, .option-balance { max-width: 60%; overflow-wrap: anywhere; white-space: normal; text-align: right; }
.picker-balance { font-size: 12px; }
.picker-placeholder { flex: 1 1 auto; color: var(--color-text-muted); }
.picker-chevron { flex: 0 0 auto; color: var(--color-text-muted); transition: transform 0.18s var(--ease-out); }
.picker-chevron.flipped { transform: rotate(180deg); }

.picker-pop {
  position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; right: 0; overflow: hidden;
  border: 1px solid var(--color-border-strong); border-radius: 12px; background: var(--color-elevated); box-shadow: var(--shadow-pop);
  animation: pop-in 0.14s var(--ease-out);
}
.picker-search {
  display: flex; align-items: center; gap: 8px; height: 44px; margin: 8px; padding: 0 12px;
  border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-muted);
}
.picker-search:focus-within { border-color: var(--color-accent); }
.picker-search input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 14px; }
.picker-list { max-height: 300px; margin: 0; padding: 0 6px 8px; overflow-y: auto; list-style: none; }
.picker-option {
  display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
}
.picker-option.active { background: var(--color-hover); }
.picker-option.selected .picker-coin { color: var(--color-accent-text); }
.option-balance { color: var(--color-text-secondary); font-size: 13px; }
.picker-empty { padding: 18px; color: var(--color-text-muted); font-size: 13px; text-align: center; }
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@media (max-width: 520px) {
  .picker-trigger, .picker-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 2px 8px;
  }
  .picker-balance, .option-balance { grid-column: 2 / -1; max-width: none; text-align: left; }
  .picker-chevron { grid-column: 3; grid-row: 1; }
  .picker-placeholder { grid-column: 1 / 3; }
  .picker-name { display: none; }
}
</style>
