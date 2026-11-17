<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight } from '@lucide/vue'

const { t: uiLabel } = useI18n({ useScope: 'global' })

/** Compact numbered pager shared by the content and account-service pages. */
const props = defineProps<{ page: number; pages: number; total?: number; disabled?: boolean }>()
const emit = defineEmits<{ (event: 'change', page: number): void }>()
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { total: '共 {n} 条', prev: '上一页', next: '下一页' },
    'en-US': { total: '{n} total', prev: 'Previous page', next: 'Next page' },
  },
})

/** At most 7 slots: first, last, current ±1 and ellipses. */
const slots = computed<Array<number | 'gap'>>(() => {
  const { page, pages } = props
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const out: Array<number | 'gap'> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pages - 1, page + 1)
  if (start > 2) out.push('gap')
  for (let value = start; value <= end; value += 1) out.push(value)
  if (end < pages - 1) out.push('gap')
  out.push(pages)
  return out
})

function go(target: number): void {
  if (props.disabled === true || target < 1 || target > props.pages || target === props.page) return
  emit('change', target)
}
</script>

<template>
  <nav v-if="pages > 1 || (total ?? 0) > 0" class="pager" :aria-label="uiLabel('accessibility.pagination2')">
    <span v-if="total !== undefined" class="pager-total num">{{ t('total', { n: total }) }}</span>
    <div v-if="pages > 1" class="pager-slots">
      <button class="pager-btn" type="button" :disabled="disabled || page <= 1" :aria-label="t('prev')" @click="go(page - 1)">
        <ChevronLeft :size="15" aria-hidden="true" />
      </button>
      <template v-for="(slot, index) in slots" :key="`${slot}-${index}`">
        <span v-if="slot === 'gap'" class="pager-gap">…</span>
        <button
          v-else
          class="pager-btn num"
          :class="{ active: slot === page }"
          type="button"
          :aria-current="slot === page ? 'page' : undefined"
          :disabled="disabled"
          @click="go(slot)"
        >{{ slot }}</button>
      </template>
      <button class="pager-btn" type="button" :disabled="disabled || page >= pages" :aria-label="t('next')" @click="go(page + 1)">
        <ChevronRight :size="15" aria-hidden="true" />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.pager { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 16px; }
.pager-total { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.pager-slots { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.pager-btn {
  display: inline-flex; align-items: center; justify-content: center; min-width: 32px; height: 32px; padding: 0 8px;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface);
  color: var(--color-text-secondary); font-size: var(--font-size-xs); transition: border-color .15s, color .15s, background-color .15s;
}
.pager-btn:hover:not(:disabled) { border-color: var(--color-border-strong); color: var(--color-text); }
.pager-btn.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); font-weight: 700; }
.pager-btn:disabled { opacity: .45; cursor: not-allowed; }
.pager-gap { padding: 0 4px; color: var(--color-text-muted); }
</style>
