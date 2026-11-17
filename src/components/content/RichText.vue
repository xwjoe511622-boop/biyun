<script setup lang="ts">
import { computed } from 'vue'
import { sanitizeHtml } from '@/modules/content/sanitize'

/**
 * The only place content pages render server HTML. Input always goes through the strict allowlist
 * sanitizer (`modules/content/sanitize.ts`) before reaching `v-html`.
 */
const props = defineProps<{ html: string }>()
const safe = computed(() => sanitizeHtml(props.html))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized by sanitizeHtml -->
  <div class="rich-text wrap-anywhere" v-html="safe"></div>
</template>

<style scoped>
.rich-text { color: var(--color-text-secondary); font-size: 15px; line-height: 1.8; }
.rich-text :deep(h1), .rich-text :deep(h2), .rich-text :deep(h3), .rich-text :deep(h4) {
  margin: 1.6em 0 .6em; color: var(--color-text); line-height: 1.35; font-weight: 700;
}
.rich-text :deep(h1) { font-size: 22px; }
.rich-text :deep(h2) { font-size: 19px; }
.rich-text :deep(h3), .rich-text :deep(h4) { font-size: 16px; }
.rich-text :deep(p) { margin: 0 0 1em; }
.rich-text :deep(strong), .rich-text :deep(b) { color: var(--color-text); }
.rich-text :deep(a) { color: var(--color-accent-text); text-decoration: underline; text-underline-offset: 3px; }
.rich-text :deep(ul), .rich-text :deep(ol) { margin: 0 0 1em; padding-left: 1.4em; }
.rich-text :deep(li) { margin: .3em 0; }
.rich-text :deep(img) { display: block; max-width: 100%; height: auto; margin: 1em 0; border-radius: var(--radius); }
.rich-text :deep(blockquote) { margin: 1em 0; padding: 4px 16px; border-left: 3px solid var(--color-accent); color: var(--color-text-secondary); }
.rich-text :deep(pre) { overflow-x: auto; padding: 12px 14px; border-radius: var(--radius); background: var(--color-surface-alt); font-size: 13px; }
.rich-text :deep(code) { font-family: var(--font-mono); font-size: .9em; }
.rich-text :deep(table) { display: block; max-width: 100%; overflow-x: auto; margin: 1em 0; border-collapse: collapse; font-size: 13px; }
.rich-text :deep(th), .rich-text :deep(td) { padding: 8px 12px; border: 1px solid var(--color-border); text-align: left; }
.rich-text :deep(th) { background: var(--color-surface-alt); color: var(--color-text); }
.rich-text :deep(hr) { margin: 1.6em 0; border: 0; border-top: 1px solid var(--color-border); }
.rich-text :deep(> :first-child) { margin-top: 0; }
</style>
