import { ENDPOINTS } from '@/config/endpoints'
import { readCache, writeCache, type CacheHit } from '@/core/session-cache'
import { request, requestLanguage, requestWithRetry, type RetryPolicy } from './http'
import type { CoinIntroItem, PublicInfoV4 } from './types'
import { validateData } from './validation'

/** A cached public info older than this is not used at all. */
export const PUBLIC_INFO_CACHE_MAX_AGE_MS = 10 * 60_000
/** A cached public info younger than this is used without a background revalidation. */
export const PUBLIC_INFO_FRESH_MS = 60_000

function publicInfoCacheName(): string {
  return `public_info_v4.${requestLanguage()}`
}

/**
 * `POST /common/public_info_v4` — market config, coin list, switches, branding, captcha config.
 * Sent anonymously: the endpoint needs no session, and the web-api rejects an expired
 * `exchange-token` even here, which used to blank the trade page for users with a stale session.
 * Transport failures (timeout, 502, offline) are retried with backoff; the result is cached per
 * language in `sessionStorage` so the next navigation renders at once.
 */
export async function fetchPublicInfo(policy?: RetryPolicy): Promise<PublicInfoV4> {
  const name = publicInfoCacheName()
  const info = await requestWithRetry<PublicInfoV4>(ENDPOINTS.publicInfo, { body: {}, anonymous: true, timeoutMs: 12_000 }, policy)
  writeCache(name, info)
  return info
}

/** The cached public info for the active language, re-validated like a network response. */
export function readCachedPublicInfo(): CacheHit<PublicInfoV4> | null {
  return readCache(publicInfoCacheName(), PUBLIC_INFO_CACHE_MAX_AGE_MS, (data) => {
    if (data === null || typeof data !== 'object') return null
    try {
      return validateData<PublicInfoV4>(ENDPOINTS.publicInfo, data)
    } catch {
      return null
    }
  })
}

/** `POST /common/coinSymbol_introduce` — coin profile list for the active language. */
export function fetchCoinIntro(): Promise<CoinIntroItem[]> {
  return request<CoinIntroItem[]>(ENDPOINTS.coinIntro, { body: {}, anonymous: true })
}
