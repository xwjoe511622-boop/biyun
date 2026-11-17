import type { Directive } from 'vue'

/**
 * Horizontal-scroller fade hint (owner 10-22: mobile right-side overflow). A genuinely wide table (order history,
 * fee schedules per network) stays inside its card in an `.x-scroll` box; this directive writes `data-fade` so the CSS
 * mask fades the edge that still has hidden content, telling the reader the box scrolls sideways.
 */
export type FadeEdges = 'none' | 'left' | 'right' | 'both'

/** Which edges still hide content. 1 px of slack absorbs sub-pixel layout rounding. */
export function fadeEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): FadeEdges {
  const slack = 1
  if (scrollWidth <= clientWidth + slack) return 'none'
  const left = scrollLeft > slack
  const right = scrollLeft + clientWidth < scrollWidth - slack
  if (left && right) return 'both'
  if (left) return 'left'
  if (right) return 'right'
  return 'none'
}

interface FadeState { update: () => void; observer: ResizeObserver | null }
const states = new WeakMap<HTMLElement, FadeState>()

export function applyFade(el: HTMLElement): FadeEdges {
  // RTL scrollLeft is negative in modern engines; the magnitude is what matters for the hint.
  const edges = fadeEdges(Math.abs(el.scrollLeft), el.clientWidth, el.scrollWidth)
  if (el.dataset.fade !== edges) el.dataset.fade = edges
  return edges
}

export const vScrollFade: Directive<HTMLElement> = {
  mounted(el) {
    const update = (): void => { applyFade(el) }
    el.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(el)
    const first = el.firstElementChild
    if (first instanceof HTMLElement) observer?.observe(first)
    states.set(el, { update, observer })
    update()
  },
  updated(el) { states.get(el)?.update() },
  beforeUnmount(el) {
    const s = states.get(el)
    if (!s) return
    el.removeEventListener('scroll', s.update)
    s.observer?.disconnect()
    states.delete(el)
  },
}
