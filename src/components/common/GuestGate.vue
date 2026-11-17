<script setup lang="ts">
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from '@lucide/vue'

/** Signed-out placeholder for account pages: explains what is behind login and offers both paths. */
withDefaults(defineProps<{ message: string; icon?: Component }>(), { icon: () => Lock })
const { t } = useI18n()
</script>

<template>
  <div class="guest-gate">
    <span class="gate-icon"><component :is="icon" :size="26" aria-hidden="true" /></span>
    <p class="gate-message">{{ message }}</p>
    <div class="gate-actions">
      <RouterLink class="btn btn-primary" to="/login">{{ t('nav.login') }}</RouterLink>
      <RouterLink class="btn" to="/register">{{ t('nav.register') }}</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.guest-gate {
  display: flex; flex-direction: column; align-items: center; gap: 16px; margin: 28px auto 0; padding: 56px 24px;
  max-width: 560px; border: 1px dashed var(--color-border-strong); border-radius: 20px; text-align: center;
  background: radial-gradient(ellipse 70% 60% at 50% 0%, var(--color-accent-soft), transparent 70%), var(--color-surface);
}
.gate-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 60px; height: 60px; border-radius: 18px;
  background: var(--color-accent-soft); color: var(--color-accent-text);
}
.gate-message { margin: 0; color: var(--color-text-secondary); font-size: 15px; }
.gate-actions { display: flex; gap: 10px; }
.gate-actions .btn { min-width: 110px; height: 42px; }
</style>
