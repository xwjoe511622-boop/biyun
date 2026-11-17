<script setup lang="ts">
/**
 * The BIYUN word mark (owner 2026-11-17): five geometric capitals drawn as one vector — even stroke, flat cuts, the
 * Y's arms on the same slant as the gold W — filled with the mark's gold, or with the text colour (`tone="ink"`).
 * It spells BIYUN only: callers show it when the brand name is BIYUN and fall back to plain text otherwise.
 */
withDefaults(defineProps<{ height?: number; tone?: 'gold' | 'ink' }>(), { height: 18, tone: 'gold' })
</script>

<template>
  <svg class="wordmark" :class="tone" viewBox="0 0 372 100" :height="height" :width="(height * 372) / 100" role="img" aria-label="BIYUN">
    <defs>
      <linearGradient id="bw-g" x1="0" y1="0" x2="372" y2="100" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FFE9A0" /><stop offset=".22" stop-color="#F2C64E" /><stop offset=".48" stop-color="#C9952C" /><stop offset=".7" stop-color="#F6D36E" /><stop offset="1" stop-color="#B8821C" />
      </linearGradient>
      <clipPath id="bw-c"><rect x="0" y="1" width="372" height="98" /></clipPath>
    </defs>
    <g clip-path="url(#bw-c)" fill="none" stroke-width="18" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="10">
      <path d="M10 10V90H43a20 20 0 0 0 0-40H10M39 50a20 20 0 0 0 0-40H10" />
      <path d="M103 10V90" />
      <path d="M131-8 166 54 201-8M166 54V90" />
      <path d="M229 10V58a29 29 0 0 0 58 0V10" />
      <path d="M317 90V10L362 90V10" />
    </g>
  </svg>
</template>

<style scoped>
.wordmark { display: block; flex: 0 0 auto; }
.wordmark.gold g { stroke: url(#bw-g); }
.wordmark.gold { filter: drop-shadow(0 1px 6px rgba(201, 149, 44, .35)); }
:root[data-theme='light'] .wordmark.gold { filter: brightness(.74) saturate(1.25); }
.wordmark.ink g { stroke: currentColor; }
</style>
