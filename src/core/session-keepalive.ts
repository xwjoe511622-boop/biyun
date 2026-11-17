import { session } from './session'

/**
 * Session keep-alive.
 *
 * The server session is a Redis key with a sliding TTL: every authenticated request extends it.
 * A user reading the trade page may send no authenticated request for a long time (market data is
 * public), so the key could lapse while they are actively looking at the screen. While the tab is
 * visible and the user has interacted recently, this touches one cheap authenticated endpoint at
 * most every `intervalMs`, and skips the touch when a real authenticated request already reached
 * the server within that interval (`session.lastServerContact()`).
 *
 * It stops when the tab is hidden or the user is idle, so an abandoned tab does not keep a session
 * alive forever. A failed touch is ignored: a transport error never clears the session, and a real
 * rejection is handled (and confirmed) by the http layer.
 */

export const KEEPALIVE_INTERVAL_MS = 10 * 60_000
export const KEEPALIVE_IDLE_MS = 15 * 60_000
const CHECK_INTERVAL_MS = 60_000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

export interface KeepAliveOptions {
  /** Cheap authenticated request; its outcome is ignored here. */
  touch: () => Promise<unknown>
  intervalMs?: number
  idleMs?: number
  checkIntervalMs?: number
  now?: () => number
  /** Injectable for tests; defaults to `document.visibilityState === 'visible'`. */
  isVisible?: () => boolean
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
}

export interface KeepAlive {
  /** Runs one check immediately (tests; also used when the tab becomes visible again). */
  check: () => Promise<void>
  /** Records user activity (the DOM listeners call this). */
  markActive: () => void
  stop: () => void
}

export function startSessionKeepAlive(options: KeepAliveOptions): KeepAlive {
  const intervalMs = options.intervalMs ?? KEEPALIVE_INTERVAL_MS
  const idleMs = options.idleMs ?? KEEPALIVE_IDLE_MS
  const now = options.now ?? Date.now
  const doc = options.doc ?? (typeof document === 'undefined' ? undefined : document)
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window)
  const isVisible = options.isVisible ?? (() => doc === undefined || doc.visibilityState === 'visible')
  let lastActivity = now()
  let lastTouch = 0
  let inFlight = false
  let stopped = false

  function markActive(): void {
    lastActivity = now()
  }

  async function check(): Promise<void> {
    if (stopped || inFlight || !session.isAuthenticated() || !isVisible()) return
    const current = now()
    if (current - lastActivity > idleMs) return
    const lastContact = Math.max(lastTouch, session.lastServerContact())
    if (current - lastContact < intervalMs) return
    inFlight = true
    lastTouch = current
    try {
      await options.touch()
    } catch {
      // Transport failures keep the session; auth rejections are confirmed by the http layer.
    } finally {
      inFlight = false
    }
  }

  const onVisibility = (): void => {
    if (isVisible()) {
      markActive()
      void check()
    }
  }
  const timer = setInterval(() => void check(), options.checkIntervalMs ?? CHECK_INTERVAL_MS)
  ACTIVITY_EVENTS.forEach((name) => target?.addEventListener(name, markActive, { passive: true, capture: true }))
  doc?.addEventListener('visibilitychange', onVisibility)

  return {
    check,
    markActive,
    stop(): void {
      stopped = true
      clearInterval(timer)
      ACTIVITY_EVENTS.forEach((name) => target?.removeEventListener(name, markActive, { capture: true }))
      doc?.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
