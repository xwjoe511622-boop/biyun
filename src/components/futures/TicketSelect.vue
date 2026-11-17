<script setup lang="ts" generic="T extends string">
import { ref } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import TicketPopover from './TicketPopover.vue'
import type { TicketOption } from './ticket-option'


/**
 * Ticket dropdown (最优价, 有效方式, …). A custom list instead of a native <select>: the native popup is positioned by
 * the browser and lands far from the field in narrow/emulated layouts; TicketPopover anchors it (a bottom sheet on phones).
 */
const props = defineProps<{ options: readonly TicketOption<T>[]; label: string; testid: string; disabled?: boolean }>()
const model = defineModel<T>({ required: true })
const open = ref(false)
const current = () => props.options.find((entry) => entry.value === model.value)?.label ?? model.value

function choose(value: T): void {
  model.value = value
  open.value = false
}
</script>

<template>
  <TicketPopover v-model:open="open" align="auto" :label="label">
    <template #trigger="{ toggle }">
      <button type="button" class="ts-trigger" :data-testid="testid" :disabled="disabled" :aria-expanded="open" aria-haspopup="dialog" :aria-label="label" @click="toggle">
        {{ current() }}<ChevronDown :size="13" />
      </button>
    </template>
    <ul class="ts-list" role="listbox" :aria-label="label">
      <li v-for="entry in options" :key="entry.value">
        <button type="button" role="option" class="ts-item" :class="{ active: entry.value === model }" :aria-selected="entry.value === model" :data-testid="`${testid}-${entry.value}`" @click="choose(entry.value)">
          <span class="ts-text">
            <b>{{ entry.label }}</b>
            <span v-if="entry.desc">{{ entry.desc }}</span>
          </span>
          <Check v-if="entry.value === model" :size="14" class="ts-check" />
        </button>
      </li>
    </ul>
  </TicketPopover>
</template>

<style scoped>
.ts-trigger { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; height: 32px; padding: 0 2px; color: var(--color-text); font-size: 13px; font-weight: 650; }
.ts-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.ts-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.ts-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 9px 10px; border-radius: 8px; text-align: left; }
.ts-item:hover, .ts-item.active { background: var(--color-surface-alt); }
.ts-text { display: grid; gap: 2px; }
.ts-text b { font-size: 13px; font-weight: 650; color: var(--color-text); }
.ts-text span { font-size: 11px; line-height: 15px; color: var(--color-text-muted); }
.ts-check { flex: 0 0 auto; color: var(--color-accent-text); }
</style>
