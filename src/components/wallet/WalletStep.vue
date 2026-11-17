<script setup lang="ts">
import { Check } from '@lucide/vue'

/** One numbered step of a deposit / withdraw flow with a vertical connector to the next step. */
withDefaults(defineProps<{ index: number; title: string; done?: boolean; muted?: boolean; last?: boolean }>(), {
  done: false,
  muted: false,
  last: false,
})
</script>

<template>
  <section class="wstep" :class="{ done, muted, last }">
    <div class="wstep-rail" aria-hidden="true">
      <span class="wstep-dot">
        <Check v-if="done" :size="13" :stroke-width="3" />
        <template v-else>{{ index }}</template>
      </span>
      <span v-if="!last" class="wstep-line" />
    </div>
    <div class="wstep-body">
      <h3 class="wstep-title">{{ title }}</h3>
      <div class="wstep-content"><slot /></div>
    </div>
  </section>
</template>

<style scoped>
.wstep { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 14px; }
.wstep-rail { display: flex; flex-direction: column; align-items: center; }
.wstep-dot {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: 0 0 26px;
  border-radius: 50%; border: 1px solid var(--color-border-strong); background: var(--color-surface-alt);
  color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  transition: background-color 0.2s var(--ease-out), color 0.2s var(--ease-out), border-color 0.2s var(--ease-out);
}
.wstep.done .wstep-dot { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-on-accent); }
.wstep-line { flex: 1 1 auto; width: 1px; min-height: 16px; margin: 6px 0; background: var(--color-border-strong); }
.wstep.done .wstep-line { background: linear-gradient(var(--color-accent), var(--color-border-strong)); }
.wstep-body { min-width: 0; padding-bottom: 26px; }
.wstep.last .wstep-body { padding-bottom: 0; }
.wstep-title { margin: 3px 0 12px; font-size: 15px; font-weight: 700; letter-spacing: -0.005em; }
.wstep.muted .wstep-title { color: var(--color-text-muted); }
.wstep.muted .wstep-content { opacity: 0.55; }
@media (max-width: 520px) {
  .wstep { grid-template-columns: 24px minmax(0, 1fr); gap: 10px; }
  .wstep-dot { width: 22px; height: 22px; flex-basis: 22px; font-size: 11px; }
}
</style>
