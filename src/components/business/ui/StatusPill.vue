<script setup lang="ts">
import { computed } from 'vue'
import { status, type Lang } from '@/modules/business/format'
const props = defineProps<{ code: unknown; lang: Lang }>()
const s = computed(() => status(props.code, props.lang))
</script>

<template>
  <span class="pill" :class="s.tone">{{ s.label }}</span>
</template>

<style scoped>
.pill {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: var(--radius-pill);
  font-size: var(--font-size-xs); font-weight: 600; white-space: nowrap;
  background: var(--color-surface-alt); color: var(--color-text-muted);
}
.pill.up { background: var(--color-up-soft); color: var(--color-up); }
.pill.down { background: var(--color-down-soft); color: var(--color-down); }
.pill.warn { background: var(--color-warning-soft); color: var(--color-warning); }
.pill.accent { background: var(--color-accent-soft); color: var(--color-accent-text); }
.pill.info { background: rgba(47, 111, 237, 0.1); color: var(--color-info); }
</style>
