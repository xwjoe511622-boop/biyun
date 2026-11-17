<script setup lang="ts">
/**
 * Inline "refreshing" hint for a panel that keeps showing its data (stale-while-revalidate): a 2px line pinned to the
 * top edge of the nearest positioned ancestor. It takes no layout space, and it only fades in when a refresh lasts
 * longer than ~250 ms, so quick refreshes after an order show nothing at all.
 */
defineProps<{ active: boolean }>()
</script>

<template>
  <span class="refresh-bar" :class="{ active }" role="progressbar" :aria-hidden="!active" aria-busy="true" data-testid="refresh-bar"></span>
</template>

<style scoped>
.refresh-bar {
  position: absolute; left: 0; right: 0; top: 0; z-index: 2; height: 2px; overflow: hidden;
  opacity: 0; pointer-events: none; transition: opacity 0.2s ease 0s;
}
.refresh-bar.active { opacity: 1; transition-delay: 0.25s; }
.refresh-bar::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 40%; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, var(--color-accent), transparent);
  animation: refresh-slide 1.1s ease-in-out infinite; animation-play-state: paused;
}
.refresh-bar.active::after { animation-play-state: running; }
/* transform only: moving `left` would itself count as a layout shift. */
@keyframes refresh-slide { to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) {
  .refresh-bar::after { animation: none; transform: none; width: 100%; opacity: 0.5; }
}
</style>
