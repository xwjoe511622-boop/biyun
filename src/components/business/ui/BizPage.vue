<script setup lang="ts">
/** Product page shell: a hero band (title, one-line value proposition, optional stats/aside) and the content column. */
defineProps<{ title: string; subtitle: string; eyebrow?: string }>()
</script>

<template>
  <div class="biz-page">
    <section class="biz-hero">
      <div class="biz-hero-inner">
        <div class="biz-hero-copy">
          <p v-if="eyebrow" class="biz-eyebrow">{{ eyebrow }}</p>
          <h1 class="biz-title">{{ title }}</h1>
          <p class="biz-subtitle">{{ subtitle }}</p>
          <div v-if="$slots.stats" class="biz-stats"><slot name="stats" /></div>
        </div>
        <div v-if="$slots.aside" class="biz-hero-aside"><slot name="aside" /></div>
      </div>
    </section>
    <div class="biz-body"><slot /></div>
  </div>
</template>

<style scoped>
.biz-page { min-height: calc(100vh - var(--header-h)); background: var(--color-bg); }
.biz-hero {
  border-bottom: 1px solid var(--color-border);
  background:
    radial-gradient(900px 260px at 85% -40%, var(--color-accent-soft), transparent 70%),
    var(--color-surface);
}
.biz-hero-inner {
  max-width: 1200px; margin: 0 auto; padding: 36px 24px 30px;
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 32px; align-items: end;
}
.biz-eyebrow { margin: 0 0 6px; color: var(--color-accent-text); font-size: var(--font-size-xs); font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; }
.biz-title { margin: 0; font-family: var(--font-display); font-size: 34px; line-height: 1.15; font-weight: 700; letter-spacing: -0.01em; }
.biz-subtitle { margin: 10px 0 0; max-width: 620px; color: var(--color-text-secondary); font-size: var(--font-size-md); line-height: 1.6; }
.biz-stats { display: flex; flex-wrap: wrap; gap: 32px; margin-top: 22px; }
.biz-hero-aside { min-width: 300px; }
.biz-body { max-width: 1200px; margin: 0 auto; padding: 24px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
/* Grid items default to min-width:auto; a wide table inside a card would otherwise widen the whole column. */
.biz-body > * { min-width: 0; }
.biz-hero-copy { min-width: 0; }
@media (max-width: 860px) {
  .biz-hero-inner { grid-template-columns: minmax(0, 1fr); padding: 24px 16px; }
  .biz-hero-aside { min-width: 0; }
  .biz-title { font-size: 26px; }
  .biz-body { padding: 16px; }
}
</style>

<style>
/* Shared building blocks for the product pages (unscoped on purpose; prefixed `biz-`). */
.biz-card { min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.biz-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--color-border); }
.biz-card-head h2 { margin: 0; font-size: var(--font-size-lg); font-weight: 700; }
.biz-card-body { padding: 16px 20px; }
.biz-muted { color: var(--color-text-muted); }
.biz-up { color: var(--color-up); }
.biz-down { color: var(--color-down); }
.biz-empty { padding: 40px 16px; text-align: center; color: var(--color-text-muted); font-size: var(--font-size-sm); }
.biz-empty.err { color: var(--color-down); }
.biz-aside-card { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: 14px; padding: 18px 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-elevated); }
.biz-aside-card h3 { margin: 0; font-size: var(--font-size-md); font-weight: 650; }
.biz-kv { display: flex; justify-content: space-between; gap: 12px; font-size: var(--font-size-sm); }
.biz-kv span:first-child { color: var(--color-text-muted); }
.biz-kv span:last-child { font-weight: 600; text-align: right; }
.biz-notice { margin: 0; overflow-wrap: anywhere; padding: 10px 14px; border-radius: var(--radius); background: var(--color-surface-alt); color: var(--color-text-muted); font-size: var(--font-size-xs); line-height: 1.6; }
.biz-search { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); }
.biz-search input { width: 140px; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: var(--font-size-sm); }
.biz-rows { display: grid; }
.biz-row { display: grid; align-items: center; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--color-border); transition: background-color 0.12s; }
.biz-row:last-child { border-bottom: 0; }
.biz-row:hover { background: var(--color-hover); }
.biz-coin { display: inline-flex; align-items: center; gap: 10px; min-width: 0; font-weight: 650; }
.biz-coin small { display: block; color: var(--color-text-muted); font-size: var(--font-size-xs); font-weight: 400; }
.biz-label { display: block; color: var(--color-text-muted); font-size: var(--font-size-xs); margin-bottom: 2px; }
.biz-bar { height: 6px; border-radius: 3px; background: var(--color-surface-alt); overflow: hidden; }
.biz-bar > i { display: block; height: 100%; border-radius: 3px; background: var(--color-accent); }
.biz-chip { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: var(--radius-pill); border: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: var(--font-size-xs); font-weight: 600; }
.biz-chip.on { border-color: var(--color-accent); color: var(--color-accent-text); background: var(--color-accent-soft); }
.biz-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.biz-switch { position: relative; width: 36px; height: 20px; border: 0; border-radius: 10px; background: var(--color-border-strong); cursor: pointer; transition: background-color 0.15s; flex: none; }
.biz-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
.biz-switch.on { background: var(--color-up); }
.biz-switch.on::after { transform: translateX(16px); }
.biz-switch:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 860px) { .biz-row { grid-template-columns: 1fr 1fr !important; } .biz-row .biz-actions { grid-column: 1 / -1; justify-content: flex-start; } }
/* Phones: the header bar carries the title; the hero keeps its figures and account card only (owner 2026-11-17). */
@media (max-width: 720px) {
  .biz-eyebrow, .biz-title, .biz-subtitle { display: none; }
  .biz-hero { padding-top: 14px; padding-bottom: 14px; }
  .biz-stats { margin-top: 0; }
}
</style>
