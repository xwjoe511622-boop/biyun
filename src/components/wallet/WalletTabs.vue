<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import type { WalletTab } from '@/modules/wallet/tabs'

const { t: uiLabel } = useI18n({ useScope: 'global' })

defineProps<{ tabs: WalletTab[]; active: string }>()
const emit = defineEmits<{ (event: 'select', id: string): void }>()

const listRef = ref<HTMLElement | null>(null)

/** Roving focus: arrows move between tabs, Home/End jump to the edges. */
function onKeydown(event: KeyboardEvent, index: number): void {
  const tabs = Array.from(listRef.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
  if (tabs.length === 0) {
    return
  }
  let next = index
  if (event.key === 'ArrowRight') {
    next = (index + 1) % tabs.length
  } else if (event.key === 'ArrowLeft') {
    next = (index - 1 + tabs.length) % tabs.length
  } else if (event.key === 'Home') {
    next = 0
  } else if (event.key === 'End') {
    next = tabs.length - 1
  } else {
    return
  }
  event.preventDefault()
  const target = tabs[next]
  target.focus()
  emit('select', target.dataset.tabId ?? '')
}
</script>

<template>
  <div ref="listRef" class="tabs wallet-tabs" role="tablist" :aria-label="uiLabel('accessibility.walletSections')">
    <button
      v-for="(tab, index) in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === active, 'tab--action': tab.action === true }"
      type="button"
      role="tab"
      :data-tab-id="tab.id"
      :id="`wallet-tab-${tab.id}`"
      :aria-selected="tab.id === active"
      :aria-controls="`wallet-panel-${tab.id}`"
      :tabindex="tab.id === active ? 0 : -1"
      @click="emit('select', tab.id)"
      @keydown="onKeydown($event, index)"
    >
      <component :is="tab.icon" v-if="tab.icon !== undefined" :size="14" aria-hidden="true" />
      <span class="tab-full">{{ tab.label }}</span>
      <span class="tab-short">{{ tab.shortLabel ?? tab.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.wallet-tabs {
  border-bottom: 1px solid var(--color-border);
  padding-bottom: var(--space-1);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  border-bottom: 2px solid transparent;
  border-radius: 0;
}

.tab.active {
  background: transparent;
  border-bottom-color: var(--color-accent);
}

.tab-short { display: none; }

/* Phones: the account tabs fit one row with short labels; actions are quick-action buttons on the page. */
@media (max-width: 720px) {
  .wallet-tabs { gap: 2px; padding-bottom: 0; }
  .tab { flex: 1 0 auto; justify-content: center; height: 36px; padding: 0 8px; font-size: 14px; }
  .tab :deep(svg) { display: none; }
  .tab-full { display: none; }
  .tab-short { display: inline; }
  .tab--action { display: none; }
}
</style>
