<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SKIN } from '@/core/skin'
import { theme } from '@/core/theme'
import { BAND_OVERHANG, CosmosEngine, type CosmosLayout, type CosmosRect, type CosmosVariant } from './cosmos-engine'
import { cosmosPalette } from './cosmos-palettes'

/**
 * Decorative starfield + galaxy band behind a home section (both skins; colours from `cosmos-palettes`).
 * Absolutely fills its positioned parent, ignores pointer events and is hidden from assistive tech.
 * Starts after mount on idle so it never competes with first paint; runs only while on screen, the tab is
 * visible and motion is allowed (prefers-reduced-motion → one static frame, no CSS drift).
 */
const props = withDefaults(defineProps<{ variant?: CosmosVariant; calm?: boolean }>(), { variant: 'hero', calm: false })

const host = ref<HTMLDivElement | null>(null)
const starsEl = ref<HTMLCanvasElement | null>(null)
const bandEl = ref<HTMLCanvasElement | null>(null)
const ready = ref(false)
const inView = ref(true)

let engine: CosmosEngine | null = null
let resizeObserver: ResizeObserver | null = null
let intersection: IntersectionObserver | null = null
let motionQuery: MediaQueryList | null = null
let finePointer = false
let idleHandle = 0
let idleUsesCallback = false
let pointerFrame = 0
let pointerX = 0
let pointerY = 0
/** Hero only: page offset and height of the host (cached per resize) for the scroll warp. */
let hostTop = 0
let hostHeight = 1
/** Calm skies (page backdrop) neither warp on scroll nor follow the pointer. */
const warps = props.variant === 'hero' && !props.calm

/** Scroll warp: one scrollY read per scroll event, no layout; the engine eases toward it per frame. */
function onScroll(): void {
  engine?.setWarp((window.scrollY - hostTop) / hostHeight)
}

function measure(el: HTMLElement): void {
  const box = el.getBoundingClientRect()
  hostTop = Math.max(0, box.top + window.scrollY - (document.querySelector('header')?.offsetHeight ?? 0))
  hostHeight = Math.max(1, box.height * 0.85)
}

/** Copy, cards and headline next to the sky, in host px: the engine keeps its bodies clear of them. */
const TEXT_SELECTOR = 'h1, h2, p, dl, form'
const CARD_SELECTOR = 'aside, .bn-card, .hero-side > *, .account-card, .okx-balance'

function measureLayout(el: HTMLElement): void {
  const section = el.parentElement
  if (section === null || engine === null) return
  const origin = el.getBoundingClientRect()
  const rect = (node: Element): CosmosRect | null => {
    const r = node.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
  }
  const collect = (selector: string): CosmosRect[] => {
    const out: CosmosRect[] = []
    for (const node of section.querySelectorAll(selector)) {
      if (node.closest('.cosmos') !== null) continue
      const r = rect(node)
      if (r !== null) out.push(r)
    }
    return out
  }
  // Copy is measured per line box (a short last line leaves the sky beside it free).
  const lines: CosmosRect[] = []
  const range = document.createRange()
  for (const node of section.querySelectorAll(TEXT_SELECTOR)) {
    if (node.closest('.cosmos') !== null) continue
    range.selectNodeContents(node)
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0) lines.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height })
    }
  }
  const h1 = section.querySelector('h1, h2')
  const headline = h1 === null ? null : rect(h1)
  const lead = section.querySelector('h1 ~ p, h2 ~ p')
  const leadRect = lead === null ? null : rect(lead)
  // The first two text boxes are the headline and the lead (the engine thins the sky behind them).
  const text = [headline, leadRect].filter((r): r is CosmosRect => r !== null)
  const layout: CosmosLayout = { text: [...text, ...lines], cards: collect(CARD_SELECTOR), headline }
  engine.setLayout(layout)
}

/** Phones and low-end devices draw a lighter sky (fewer stars, no spiral galaxy). */
function liteDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency
  const memory = nav.deviceMemory
  return window.innerWidth <= 640 || (cores > 0 && cores <= 4) || (memory !== undefined && memory <= 4)
}

let layoutTimer = 0
function scheduleLayout(el: HTMLElement): void {
  if (layoutTimer !== 0) globalThis.clearTimeout(layoutTimer)
  layoutTimer = globalThis.setTimeout(() => {
    layoutTimer = 0
    measureLayout(el)
  }, 160)
}

/** The band canvas overhangs the host by the engine's margin on every side (box set inline, no CSS copy). */
const bandBox = {
  top: `${-BAND_OVERHANG * 100}%`,
  left: `${-BAND_OVERHANG * 100}%`,
  width: `${100 + BAND_OVERHANG * 200}%`,
  height: `${100 + BAND_OVERHANG * 200}%`,
}

function reduced(): boolean {
  return motionQuery?.matches === true
}

function sync(): void {
  if (engine === null) return
  if (reduced()) {
    engine.renderStatic()
    return
  }
  engine.setRunning(inView.value && document.visibilityState === 'visible')
}

function onPointer(event: PointerEvent): void {
  pointerX = (event.clientX / window.innerWidth) * 2 - 1
  pointerY = (event.clientY / window.innerHeight) * 2 - 1
  if (pointerFrame !== 0) return
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0
    engine?.setPointer(pointerX, pointerY)
  })
}

