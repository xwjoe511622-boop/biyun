<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'

/** Inline, honest error state: shows the real server/transport message with an optional retry. */
defineProps<{ message: string; retryable?: boolean }>()
const emit = defineEmits<{ (event: 'retry'): void }>()
const { t } = useI18n()
</script>

<template>
  <div class="error-banner" role="alert">
    <AlertTriangle :size="18" aria-hidden="true" />
    <span class="error-text wrap-anywhere">{{ message }}</span>
    <button v-if="retryable" class="btn" type="button" @click="emit('retry')">{{ t('common.retry') }}</button>
  </div>
</template>

<style scoped>
.error-banner {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px; border: 1px solid transparent;
  border-radius: var(--radius-lg); background: var(--color-down-soft); color: var(--color-down); font-size: 13px;
}
.error-text { flex: 1 1 auto; min-width: 0; }
.error-banner .btn { height: 32px; }
</style>
