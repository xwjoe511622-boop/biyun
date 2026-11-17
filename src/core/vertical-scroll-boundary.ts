import type { Directive } from 'vue'

const observers = new WeakMap<HTMLElement, ResizeObserver>()

function measure(el: HTMLElement): void {
  el.toggleAttribute('data-scrolls-vertically', el.scrollHeight > el.clientHeight)
}

// Short tables should pass vertical gestures to the page. Recheck when rows
// arrive or when a resize changes the height of either the table or its box.
export const vVerticalScrollBoundary: Directive<HTMLElement> = {
  mounted(el) {
    measure(el)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure(el))
    observer.observe(el)
    if (el.firstElementChild instanceof HTMLTableElement) observer.observe(el.firstElementChild)
    observers.set(el, observer)
  },
  updated(el) {
    const observer = observers.get(el)
    if (observer && el.firstElementChild instanceof HTMLTableElement) observer.observe(el.firstElementChild)
    measure(el)
  },
  unmounted(el) {
    observers.get(el)?.disconnect()
    observers.delete(el)
  },
}
