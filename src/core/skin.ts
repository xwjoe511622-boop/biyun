/**
 * Layout skin chosen at build time (owner 10-21): two separately deployed front ends from one code base.
 *   binance: Binance-style layout, Bitwinex blue accent (www)
 *   okx:     OKX-style layout, black-gold (dark) / white-gold (light)
 * `import.meta.env.VITE_SKIN` is a literal (vite.config.ts), so the minifier drops the other skin's branches.
 */
export type SkinId = 'binance' | 'okx'
export const SKIN: SkinId = import.meta.env.VITE_SKIN === 'okx' ? 'okx' : 'binance'
