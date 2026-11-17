// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import DialogShell from '@/components/transfer/DialogShell.vue'

let app: App | undefined
afterEach(() => { app?.unmount(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('cycles both focus boundaries, skips unavailable controls and restores the trigger on Escape', async () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.style.display === 'none' ? [] : [{}]) as unknown as DOMRectList
  })
  document.body.innerHTML = '<button id="trigger">Transfer</button><div id="mount"></div><a href="/register">Background</a>'
  const trigger = document.querySelector<HTMLButtonElement>('#trigger')!
  trigger.focus()
  const open = ref(true)
  app = createApp({ render: () => h(DialogShell, { open: open.value, title: 'Transfer', onClose: () => { open.value = false } }, {
    default: () => [h('input', { id: 'amount' }), h('button', { id: 'last' }, 'Confirm'),
      h('button', { disabled: true }, 'Disabled'), h('button', { style: 'display:none' }, 'Hidden'),
      h('button', { tabindex: -1 }, 'Not tabbable')],
  }) })
  app.mount('#mount')
  await nextTick(); await nextTick()
  expect(document.activeElement?.id).toBe('amount')
  const first = document.querySelector<HTMLButtonElement>('.dialog-close')!
  const last = document.querySelector<HTMLButtonElement>('#last')!
  first.focus()
  const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
  first.dispatchEvent(backward)
  expect(backward.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(last)
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  expect(document.activeElement).toBe(first)
  const middle = document.querySelector<HTMLInputElement>('#amount')!
  middle.focus()
  const normal = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  middle.dispatchEvent(normal)
  expect(normal.defaultPrevented).toBe(false)
  middle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await nextTick()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
