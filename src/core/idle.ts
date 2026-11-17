/**
 * Runs `task` once the page is idle (after an optional delay), for work that must never compete
 * with a page's first data: the footer links, the home sparkline. Returns a cancel function.
 */
export function runWhenIdle(task: () => void, options: { delayMs?: number; timeoutMs?: number } = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let idle: number | null = null
  const schedule = (): void => {
    timer = null
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(() => {
        idle = null
        task()
      }, { timeout: options.timeoutMs ?? 3_000 })
    } else {
      timer = setTimeout(task, 0)
    }
  }
  timer = setTimeout(schedule, options.delayMs ?? 0)
  return () => {
    if (timer !== null) clearTimeout(timer)
    if (idle !== null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle)
    timer = null
    idle = null
  }
}
