<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { useOtcI18n } from '@/modules/otc/i18n'

const { t: uiLabel } = useI18n({ useScope: 'global' })

const props = defineProps<{ page: number; pageSize: number; total: number; disabled?: boolean }>()
const emit = defineEmits<{ (event: 'change', page: number): void }>()
const { t } = useOtcI18n()

const pages = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize)))) // float-ok: pagination
</script>

<template>
  <nav v-if="total > pageSize" class="pager" :aria-label="uiLabel('accessibility.pagination')">
    <span class="pager-info">{{ t('otc.pager', { page, pages, total }) }}</span>
    <div class="pager-buttons">
      <button class="btn btn-ghost" type="button" :disabled="disabled || page <= 1" @click="emit('change', page - 1)">
        <ChevronLeft :size="16" />{{ t('common.prev') }}
      </button>
      <button class="btn btn-ghost" type="button" :disabled="disabled || page >= pages" @click="emit('change', page + 1)">
        {{ t('common.next') }}<ChevronRight :size="16" />
      </button>
    </div>
  </nav>
</template>

<style scoped>
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 4px 4px; flex-wrap: wrap; }
.pager-info { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.pager-buttons { display: flex; gap: 6px; }
.pager-buttons .btn { height: 32px; padding: 0 10px; }
</style>
