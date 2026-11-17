<script setup lang="ts">
import { computed } from 'vue'
import { Ruler } from '@lucide/vue'
import type { SizeContract, SizeUnit } from '@/modules/futures/size-unit'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { useFuturesI18n } from '@/modules/futures/i18n'
import TicketSelect from './TicketSelect.vue'
import type { TicketOption } from './ticket-option'

/**
 * Futures-wide quantity unit (Binance: base coin or USDT; 张 removed 2026-09-29). Same preference as the order ticket
 * (`picat.futures.sizeUnit`), applied to 持仓量 / 可平 and every size column. A TicketSelect instead of a native <select>:
 * the native control read as a static "USDT" label and its popup is placed by the browser; this one is a bottom sheet
 * on phones.
 */
const props = defineProps<{ contract?: SizeContract }>()
const { t } = useFuturesI18n()
const sizes = useSizeFormat()
const options = computed<TicketOption<SizeUnit>[]>(() => sizes.units.map((value) => {
  const label = sizes.label(props.contract, value)
  return { value, label, desc: value === 'quote' ? t('fut.sizeUnitQuoteDesc', { unit: label }) : t('fut.sizeUnitBaseDesc', { unit: label }) }
}))
</script>

<template>
  <span class="unit-switch" :title="t('fut.sizeUnitHint')">
    <Ruler :size="13" aria-hidden="true" />
    <span class="unit-switch-label">{{ t('fut.sizeUnit') }}</span>
    <TicketSelect v-model="sizes.unit.value" :options="options" :label="t('fut.sizeUnit')" testid="fut-size-unit" />
  </span>
</template>

<style scoped>
.unit-switch { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 6px 0 8px; border: 1px solid var(--color-border-strong); border-radius: 8px; color: var(--color-text-muted); font-size: 12px; white-space: nowrap; }
.unit-switch:hover, .unit-switch:focus-within { border-color: var(--color-accent); }
.unit-switch :deep(.ts-trigger) { height: 26px; font-size: 12px; }
@media (max-width: 520px) { .unit-switch-label { display: none; } }
</style>
