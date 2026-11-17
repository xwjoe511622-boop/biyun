<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { theme } from '@/core/theme'
import type { DepthLevel } from '@/stores/market'
import { depthPoints, type DepthPoint } from '@/modules/market/trade-value'
import { useMarketSource } from './market-source'

/**
 * Cumulative depth chart drawn on a canvas from the live depth channel. Values are converted to
 * JavaScript numbers for drawing only; nothing here feeds back into order maths.
 */
const { t } = useI18n()
const market = useMarketSource()
const host = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const tip = ref<{ x: number; y: number; side: 'bid' | 'ask'; price: string; total: string; value: string } | null>(null)

type Point = DepthPoint
interface Layout { width: number; height: number; minX: number; maxX: number; maxY: number; left: number; right: number; top: number; bottom: number }

let layout: Layout | null = null
let observer: ResizeObserver | null = null
let frame = 0

function toPoints(rows: DepthLevel[]): Point[] {
  return depthPoints(rows, market.currentSymbol?.valueMultiplier ?? '1', market.currentSymbol?.volumeIsValue === true)
}

const bids = computed(() => toPoints(market.buys))
const asks = computed(() => toPoints(market.asks))
const empty = computed(() => bids.value.length === 0 && asks.value.length === 0)
const pricePrecision = computed(() => market.currentSymbol?.pricePrecision ?? 2)
const volumePrecision = computed(() => Math.min(market.currentSymbol?.volumeDisplayPrecision ?? market.currentSymbol?.volumePrecision ?? 4, 6))

