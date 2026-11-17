<script setup lang="ts">
import { useI18n } from 'vue-i18n'

withDefaults(
  defineProps<{
    variant: 'loading' | 'error' | 'empty'
    message?: string
    retryable?: boolean
  }>(),
  { message: '', retryable: false },
)

const emit = defineEmits<{ (event: 'retry'): void }>()
const { t } = useI18n()
</script>

<template>
  <div class="state" :class="variant">
    <svg v-if="variant === 'empty'" class="state-art" viewBox="0 0 96 72" aria-hidden="true">
      <ellipse cx="48" cy="64" rx="30" ry="4" fill="currentColor" opacity=".12" />
      <path d="M22 30l10-16h32l10 16v22a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" opacity=".55" />
      <path d="M22 30h17a3 3 0 0 1 3 3 6 6 0 0 0 12 0 3 3 0 0 1 3-3h17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" opacity=".55" />
      <path class="state-art-gold" d="M70 6l1.8 4.2L76 12l-4.2 1.8L70 18l-1.8-4.2L64 12l4.2-1.8zM24 8l1.1 2.6L27.7 12l-2.6 1.1L24 15.700l-1.1-2.6L20.3 12l2.6-1.400z" />
    </svg>
    <span class="state-text wrap-anywhere">{{ message !== '' ? message : t('common.empty') }}</span>
    <button v-if="variant === 'error' && retryable" class="btn" type="button" @click="emit('retry')">
      {{ t('common.retry') }}
    </button>
  </div>
</template>

<style scoped>
.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 72px;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.state.error .state-text {
  color: var(--color-down);
}
.state-art { display: none; }
/* Phones: empty lists get a small illustration instead of a bare line of text (owner 2026-11-17). */
@media (max-width: 720px) {
  .state.empty { flex-direction: column; gap: 10px; min-height: 150px; }
  .state-art { display: block; width: 84px; height: 63px; }
  .state-art-gold { fill: var(--color-accent); }
}
</style>
