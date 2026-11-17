<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    description?: string
    /** `stacked` puts the action under the text (mobile / form rows). */
    layout?: 'inline' | 'stacked'
  }>(),
  { description: '', layout: 'inline' },
)
</script>

<template>
  <div class="security-row" :class="layout">
    <span v-if="$slots.icon" class="row-icon" aria-hidden="true"><slot name="icon" /></span>
    <div class="row-main">
      <div class="row-label">{{ label }}</div>
      <p v-if="description !== ''" class="row-desc wrap-anywhere">{{ description }}</p>
    </div>
    <div v-if="$slots.value || $slots.action" class="row-side">
      <slot name="value" />
      <slot name="action" />
    </div>
    <div v-if="$slots.body" class="row-extra">
      <slot name="body" />
    </div>
  </div>
</template>

<style scoped>
.security-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: 14px 0;
  border-bottom: 1px solid var(--color-border);
}

.security-row:last-child {
  border-bottom: none;
}

.row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: 1px;
  color: var(--color-text-muted);
  flex: 0 0 22px;
}

.row-main {
  flex: 1 1 auto;
  min-width: 0;
}

.row-label {
  font-size: var(--font-size-md);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.row-desc {
  margin: 3px 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.row-side {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  flex: 0 0 auto;
  margin-left: auto;
  min-height: 26px;
  justify-content: flex-end;
}

.row-extra {
  flex: 1 1 100%;
  min-width: 0;
}

@media (max-width: 640px) {
  .security-row {
    flex-wrap: wrap;
  }

  .row-side {
    flex: 1 1 100%;
    margin-left: 0;
    justify-content: flex-start;
  }
}
</style>