function css(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/** `#rrggbb` + alpha -> `rgba()`; canvas colour parsing does not accept `color-mix()` everywhere. */
function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (match === null) return color
  const value = parseInt(match[1], 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

function formatAxis(value: number, digits: number): string {
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return value.toFixed(digits)
}

function draw(): void {
  frame = 0
  const element = canvas.value
  const box = host.value
  if (element === undefined || box === undefined) return
  const width = box.clientWidth
  const height = box.clientHeight
  const ratio = window.devicePixelRatio || 1
  element.width = Math.max(1, Math.floor(width * ratio))
  element.height = Math.max(1, Math.floor(height * ratio))
  element.style.width = `${width}px`
  element.style.height = `${height}px`
  const ctx = element.getContext('2d')
  if (ctx === null) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (empty.value || width < 40 || height < 40) {
    layout = null
    return
  }

  const bidPts = bids.value
  const askPts = asks.value
  const bestBid = bidPts[0]?.price
  const bestAsk = askPts[0]?.price
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? 0)
  const span = Math.max(
    bidPts.length > 0 ? mid - bidPts[bidPts.length - 1].price : 0,
    askPts.length > 0 ? askPts[askPts.length - 1].price - mid : 0, // float-ok: depth chart axis span, display only
  )
  // A single level has no span; fall back to a small window around it so the step stays readable.
  const far = span > 0 ? span : Math.max(mid * 0.01, 10 ** -pricePrecision.value * 10)
  // Pad by part of the spread as well, so a thin book (one level per side) is not pinned to the edges.
  const halfSpread = bestBid !== undefined && bestAsk !== undefined ? (bestAsk - bestBid) / 2 : 0
  const reach = far * 1.08 + halfSpread * 0.6
  const minX = mid - reach
  const maxX = mid + reach
  const maxY = Math.max(...bidPts.map((p) => p.total), ...askPts.map((p) => p.total), 0) * 1.15 || 1
  const left = 8
  const right = width - 62
  const top = 16
  const bottom = height - 26
  layout = { width, height, minX, maxX, maxY, left, right, top, bottom }
  const x = (price: number): number => left + ((price - minX) / (maxX - minX)) * (right - left) // float-ok: depth chart pixel coordinates, display only
  const y = (total: number): number => bottom - (total / maxY) * (bottom - top) // float-ok: depth chart pixel coordinates, display only

  const muted = css('--color-text-muted', '#6d7888')
  const border = css('--color-border', '#1c232d')
  const up = css('--color-up', '#22c9a0')
  const down = css('--color-down', '#f6465d')
  ctx.font = `11px ${css('--font-mono', 'monospace')}`

  // Grid + Y axis labels.
  ctx.strokeStyle = border
  ctx.lineWidth = 1
  ctx.fillStyle = muted
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= 4; i += 1) {
    const value = (maxY / 4) * i
    const py = Math.round(y(value)) + 0.5
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(left, py)
    ctx.lineTo(right, py)
    ctx.stroke()
    ctx.setLineDash([])
    if (i > 0) ctx.fillText(formatAxis(value, volumePrecision.value > 2 ? 3 : 2), right + 8, py)
  }

  // X axis labels.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let i = 0; i <= 4; i += 1) {
    const price = minX + ((maxX - minX) / 4) * i
    ctx.fillText(formatAxis(price, pricePrecision.value), Math.min(Math.max(x(price), 30), right - 20), bottom + 8)
  }

  function area(points: Point[], color: string, direction: -1 | 1): void {
    if (points.length === 0 || ctx === null) return
    const edge = direction < 0 ? minX : maxX
    ctx.beginPath()
    ctx.moveTo(x(points[0].price), y(0))
    let previous = 0
    points.forEach((point) => {
      ctx.lineTo(x(point.price), y(previous))
      ctx.lineTo(x(point.price), y(point.total))
      previous = point.total
    })
    ctx.lineTo(x(edge), y(previous))
    const line = new Path2D()
    line.moveTo(x(points[0].price), y(0))
    let last = 0
    points.forEach((point) => {
      line.lineTo(x(point.price), y(last))
      line.lineTo(x(point.price), y(point.total))
      last = point.total
    })
    line.lineTo(x(edge), y(last))
    ctx.lineTo(x(edge), y(0))
    ctx.closePath()
    const gradient = ctx.createLinearGradient(0, top, 0, bottom)
    gradient.addColorStop(0, withAlpha(color, 0.36))
    gradient.addColorStop(1, withAlpha(color, 0.03))
    ctx.fillStyle = gradient
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.6
    ctx.stroke(line)
  }

  area(bidPts, up, -1)
  area(askPts, down, 1)

  // Mid-price marker.
  const mx = Math.round(x(mid)) + 0.5
  ctx.strokeStyle = muted
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(mx, top)
  ctx.lineTo(mx, bottom)
  ctx.stroke()
  ctx.setLineDash([])

  // Hover crosshair.
  const hovered = tip.value
  if (hovered !== null) {
    ctx.strokeStyle = hovered.side === 'bid' ? up : down
    ctx.beginPath()
    ctx.moveTo(Math.round(hovered.x) + 0.5, top)
    ctx.lineTo(Math.round(hovered.x) + 0.5, bottom)
    ctx.stroke()
    ctx.fillStyle = hovered.side === 'bid' ? up : down
    ctx.beginPath()
    ctx.arc(hovered.x, hovered.y, 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function schedule(): void {
  if (frame === 0) frame = requestAnimationFrame(draw)
}

function onMove(event: MouseEvent): void {
  const current = layout
  const box = host.value
  if (current === null || box === undefined) return
  const rect = box.getBoundingClientRect()
  const px = event.clientX - rect.left
  if (px < current.left || px > current.right) {
    tip.value = null
    schedule()
    return
  }
  const price = current.minX + ((px - current.left) / (current.right - current.left)) * (current.maxX - current.minX)
  const bestBid = bids.value[0]?.price ?? -Infinity
  const side: 'bid' | 'ask' = price <= bestBid || asks.value.length === 0 ? 'bid' : 'ask'
  const points = side === 'bid' ? bids.value : asks.value
  // The cumulative total at a price is the deepest level at or better than it.
  let hit: Point | undefined
  points.forEach((point) => {
    if (side === 'bid' ? point.price >= price : point.price <= price) hit = point
  })
  if (hit === undefined) {
    tip.value = null
    schedule()
    return
  }
  const y = current.bottom - (hit.total / current.maxY) * (current.bottom - current.top) // float-ok: depth chart tooltip position, display only
  tip.value = {
    x: px,
    y,
    side,
    price: price.toFixed(pricePrecision.value),
    total: hit.total.toFixed(volumePrecision.value),
    value: hit.notional.toFixed(Math.min(pricePrecision.value, 4)),
  }
  schedule()
}

function onLeave(): void {
  tip.value = null
  schedule()
}

watch([bids, asks, theme], schedule)

onMounted(() => {
  observer = new ResizeObserver(schedule)
  if (host.value !== undefined) observer.observe(host.value)
  schedule()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame !== 0) cancelAnimationFrame(frame)
})
</script>

<template>
  <div class="depth-chart">
    <div class="legend">
      <span class="lg bid"><i></i>{{ t('trade.depthBids') }}</span>
      <span class="lg ask"><i></i>{{ t('trade.depthAsks') }}</span>
    </div>
    <div ref="host" class="canvas-host" @mousemove="onMove" @mouseleave="onLeave">
      <canvas ref="canvas"></canvas>
      <div v-if="tip !== null" class="tip" :class="tip.side" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">
        <div><span>{{ t('common.price') }}</span><b class="num">{{ tip.price }}</b></div>
        <div><span>{{ t('trade.cumulative', { base: market.currentSymbol?.volumeUnit ?? market.currentSymbol?.base ?? '' }) }}</span><b class="num">{{ tip.total }}</b></div>
        <div><span>{{ t('common.total') }}</span><b class="num">{{ tip.value }} {{ market.currentSymbol?.quote ?? '' }}</b></div>
      </div>
      <p v-if="empty" class="empty">{{ t('trade.depthEmpty') }}</p>
    </div>
  </div>
</template>

<style scoped>
.depth-chart { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.legend { display: flex; gap: 16px; padding: 10px 14px 0; font-size: 11px; color: var(--color-text-secondary); }
.lg { display: inline-flex; align-items: center; gap: 6px; }
.lg i { width: 10px; height: 10px; border-radius: 3px; }
.lg.bid i { background: var(--color-up); }
.lg.ask i { background: var(--color-down); }
.canvas-host { position: relative; flex: 1 1 auto; min-height: 0; cursor: crosshair; }
canvas { position: absolute; inset: 0; display: block; }
.tip {
  position: absolute; z-index: 2; min-width: 170px; padding: 9px 11px; transform: translate(14px, -50%);
  border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-elevated);
  box-shadow: var(--shadow-pop); font-size: 11px; pointer-events: none;
}
.tip div { display: flex; justify-content: space-between; gap: 14px; line-height: 1.8; }
.tip span { color: var(--color-text-muted); }
.tip.bid { border-left: 3px solid var(--color-up); }
.tip.ask { border-left: 3px solid var(--color-down); transform: translate(calc(-100% - 14px), -50%); }
.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; margin: 0; color: var(--color-text-muted); font-size: 13px; }
</style>
