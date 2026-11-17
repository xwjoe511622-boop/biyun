import type { RouteLocationRaw, Router } from 'vue-router'

/**
 * A tab opened before a frontend deploy still references the previous build's hashed page chunks. When such a chunk
 * is gone (or the request fails), vue-router rejects the navigation silently: the header link "does nothing" until the
 * user reloads. Recover by loading the target URL as a full page (fresh index.html → current chunks), at most once per
 * target within a short window so a genuinely broken chunk cannot cause a reload loop.
 */
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk .* failed/i
const GUARD_KEY = 'lb-chunk-reload'
const GUARD_MS = 30_000

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return CHUNK_ERROR.test(message)
}

function reloadOnce(url: string): boolean {
  try {
    const last = JSON.parse(sessionStorage.getItem(GUARD_KEY) ?? 'null') as { url: string; at: number } | null
    if (last && last.url === url && Date.now() - last.at < GUARD_MS) return false
    sessionStorage.setItem(GUARD_KEY, JSON.stringify({ url, at: Date.now() }))
  } catch {
    /* Storage unavailable: reload anyway, it is the only recovery. */
  }
  window.location.assign(url)
  return true
}

export function installChunkRecovery(router: Router): void {
  // Vite's preload helper rethrows failed CSS/JS preloads (`vite:preloadError` not prevented), so they land here too.
  router.onError((error, to) => {
    if (isChunkLoadError(error)) reloadOnce(to.fullPath)
  })
}

/** Starts downloading a route's page chunk (e.g. on hover) so the click itself navigates without waiting. */
export function warmRoute(router: Router, to: RouteLocationRaw): void {
  try {
    for (const record of router.resolve(to).matched) {
      const component = record.components?.default
      if (typeof component === 'function') void (component as () => Promise<unknown>)().catch(() => undefined)
    }
  } catch {
    /* Unknown route: nothing to warm. */
  }
}
