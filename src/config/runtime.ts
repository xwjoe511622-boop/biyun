import type { PublicInfoV4 } from '@/modules/api/types'
import { BRAND_NAME } from '@/core/brand'

/**
 * Runtime brand configuration.
 *
 * The legacy app received branding from a rendered `/fePublicInfo` script
 * (`window.publicInfo`). That endpoint still exists (egg controller `fePublicInfo.js`)
 * but is not part of `/fe-ex-api/`, so this client resolves branding from build defaults
 * and then overrides it with the values `/common/public_info_v4` already returns
 * (`msg.logoUrl`, `switch.*`). The display name is the client brand (`core/brand.ts`); the legacy
 * `msg.company_name` still reads "Picat" and is intentionally not used.
 */

export interface BrandConfig {
  name: string
  logoUrl: string
  /** Locales exposed in the language switcher. */
  locales: readonly string[]
  defaultLocale: string
  contactEmail: string
}

export const defaultBrand: BrandConfig = {
  name: BRAND_NAME,
  logoUrl: '',
  locales: ['zh-CN', 'en-US'],
  defaultLocale: 'zh-CN',
  contactEmail: '',
}

export interface RuntimeConfig {
  brand: BrandConfig
  /** Server-provided public info; `null` until `/common/public_info_v4` resolves. */
  publicInfo: PublicInfoV4 | null
  /** Server-provided market WebSocket URL. */
  wsUrl: string | null
}

const runtimeConfig: RuntimeConfig = {
  brand: { ...defaultBrand },
  publicInfo: null,
  wsUrl: null,
}

export function applyPublicInfo(info: PublicInfoV4, fallbackWsUrl: string): void {
  runtimeConfig.publicInfo = info
  const msg = info.msg ?? {}
  runtimeConfig.brand = {
    ...runtimeConfig.brand,
    logoUrl: typeof msg.logoUrl === 'string' ? msg.logoUrl : '',
    contactEmail: typeof msg.contact_email === 'string' ? msg.contact_email : '',
  }
  const wsUrl = info.market?.wsUrl
  runtimeConfig.wsUrl = typeof wsUrl === 'string' && wsUrl !== '' ? wsUrl : fallbackWsUrl
}

export function runtimeBrand(): BrandConfig {
  return runtimeConfig.brand
}

export function runtimePublicInfo(): PublicInfoV4 | null {
  return runtimeConfig.publicInfo
}

export function runtimeWsUrl(): string | null {
  return runtimeConfig.wsUrl
}
