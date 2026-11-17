<script setup lang="ts">
import type { Component } from 'vue'

/** Shared heading for content / account-service pages: icon tile, title, optional lead, actions slot. */
defineProps<{ title: string; lead?: string; icon?: Component; eyebrow?: string }>()
</script>

<template>
  <header class="page-head">
    <div class="head-main">
      <span v-if="icon" class="head-icon" aria-hidden="true"><component :is="icon" :size="22" /></span>
      <div class="head-copy">
        <span v-if="eyebrow" class="head-eyebrow">{{ eyebrow }}</span>
        <h1 class="head-title">{{ title }}</h1>
        <p v-if="lead" class="head-lead">{{ lead }}</p>
      </div>
    </div>
    <div v-if="$slots.default" class="head-actions"><slot /></div>
  </header>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding-bottom: 20px; }
.head-main { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
.head-icon {
  display: inline-flex; flex: 0 0 48px; align-items: center; justify-content: center; width: 48px; height: 48px;
  border: 1px solid var(--color-border-strong); border-radius: 14px;
  background: radial-gradient(circle at 30% 20%, var(--color-accent-soft), transparent 70%), var(--color-surface);
  color: var(--color-accent-text);
}
.head-copy { min-width: 0; }
.head-eyebrow { color: var(--color-accent-text); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.head-title { margin: 2px 0 0; font-size: 30px; font-weight: 750; line-height: 1.2; letter-spacing: -.02em; }
.head-lead { margin: 6px 0 0; max-width: 640px; color: var(--color-text-secondary); font-size: 14px; line-height: 1.6; }
.head-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
@media (max-width: 640px) {
  .head-title { font-size: 23px; }
  .head-actions { width: 100%; }
  .head-icon { flex-basis: 40px; width: 40px; height: 40px; border-radius: 12px; }
}
/* Phones: the header bar carries the page title; keep only the page's own actions (owner 2026-11-17). */
@media (max-width: 720px) {
  .head-main { display: none; }
  .page-head:not(:has(.head-actions)) { display: none; }
}
</style>
