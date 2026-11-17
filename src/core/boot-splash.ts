/**
 * Dismisses the entry splash injected into index.html (scripts/boot-splash.ts; owner 10-22). Imported first by
 * main.ts so the check runs before the rest of the app evaluates:
 *   - once per browser session: later loads in the same session (and reduced motion) remove it at once — the
 *     splash only fades in after 180 ms, so a cached reload never shows it;
 *   - otherwise (first visit of the session) it plays in full — the W rises out of the black hole, BITWINEX and
 *     WIN THE FUTURE fade in — for ~2.4 s (owner 10-22: the 0.6 s cut ended before the mark and tagline appeared),
 *     or longer only if the app is still loading; any click / tap / key skips it. It never waits on data.
 */
const SEEN_KEY = 'bw.boot'
/** First-visit play length: the rise and tagline finish at ~1.6 s (CSS), then a short hold. */
const SHOW_UNTIL_MS = 2400
const FADE_MS = 420

const splash = document.getElementById('boot')

function seenThisSession(): boolean {
  try {
    if (sessionStorage.getItem(SEEN_KEY) !== null) return true
    sessionStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Storage blocked (private mode): show it, nothing to remember.
  }
  return false
}

const skip = splash === null || seenThisSession() || window.matchMedia('(prefers-reduced-motion: reduce)').matches
if (skip) splash?.remove()

/** Call once the app is mounted and the first view is ready. */
let leaving = false
function leave(): void {
  if (leaving || splash === null || !splash.isConnected) return
  leaving = true
  splash.classList.add('out')
  globalThis.setTimeout(() => splash.remove(), FADE_MS)
}

if (!skip && splash !== null) {
  // Any input skips the intro (the splash itself is pointer-events: none, so listen on the document).
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    document.addEventListener(type, leave, { once: true, passive: true, capture: true })
  }
}

export function dismissBootSplash(): void {
  if (skip || splash === null || !splash.isConnected) return
  globalThis.setTimeout(leave, Math.max(0, SHOW_UNTIL_MS - performance.now()))
}
