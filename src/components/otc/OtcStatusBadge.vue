<script setup lang="ts">
import { computed } from 'vue'
import { statusKey, statusTone, type OtcOrderStatus } from '@/modules/otc/order-state'
import { useOtcI18n } from '@/modules/otc/i18n'

const props = defineProps<{ status: OtcOrderStatus | null }>()
const { t } = useOtcI18n()
const tone = computed(() => statusTone(props.status))
const label = computed(() => t(`otc.status.${statusKey(props.status)}`))
</script>

<template>
  <span class="status-badge" :class="tone"><i aria-hidden="true" />{{ label }}</span>
</template>

<style scoped>
.status-badge {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: var(--radius-pill);
  background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 12px; font-weight: 650; white-space: nowrap;
}
.status-badge i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-badge.warn { background: var(--color-accent-soft); color: var(--color-accent-text); }
.status-badge.warn i { animation: pulse-dot 1.6s infinite; }
.status-badge.info { background: rgba(110, 160, 255, 0.12); color: var(--color-info); }
.status-badge.up { background: var(--color-up-soft); color: var(--color-up); }
.status-badge.down { background: var(--color-down-soft); color: var(--color-down); }
</style>
