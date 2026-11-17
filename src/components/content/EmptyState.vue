<script setup lang="ts">
import type { Component } from 'vue'
import { Inbox } from '@lucide/vue'

/** Larger, illustrated empty state for content pages (the compact one is `common/StateBlock`). */
withDefaults(defineProps<{ title: string; message?: string; icon?: Component }>(), { message: '', icon: () => Inbox })
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon" aria-hidden="true"><component :is="icon" :size="24" /></span>
    <p class="empty-title">{{ title }}</p>
    <p v-if="message !== ''" class="empty-message wrap-anywhere">{{ message }}</p>
    <div v-if="$slots.default" class="empty-actions"><slot /></div>
  </div>
</template>

<style scoped>
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 20px; text-align: center; }
.empty-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; margin-bottom: 6px;
  border: 1px dashed var(--color-border-strong); border-radius: 16px; color: var(--color-text-muted);
  background: var(--color-surface-alt);
}
.empty-title { margin: 0; color: var(--color-text); font-weight: 650; }
.empty-message { margin: 0; max-width: 420px; color: var(--color-text-muted); font-size: 13px; }
.empty-actions { display: flex; gap: 8px; margin-top: 10px; }
</style>
