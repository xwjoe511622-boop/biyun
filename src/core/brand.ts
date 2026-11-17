/**
 * Client display brand, chosen at build time (owner 10-20: the AWS production line is "Bitwinex"; the Aliyun test
 * env keeps "Longbit 龙比特"). Display only: storage keys, API paths, cookies and service names never change.
 *
 *   VITE_BRAND=bitwinex | longbit   (unset: derived from VITE_SITE_DOMAIN, bitwinex.cc -> bitwinex, else longbit;
 *                                     vite.config.ts resolves it once and defines it for the client)
 *   VITE_BRAND_NAME / VITE_BRAND_NAME_ZH  optional overrides of the two name slots below.
 *
 * `nameLocal` is the single slot for a Chinese brand name. Bitwinex has none yet (do not invent one): it stays empty
 * and every place that prints it collapses. When the owner picks one, set it here (or VITE_BRAND_NAME_ZH).
 *
 * The legacy backend still returns `msg.company_name` from `/common/public_info_v4`; the display name is owned by
 * the client build instead of following that field. The server logo (`msg.logoUrl`) is still honoured when set.
 * Brand assets: `brand-public/<id>/` (icons, manifest, og-image), sources in `clean-source/frontend/brand/`.
 */
export type BrandId = 'longbit' | 'bitwinex'

interface BrandDef {
  name: string
  nameLocal: string
}

// `import.meta.env.VITE_BRAND` is a build-time literal (vite.config.ts `define`), so the minifier folds this
// ternary and a bundle carries only its own brand's names.
export const BRAND_ID: BrandId = import.meta.env.VITE_BRAND === 'bitwinex' ? 'bitwinex' : 'longbit'
const def: BrandDef =
  import.meta.env.VITE_BRAND === 'bitwinex'
    ? { name: 'BIYUN', nameLocal: '' } // owner 2026-11-17: renamed from BITWINEX; no Chinese name; the gold W mark stays
    : { name: 'Longbit', nameLocal: '龙比特' }

const override = (raw: string | undefined): string | undefined => (raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined)

export const BRAND_NAME: string = override(import.meta.env.VITE_BRAND_NAME) ?? def.name
/** Chinese name slot; empty for brands without one. */
export const BRAND_NAME_ZH: string = override(import.meta.env.VITE_BRAND_NAME_ZH) ?? def.nameLocal

/** Full display name for titles: `Longbit 龙比特`, or just `Bitwinex` while it has no Chinese name. */
export const BRAND_FULL = `${BRAND_NAME} ${BRAND_NAME_ZH}`.trim()
