<script setup lang="ts">
/** Record status pill; the tone is derived from the raw server status by the caller. */
defineProps<{ label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }>()
</script>

<template>
  <span class="status-chip" :class="tone"><span class="status-dot" aria-hidden="true" />{{ label }}</span>
</template>

<style scoped>
.status-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px;
  font-size: 11px; font-weight: 650; white-space: nowrap; background: var(--color-surface-alt); color: var(--color-text-secondary);
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-chip.ok { background: var(--color-up-soft); color: var(--color-up); }
.status-chip.bad { background: var(--color-down-soft); color: var(--color-down); }
.status-chip.warn { background: var(--color-warning-soft); color: var(--color-warning); }
.status-chip.info { background: color-mix(in srgb, var(--color-info) 12%, transparent); color: var(--color-info); }
.status-chip.muted { color: var(--color-text-muted); }
</style>
