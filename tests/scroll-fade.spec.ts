// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, withDirectives } from 'vue'
import { applyFade, fadeEdges, vScrollFade } from '@/core/scroll-fade'

/** Owner 10-22 (mobile right-side overflow): wide tables scroll inside their card and fade the hidden edge. */
describe('fadeEdges', () => {
  it('no hint when the content fits', () => {
    expect(fadeEdges(0, 375, 375)).toBe('none')
    expect(fadeEdges(0, 375, 376)).toBe('none') // 1 px rounding slack
  })
  it('fades the right edge at the start', () => {
    expect(fadeEdges(0, 375, 960)).toBe('right')
  })
  it('fades both edges in the middle', () => {
    expect(fadeEdges(200, 375, 960)).toBe('both')
  })
  it('fades the left edge at the end', () => {
    expect(fadeEdges(585, 375, 960)).toBe('left')
    expect(fadeEdges(584.5, 375, 960)).toBe('left')
  })
})

function sized(el: HTMLElement, client: number, scroll: number, left = 0): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: client })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll })
  el.scrollLeft = left
}

describe('vScrollFade', () => {
  it('writes data-fade on mount and follows scrolling', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => withDirectives(h('div', { class: 'x-scroll' }, [h('table')]), [[vScrollFade]]) })
    // Dimensions must exist before mount: patch the prototype getters for this test only.
    const proto = HTMLElement.prototype
    const cw = Object.getOwnPropertyDescriptor(proto, 'clientWidth')
    const sw = Object.getOwnPropertyDescriptor(proto, 'scrollWidth')
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 375 })
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 960 })
    try {
      app.mount(host)
      await nextTick()
      const box = host.querySelector<HTMLElement>('.x-scroll')
      expect(box?.dataset.fade).toBe('right')
      if (!box) return
      sized(box, 375, 960, 300)
      box.dispatchEvent(new Event('scroll'))
      expect(box.dataset.fade).toBe('both')
      sized(box, 375, 960, 585)
      expect(applyFade(box)).toBe('left')
      app.unmount()
    } finally {
      if (cw) Object.defineProperty(proto, 'clientWidth', cw)
      if (sw) Object.defineProperty(proto, 'scrollWidth', sw)
      host.remove()
    }
  })
})
