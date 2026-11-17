// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, ref, nextTick, type App } from 'vue'
import PercentSlider from '@/components/common/PercentSlider.vue'

let app: App | null = null
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; vi.unstubAllGlobals() })

function mount(initial = 0, disabled = false, snapTaps = false) {
  const value = ref(initial)
  const changes: number[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(PercentSlider, { modelValue: value.value, disabled, snapTaps, 'onUpdate:modelValue': (v: number) => { value.value = v }, onChange: (v: number) => changes.push(v) }) })
  app.mount(host)
  const rail = host.querySelector('[role="slider"]') as HTMLDivElement
  rail.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, right: 300, bottom: 16, height: 16, x: 100, y: 0, toJSON: () => ({}) })
  return { host, rail, value, changes }
}

function pointer(type: string, clientX: number, target: EventTarget = window, pointerType = 'mouse'): void {
  const event = new PointerEvent(type, { clientX, bubbles: true, button: 0, pointerType })
  target.dispatchEvent(event)
}

describe('PercentSlider', () => {
  it('drags continuously and commits once on release', async () => {
    const { rail, value, changes } = mount()
    pointer('pointerdown', 150, rail)
    expect(value.value).toBe(25)
    pointer('pointermove', 237)
    expect(value.value).toBe(69)
    pointer('pointermove', 400)
    expect(value.value).toBe(100)
    pointer('pointerup', 400)
    expect(changes).toEqual([100])
    await nextTick()
    expect(rail.getAttribute('aria-valuenow')).toBe('100')
  })

  it('drags from the thumb resting on a mark (0% / 100%): the mark does not swallow the press (09-30 owner bug)', async () => {
    const { host, rail, value, changes } = mount(0)
    const marks = host.querySelectorAll('.pct-mark')
    // Pressing the 0% diamond under the thumb, then dragging past the right end, reaches 100%.
    pointer('pointerdown', 100, marks[0])
    expect(value.value).toBe(0)
    pointer('pointermove', 200)
    expect(value.value).toBe(50)
    pointer('pointermove', 330)
    pointer('pointerup', 330)
    expect(value.value).toBe(100)
    expect(changes).toEqual([100])
    await nextTick()
    // And back from the 100% diamond to 25%.
    pointer('pointerdown', 300, host.querySelectorAll('.pct-mark')[4])
    pointer('pointermove', 150)
    pointer('pointerup', 150)
    expect(value.value).toBe(25)
    await nextTick()
    expect(rail.getAttribute('aria-valuenow')).toBe('25')
  })

  it('a plain press on a mark picks that mark exactly', () => {
    const { host, value, changes } = mount(10)
    const mark = host.querySelectorAll('.pct-mark')[3]
    pointer('pointerdown', 251, mark)
    pointer('pointerup', 251)
    expect(value.value).toBe(75)
    expect(changes).toEqual([75])
  })

  it('QA-239 snaps nearby phone taps but keeps whole-percent precision while dragging', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { rail, value, changes } = mount(0, false, true)
    for (const [x, expected] of [[156, 25], [194, 50], [256, 75]]) {
      pointer('pointerdown', x, rail, 'touch')
      pointer('pointermove', x + 3, window, 'touch')
      pointer('pointerup', x + 3, window, 'touch')
      expect(value.value).toBe(expected)
      await nextTick()
    }
    pointer('pointerdown', 155, rail, 'touch')
    expect(value.value).toBe(25)
    await nextTick()
    pointer('pointermove', 167, window, 'touch')
    expect(value.value).toBe(34)
    await nextTick()
    pointer('pointermove', 154, window, 'touch')
    pointer('pointerup', 154, window, 'touch')
    expect(value.value).toBe(27)
    expect(changes).toEqual([25, 50, 75, 27])
  })

  it('clicks marks and supports the keyboard', async () => {
    const { host, rail, value } = mount(10)
    ;(host.querySelectorAll('.pct-label')[2] as HTMLButtonElement).click()
    expect(value.value).toBe(50)
    await nextTick()
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(value.value).toBe(51)
    await nextTick()
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(value.value).toBe(41)
    await nextTick()
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(value.value).toBe(100)
    await nextTick()
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(value.value).toBe(0)
  })

  it('ignores input while disabled', () => {
    const { rail, value } = mount(30, true)
    pointer('pointerdown', 250, rail)
    rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(value.value).toBe(30)
  })
})
