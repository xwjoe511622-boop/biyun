<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Decimal } from '@/modules/finance/decimal'
import { formatDateTime } from '@/modules/futures/format'
import { fundingRateView } from '@/modules/futures/math'
import type { FundingRateRow } from '@/modules/futures/types'

const { t: uiLabel } = useI18n({ useScope: 'global' })

/**
 * Funding-rate history as sign-coloured bars from a zero baseline (polarity: longs pay when
 * positive, shorts when negative). Values are converted to numbers for geometry only; labels and
 * the tooltip print the original decimal strings. The history table below is the table view.
 */
const props = defineProps<{ rows: FundingRateRow[]; emptyText: string }>()

const host = ref<HTMLDivElement>()
const width = ref(640)
const height = 220
const pad = { top: 14, right: 64, bottom: 26, left: 8 }
const hover = ref<number | null>(null)
let observer: ResizeObserver | null = null

onMounted(() => {
  observer = new ResizeObserver(([entry]) => { width.value = Math.max(240, entry.contentRect.width) })
  if (host.value !== undefined) observer.observe(host.value)
})
onBeforeUnmount(() => observer?.disconnect())

const points = computed(() => props.rows
  .filter((row) => row.rate !== '' && row.ctime !== null)
  .sort((a, b) => (a.ctime ?? 0) - (b.ctime ?? 0))
  .map((row) => ({ row, value: new Decimal(row.rate).toNumber() })))

const scale = computed(() => {
  const values = points.value.map((p) => p.value)
  const max = Math.max(0, ...values)
  const min = Math.min(0, ...values)
  const span = max - min || Math.abs(max) || 0.0001
  const top = max + span * 0.08
  const bottom = min - (min < 0 ? span * 0.08 : 0)
  const plotH = height - pad.top - pad.bottom
  const y = (v: number): number => pad.top + ((top - v) / (top - bottom)) * plotH
  return { top, bottom, y }
})

const bars = computed(() => {
  const plotW = width.value - pad.left - pad.right
  const n = points.value.length
  const slot = n > 0 ? plotW / n : plotW
  const barW = Math.max(2, Math.min(22, slot - 2))
  const zero = scale.value.y(0)
  return points.value.map((p, index) => {
    const y = scale.value.y(p.value)
    const h = Math.max(1, Math.abs(zero - y))
    return {
      key: `${p.row.ctime}-${index}`,
      x: pad.left + index * slot + (slot - barW) / 2,
      y: p.value >= 0 ? zero - h : zero,
      w: barW,
      h,
      up: p.value >= 0,
      slotX: pad.left + index * slot,
      slot,
      row: p.row,
    }
  })
})

function pct(value: number): string {
  return `${(value * 100).toFixed(4)}%`
}

const ticks = computed(() => {
  const { top, bottom, y } = scale.value
  return [top, (top + bottom) / 2, bottom].map((v) => ({ y: y(v), label: pct(v) }))
})
const zeroY = computed(() => scale.value.y(0))
const active = computed(() => (hover.value === null ? null : bars.value[hover.value] ?? null))
const xLabels = computed(() => {
  const list = bars.value
  if (list.length === 0) return []
  const picks = [0, Math.floor((list.length - 1) / 2), list.length - 1]
  const last = list.length - 1
  // The first label starts at the plot's left edge and the last one ends at its right edge; centring them on the end
  // bars pushed half of 「10-21 19:00」 outside the 8px padding (QA-062).
  return [...new Set(picks)].map((index) => {
    const bar = list[index]
    const anchor = index === 0 && last > 0 ? 'start' : index === last && last > 0 ? 'end' : 'middle'
    const x = anchor === 'start' ? bar.slotX : anchor === 'end' ? bar.slotX + bar.slot : bar.slotX + bar.slot / 2
    return { x, anchor, label: formatDateTime(bar.row.ctime, false).slice(0, 11) }
  })
})
</script>

<template>
  <div ref="host" class="frc" @mouseleave="hover = null">
    <svg v-if="bars.length > 0" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="uiLabel('accessibility.fundingRateHistory')">
      <g class="grid">
        <line v-for="tick in ticks" :key="tick.label" :x1="pad.left" :x2="width - pad.right" :y1="tick.y" :y2="tick.y" />
        <text v-for="tick in ticks" :key="`l-${tick.label}`" :x="width - pad.right + 8" :y="tick.y + 4">{{ tick.label }}</text>
      </g>
      <line class="zero" :x1="pad.left" :x2="width - pad.right" :y1="zeroY" :y2="zeroY" />
      <rect
        v-for="(bar, index) in bars"
        :key="bar.key"
        class="bar"
        :class="[bar.up ? 'up' : 'down', { dim: hover !== null && hover !== index }]"
        :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" rx="2"
      />
      <rect
        v-for="(bar, index) in bars"
        :key="`hit-${bar.key}`"
        class="hit" :x="bar.slotX" :y="pad.top" :width="bar.slot" :height="height - pad.top - pad.bottom"
        @mouseenter="hover = index"
      />
      <text v-for="label in xLabels" :key="label.label + label.x" class="x-label" :x="label.x" :y="height - 8" :text-anchor="label.anchor">{{ label.label }}</text>
    </svg>
    <p v-else class="frc-empty">{{ emptyText }}</p>
    <div
      v-if="active !== null"
      class="tip"
      :style="{ left: `${Math.min(active.slotX + active.slot / 2, width - 150)}px`, top: `${Math.max(8, active.y - 54)}px` }"
    >
      <span class="muted">{{ formatDateTime(active.row.ctime) }}</span>
      <b class="num" :class="fundingRateView(active.row.rate).direction">{{ fundingRateView(active.row.rate).text }}</b>
    </div>
  </div>
</template>

<style scoped>
.frc { position: relative; width: 100%; min-height: 220px; }
svg { display: block; }
.grid line { stroke: var(--color-border); stroke-dasharray: 2 4; }
.grid text, .x-label { fill: var(--color-text-muted); font-family: var(--font-mono); font-size: 10px; }
.zero { stroke: var(--color-text-muted); stroke-width: 1; }
.bar { transition: opacity 0.15s; }
.bar.up { fill: var(--color-up); }
.bar.down { fill: var(--color-down); }
.bar.dim { opacity: 0.45; }
.hit { fill: transparent; cursor: crosshair; }
.frc-empty { display: flex; align-items: center; justify-content: center; height: 220px; margin: 0; color: var(--color-text-muted); font-size: 13px; }
.tip {
  position: absolute; display: flex; flex-direction: column; gap: 2px; min-width: 140px; padding: 7px 10px; transform: translateX(-50%);
  border: 1px solid var(--color-border-strong); border-radius: 9px; background: var(--color-elevated); box-shadow: var(--shadow-pop);
  font-size: 11px; pointer-events: none;
}
.tip .up { color: var(--color-up); }
.tip .down { color: var(--color-down); }
</style>
