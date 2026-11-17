/**
 * Small `sessionStorage` cache for public, non-personal payloads (public info, contract list, footer
 * links, last tickers), so a repeat navigation or reload renders at once and revalidates in the
 * background.
 *
 * Keys are namespaced `picat.cache.v1.*`; every entry carries its write time and is dropped once it
 * is older than the caller's `maxAgeMs`. Readers must re-validate the payload (the stored JSON is
 * as untrusted as a network response). Nothing tied to a session or user is ever written here.
 */

export const CACHE_NAMESPACE = 'picat.cache.v1'

interface CacheEntry {
  at: number
  data: unknown
}

export interface CacheHit<T> {
  data: T
  /** Milliseconds since the entry was written. */
  age: number
}

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function cacheKey(name: string): string {
  return `${CACHE_NAMESPACE}.${name}`
}

/** Returns the entry when it is younger than `maxAgeMs` and `validate` accepts it; else `null`. */
export function readCache<T>(name: string, maxAgeMs: number, validate: (data: unknown) => T | null, now: number = Date.now()): CacheHit<T> | null {
  const storage = store()
  if (storage === null) return null
  try {
    const raw = storage.getItem(cacheKey(name))
    if (raw === null) return null
    const entry = JSON.parse(raw) as Partial<CacheEntry> | null
    const at = typeof entry?.at === 'number' ? entry.at : Number.NaN
    const age = now - at
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      storage.removeItem(cacheKey(name))
      return null
    }
    const data = validate(entry?.data)
    if (data === null) {
      storage.removeItem(cacheKey(name))
      return null
    }
    return { data, age }
  } catch {
    return null
  }
}

export function writeCache(name: string, data: unknown, now: number = Date.now()): void {
  const storage = store()
  if (storage === null) return
  try {
    storage.setItem(cacheKey(name), JSON.stringify({ at: now, data } satisfies CacheEntry))
  } catch {
    // Quota / private mode: the cache is an optimisation only.
  }
}
