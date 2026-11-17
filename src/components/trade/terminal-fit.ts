import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { SKIN } from '@/core/skin'

/**
 * OKX skin: the terminal's working area (pair bar, chart, book, ticket) fills the viewport below the site header and
 * above the pinned status bar, like OKX; the orders section follows below the fold. CSS cannot sum grid rows, so
 * this measures once per layout change and publishes two custom properties on the terminal root:
 *   --term-fill  viewport height left for the terminal (viewport − terminal top − pinned status bar)
 *   --term-rest  --term-fill minus the rows named by `subtract` (e.g. pair bar + ticket) and the 1px rules between them
 * skin-okx.css sizes the flexible row from them (with a minimum, so short screens scroll instead of squashing).
 * Layout only; nothing here touches market or money data. The Binance skin never calls into it.
 */
export function useTerminalFit(root: Ref<HTMLElement | undefined>, subtract: string[]): void {
  if (SKIN !== 'okx' || typeof window === 'undefined') return
  let frame = 0
  let observer: ResizeObserver | null = null
  const watched = new Set<Element>()

  function measure(): void {
    const element = root.value
    if (element === undefined) return
    const top = element.getBoundingClientRect().top + window.scrollY
    const footer = document.querySelector<HTMLElement>('.terminal-footer')
    const fill = Math.max(0, window.innerHeight - top - (footer?.offsetHeight ?? 0))
    let rest = fill
    let rows = 0
    subtract.forEach((selector) => {
      const target = element.querySelector<HTMLElement>(selector)
      if (target === null) return
      rest -= target.offsetHeight
      rows += 1
      if (observer !== null && !watched.has(target)) {
        watched.add(target)
        observer.observe(target)
      }
    })
    rest -= rows // the 1px rules between the stacked rows
    element.style.setProperty('--term-fill', `${Math.round(fill)}px`)
    element.style.setProperty('--term-rest', `${Math.round(rest)}px`)
  }
  function schedule(): void {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measure)
  }

  onMounted(() => {
    observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    if (root.value !== undefined) observer?.observe(root.value)
    window.addEventListener('resize', schedule)
    measure()
  })
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    observer?.disconnect()
    observer = null
    watched.clear()
    window.removeEventListener('resize', schedule)
  })
}
