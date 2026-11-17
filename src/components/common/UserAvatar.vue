<script setup lang="ts">
/**
 * Account avatar (owner 2026-11-17): a dark disc with a gold ring and a gold silhouette, in the brand mark's gold.
 * `active` = signed in (gold); otherwise the ring and figure are muted grey so the two states read at a glance.
 */
withDefaults(defineProps<{ size?: number; active?: boolean }>(), { size: 36, active: true })
</script>

<template>
  <svg class="user-avatar" :class="{ muted: !active }" viewBox="0 0 40 40" :width="size" :height="size" aria-hidden="true">
    <defs>
      <linearGradient id="ua-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE9A0" /><stop offset=".35" stop-color="#F2C64E" /><stop offset=".7" stop-color="#C08A22" /><stop offset="1" stop-color="#F6D36E" /></linearGradient>
      <linearGradient id="ua-m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9bcc4" /><stop offset="1" stop-color="#6d717b" /></linearGradient>
      <radialGradient id="ua-b" cx=".35" cy=".25" r=".9"><stop offset="0" stop-color="#2c2416" /><stop offset="1" stop-color="#0c0a06" /></radialGradient>
      <clipPath id="ua-c"><circle cx="20" cy="20" r="16.4" /></clipPath>
    </defs>
    <circle cx="20" cy="20" r="18.6" fill="url(#ua-b)" />
    <g clip-path="url(#ua-c)" class="ua-figure">
      <circle cx="20" cy="15.6" r="6.1" />
      <path d="M6.5 38c0-8.2 6-13.2 13.5-13.200S33.500 29.800 33.500 38z" />
    </g>
    <circle class="ua-ring" cx="20" cy="20" r="18.600" fill="none" stroke-width="1.600" />
    <path d="M9 11a14.500 14.500 0 0 1 9-5.300" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.user-avatar { display: block; filter: drop-shadow(0 3px 8px rgba(192, 138, 34, .4)); }
.ua-figure { fill: url(#ua-g); }
.ua-ring { stroke: url(#ua-g); }
.user-avatar.muted { filter: none; }
.muted .ua-figure { fill: url(#ua-m); }
.muted .ua-ring { stroke: url(#ua-m); }
</style>
