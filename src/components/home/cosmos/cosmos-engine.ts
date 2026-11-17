import type { CosmosPalette } from './cosmos-palettes'
import {
  PLANET_EXTENT,
  RING_FLAT,
  RING_TILT,
  canvas,
  dither,
  gauss,
  makeGalaxy,
  makeMoon,
  makeNebula,
  makePlanet,
  makePuff,
  makeSpikes,
  makeStar,
  makeTail,
  rng,
  type Sprite,
} from './cosmos-bodies'

/**
 * Canvas engine for the home "cosmos" layer (owner 10-22: 星空动得更快些，多些天体种类). Two canvases:
 *   - `band`: the galaxy band (clouds, bulge, dust, a dark rift), painted once per size / palette and moved by
 *     a CSS transform in the component (compositor only).
 *   - `stars`: repainted on requestAnimationFrame. The far star layer is pre-rendered into one tile and
 *     scrolled (two blits); the mid and near layers are sprites with a strong twinkle. On top: a nebula, a
 *     rotating spiral galaxy, a ringed planet with an orbiting moon, star clusters, pulsing stars with
 *     diffraction spikes, a comet, meteors and an occasional sparkle burst at the headline. Every body is a
 *     pre-rendered sprite (cosmos-bodies.ts); a frame is only blits and transforms.
 * Bodies are placed per layout, away from text (the component passes the text and card boxes).
 * Phones and low-end devices (`lite`) get fewer stars and skip the galaxy and most clusters.
 * float-ok: the whole file is UI layout / animation maths (money-precision rule, display-only).
 */

export type CosmosVariant = 'hero' | 'cta'

/** A box in host CSS px. */
export interface CosmosRect {
  x: number
  y: number
  w: number
  h: number
}

/** What the component measured around the sky: copy to keep clear, cards that may cover bodies, the headline. */
export interface CosmosLayout {
  text: CosmosRect[]
  cards: CosmosRect[]
  headline: CosmosRect | null
}

export interface CosmosOptions {
  variant: CosmosVariant
  palette: CosmosPalette
  /** Per-layout override of where the bulge sits on the band curve (OKX hero has a wider headline). */
  bulge?: number
  /** Phones / low-end devices: fewer stars, no spiral galaxy. */
  lite: boolean
  /**
   * Quiet backdrop behind page content (owner 10-22: 做过头了), drifting at half speed: no scroll warp streaks, no
   * headline sparkles. Bodies came back smaller and dimmer (owner 10-22: 星球再弄一些回来) and pinned to the
   * viewport edges — planet + moon top right, nebula behind it, spiral galaxy bottom left — since the page copy
   * scrolls over this sky and cannot be measured; three pulsars, a rare comet, a meteor now and then.
   */
  calm?: boolean
}

interface Star {
  x: number
  y: number
  layer: number
  size: number
  tint: number
  alpha: number
  twinkle: number
  phase: number
  delay: number
}

interface Pulsar {
  x: number
  y: number
  size: number
  rate: number
  phase: number
}

interface Meteor {
  x: number
  y: number
  dx: number
  dy: number
  born: number
  life: number
  length: number
}

interface Comet {
  x: number
  y: number
  dx: number
  dy: number
  born: number
  life: number
}

interface Spark {
  x: number
  y: number
  dx: number
  dy: number
  born: number
  life: number
  size: number
}

interface BandShape {
  p0: [number, number]
  p1: [number, number]
  p2: [number, number]
  /** Position of the bulge along the curve (0..1). */
  bulge: number
  /** Band strength multiplier. */
  strength: number
}

interface Placed {
  x: number
  y: number
}

const ENTRANCE_SECONDS = 2.2
/** Horizontal drift per depth layer, CSS px / s (far → near). */
const LAYER_DRIFT = [5, 11, 22]
/** Slow vertical drift per layer, CSS px / s (the sky slides diagonally, like a slow pan). */
const LAYER_RISE = [-0.8, -1.8, -3.6]
/** Pointer parallax amplitude per depth layer, CSS px. */
const LAYER_PARALLAX = [6, 15, 30]
/** Scroll warp (hero leaving the screen): extra radial zoom per depth layer at full warp. */
const WARP_ZOOM = [0.12, 0.38, 0.9]
/** CSS px² of sky per star before the palette density multiplier. */
const AREA_PER_STAR: Record<CosmosVariant, number> = { hero: 2100, cta: 4800 }
const MAX_STARS = 760
const MAX_STARS_LITE = 300
/** Wrap margin around the host for drifting stars. */
const WRAP = 24
/** The band canvas overhangs the host on every side so the CSS drift never shows an edge. */
export const BAND_OVERHANG = 0.09
/** Spiral galaxy: one turn per this many seconds. */
const GALAXY_TURN = 70
/** Moon: one orbit per this many seconds. */
const MOON_ORBIT = 26

const BANDS: Record<CosmosVariant, BandShape> = {
  // Rises from lower left behind the headline; the bulge peeks out between the copy and the market card.
  hero: { p0: [-0.1, 0.86], p1: [0.42, 0.34], p2: [1.12, 0.08], bulge: 0.56, strength: 1 },
  cta: { p0: [-0.12, 0.78], p1: [0.5, 0.36], p2: [1.12, 0.66], bulge: 0.5, strength: 0.5 },
}
/** Portrait hosts (phones): a flatter band across the top, clear of the stats and the sign-up field. */
const PORTRAIT_HERO: BandShape = { p0: [-0.3, 0.4], p1: [0.45, 0.17], p2: [1.3, 0.03], bulge: 0.6, strength: 0.8 }

