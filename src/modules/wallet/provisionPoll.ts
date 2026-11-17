/**
 * Deposit-address provisioning poll schedule (owner 10-23: 「至少中间要有一个加载动画"生成中"，不能一直出不来就好像不能成功一样」).
 *
 * While the server reports PROVISIONING the page re-checks on its own: every 3 s for the first 30 s, every 5 s
 * up to 2 min, every 10 s up to 5 min, then a slow 30 s background check (the "taking longer" phase). Pure
 * functions so the schedule is unit-tested; timers live in the component.
 */

export type ProvisionPhase = 'generating' | 'slow'

/** After this the UI switches to the "taking longer, still working" message (polling continues, slower). */
export const PROVISION_SLOW_AFTER_MS = 5 * 60_000

/** Delay before the next re-check, given how long the address has been provisioning. */
export function nextPollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 3_000
  if (elapsedMs < 120_000) return 5_000
  if (elapsedMs < PROVISION_SLOW_AFTER_MS) return 10_000
  return 30_000
}

export function provisionPhase(elapsedMs: number): ProvisionPhase {
  return elapsedMs < PROVISION_SLOW_AFTER_MS ? 'generating' : 'slow'
}

/** `m:ss` for the elapsed counter (no locale or float formatting involved). */
export function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(total / 60) // float-ok: elapsed-time display, integer seconds
  const seconds = total % 60
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`
}
