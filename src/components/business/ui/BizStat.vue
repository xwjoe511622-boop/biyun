<script setup lang="ts">
/** A hero/summary figure: small label above a large tabular number with an optional unit. */
defineProps<{ label: string; value: string; unit?: string; tone?: 'up' | 'accent' | 'default' }>()
</script>

<template>
  <div class="stat">
    <span class="stat-label">{{ label }}</span>
    <span class="stat-value num" :class="tone ?? 'default'">{{ value }}<small v-if="unit" class="stat-unit">{{ unit }}</small></span>
  </div>
</template>

<style scoped>
.stat { display: grid; gap: 4px; min-width: 0; }
.stat-label { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.stat-value { font-size: 22px; font-weight: 650; line-height: 1.2; }
.stat-value.up { color: var(--color-up); }
.stat-value.accent { color: var(--color-accent-text); }
.stat-unit { margin-left: 4px; color: var(--color-text-muted); font-size: var(--font-size-sm); font-weight: 500; font-family: var(--font-sans); }
</style>