function bandShape(variant: CosmosVariant, w: number, h: number, bulge: number | undefined): BandShape {
  if (variant === 'hero' && h > w * 1.2) return PORTRAIT_HERO
  const shape = BANDS[variant]
  return bulge === undefined ? shape : { ...shape, bulge }
}

/** Band thickness unit: the host height, but never more than ¾ of the width (tall phone heroes). */
function bandUnit(w: number, h: number): number {
  return Math.min(h, w * 0.75)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function easeOutCubic(v: number): number {
  const k = 1 - v
  return 1 - k * k * k
}

function overlap(a: CosmosRect, b: CosmosRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function curvePoint(shape: BandShape, t: number, w: number, h: number): { x: number; y: number; nx: number; ny: number; angle: number } {
  const u = 1 - t
  const x = (u * u * shape.p0[0] + 2 * u * t * shape.p1[0] + t * t * shape.p2[0]) * w
  const y = (u * u * shape.p0[1] + 2 * u * t * shape.p1[1] + t * t * shape.p2[1]) * h
  const tx = (2 * u * (shape.p1[0] - shape.p0[0]) + 2 * t * (shape.p2[0] - shape.p1[0])) * w
  const ty = (2 * u * (shape.p1[1] - shape.p0[1]) + 2 * t * (shape.p2[1] - shape.p1[1])) * h
  const len = Math.hypot(tx, ty) || 1
  return { x, y, nx: -ty / len, ny: tx / len, angle: Math.atan2(ty, tx) }
}

function wrap(v: number, size: number): number {
  return (((v + WRAP) % size) + size) % size - WRAP
}

export class CosmosEngine {
  private readonly starsCanvas: HTMLCanvasElement
  private readonly bandCanvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly variant: CosmosVariant
  private readonly bulge: number | undefined
  private readonly lite: boolean
  private palette: CosmosPalette
  private layout: CosmosLayout = { text: [], cards: [], headline: null }
  private width = 0
  private height = 0
  private dpr = 1
  private stars: Star[] = []
  private sprites: Sprite[] = []
  /** Far layer, pre-rendered (covers [-WRAP, w + WRAP) horizontally, [-WRAP, h + WRAP) vertically). */
  private farTile: Sprite | null = null
  private farScale = 1
  private spikes: Sprite | null = null
  private flare: Sprite | null = null
  private planet: Sprite | null = null
  private moon: Sprite | null = null
  private galaxy: Sprite | null = null
  private nebula: Sprite | null = null
  private dustTail: Sprite | null = null
  private ionTail: Sprite | null = null
  private eraser: Sprite | null = null
  private planetAt: Placed | null = null
  private planetR = 0
  private galaxyAt: Placed | null = null
  private galaxyR = 0
  private nebulaAt: Placed | null = null
  private nebulaW = 0
  private nebulaH = 0
  private pulsars: Pulsar[] = []
  private meteor: Meteor | null = null
  private nextMeteorAt = 0
  private comet: Comet | null = null
  private nextCometAt = 0
  private sparks: Spark[] = []
  private sparkFlash: { x: number; y: number; born: number } | null = null
  private nextSparkAt = 0
  private eventRand = rng(0x5eed)
  private clock = 0
  private lastFrame = 0
  private frameId = 0
  private running = false
  private pointerX = 0
  private pointerY = 0
  private pointerTargetX = 0
  private pointerTargetY = 0
  /** 0..1, how far the hero has scrolled away (smoothed toward `warpTarget` each frame). */
  private warp = 0
  private readonly calm: boolean
  private warpTarget = 0
  /** Skip the entrance (CTA layer, or a redraw after the first one finished). */
  private entranceDone: boolean

  constructor(starsCanvas: HTMLCanvasElement, bandCanvas: HTMLCanvasElement, options: CosmosOptions) {
    this.starsCanvas = starsCanvas
    this.bandCanvas = bandCanvas
    this.ctx = starsCanvas.getContext('2d')
    this.variant = options.variant
    this.palette = options.palette
    this.bulge = options.bulge
    this.lite = options.lite
    this.calm = options.calm === true
    this.entranceDone = options.variant !== 'hero'
    this.buildSprites()
  }

  setPalette(palette: CosmosPalette): void {
    this.palette = palette
    this.buildSprites()
    this.seedStars()
    this.placeBodies()
    this.paintBand()
    if (!this.running) this.drawFrame()
  }

  /** Size in CSS px of the host box. Repaints the band and reseeds stars (same seed → same sky). */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.dpr = Math.min(this.lite ? 1.5 : 2, window.devicePixelRatio || 1)
    this.starsCanvas.width = Math.round(w * this.dpr)
    this.starsCanvas.height = Math.round(h * this.dpr)
    this.seedStars()
    this.placeBodies()
    this.paintBand()
    if (!this.running) this.drawFrame()
  }

  /** Text / card boxes around the sky; bodies move to the clearest spots. */
  setLayout(layout: CosmosLayout): void {
    this.layout = layout
    this.placeBodies()
    if (!this.running) this.drawFrame()
  }

  /** Normalised pointer position in the viewport, -1..1 on each axis. */
  setPointer(nx: number, ny: number): void {
    this.pointerTargetX = nx
    this.pointerTargetY = ny
  }

  /** Scroll warp target, 0 (hero in place) .. 1 (hero scrolled out): stars zoom outward and streak. */
  setWarp(value: number): void {
    if (this.calm) return
    this.warpTarget = clamp01(value)
  }

  /** Start or pause the animation loop (off-screen, hidden tab, reduced motion). */
  setRunning(on: boolean): void {
    if (on === this.running) return
    this.running = on
    if (on) {
      this.lastFrame = 0
      this.frameId = requestAnimationFrame(this.tick)
    } else {
      cancelAnimationFrame(this.frameId)
    }
  }

  /** One finished, calm frame — used for prefers-reduced-motion. */
  renderStatic(): void {
    this.setRunning(false)
    this.entranceDone = true
    this.meteor = null
    this.comet = null
    this.sparks = []
    this.sparkFlash = null
    this.drawFrame()
  }

  destroy(): void {
    this.setRunning(false)
    this.stars = []
    this.sprites = []
    this.farTile = null
    this.planet = null
    this.moon = null
    this.galaxy = null
    this.nebula = null
  }

  private get dark(): boolean {
    return this.palette.additive
  }

  /** Size-independent sprites. */
  private buildSprites(): void {
    const pal = this.palette
    this.sprites = pal.stars.map((rgb) => makeStar(rgb, pal.additive))
    this.spikes = makeSpikes(pal.glint, pal.additive)
    this.flare = makeStar(pal.glint, pal.additive)
    this.eraser = makePuff('0, 0, 0')
    this.dustTail = makeTail(220, 26, 2, pal.bodies.comet, pal.additive ? 0.7 : 0.5)
    this.ionTail = makeTail(300, 6, 2, pal.bodies.ion, pal.additive ? 0.55 : 0.35)
  }

  private seedStars(): void {
    const w = this.width
    const h = this.height
    if (w <= 1 || h <= 1) return
    const rand = rng(this.variant === 'hero' ? 0xb17 : 0xc7a)
    const cap = this.lite ? MAX_STARS_LITE : MAX_STARS
    const count = Math.min(cap, Math.round(((w * h) / AREA_PER_STAR[this.variant]) * this.palette.density * (this.lite ? 0.75 : 1)))
    const shape = bandShape(this.variant, w, h, this.bulge)
    const unit = bandUnit(w, h)
    const cx = w / 2
    const cy = h / 2
    const maxDist = Math.hypot(cx, cy)
    const tints = this.palette.stars.length
    const stars: Star[] = []
    const push = (x: number, y: number, layer: number, boost: number): void => {
      const sizeBase = layer === 0 ? 0.45 : layer === 1 ? 0.75 : 1.1
      const size = (sizeBase + rand() * sizeBase * 0.7) * boost
      const tint = rand() < 0.6 ? 0 : Math.min(tints - 1, 1 + Math.floor(rand() * (tints - 1)))
      const alpha = Math.min(1, (layer === 0 ? 0.45 : layer === 1 ? 0.72 : 0.92) * (0.6 + rand() * 0.4) * boost)
      const dist = Math.hypot(x - cx, y - cy) / maxDist
      stars.push({ x, y, layer, size, tint, alpha, twinkle: 0.9 + rand() * 2.6, phase: rand() * Math.PI * 2, delay: 0.1 + dist * 0.8 + rand() * 0.2 })
    }
    for (let i = 0; i < count; i += 1) {
      let x: number
      let y: number
      // About a third of the stars crowd the band, so the galaxy reads as a denser river of light.
      if (rand() < 0.32) {
        const p = curvePoint(shape, rand(), w, h)
        const spread = gauss(rand) * unit * 0.08
        x = p.x + p.nx * spread
        y = p.y + p.ny * spread
      } else {
        x = rand() * w
        y = rand() * h
      }
      const roll = rand()
      push(x, y, roll < 0.6 ? 0 : roll < 0.9 ? 1 : 2, 1)
    }
    // Open star clusters: tight knots of mid-layer stars.
    const clusters = this.variant === 'cta' ? 1 : this.lite ? 1 : 3
    for (let k = 0; k < clusters; k += 1) {
      const kx = w * (0.08 + rand() * 0.84)
      const ky = h * (0.1 + rand() * 0.6)
      const n = 12 + Math.floor(rand() * 10)
      const spread = 9 + rand() * 9
      for (let i = 0; i < n; i += 1) push(kx + gauss(rand) * spread, ky + gauss(rand) * spread * 0.8, 1, 1.15)
    }
    this.stars = stars
    this.paintFarTile()
  }

  /** Far layer → one tile, scrolled per frame instead of hundreds of blits. */
  private paintFarTile(): void {
    const w = this.width
    const h = this.height
    this.farScale = Math.min(1.5, this.dpr)
    const { c, ctx } = canvas((w + WRAP * 2) * this.farScale, (h + WRAP * 2) * this.farScale)
    this.farTile = c
    if (ctx === null) return
    ctx.scale(this.farScale, this.farScale)
    ctx.translate(WRAP, WRAP)
    ctx.globalCompositeOperation = this.dark ? 'lighter' : 'source-over'
    const glow = this.dark ? 3.2 : 1.7
    for (const s of this.stars) {
      if (s.layer !== 0) continue
      const sprite = this.sprites[s.tint]
      if (sprite === undefined) continue
      const d = s.size * glow
      ctx.globalAlpha = s.alpha * this.palette.starAlpha * 0.85
      ctx.drawImage(sprite, s.x - d, s.y - d, d * 2, d * 2)
    }
  }

  /** Clearest spot for a box of half-size (hw, hh): text overlap costs most, cards less, then distance to a preference. */
  private findSpot(hw: number, hh: number, prefer: Placed, taken: CosmosRect[]): Placed {
    const w = this.width
    const h = this.height
    const text = this.layout.text
    const cards = this.layout.cards
    let best: Placed = prefer
    let bestScore = Number.POSITIVE_INFINITY
    const portrait = h > w * 1.2
    const cols = 18
    const rows = portrait ? 36 : 14
    const top = portrait ? 0.035 : 0.08
    const span = portrait ? 0.72 : 0.7
    for (let i = 0; i <= cols; i += 1) {
      for (let j = 0; j <= rows; j += 1) {
        const x = w * (0.04 + (i / cols) * 0.92)
        // Stay inside the band of the host the mask keeps fully visible.
        const y = h * (top + (j / rows) * span)
        const box: CosmosRect = { x: x - hw * 1.15, y: y - hh * 1.15, w: hw * 2.3, h: hh * 2.3 }
        let score = 0
        for (const r of text) score += overlap(box, r) * 12
        for (const r of cards) score += overlap(box, r) * 3
        for (const r of taken) score += overlap(box, r) * 6
        // Off-host parts are free but should not dominate.
        if (box.x < 0) score += -box.x * box.h * 2
        if (box.x + box.w > w) score += (box.x + box.w - w) * box.h * 2
        score += Math.hypot((x - prefer.x) / w, (y - prefer.y) / h) * hw * hh * 1.6
        if (score < bestScore) {
          bestScore = score
          best = { x, y }
        }
      }
    }
    return best
  }

  /** Size and place planet, nebula, galaxy and pulsing stars for this host size and layout. */
  private placeBodies(): void {
    const w = this.width
    const h = this.height
    if (w <= 1 || h <= 1) return
    const pal = this.palette.bodies
    const scale = this.dpr
    const portrait = h > w * 1.2
    const taken: CosmosRect[] = []
    this.planet = null
    this.moon = null
    this.galaxy = null
    this.nebula = null
    this.planetAt = null
    this.galaxyAt = null
    this.nebulaAt = null
    if (this.variant === 'hero') {
      const calm = this.calm
      const r = Math.round(calm ? Math.max(16, Math.min(42, Math.min(w, h) * 0.045)) : Math.max(18, Math.min(58, Math.min(w, h) * 0.065)))
      this.planetR = r
      const at = calm
        ? { x: w - r * (portrait ? 2.2 : 3.4), y: h * (portrait ? 0.14 : 0.22) }
        : this.findSpot(r * 2.8, r * 1.3, portrait ? { x: w * 0.86, y: h * 0.1 } : { x: w * 0.82, y: h * 0.82 }, taken)
      this.planetAt = at
      taken.push({ x: at.x - r * 2.9, y: at.y - r * 1.5, w: r * 5.8, h: r * 3 })
      this.planet = makePlanet(r, scale, pal, this.dark, 0x91a)
      this.moon = makeMoon(Math.max(4, r * 0.24), scale, pal, 0x3e0)
      // Nebula sits behind the planet, offset toward the open sky.
      this.nebulaW = Math.min(w * 0.42, r * 9)
      this.nebulaH = this.nebulaW * 0.6
      this.nebulaAt = { x: at.x - this.nebulaW * 0.22, y: at.y - this.nebulaH * 0.12 }
      this.nebula = makeNebula(this.nebulaW, this.nebulaH, Math.min(1, scale), pal, this.dark, this.lite ? 14 : 26, 0x4eb)
      if (!this.lite && !portrait) {
        const gr = Math.round(Math.max(40, Math.min(this.calm ? 64 : 84, w * 0.052)))
        this.galaxyR = gr
        const g = this.calm ? { x: gr * 1.6, y: h * 0.78 } : this.findSpot(gr, gr * 0.5, { x: w * 0.5, y: h * 0.12 }, taken)
        this.galaxyAt = g
        taken.push({ x: g.x - gr, y: g.y - gr * 0.5, w: gr * 2, h: gr })
        this.galaxy = makeGalaxy(gr, scale, pal, this.dark, 900, 0x6a1)
      }
    }
    // Pulsing stars with diffraction spikes, kept off the copy.
    const rand = rng(0x7a5 + (this.variant === 'hero' ? 0 : 1))
    const n = this.variant === 'cta' ? 2 : this.calm || this.lite ? 3 : 5
    const pulsars: Pulsar[] = []
    for (let i = 0; i < n; i += 1) {
      const at = this.findSpot(14, 14, { x: w * (0.08 + rand() * 0.84), y: h * (0.08 + rand() * 0.66) }, taken)
      taken.push({ x: at.x - 30, y: at.y - 30, w: 60, h: 60 })
      pulsars.push({ x: at.x, y: at.y, size: 18 + rand() * 16, rate: 0.9 + rand() * 1.1, phase: rand() * Math.PI * 2 })
    }
    this.pulsars = pulsars
  }

  private paintBand(): void {
    const canvasEl = this.bandCanvas
    const w = this.width
    const h = this.height
    if (w <= 1 || h <= 1) return
    const scale = Math.min(this.lite ? 1 : 1.5, window.devicePixelRatio || 1)
    const ow = w * BAND_OVERHANG
    const oh = h * BAND_OVERHANG
    canvasEl.width = Math.round((w + ow * 2) * scale)
    canvasEl.height = Math.round((h + oh * 2) * scale)
    const ctx = canvasEl.getContext('2d')
    if (ctx === null) return
    const pal = this.palette
    const shape = bandShape(this.variant, w, h, this.bulge)
    const unit = bandUnit(w, h)
    const strength = shape.strength * pal.cloudAlpha
    const rand = rng(this.variant === 'hero' ? 0x9a1 : 0x9a2)
    ctx.setTransform(scale, 0, 0, scale, ow * scale, oh * scale)
    ctx.clearRect(-ow, -oh, w + ow * 2, h + oh * 2)
    ctx.globalCompositeOperation = pal.additive ? 'lighter' : 'source-over'

    const profile = (t: number): number => {
      const d = (t - shape.bulge) / 0.3
      return 0.3 + 0.7 * Math.exp(-d * d)
    }
    // Clouds are scaled copies of one pre-drawn puff per colour: a gradient filled straight into a large rect
    // gets Skia's dither noise across the whole rect, and summed ('lighter') those rects show as faint blocks.
    const puffs = new Map<string, HTMLCanvasElement>()
    const blob = (x: number, y: number, r: number, rgb: string, a: number): void => {
      let puff = puffs.get(rgb)
      if (puff === undefined) {
        puff = makePuff(rgb)
        puffs.set(rgb, puff)
      }
      ctx.globalAlpha = Math.min(1, a)
      ctx.drawImage(puff, x - r, y - r, r * 2, r * 2)
      ctx.globalAlpha = 1
    }

    // Body of the band: overlapping soft clouds along the curve, thicker at the bulge.
    const steps = 90
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps + (rand() - 0.5) / steps
      const p = curvePoint(shape, t, w, h)
      const prof = profile(t)
      const off = gauss(rand) * unit * 0.05
      const r = unit * (0.11 + rand() * 0.13) * (0.55 + prof * 0.6)
      const rgb = pal.cloud[Math.floor(rand() * pal.cloud.length)] ?? pal.core
      blob(p.x + p.nx * off, p.y + p.ny * off, r, rgb, 0.1 * prof * strength)
    }

    // Bulge: an elongated glow along the band direction.
    const core = curvePoint(shape, shape.bulge, w, h)
    ctx.save()
    ctx.translate(core.x, core.y)
    ctx.rotate(core.angle)
    ctx.scale(2.6, 1)
    blob(0, 0, unit * 0.2, pal.core, 0.28 * strength)
    blob(0, 0, unit * 0.06, pal.core, 0.42 * strength)
    ctx.restore()

    // Dust: fine grains, densest at the bulge, scattered across the band width.
    const grains = Math.round(((w * unit) / 300) * shape.strength)
    ctx.fillStyle = `rgb(${pal.dust})`
    for (let i = 0; i < grains; i += 1) {
      const t = rand()
      const prof = profile(t)
      if (rand() > prof) continue
      const p = curvePoint(shape, t, w, h)
      const off = gauss(rand) * unit * 0.07 * (0.7 + prof * 0.5)
      const s = 0.35 + rand() * 0.8
      ctx.globalAlpha = (0.08 + rand() * 0.32) * strength
      ctx.fillRect(p.x + p.nx * off, p.y + p.ny * off, s, s)
    }
    ctx.globalAlpha = 1

    // Dark rift through the bright band (dark skies only): erase a ragged lane so it reads as a galaxy.
    if (pal.additive) {
      ctx.globalCompositeOperation = 'destination-out'
      for (let i = 0; i <= 240; i += 1) {
        const t = 0.18 + (i / 240) * 0.7
        const p = curvePoint(shape, t, w, h)
        const off = unit * 0.012 + Math.sin(t * 19) * unit * 0.008
        const r = unit * (0.016 + rand() * 0.026) * profile(t)
        blob(p.x + p.nx * off, p.y + p.ny * off, r, '0, 0, 0', 0.1)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
    dither(ctx, canvasEl.width, canvasEl.height, rand)
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return
    // Clamp the step so a resumed tab does not jump the sky forward.
    const dt = this.lastFrame === 0 ? 0 : Math.min(0.05, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.warp += (this.warpTarget - this.warp) * Math.min(1, dt * 9)
    if (Math.abs(this.warpTarget - this.warp) < 0.001) this.warp = this.warpTarget
    // Time runs faster while warping, so the drift and twinkle speed up with the zoom.
    this.clock += dt * (1 + this.warp * 5) * (this.calm ? 0.5 : 1)
    const ease = Math.min(1, dt * 3)
    this.pointerX += (this.pointerTargetX - this.pointerX) * ease
    this.pointerY += (this.pointerTargetY - this.pointerY) * ease
    this.updateEvents()
    this.drawFrame()
    this.frameId = requestAnimationFrame(this.tick)
  }

  /** Meteors, the comet and the headline sparkle: scheduled on the sky clock. */
  private updateEvents(): void {
    const now = this.clock
    const r = this.eventRand
    const w = this.width
    const h = this.height
    const pal = this.palette
    if (!pal.meteors) {
      this.meteor = null
      this.comet = null
      return
    }
    const hero = this.variant === 'hero' && !this.calm
    const gap = (pal.additive ? 1 : 1.8) * (this.calm ? 2.5 : 1)
    if (this.nextMeteorAt === 0) {
      this.nextMeteorAt = (hero ? 2.5 : 4) + r() * 3
      this.nextCometAt = 5 + r() * 4
      this.nextSparkAt = ENTRANCE_SECONDS + 1.2
    }
    if (this.meteor !== null && now - this.meteor.born > this.meteor.life) {
      this.meteor = null
      this.nextMeteorAt = now + (hero ? 3.5 + r() * 5 : 7 + r() * 8) * gap
    }
    if (this.meteor === null && now >= this.nextMeteorAt) {
      const angle = Math.PI * (0.8 + r() * 0.12)
      const speed = 640 + r() * 320
      this.meteor = {
        x: w * (0.35 + r() * 0.65),
        y: h * (0.02 + r() * 0.4),
        dx: Math.cos(angle) * speed,
        // Screen space: cos < 0 and sin > 0, so it travels down-left.
        dy: Math.sin(angle) * speed,
        born: now,
        life: 0.7 + r() * 0.5,
        length: 130 + r() * 110,
      }
    }
    if (!hero && !this.calm) return
    if (this.comet !== null && now - this.comet.born > this.comet.life) {
      this.comet = null
      this.nextCometAt = now + (this.calm ? 24 + r() * 16 : 12 + r() * 10)
    }
    if (this.comet === null && now >= this.nextCometAt) {
      // Glides from beyond the right edge across the upper sky, slowly enough to follow.
      const life = 9 + r() * 4
      const x0 = w + 60
      const y0 = h * (0.04 + r() * 0.22)
      const x1 = -260
      const y1 = y0 + h * (0.12 + r() * 0.22)
      this.comet = { x: x0, y: y0, dx: (x1 - x0) / life, dy: (y1 - y0) / life, born: now, life }
    }
    if (!hero) return
    // Sparkle burst at the headline.
    this.sparks = this.sparks.filter((s) => now - s.born < s.life)
    if (this.sparkFlash !== null && now - this.sparkFlash.born > 0.9) this.sparkFlash = null
    const head = this.layout.headline
    if (head !== null && now >= this.nextSparkAt) {
      this.nextSparkAt = now + 5 + r() * 5
      // A random point along the headline's top or right edge.
      const onTop = r() < 0.6
      const x = onTop ? head.x + head.w * (0.15 + r() * 0.8) : head.x + head.w
      const y = onTop ? head.y + head.h * 0.08 : head.y + head.h * (0.2 + r() * 0.6)
      this.sparkFlash = { x, y, born: now }
      const n = this.lite ? 8 : 14
      for (let i = 0; i < n; i += 1) {
        const a = r() * Math.PI * 2
        const v = 30 + r() * 90
        this.sparks.push({ x, y, dx: Math.cos(a) * v, dy: Math.sin(a) * v - 12, born: now, life: 0.8 + r() * 0.7, size: 0.8 + r() * 1.3 })
      }
    }
  }

  private drawFrame(): void {
    const ctx = this.ctx
    if (ctx === null || this.width <= 1) return
    const w = this.width
    const h = this.height
    const dpr = this.dpr
    const t = this.clock
    const pal = this.palette
    const dark = pal.additive
    const add: GlobalCompositeOperation = dark ? 'lighter' : 'source-over'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = add

    const cx = w / 2
    const cy = h / 2
    const entering = !this.entranceDone && t < ENTRANCE_SECONDS + 1.4
    if (!entering) this.entranceDone = true
    const glow = dark ? 3.2 : 1.7
    const wrapW = w + WRAP * 2
    const wrapH = h + WRAP * 2
    const warp = this.warp
    // Warp zooms about the band's bulge area (same origin as the band's CSS transform).
    const fx = w * 0.62
    const fy = h * 0.38
    const px = this.pointerX
    const py = this.pointerY
    const intro = entering ? easeOutCubic(clamp01((t - 0.15) / 1.8)) : 1

    // Far layer: one tile, scrolled with wrap-around (up to four blits at the corners of the wrap).
    const far = this.farTile
    if (far !== null) {
      const ox = wrap(LAYER_DRIFT[0] * t + px * LAYER_PARALLAX[0], wrapW) + WRAP
      const oy = wrap(LAYER_RISE[0] * t + py * LAYER_PARALLAX[0] * 0.6, wrapH) + WRAP
      ctx.save()
      const zoom = (entering ? 0.8 + 0.2 * intro : 1) * (1 + warp * WARP_ZOOM[0])
      const ox0 = entering ? cx : fx
      const oy0 = entering ? cy : fy
      ctx.translate(ox0, oy0)
      ctx.scale(zoom, zoom)
      ctx.translate(-ox0, -oy0)
      ctx.globalAlpha = intro
      for (const dx of [ox - wrapW, ox]) {
        for (const dy of [oy - wrapH, oy]) {
          if (dx - WRAP > w || dx - WRAP + wrapW < 0 || dy - WRAP > h || dy - WRAP + wrapH < 0) continue
          ctx.drawImage(far, dx - WRAP, dy - WRAP, wrapW, wrapH)
        }
      }
      ctx.restore()
    }

    // Nebula: slow breathing and drift.
    if (this.nebula !== null && this.nebulaAt !== null) {
      const breath = 0.82 + 0.18 * Math.sin(t * 0.35)
      const nx = this.nebulaAt.x + Math.sin(t * 0.06) * 18 + px * LAYER_PARALLAX[0]
      const ny = this.nebulaAt.y + Math.cos(t * 0.05) * 8 + py * LAYER_PARALLAX[0] * 0.6
      ctx.globalAlpha = breath * pal.bodies.alpha * intro
      ctx.drawImage(this.nebula, nx - this.nebulaW / 2, ny - this.nebulaH / 2, this.nebulaW, this.nebulaH)
    }

    // Spiral galaxy: inclined disc, visibly turning.
    if (this.galaxy !== null && this.galaxyAt !== null) {
      const gr = this.galaxyR
      ctx.save()
      ctx.globalAlpha = pal.bodies.alpha * intro
      ctx.translate(this.galaxyAt.x + px * LAYER_PARALLAX[1] * 0.6, this.galaxyAt.y + py * LAYER_PARALLAX[1] * 0.36)
      ctx.rotate(-0.42)
      ctx.scale(1, 0.42)
      ctx.rotate((t / GALAXY_TURN) * Math.PI * 2)
      ctx.drawImage(this.galaxy, -gr, -gr, gr * 2, gr * 2)
      ctx.restore()
    }

    // Mid and near layers: individual sprites with a strong twinkle; warp streaks batched per layer.
    const streaks: Path2D[] | null = warp > 0.03 ? [new Path2D(), new Path2D(), new Path2D()] : null
    for (const s of this.stars) {
      if (s.layer === 0) continue
      let x = wrap(s.x + LAYER_DRIFT[s.layer] * t, wrapW)
      let y = wrap(s.y + LAYER_RISE[s.layer] * t, wrapH)
      let a = s.alpha * pal.starAlpha
      if (entering) {
        const e = easeOutCubic(clamp01((t - s.delay) / 1.3))
        if (e <= 0) continue
        x = cx + (x - cx) * (0.75 + 0.25 * e)
        y = cy + (y - cy) * (0.75 + 0.25 * e)
        a *= e
      }
      x += px * LAYER_PARALLAX[s.layer]
      y += py * LAYER_PARALLAX[s.layer] * 0.6
      const tw = Math.sin(t * s.twinkle + s.phase)
      a *= 0.4 + 0.6 * (0.5 + 0.5 * tw)
      if (warp > 0.002) {
        const zoom = 1 + warp * WARP_ZOOM[s.layer]
        const tail = 1 + warp * WARP_ZOOM[s.layer] * 0.45
        const sx = x
        const sy = y
        x = fx + (sx - fx) * zoom
        y = fy + (sy - fy) * zoom
        a = Math.min(1, a * (1 + warp * 0.6))
        streaks?.[s.layer]?.moveTo(x, y)
        streaks?.[s.layer]?.lineTo(fx + (sx - fx) * tail, fy + (sy - fy) * tail)
      }
      if (a <= 0.01) continue
      const d = s.size * glow * (0.85 + 0.25 * tw)
      const sprite = this.sprites[s.tint]
      if (sprite === undefined) continue
      ctx.globalAlpha = a
      ctx.drawImage(sprite, x - d, y - d, d * 2, d * 2)
    }

    if (streaks !== null) {
      ctx.lineCap = 'round'
      ctx.strokeStyle = `rgb(${pal.stars[0] ?? pal.glint})`
      for (let layer = 1; layer < streaks.length; layer += 1) {
        const path = streaks[layer]
        if (path === undefined) continue
        ctx.globalAlpha = Math.min(1, warp * 1.6) * pal.starAlpha * (0.25 + layer * 0.25)
        ctx.lineWidth = 0.6 + layer * 0.5
        ctx.stroke(path)
      }
    }

    // Pulsing bright stars with diffraction spikes.
    if (this.spikes !== null) {
      for (const p of this.pulsars) {
        const beat = Math.sin(t * p.rate + p.phase) // float-ok: animation pulse, display-only
        const k = 0.7 + 0.3 * beat
        const size = p.size * k
        ctx.globalAlpha = (dark ? 0.55 + 0.45 * beat : 0.3 + 0.2 * beat) * intro
        const x = p.x + px * LAYER_PARALLAX[2] * 0.5
        const y = p.y + py * LAYER_PARALLAX[2] * 0.3
        ctx.drawImage(this.spikes, x - size, y - size, size * 2, size * 2)
      }
    }

    this.drawPlanet(ctx, t, intro)
    this.drawComet(ctx, t)
    ctx.globalCompositeOperation = add
    this.drawMeteor(ctx, t)
    this.drawSparks(ctx, t)

    // Keep the copy readable: thin the sky right behind the headline and lead.
    if (this.eraser !== null && this.variant === 'hero') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.globalAlpha = dark ? 0.55 : 0.75
      for (const r of this.layout.text.slice(0, 2)) {
        ctx.drawImage(this.eraser, r.x - r.w * 0.12, r.y - r.h * 0.5, r.w * 1.24, r.h * 2)
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawPlanet(ctx: CanvasRenderingContext2D, t: number, intro: number): void {
    const planet = this.planet
    const at = this.planetAt
    if (planet === null || at === null) return
    const r = this.planetR
    const pal = this.palette
    ctx.globalCompositeOperation = 'source-over'
    // Slow float plus a mid-layer parallax.
    const x = at.x + Math.sin(t * 0.11) * r * 0.35 + this.pointerX * LAYER_PARALLAX[1] * 0.8
    const y = at.y + Math.sin(t * 0.17 + 1) * r * 0.18 + this.pointerY * LAYER_PARALLAX[1] * 0.5
    const half = PLANET_EXTENT * r
    // Moon on an orbit in the ring plane: behind the planet on the far half, in front on the near half.
    const phi = (t / MOON_ORBIT) * Math.PI * 2 + 0.6
    const ox = Math.cos(phi) * r * 2.75
    const oy = Math.sin(phi) * r * 2.75 * RING_FLAT * 1.6
    const mx = x + ox * Math.cos(RING_TILT) - oy * Math.sin(RING_TILT)
    const my = y + ox * Math.sin(RING_TILT) + oy * Math.cos(RING_TILT)
    const behind = Math.sin(phi) < 0
    const mr = Math.max(4, r * 0.24) * (behind ? 0.9 : 1.06)
    const alpha = pal.bodies.alpha * intro * (this.calm ? 0.8 : 1)
    const drawMoon = (): void => {
      if (this.moon === null) return
      ctx.globalAlpha = alpha * (behind ? 0.85 : 1)
      ctx.drawImage(this.moon, mx - mr, my - mr, mr * 2, mr * 2)
    }
    if (behind) drawMoon()
    ctx.globalAlpha = alpha
    ctx.drawImage(planet, x - half, y - half, half * 2, half * 2)
    if (!behind) drawMoon()
  }

  private drawComet(ctx: CanvasRenderingContext2D, t: number): void {
    const c = this.comet
    if (c === null || this.dustTail === null || this.ionTail === null) return
    const age = t - c.born
    const k = age / c.life
    const fade = Math.min(1, Math.sin(Math.PI * clamp01(k)) * 2.2)
    const x = c.x + c.dx * age + this.pointerX * LAYER_PARALLAX[1]
    const y = c.y + c.dy * age + this.pointerY * LAYER_PARALLAX[1] * 0.6
    const heading = Math.atan2(c.dy, c.dx)
    const pal = this.palette
    const alpha = fade * pal.bodies.alpha * pal.meteorAlpha
    ctx.globalCompositeOperation = pal.additive ? 'lighter' : 'source-over'
    // Tails point away from the direction of travel; the dust tail curves a little (drawn slightly off-axis).
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(heading)
    ctx.globalAlpha = alpha * 0.9
    ctx.drawImage(this.ionTail, -300, -3, 300, 6)
    ctx.rotate(0.06)
    ctx.globalAlpha = alpha
    ctx.drawImage(this.dustTail, -220, -13, 220, 26)
    ctx.restore()
    const sprite = this.flare
    if (sprite !== null) {
      ctx.globalAlpha = alpha
      ctx.drawImage(sprite, x - 9, y - 9, 18, 18)
      ctx.drawImage(sprite, x - 4, y - 4, 8, 8)
    }
  }

  private drawMeteor(ctx: CanvasRenderingContext2D, t: number): void {
    const m = this.meteor
    if (m === null) return
    const pal = this.palette
    const age = t - m.born
    const k = age / m.life
    const fade = Math.sin(Math.PI * clamp01(k)) * pal.meteorAlpha
    const hx = m.x + m.dx * age
    const hy = m.y + m.dy * age
    const len = Math.hypot(m.dx, m.dy) || 1
    const tx = hx - (m.dx / len) * m.length
    const ty = hy - (m.dy / len) * m.length
    const g = ctx.createLinearGradient(hx, hy, tx, ty)
    g.addColorStop(0, pal.additive ? `rgba(255, 255, 255, ${0.9 * fade})` : `rgba(${pal.glint}, ${0.8 * fade})`)
    g.addColorStop(0.2, `rgba(${pal.glint}, ${0.45 * fade})`)
    g.addColorStop(1, `rgba(${pal.glint}, 0)`)
    ctx.globalAlpha = 1
    ctx.strokeStyle = g
    ctx.lineWidth = 1.3
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(hx, hy)
    ctx.lineTo(tx, ty)
    ctx.stroke()
  }

  private drawSparks(ctx: CanvasRenderingContext2D, t: number): void {
    const flare = this.flare
    if (flare === null) return
    const pal = this.palette
    const level = pal.additive ? 1 : 0.6
    const f = this.sparkFlash
    if (f !== null && this.spikes !== null) {
      const k = clamp01((t - f.born) / 0.9)
      const size = 10 + 26 * Math.sin(Math.PI * Math.min(1, k * 1.4))
      ctx.globalAlpha = (1 - k) * level
      ctx.drawImage(this.spikes, f.x - size, f.y - size, size * 2, size * 2)
    }
    for (const s of this.sparks) {
      const age = t - s.born
      const k = age / s.life
      const x = s.x + s.dx * age
      const y = s.y + s.dy * age + 14 * age * age
      const d = s.size * 2.6 * (1 - k * 0.5)
      ctx.globalAlpha = (1 - k) * level
      ctx.drawImage(flare, x - d, y - d, d * 2, d * 2)
    }
  }
}
