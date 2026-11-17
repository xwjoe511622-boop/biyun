<script setup lang="ts">
/**
 * The BIYUN word mark (owner 2026-11-17): five geometric capitals drawn as one vector — even stroke, flat cuts, the
 * Y's arms on the same slant as the gold W — filled with the mark's gold, or with the text colour (`tone="ink"`).
 * It spells BIYUN only: callers show it when the brand name is BIYUN and fall back to plain text otherwise.
 */
withDefaults(defineProps<{ height?: number; tone?: 'gold' | 'ink' }>(), { height: 18, tone: 'gold' })
</script>

<template>
  <svg class="wordmark" :class="tone" viewBox="0 0 378 100" :height="height" :width="(height * 378) / 100" role="img" aria-label="BIYUN">
    <defs>
      <!-- Polished metal, lit from above: pale top edge, warm body, a deep band below the middle, a lift at the foot. -->
      <linearGradient id="bw-g" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FFF6CF" /><stop offset=".3" stop-color="#F6D36E" /><stop offset=".52" stop-color="#D9A63A" /><stop offset=".66" stop-color="#B07A18" /><stop offset=".84" stop-color="#E2B44C" /><stop offset="1" stop-color="#F8DC8A" />
      </linearGradient>
      <clipPath id="bw-c"><rect x="0" y="1" width="378" height="98" /></clipPath>
    </defs>
    <!-- Wide geometric capitals on one 15-unit stroke. The B is cut like a stencil (its waist bar stops short of the
         stem); Y and N share one diagonal; every terminal is a flat cut. -->
    <g clip-path="url(#bw-c)" fill="none" stroke-width="15" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="12">
      <path d="M8.5 1V99M1 8.500H44a20.750 20.750 0 0 1 0 41.500H25M25 50H48a20.750 20.750 0 0 1 0 41.500H1" />
      <path d="M101.500 1V99" />
      <path d="M126-8 162 55 198-8M162 52V99" />
      <path d="M224.500 1V58a30 30 0 0 0 60 0V1" />
    </g>
    <!-- N as an outline, not a stroke: stems as wide as the other stems, a lean diagonal, no heavy corners. -->
    <path class="wm-fill" d="M312 99V1h16.500l33 66V1h15v98H360l-33-66v66z" />
  </svg>
</template>

<style scoped>
.wordmark { display: block; flex: 0 0 auto; }
.wordmark.gold g { stroke: url(#bw-g); }
.wordmark.gold .wm-fill { fill: url(#bw-g); }
.wordmark.ink .wm-fill { fill: currentColor; }
.wordmark.gold { filter: drop-shadow(0 1px 6px rgba(201, 149, 44, .35)); }
:root[data-theme='light'] .wordmark.gold { filter: brightness(.74) saturate(1.25); }
.wordmark.ink g { stroke: currentColor; }
</style>
