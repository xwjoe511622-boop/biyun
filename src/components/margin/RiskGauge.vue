<script setup lang="ts">
import { computed } from 'vue'
import { RISK_THRESHOLDS, accountRiskBand, accountRiskText, formatRiskRate, riskBand, riskColor, riskGaugeFraction, thresholdFraction } from '@/modules/margin/risk'

/**
 * Semicircular risk-rate gauge. Coloured bands follow the server thresholds (LeverUtils); the needle
 * sits at the server-reported risk rate. A zero rate means "no debt" and parks the needle off-scale.
 */
const props = defineProps<{ riskRate: string; bandLabel: string; label: string; hasBorrowing?: boolean | null }>()

const RADIUS = 64
const CENTER_X = 80
const CENTER_Y = 76

function point(fraction: number, radius = RADIUS): { x: number; y: number } {
  const angle = Math.PI * (1 - fraction)
  return { x: CENTER_X + radius * Math.cos(angle), y: CENTER_Y - radius * Math.sin(angle) }
}

function arc(start: number, end: number): string {
  const a = point(start)
  const b = point(end)
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${RADIUS} ${RADIUS} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

const segments = [
  { from: 0, to: thresholdFraction(RISK_THRESHOLDS.liquidation), color: 'var(--color-down)', opacity: 0.95 },
  { from: thresholdFraction(RISK_THRESHOLDS.liquidation), to: thresholdFraction(RISK_THRESHOLDS.reminder), color: 'var(--color-down)', opacity: 0.55 },
  { from: thresholdFraction(RISK_THRESHOLDS.reminder), to: thresholdFraction(RISK_THRESHOLDS.borrow), color: 'var(--color-accent)', opacity: 0.8 },
  { from: thresholdFraction(RISK_THRESHOLDS.borrow), to: thresholdFraction(RISK_THRESHOLDS.transfer), color: 'var(--color-up)', opacity: 0.55 },
  { from: thresholdFraction(RISK_THRESHOLDS.transfer), to: 1, color: 'var(--color-up)', opacity: 0.9 },
].map(segment => ({ ...segment, d: arc(segment.from + 0.004, segment.to - 0.004) }))

const band = computed(() => props.hasBorrowing === undefined ? riskBand(props.riskRate) : accountRiskBand(props.riskRate, props.hasBorrowing))
const color = computed(() => riskColor(band.value))
const hasDebt = computed(() => band.value !== 'none' && band.value !== 'unknown')
const needle = computed(() => {
  const tip = point(riskGaugeFraction(props.riskRate), RADIUS - 14)
  return { x: tip.x.toFixed(2), y: tip.y.toFixed(2) }
})
const text = computed(() => props.hasBorrowing === undefined ? formatRiskRate(props.riskRate) : accountRiskText(props.riskRate, props.hasBorrowing))
</script>

<template>
  <figure class="gauge" :class="`band-${band}`" role="meter" :aria-label="label" :aria-valuetext="`${text} ${bandLabel}`">
    <svg viewBox="0 0 160 88" aria-hidden="true">
      <path v-for="(segment, index) in segments" :key="index" :d="segment.d" class="band" :style="{ stroke: segment.color, opacity: hasDebt ? segment.opacity : 0.22 }" />
      <g v-if="hasDebt" class="needle" :style="{ color }">
        <line :x1="80" :y1="76" :x2="needle.x" :y2="needle.y" />
        <circle cx="80" cy="76" r="4.5" />
      </g>
    </svg>
    <figcaption class="gauge-caption">
      <strong class="num" :style="{ color: hasDebt ? color : undefined }" data-testid="risk-rate">{{ text }}</strong>
      <span class="band-chip" :style="{ color, borderColor: color }" data-testid="risk-band">{{ bandLabel }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.gauge { position: relative; margin: 0; width: 100%; max-width: 176px; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.band { fill: none; stroke-width: 9; stroke-linecap: round; transition: opacity 0.3s; }
.needle line { stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; }
.needle circle { fill: currentColor; }
.needle { transition: color 0.3s; }
.gauge-caption { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 6px; }
.gauge-caption strong { font-size: 20px; font-weight: 700; line-height: 1; }
.band-chip { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border: 1px solid; border-radius: 999px; font-size: 10.5px; font-weight: 700; background: var(--color-surface); }
.band-none .gauge-caption strong { color: var(--color-text-muted); }
</style>
