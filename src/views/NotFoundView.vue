<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div class="not-found panel">
    <p class="code">404</p>
    <RouterLink class="btn btn-primary" to="/trade">{{ t('nav.trade') }}</RouterLink>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5);
}

.code {
  margin: 0;
  font-size: 32px;
  font-weight: 600;
  color: var(--color-text-muted);
}
</style>
