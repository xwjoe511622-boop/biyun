import { onBeforeUnmount, onMounted, type Directive, type Ref } from 'vue'
import { cmp, isDecimalString } from '@/modules/finance/decimal'

/**
 * Home-page motion, deliberately small (owner 10-22: 做过头了 — a serious exchange, motion only where it helps):
 *   - `useReveal`: each `[data-fx]` section fades and rises a few pixels the first time it enters view, once.
 *     One shared IntersectionObserver; reduced motion or no IntersectionObserver → everything simply shows.
 *   - `vTick`: flashes a price cell green/red when its live value rises/falls (decimal compare, no floats).
 * Nothing is pinned, nothing follows the pointer, nothing is driven by the scroll position.
 */

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One-shot entrance for `[data-fx]` inside `root` (`html.fx-io` arms the hidden state; `.fx-in` releases it). */
export function useReveal(root: Ref<HTMLElement | null>): void {
  let io: IntersectionObserver | null = null

  onMounted(() => {
    const el = root.value
    if (el === null || prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return
    const vh = window.innerHeight
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('fx-in')
          io?.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -6% 0px' },
    )
    for (const node of el.querySelectorAll<HTMLElement>('[data-fx]')) {
      // Already on screen at load: shown as is, no entrance.
      if (node.getBoundingClientRect().top < vh) node.classList.add('fx-in')
      else io.observe(node)
    }
    document.documentElement.classList.add('fx-io')
  })

  onBeforeUnmount(() => {
    io?.disconnect()
    document.documentElement.classList.remove('fx-io')
  })
}

const TICK_CLASSES = ['fx-tk-up1', 'fx-tk-up2', 'fx-tk-dn1', 'fx-tk-dn2']

/**
 * `v-tick="row.last"` on an element whose class list is static: a higher value flashes up, a lower one down.
 * Two alternating class names restart the CSS animation without forcing a reflow.
 */
export const vTick: Directive<HTMLElement, string> = {
  updated(el, { value, oldValue }) {
    if (oldValue === undefined || oldValue === null || value === oldValue) return
    const next = value.replace(/,/g, '')
    const prev = oldValue.replace(/,/g, '')
    if (!isDecimalString(next) || !isDecimalString(prev)) return
    const order = cmp(next, prev)
    if (order === 0) return
    const flip = el.dataset.tk === '1' ? '2' : '1'
    el.dataset.tk = flip
    el.classList.remove(...TICK_CLASSES)
    el.classList.add(`fx-tk-${order > 0 ? 'up' : 'dn'}${flip}`)
  },
}