function boot(): void {
  idleHandle = 0
  const el = host.value
  const stars = starsEl.value
  const band = bandEl.value
  if (el === null || stars === null || band === null) return
  // OKX's headline runs wider, so its bulge sits a little further right, in the gap before the board.
  engine = new CosmosEngine(stars, band, {
    variant: props.variant,
    palette: cosmosPalette(SKIN, theme.value),
    bulge: SKIN === 'okx' && props.variant === 'hero' ? 0.6 : undefined,
    lite: liteDevice(),
    calm: props.calm,
  })
  const box = el.getBoundingClientRect()
  engine.resize(box.width, box.height)
  measureLayout(el)
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (entry === undefined || engine === null) return
    engine.resize(entry.contentRect.width, entry.contentRect.height)
    if (warps) measure(el)
    scheduleLayout(el)
  })
  resizeObserver.observe(el)
  // Cards grow when live rows arrive; their boxes are watched too (layout re-measured at most every 160 ms).
  const section = el.parentElement
  if (section !== null) for (const node of section.querySelectorAll(CARD_SELECTOR)) resizeObserver.observe(node)
  intersection = new IntersectionObserver((entries) => {
    const entry = entries[0]
    if (entry === undefined) return
    inView.value = entry.isIntersecting
    sync()
  })
  intersection.observe(el)
  document.addEventListener('visibilitychange', sync)
  motionQuery?.addEventListener('change', sync)
  finePointer = !props.calm && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  if (finePointer) window.addEventListener('pointermove', onPointer, { passive: true })
  if (warps && !reduced()) {
    measure(el)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
  ready.value = true
  sync()
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  // After first paint: idle callback where available, a short timeout otherwise.
  // (Safari before 18 has no requestIdleCallback.)
  idleUsesCallback = typeof window.requestIdleCallback === 'function'
  idleHandle = idleUsesCallback ? window.requestIdleCallback(boot, { timeout: 400 }) : globalThis.setTimeout(boot, 120)
})

watch(theme, (next) => {
  engine?.setPalette(cosmosPalette(SKIN, next))
})

onBeforeUnmount(() => {
  if (idleHandle !== 0) {
    if (idleUsesCallback) window.cancelIdleCallback(idleHandle)
    else globalThis.clearTimeout(idleHandle)
  }
  if (pointerFrame !== 0) cancelAnimationFrame(pointerFrame)
  if (layoutTimer !== 0) globalThis.clearTimeout(layoutTimer)
  resizeObserver?.disconnect()
  intersection?.disconnect()
  document.removeEventListener('visibilitychange', sync)
  motionQuery?.removeEventListener('change', sync)
  if (finePointer) window.removeEventListener('pointermove', onPointer)
  window.removeEventListener('scroll', onScroll)
  engine?.destroy()
  engine = null
})
</script>

<template>
  <div ref="host" class="cosmos" :class="[`cosmos-${variant}`, { 'is-ready': ready, 'is-paused': !inView, 'is-calm': calm }]" aria-hidden="true">
    <canvas ref="bandEl" class="cosmos-band" :style="bandBox"></canvas>
    <canvas ref="starsEl" class="cosmos-stars"></canvas>
  </div>
</template>

<style scoped>
.cosmos {
  position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; contain: strict;
  /* Dissolve into the page instead of ending on a hard edge. */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 6%, #000 72%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 6%, #000 72%, transparent 100%);
}
.cosmos-cta { -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 30%, #000 70%, transparent 100%); mask-image: linear-gradient(to bottom, transparent 0, #000 30%, #000 70%, transparent 100%); }
.cosmos canvas { position: absolute; display: block; }
.cosmos-stars { inset: 0; width: 100%; height: 100%; }
.cosmos-band { opacity: 0; transform-origin: 62% 38%; will-change: transform, opacity; }

/* The single entrance moment: the band blooms in while the stars ease outward (engine), then a very slow
   drift — one 26 s breath with a visible turn, compositor-only. */
.is-ready .cosmos-band {
  animation: cosmos-bloom 2.4s cubic-bezier(0.2, 0.7, 0.2, 1) forwards, cosmos-drift 26s ease-in-out 2.4s infinite alternate;
}
.is-calm.is-ready .cosmos-band { animation: cosmos-fade 1.6s ease-out forwards; }
.cosmos-cta.is-ready .cosmos-band { animation: cosmos-fade 1.6s ease-out forwards, cosmos-drift 26s ease-in-out 1.6s infinite alternate; }
.is-paused .cosmos-band { animation-play-state: paused; }

@keyframes cosmos-bloom {
  from { opacity: 0; transform: scale(0.94) rotate(-1.2deg); }
  to { opacity: 1; transform: scale(1) rotate(0deg); }
}
@keyframes cosmos-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes cosmos-drift {
  from { transform: scale(1) rotate(0deg) translate3d(0, 0, 0); }
  to { transform: scale(1.07) rotate(2.6deg) translate3d(-2.6%, 1.4%, 0); }
}

/* Scroll warp, compositor half: as the hero scrolls out the whole sky zooms toward the bulge and dims (the
   engine adds the star streaks). Browsers without scroll timelines simply keep the sky still. */
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .cosmos-hero:not(.is-calm) {
      transform-origin: 62% 38%;
      animation: cosmos-warp linear both;
      animation-timeline: view();
      animation-range: exit-crossing 0% exit-crossing 100%;
    }
  }
}
@keyframes cosmos-warp {
  to { transform: scale(1.32); opacity: 0.25; }
}

@media (prefers-reduced-motion: reduce) {
  .is-ready .cosmos-band, .cosmos-cta.is-ready .cosmos-band { animation: none; opacity: 1; }
}
</style>
