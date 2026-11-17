<script setup lang="ts">
import { ref } from 'vue'
import { Check, ChevronDown, Info } from '@lucide/vue'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { TICKET_ORDER_TYPES, type TicketOrderType } from '@/modules/futures/order-entry'
import TicketPopover from './TicketPopover.vue'

/** Binance-style order type picker: a dropdown whose entries carry a one-line description. */
defineProps<{ disabled?: boolean }>()
const model = defineModel<TicketOrderType>({ required: true })
const { t } = useFuturesI18n()
const open = ref(false)

function choose(value: TicketOrderType): void {
  model.value = value
  open.value = false
}
</script>

<template>
  <div class="ots">
    <TicketPopover v-model:open="open" :label="t('fut.orderTypeTitle')">
      <template #trigger="{ toggle }">
        <button type="button" class="ots-trigger" data-testid="fut-order-type" :disabled="disabled" :aria-expanded="open" aria-haspopup="dialog" @click="toggle">
          {{ t(`fut.typeName.${model}`) }}<ChevronDown :size="13" />
        </button>
      </template>
      <ul class="ots-list" role="listbox" :aria-label="t('fut.orderTypeTitle')">
        <li v-for="entry in TICKET_ORDER_TYPES" :key="entry">
          <button type="button" role="option" class="ots-item" :class="{ active: entry === model }" :aria-selected="entry === model" :data-testid="`fut-order-type-${entry}`" @click="choose(entry)">
            <span class="ots-text">
              <b>{{ t(`fut.typeName.${entry}`) }}</b>
              <span>{{ t(`fut.typeDesc.${entry}`) }}</span>
            </span>
            <Check v-if="entry === model" :size="14" class="ots-check" />
          </button>
        </li>
      </ul>
    </TicketPopover>
    <span class="ots-info" tabindex="0" role="img" :aria-label="t('fut.orderTypeInfo')" :title="t('fut.orderTypeInfo')"><Info :size="13" /></span>
  </div>
</template>

<style scoped>
.ots { display: inline-flex; align-items: center; gap: 6px; }
.ots-trigger { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 10px; border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text); font-size: 13px; font-weight: 650; }
.ots-trigger:hover:not(:disabled) { color: var(--color-accent-text); }
.ots-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.ots-info { display: inline-flex; color: var(--color-text-muted); cursor: help; }
.ots-info:hover, .ots-info:focus-visible { color: var(--color-text); }
.ots-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.ots-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 9px 10px; border-radius: 8px; text-align: left; }
.ots-item:hover, .ots-item.active { background: var(--color-surface-alt); }
.ots-text { display: grid; gap: 2px; }
.ots-text b { font-size: 13px; font-weight: 650; color: var(--color-text); }
.ots-text span { font-size: 11px; line-height: 15px; color: var(--color-text-muted); }
.ots-check { flex: 0 0 auto; color: var(--color-accent-text); }
</style>
