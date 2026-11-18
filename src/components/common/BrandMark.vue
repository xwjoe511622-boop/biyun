<script setup lang="ts">
import { BRAND_ID } from '@/core/brand'

/**
 * Build-time brand (`VITE_BRAND`). Longbit mark: an "L" whose stem ends in a dragon's head and whose base carries a
 * rising ridge. BITWINEX draws nothing. Pure inline SVG, no external asset.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 30 })
const gradientId = `longbit-mark-${Math.random().toString(36).slice(2, 8)}`
</script>

<template>
  <!-- BITWINEX has no mark (owner 2026-11-18): the name stands alone, so nothing is drawn for it. -->
  <svg v-if="BRAND_ID !== 'bitwinex'" class="brand-mark" :width="size" :height="size" viewBox="0 0 32 32" aria-hidden="true">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffd27a" />
        <stop offset="1" stop-color="#f08a0c" />
      </linearGradient>
    </defs>
    <rect width="32" height="32" rx="9" :fill="`url(#${gradientId})`" />
    <path
      d="M9.5 8.2c0-1 .8-1.6 1.8-1.4l3.6.8c.6.1.6.9 0 1.1l-2.2.6V21h11.1c.9 0 1.4 1 .9 1.7l-.4.5c-.3.4-.7.6-1.2.6H10.9c-.8 0-1.4-.6-1.4-1.4z"
      fill="#1a1103"
    />
    <path d="M14.8 21 17.3 16.4 19.1 19 22.2 13.2 23.6 21z" fill="#1a1103" opacity=".88" />
    <circle cx="11.6" cy="9.1" r=".85" fill="#ffd27a" />
  </svg>
</template>

<style scoped>
.brand-mark { flex: 0 0 auto; display: block; filter: drop-shadow(0 4px 12px rgba(240, 138, 12, 0.28)); }
</style>
