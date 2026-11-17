/**
 * Order payment countdown.
 *
 * `order_detail` returns `limitTime` as the REMAINING milliseconds at the moment the server answered
 * (legacy `otcDetailOrder/title.js` decremented it by 1000 per tick). We pin it to the local clock at
 * receipt time, so a tab that sleeps or a slow render never extends the deadline.
 */

export function deadlineFromRemaining(remainingMs: number, receivedAtMs: number): number | null {
  if (!Number.isFinite(remainingMs) || !Number.isFinite(receivedAtMs)) return null
  return receivedAtMs + Math.max(0, remainingMs)
}

export function remainingMs(deadlineMs: number | null, nowMs: number): number {
  if (deadlineMs === null || !Number.isFinite(nowMs)) return 0
  return Math.max(0, deadlineMs - nowMs)
}

export interface CountdownParts {
  hours: number
  minutes: number
  seconds: number
  expired: boolean
}

export function countdownParts(ms: number): CountdownParts {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  const total = Math.floor(safe / 1000)
  return {
    hours: Math.floor(total / 3600), // float-ok: not money (countdown seconds)
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    expired: total <= 0,
  }
}

/** `MM:SS`, or `H:MM:SS` once an hour or more remains. */
export function formatCountdown(ms: number): string {
  const { hours, minutes, seconds } = countdownParts(ms)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** Parses a server number/string of milliseconds; `null` for anything unusable. */
export function parseMillis(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
