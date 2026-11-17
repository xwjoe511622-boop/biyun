<script setup lang="ts">
import { BRAND_ID, BRAND_NAME } from '@/core/brand'
// BIYUN mark (owner 2026-11-17): the arc-and-B cut from the owner's logo, transparent background.
import biyunMark from '@/assets/biyun-mark.png?inline'
import { SKIN } from '@/core/skin'

/**
 * Build-time brand (`VITE_BRAND`). BITWINEX mark v3 (owner 10-22, designer's gold "W"; sources:
 * clean-source/frontend/brand/bitwinex/w-mark.svg): two outer blades and a centre chevron in brushed gold, drawn at
 * the reference aspect (1594:987, so `size` is the visual height class, width ≈ 1.42 × size). Longbit mark: an "L" whose stem ends in a dragon's head and whose base carries a rising ridge,
 * read as both a dragon's back and an up-trending price line. Pure inline SVG, no external asset.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 30 })
const gradientId = `longbit-mark-${Math.random().toString(36).slice(2, 8)}`
/** W metal per skin (owner 10-22): www (binance skin) blue, pro (okx skin) gold; build-time literal. */
const wStops: readonly string[] = SKIN === 'okx'
  ? ['#FFEBA3', '#F4C94F', '#C38C23', '#F8D670', '#B37C19']
  : ['#D6E1FF', '#7D9BFF', '#2E5BFF', '#A3BAFF', '#1F3FC2']
const wEdge = SKIN === 'okx' ? '#8C5E12' : '#16307A'
const wOffsets = ['0', '.3', '.56', '.8', '1']
</script>

<template>
  <img v-if="BRAND_ID === 'bitwinex' && BRAND_NAME === 'BIYUN'" class="brand-mark biyun" :src="biyunMark" :width="Math.round(size * 1.3)" :height="Math.round(size * 1.3)" alt="" aria-hidden="true" />
  <svg v-else-if="BRAND_ID === 'bitwinex'" class="brand-mark bitwinex w-mark" :width="Math.round(size * 1.42)" :height="Math.round(size * 0.88)" viewBox="0 0 1594 987" aria-hidden="true">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="1" y2="1">
        <stop v-for="(c, i) in wStops" :key="i" :offset="wOffsets[i]" :stop-color="c" />
      </linearGradient>
    </defs>
    <g :fill="`url(#${gradientId})`" :stroke="wEdge" stroke-width="10" stroke-linejoin="miter">
      <path d="M6 8H273L646 724 521 984Z" />
      <path d="M797 40 1031 440 913 665 797 440 681 665 563 440Z" />
      <path d="M1321 8H1588L1073 984 948 724Z" />
    </g>
  </svg>
  <svg v-else class="brand-mark" :width="size" :height="size" viewBox="0 0 32 32" aria-hidden="true">
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
.brand-mark.biyun { filter: none; margin: -3px -2px; }
.brand-mark.bitwinex { filter: drop-shadow(0 3px 10px rgba(46, 91, 255, 0.35)); }
:root[data-skin='okx'] .brand-mark.bitwinex { filter: drop-shadow(0 3px 10px rgba(201, 150, 40, 0.35)); }
</style>
