import type { SkinId } from '@/core/skin'
import type { Theme } from '@/core/theme'

/**
 * Colour sets for the home "cosmos" layer, one per skin × theme. Every colour is an `r, g, b` triplet so the
 * engine can build rgba() stops at any alpha. Light themes keep the page white and draw a pale wash with
 * ink-coloured dust, so headline / input / card contrast is untouched (text tokens are unchanged).
 */
export interface CosmosPalette {
  /** Star sprite tints, picked per star (first entries are the common ones). */
  stars: readonly string[]
  /** Rare bright stars that get a four-point glint. */
  glint: string
  /** Soft cloud colours of the galaxy band, outer → inner. */
  cloud: readonly string[]
  /** Band core (bulge) colour. */
  core: string
  /** Fine dust sprinkled along the band. */
  dust: string
  /** Peak alpha multiplier for the band and clouds. */
  cloudAlpha: number
  /** Star alpha multiplier. */
  starAlpha: number
  /** Star density multiplier. */
  density: number
  /** Meteors, glints and comets (light skies draw them faintly via `meteorAlpha`). */
  meteors: boolean
  /** Draw stars additively (dark sky) or plainly (light sky). */
  additive: boolean
  /** Peak alpha of meteors (light skies draw them as faint ink strokes). */
  meteorAlpha: number
  /** Celestial bodies (planet, moon, spiral galaxy, nebula, comet, pulsing stars). */
  bodies: BodyPalette
}

/** Colours of the procedurally drawn bodies, `r, g, b` triplets like the rest. */
export interface BodyPalette {
  /** Overall alpha of planet / moon / galaxy / nebula / comet. */
  alpha: number
  /** Planet: lit highlight, mid tone, limb tone, cloud bands, ring, night side. */
  planetLight: string
  planetBase: string
  planetDeep: string
  planetBand: string
  ring: string
  night: string
  /** Night-side opacity of the terminator (opaque on dark skies, a soft shade on light ones). */
  nightAlpha: number
  moon: string
  /** Spiral galaxy arms and core. */
  arms: string
  armsCore: string
  /** Nebula colours, mixed per puff. */
  nebula: readonly string[]
  /** Comet dust tail and the thinner ion tail. */
  comet: string
  ion: string
}

const BINANCE_DARK: CosmosPalette = {
  stars: ['234, 240, 255', '200, 214, 255', '170, 190, 255', '255, 236, 210'],
  glint: '214, 226, 255',
  cloud: ['32, 40, 120', '46, 72, 190', '76, 116, 255', '120, 92, 255'],
  core: '186, 206, 255',
  dust: '205, 220, 255',
  cloudAlpha: 1,
  starAlpha: 1,
  density: 1,
  meteors: true,
  additive: true,
  meteorAlpha: 1,
  bodies: {
    alpha: 1,
    planetLight: '176, 204, 255',
    planetBase: '64, 92, 214',
    planetDeep: '24, 30, 96',
    planetBand: '120, 150, 255',
    ring: '132, 222, 255',
    night: '5, 7, 22',
    nightAlpha: 0.94,
    moon: '214, 222, 240',
    arms: '128, 168, 255',
    armsCore: '226, 234, 255',
    nebula: ['86, 64, 230', '42, 132, 255', '0, 196, 232', '150, 92, 255'],
    comet: '206, 228, 255',
    ion: '96, 214, 255',
  },
}

const BINANCE_LIGHT: CosmosPalette = {
  stars: ['70, 86, 140', '46, 91, 255', '96, 108, 150'],
  glint: '46, 91, 255',
  cloud: ['200, 214, 255', '176, 196, 255', '196, 188, 255', '170, 194, 255'],
  core: '214, 226, 255',
  dust: '110, 132, 210',
  cloudAlpha: 1,
  starAlpha: 0.5,
  density: 0.55,
  meteors: true,
  additive: false,
  meteorAlpha: 0.42,
  bodies: {
    alpha: 0.62,
    planetLight: '240, 245, 255',
    planetBase: '168, 190, 255',
    planetDeep: '112, 136, 222',
    planetBand: '130, 156, 240',
    ring: '46, 91, 255',
    night: '96, 110, 170',
    nightAlpha: 0.38,
    moon: '176, 186, 214',
    arms: '78, 112, 230',
    armsCore: '46, 91, 255',
    nebula: ['196, 186, 255', '176, 206, 255', '170, 228, 246', '206, 192, 255'],
    comet: '46, 91, 255',
    ion: '0, 150, 210',
  },
}

const OKX_DARK: CosmosPalette = {
  stars: ['247, 236, 214', '255, 250, 240', '217, 179, 108', '236, 214, 170'],
  glint: '243, 221, 168',
  cloud: ['70, 48, 18', '122, 88, 38', '217, 179, 108', '170, 130, 70'],
  core: '243, 221, 168',
  dust: '231, 197, 132',
  cloudAlpha: 0.62,
  starAlpha: 0.95,
  density: 0.9,
  meteors: true,
  additive: true,
  meteorAlpha: 1,
  bodies: {
    alpha: 1,
    planetLight: '255, 222, 160',
    planetBase: '196, 124, 46',
    planetDeep: '84, 44, 12',
    planetBand: '236, 170, 92',
    ring: '243, 221, 168',
    night: '6, 4, 2',
    nightAlpha: 0.95,
    moon: '236, 226, 206',
    arms: '231, 197, 132',
    armsCore: '255, 242, 214',
    nebula: ['122, 78, 30', '217, 160, 84', '176, 98, 44', '236, 206, 150'],
    comet: '250, 232, 196',
    ion: '217, 179, 108',
  },
}

const OKX_LIGHT: CosmosPalette = {
  stars: ['138, 100, 24', '107, 97, 82', '176, 136, 62'],
  glint: '138, 100, 24',
  cloud: ['240, 224, 190', '232, 210, 166', '244, 230, 200', '236, 218, 180'],
  core: '246, 234, 206',
  dust: '176, 136, 62',
  cloudAlpha: 0.8,
  starAlpha: 0.48,
  density: 0.55,
  meteors: true,
  additive: false,
  meteorAlpha: 0.4,
  bodies: {
    alpha: 0.6,
    planetLight: '255, 248, 232',
    planetBase: '236, 204, 150',
    planetDeep: '196, 150, 84',
    planetBand: '214, 170, 104',
    ring: '176, 136, 62',
    night: '150, 118, 70',
    nightAlpha: 0.34,
    moon: '200, 188, 166',
    arms: '176, 136, 62',
    armsCore: '138, 100, 24',
    nebula: ['244, 222, 184', '236, 210, 160', '248, 228, 196', '232, 214, 182'],
    comet: '138, 100, 24',
    ion: '176, 136, 62',
  },
}

export function cosmosPalette(skin: SkinId, theme: Theme): CosmosPalette {
  if (skin === 'okx') return theme === 'dark' ? OKX_DARK : OKX_LIGHT
  return theme === 'dark' ? BINANCE_DARK : BINANCE_LIGHT
}
