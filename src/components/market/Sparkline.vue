<script setup lang="ts">
import { computed } from 'vue'

/**
 * Tiny SVG trend line. Values are display-only numbers (already converted from decimal strings);
 * fewer than two points renders nothing rather than inventing a line.
 */
const props = withDefaults(
  defineProps<{ values: number[]; width?: number; height?: number; direction?: 'up' | 'down' | 'flat'; fill?: boolean }>(),
  { width: 120, height: 36, direction: 'flat', fill: true },
)

const gradientId = `spark-${Math.random().toString(36).slice(2, 8)}`

const points = computed<[number, number][]>(() => {
  const values = props.values.filter((value) => Number.isFinite(value))
  if (values.length < 2) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const pad = 3
  return values.map((value, index) => [
    (index / (values.length - 1)) * props.width,
    span === 0 ? props.height / 2 : pad + (1 - (value - min) / span) * (props.height - pad * 2),
  ])
})

const line = computed(() => points.value.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '))
const area = computed(() => (points.value.length === 0 ? '' : `${line.value} L${props.width} ${props.height} L0 ${props.height} Z`))
const color = computed(() => (props.direction === 'up' ? 'var(--color-up)' : props.direction === 'down' ? 'var(--color-down)' : 'var(--color-text-muted)'))
</script>

<template>
  <svg v-if="points.length > 0" class="sparkline" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" :stop-color="color" stop-opacity="0.28" />
        <stop offset="1" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path v-if="fill" :d="area" :fill="`url(#${gradientId})`" />
    <path :d="line" fill="none" :stroke="color" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
  </svg>
  <span v-else class="sparkline-empty" :style="{ width: `${width}px`, height: `${height}px` }" aria-hidden="true" />
</template>

<style scoped>
.sparkline { display: block; max-width: 100%; }
.sparkline-empty {
  display: block;
  max-width: 100%;
  background: linear-gradient(to right, transparent, var(--color-border) 20%, var(--color-border) 80%, transparent) center / 100% 1px no-repeat;
  opacity: 0.8;
}
</style>
