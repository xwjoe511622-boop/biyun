<script setup lang="ts">
import { computed } from 'vue'
import { Archive } from '@lucide/vue'
import { browserOffsetMin } from '@/modules/api/history-export.api'
import { wallClock } from './format'
import { useHistoryExportI18n } from './i18n'
import { useHistoryExport } from './state'

/**
 * Shown where a history list cannot reach: records before the hot window live only in the archive. `compact` is the
 * one-line form for dense panels (futures tabs); the full form replaces an empty table on the orders centre.
 */
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ (event: 'export'): void }>()
const { t } = useHistoryExportI18n()
const state = useHistoryExport()
const since = computed(() => {
  const from = state.info.value?.hotFromMs ?? null
  return from === null ? '' : wallClock(from, browserOffsetMin(), false)
})
</script>

<template>
  <div class="archive-notice" :class="{ compact: props.compact }" data-testid="hx-archive-notice">
    <Archive :size="props.compact ? 14 : 18" aria-hidden="true" class="icon" />
    <div class="text">
      <template v-if="props.compact">{{ t('hx.archivedShort') }}</template>
      <template v-else>
        <strong>{{ t('hx.archivedTitle') }}</strong>
        <span>{{ t('hx.archivedBody', { date: since }) }}</span>
      </template>
    </div>
    <button class="btn" :class="props.compact ? 'btn-ghost' : 'btn-primary'" type="button" data-testid="hx-open" @click="emit('export')">{{ t('hx.generate') }}</button>
  </div>
</template>

<style scoped>
.archive-notice {
  display: flex; align-items: center; gap: 12px; margin: 12px 18px; padding: 14px 16px; border: 1px dashed var(--color-border-strong);
  border-radius: 12px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13px;
}
.archive-notice .icon { flex: none; color: var(--color-accent-text); }
.text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.text strong { color: var(--color-text); font-size: 13.5px; }
.archive-notice .btn { flex: none; height: 34px; }
.archive-notice.compact { margin: 6px 10px; padding: 6px 10px; gap: 8px; border-radius: 8px; font-size: 12px; }
.archive-notice.compact .btn { height: 28px; padding: 0 10px; font-size: 12px; }
@media (max-width: 720px) {
  .archive-notice:not(.compact) { flex-wrap: wrap; }
}
</style>
