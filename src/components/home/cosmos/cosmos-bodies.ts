import type { BodyPalette } from './cosmos-palettes'

/**
 * Pre-rendered sprites for the cosmos layer (owner 10-22: 多些天体种类). Every body is painted once per size /
 * palette into an offscreen canvas; the engine only blits and transforms them per frame.
 * float-ok: the whole file is canvas geometry for decoration (money-precision rule, display-only).
 */

export type Sprite = HTMLCanvasElement

export function canvas(width: number, height: number): { c: Sprite; ctx: CanvasRenderingContext2D | null } {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(width))
  c.height = Math.max(1, Math.ceil(height))
  return { c, ctx: c.getContext('2d') }
}

/** Small seeded PRNG (mulberry32) so a resize regenerates the same sky. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gauss(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) / 0.75
}

/** Round star sprite: a white-hot centre in a tinted halo (dark skies) or a plain soft dot (light skies). */
export function makeStar(rgb: string, soft: boolean): Sprite {
  const { c, ctx } = canvas(64, 64)
  if (ctx === null) return c
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  if (soft) {
    g.addColorStop(0, 'rgba(255, 255, 255, 1)')
    g.addColorStop(0.12, `rgba(${rgb}, 0.95)`)
    g.addColorStop(0.32, `rgba(${rgb}, 0.32)`)
    g.addColorStop(0.62, `rgba(${rgb}, 0.06)`)
    g.addColorStop(1, `rgba(${rgb}, 0)`)
  } else {
    g.addColorStop(0, `rgba(${rgb}, 1)`)
    g.addColorStop(0.42, `rgba(${rgb}, 0.85)`)
    g.addColorStop(1, `rgba(${rgb}, 0)`)
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return c
}

/** A soft round puff with a Gaussian fall-off (no visible rim), clipped to its circle so the corners stay empty. */
export function makePuff(rgb: string): Sprite {
  const { c, ctx } = canvas(128, 128)
  if (ctx === null) return c
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  for (let k = 0; k <= 12; k += 1) {
    const r = k / 12
    g.addColorStop(r, `rgba(${rgb}, ${(Math.exp(-4 * r * r) - Math.exp(-4)) / (1 - Math.exp(-4))})`)
  }
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(64, 64, 63, 0, Math.PI * 2)
  ctx.fill()
  return c
}

/**
 * Bright star with diffraction spikes: four long rays, four short diagonal ones and a hot halo. `soft` adds
 * the white core used on dark skies.
 */
export function makeSpikes(rgb: string, soft: boolean): Sprite {
  const size = 128
  const mid = size / 2
  const { c, ctx } = canvas(size, size)
  if (ctx === null) return c
  ctx.globalCompositeOperation = soft ? 'lighter' : 'source-over'
  const ray = (angle: number, length: number, width: number, alpha: number): void => {
    ctx.save()
    ctx.translate(mid, mid)
    ctx.rotate(angle)
    const g = ctx.createLinearGradient(-length, 0, length, 0)
    g.addColorStop(0, `rgba(${rgb}, 0)`)
    g.addColorStop(0.5, `rgba(${rgb}, ${alpha})`)
    g.addColorStop(1, `rgba(${rgb}, 0)`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(-length, 0)
    ctx.lineTo(0, -width)
    ctx.lineTo(length, 0)
    ctx.lineTo(0, width)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  ray(0, mid, 1.5, 0.95)
  ray(Math.PI / 2, mid, 1.5, 0.95)
  ray(Math.PI / 4, mid * 0.42, 1, 0.5)
  ray(-Math.PI / 4, mid * 0.42, 1, 0.5)
  const halo = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid * 0.36)
  halo.addColorStop(0, soft ? 'rgba(255, 255, 255, 1)' : `rgba(${rgb}, 0.9)`)
  halo.addColorStop(0.18, `rgba(${rgb}, 0.6)`)
  halo.addColorStop(0.5, `rgba(${rgb}, 0.12)`)
  halo.addColorStop(1, `rgba(${rgb}, 0)`)
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, size, size)
  return c
}

/** Light direction for planet and moon: from the upper left. */
const LIGHT_X = -0.62
const LIGHT_Y = -0.56

/** Paints a lit sphere of radius `r` at (cx, cy): limb-darkened body plus a soft terminator on the night side. */
function sphere(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, light: string, base: string, deep: string, night: string, nightAlpha: number, extra?: () => void): void {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.clip()
  const body = ctx.createRadialGradient(cx + LIGHT_X * r * 0.55, cy + LIGHT_Y * r * 0.55, r * 0.05, cx, cy, r * 1.05)
  body.addColorStop(0, `rgb(${light})`)
  body.addColorStop(0.45, `rgb(${base})`)
  body.addColorStop(1, `rgb(${deep})`)
  ctx.fillStyle = body
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  extra?.()
  // Terminator: a linear ramp from the lit limb to the far limb, soft in the middle.
  const term = ctx.createLinearGradient(cx + LIGHT_X * r, cy + LIGHT_Y * r, cx - LIGHT_X * r, cy - LIGHT_Y * r)
  term.addColorStop(0, `rgba(${night}, 0)`)
  term.addColorStop(0.48, `rgba(${night}, 0)`)
  term.addColorStop(0.7, `rgba(${night}, ${nightAlpha * 0.7})`)
  term.addColorStop(1, `rgba(${night}, ${nightAlpha})`)
  ctx.fillStyle = term
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  ctx.restore()
}

/** Ring tilt of the planet (radians); the moon orbits in the same plane. */
export const RING_TILT = -0.36
/** Ring flattening (minor / major axis). */
export const RING_FLAT = 0.27
/** Sprite half-size in units of the planet radius. */
export const PLANET_EXTENT = 2.35

/**
 * Ringed gas giant: back half of the ring, banded lit sphere, front half of the ring. Returns a square sprite
 * of side `2 · PLANET_EXTENT · r · scale`, planet centred.
 */
export function makePlanet(r: number, scale: number, pal: BodyPalette, dark: boolean, seed: number): Sprite {
  const half = PLANET_EXTENT * r
  const { c, ctx } = canvas(half * 2 * scale, half * 2 * scale)
  if (ctx === null) return c
  ctx.scale(scale, scale)
  const rand = rng(seed)
  const ringRadii: Array<[number, number, number]> = []
  // Ring: concentric strokes with a darker gap (Cassini-like division) two thirds of the way out.
  for (let k = 0; k < 26; k += 1) {
    const f = k / 25
    const radius = r * (1.42 + f * 0.82)
    const gap = Math.abs(f - 0.62) < 0.06 ? 0.15 : 1
    const alpha = (0.18 + 0.38 * Math.sin(Math.PI * Math.min(1, f * 1.1)) + rand() * 0.12) * gap
    ringRadii.push([radius, alpha, r * 0.034])
  }
  const ring = (front: boolean): void => {
    ctx.save()
    ctx.translate(half, half)
    ctx.rotate(RING_TILT)
    ctx.beginPath()
    // Back half is the upper half of the tilted ellipse, front half the lower.
    if (front) ctx.rect(-half * 1.5, 0, half * 3, half * 1.5)
    else ctx.rect(-half * 1.5, -half * 1.5, half * 3, half * 1.5)
    ctx.clip()
    for (const [radius, alpha, width] of ringRadii) {
      ctx.strokeStyle = `rgba(${pal.ring}, ${Math.min(1, alpha * (front ? 1 : 0.8))})`
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.ellipse(0, 0, radius, radius * RING_FLAT, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }
  ring(false)
  // Atmosphere glow on dark skies.
  if (dark) {
    const glow = ctx.createRadialGradient(half, half, r * 0.9, half, half, r * 1.32)
    glow.addColorStop(0, `rgba(${pal.planetLight}, 0.28)`)
    glow.addColorStop(1, `rgba(${pal.planetLight}, 0)`)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(half, half, r * 1.32, 0, Math.PI * 2)
    ctx.fill()
  }
  sphere(ctx, half, half, r, pal.planetLight, pal.planetBase, pal.planetDeep, pal.night, pal.nightAlpha, () => {
    // Cloud bands parallel to the ring plane.
    ctx.save()
    ctx.translate(half, half)
    ctx.rotate(RING_TILT)
    for (let k = 0; k < 9; k += 1) {
      const y = -r + (k + 0.5) * ((r * 2) / 9) + (rand() - 0.5) * r * 0.08
      const hgt = r * (0.06 + rand() * 0.14)
      ctx.fillStyle = `rgba(${k % 2 === 0 ? pal.planetBand : pal.planetDeep}, ${0.12 + rand() * 0.2})`
      ctx.beginPath()
      ctx.ellipse(0, y, r * 1.2, hgt, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  })
  // Shadow of the planet on the back ring is hidden by the body; its shadow on the front ring is a dark notch.
  ring(true)
  ctx.save()
  ctx.translate(half, half)
  ctx.rotate(RING_TILT)
  ctx.beginPath()
  ctx.rect(-half * 1.5, 0, half * 3, half * 1.5)
  ctx.clip()
  ctx.rotate(-RING_TILT)
  const shade = ctx.createRadialGradient(-LIGHT_X * r * 1.4, -LIGHT_Y * r * 0.7, 0, -LIGHT_X * r * 1.4, -LIGHT_Y * r * 0.7, r * 0.75)
  shade.addColorStop(0, `rgba(${pal.night}, ${pal.nightAlpha * 0.75})`)
  shade.addColorStop(1, `rgba(${pal.night}, 0)`)
  ctx.globalCompositeOperation = 'source-atop'
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, r * 2.4, r * 2)
  ctx.restore()
  return c
}

/** Small cratered moon, square sprite of side `2 · r · scale`. */
export function makeMoon(r: number, scale: number, pal: BodyPalette, seed: number): Sprite {
  const { c, ctx } = canvas(r * 2 * scale, r * 2 * scale)
  if (ctx === null) return c
  ctx.scale(scale, scale)
  const rand = rng(seed)
  sphere(ctx, r, r, r, '255, 255, 255', pal.moon, pal.moon, pal.night, pal.nightAlpha, () => {
    for (let k = 0; k < 7; k += 1) {
      const a = rand() * Math.PI * 2
      const d = rand() * r * 0.75
      const cr = r * (0.08 + rand() * 0.2)
      ctx.fillStyle = `rgba(${pal.night}, ${0.1 + rand() * 0.12})`
      ctx.beginPath()
      ctx.arc(r + Math.cos(a) * d, r + Math.sin(a) * d, cr, 0, Math.PI * 2)
      ctx.fill()
    }
  })
  return c
}

/**
 * Face-on two-armed spiral galaxy (the engine squashes and rotates it per frame). Square sprite of side
 * `2 · radius · scale`.
 */
export function makeGalaxy(radius: number, scale: number, pal: BodyPalette, dark: boolean, dots: number, seed: number): Sprite {
  const { c, ctx } = canvas(radius * 2 * scale, radius * 2 * scale)
  if (ctx === null) return c
  ctx.scale(scale, scale)
  ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over'
  const rand = rng(seed)
  const disc = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius)
  disc.addColorStop(0, `rgba(${pal.armsCore}, ${dark ? 0.55 : 0.3})`)
  disc.addColorStop(0.12, `rgba(${pal.arms}, ${dark ? 0.22 : 0.12})`)
  disc.addColorStop(0.5, `rgba(${pal.arms}, ${dark ? 0.06 : 0.04})`)
  disc.addColorStop(1, `rgba(${pal.arms}, 0)`)
  ctx.fillStyle = disc
  ctx.fillRect(0, 0, radius * 2, radius * 2)
  for (let i = 0; i < dots; i += 1) {
    const arm = i % 2
    const t = Math.pow(rand(), 0.8)
    const theta = t * Math.PI * 2.4 + arm * Math.PI + gauss(rand) * 0.22
    const dist = radius * (0.06 + t * 0.86) + gauss(rand) * radius * 0.035 * (0.5 + t)
    const x = radius + Math.cos(theta) * dist
    const y = radius + Math.sin(theta) * dist
    const s = 0.5 + rand() * (1.1 - t * 0.5)
    ctx.fillStyle = `rgba(${rand() < 0.2 ? pal.armsCore : pal.arms}, ${(dark ? 0.55 : 0.4) * (1 - t * 0.6)})`
    ctx.fillRect(x - s / 2, y - s / 2, s, s)
  }
  const core = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius * 0.16)
  core.addColorStop(0, dark ? 'rgba(255, 255, 255, 0.95)' : `rgba(${pal.armsCore}, 0.6)`)
  core.addColorStop(0.4, `rgba(${pal.armsCore}, ${dark ? 0.5 : 0.25})`)
  core.addColorStop(1, `rgba(${pal.armsCore}, 0)`)
  ctx.fillStyle = core
  ctx.fillRect(0, 0, radius * 2, radius * 2)
  return c
}

/** Nebula cloud: overlapping puffs of several colours plus a few embedded stars; sprite `w × h` at `scale`. */
export function makeNebula(w: number, h: number, scale: number, pal: BodyPalette, dark: boolean, puffs: number, seed: number): Sprite {
  const { c, ctx } = canvas(w * scale, h * scale)
  if (ctx === null) return c
  ctx.scale(scale, scale)
  ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over'
  const rand = rng(seed)
  const cache = new Map<string, Sprite>()
  for (let i = 0; i < puffs; i += 1) {
    const rgb = pal.nebula[i % pal.nebula.length] ?? pal.arms
    let puff = cache.get(rgb)
    if (puff === undefined) {
      puff = makePuff(rgb)
      cache.set(rgb, puff)
    }
    // Filaments: puffs follow a loose S-curve across the box.
    const t = rand()
    const x = w * (0.12 + t * 0.76) + gauss(rand) * w * 0.06
    const y = h * (0.5 + Math.sin(t * Math.PI * 1.6) * 0.18) + gauss(rand) * h * 0.1
    const r = Math.min(w, h) * (0.14 + rand() * 0.26)
    ctx.globalAlpha = (dark ? 0.11 : 0.16) * (0.5 + rand() * 0.6)
    ctx.drawImage(puff, x - r, y - r, r * 2, r * 2)
  }
  ctx.globalAlpha = 1
  dither(ctx, c.width, c.height, rand)
  return c
}

/** Comet tail: a tapered gradient wedge pointing left from the head at the right edge; sprite `len × width`. */
export function makeTail(len: number, width: number, scale: number, rgb: string, alpha: number): Sprite {
  const { c, ctx } = canvas(len * scale, width * scale)
  if (ctx === null) return c
  ctx.scale(scale, scale)
  const g = ctx.createLinearGradient(len, 0, 0, 0)
  g.addColorStop(0, `rgba(${rgb}, ${alpha})`)
  g.addColorStop(0.25, `rgba(${rgb}, ${alpha * 0.45})`)
  g.addColorStop(1, `rgba(${rgb}, 0)`)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(len, width / 2 - width * 0.08)
  ctx.quadraticCurveTo(len * 0.4, 0, 0, width * 0.2)
  ctx.lineTo(0, width * 0.8)
  ctx.quadraticCurveTo(len * 0.4, width, len, width / 2 + width * 0.08)
  ctx.closePath()
  ctx.fill()
  return c
}

/**
 * Faint gradients over many pixels quantise into visible rings; one pass of ±1 noise on every channel
 * (once per paint, never per frame) hides the banding.
 */
export function dither(ctx: CanvasRenderingContext2D, pw: number, ph: number, rand: () => number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const image = ctx.getImageData(0, 0, pw, ph)
  const px = image.data
  let seed = (Math.floor(rand() * 0xfffffffe) + 1) >>> 0
  for (let i = 0; i < px.length; i += 4) {
    // Nearly transparent pixels are left alone: a ±1 step there is a large relative jump.
    if (px[i + 3] < 12) continue
    // xorshift32: uncorrelated from pixel to pixel, so the noise cannot line up into stripes.
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    const n = (seed % 3) - 1
    px[i] += n
    px[i + 1] += n
    px[i + 2] += n
  }
  ctx.putImageData(image, 0, 0)
}
