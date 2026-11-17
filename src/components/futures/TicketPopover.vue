<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { placePopover, type PopoverPlacement } from './popover-placement'

/**
 * Small anchored sheet for the futures ticket and dialogs (order type, unit, 最优价, 对手价1…). The trigger slot receives
 * `{ open, toggle }`; the panel closes on outside tap/click, Escape, page scroll and resize.
 *
 * 2026-09-30 (owner screenshot, 平仓 dialog → 最优价 → 对手价1): the panel used to be `position: absolute` inside the
 * trigger, so inside a dialog it was clipped by the dialog body's overflow and, right-aligned to a trigger on the left,
 * hung off the dialog with its labels cut away. It is now teleported to <body> as a fixed layer above every dialog,
 * placed from the trigger's rect (`placePopover`: below, flipped above when there is no room, shifted to stay 8px
 * inside the viewport, max-height = the room left). On phone widths it is a bottom sheet (Binance app style).
 */
const props = withDefaults(defineProps<{ align?: 'left' | 'right' | 'auto'; label: string }>(), { align: 'left' })
const open = defineModel<boolean>('open', { default: false })
const root = ref<HTMLDivElement>()
const panel = ref<HTMLDivElement>()
const placement = ref<PopoverPlacement | null>(null)
const SHEET_MAX = 640

function toggle(): void {
  open.value = !open.value
}

function isSheet(): boolean {
  return window.innerWidth <= SHEET_MAX
}

function place(): void {
  const trigger = root.value?.getBoundingClientRect()
  const box = panel.value
  if (trigger === undefined || box === undefined || isSheet()) {
    placement.value = null
    return
  }
  placement.value = placePopover({
    trigger: { top: trigger.top, bottom: trigger.bottom, left: trigger.left, right: trigger.right, width: trigger.width },
    panel: { width: box.offsetWidth, height: box.scrollHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    align: props.align,
  })
}

function onDocumentPointer(event: PointerEvent): void {
  const target = event.target as Node
  if (root.value?.contains(target) || panel.value?.contains(target)) return
  open.value = false
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

/** A scroll anywhere but inside the panel moves the trigger away: close (Binance does the same). */
function onScroll(event: Event): void {
  // The phone bottom sheet is not anchored to the trigger: a scroll behind it changes nothing.
  if (isSheet() || panel.value?.contains(event.target as Node)) return
  open.value = false
}

function onResize(): void {
  open.value = false
}

function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  document[method]('pointerdown', onDocumentPointer as EventListener, true)
  document[method]('keydown', onKey as EventListener)
  window[method]('scroll', onScroll, true)
  window[method]('resize', onResize)
}

watch(open, async (value) => {
  listen(false)
  if (!value) {
    placement.value = null
    return
  }
  listen(true)
  await nextTick()
  place()
})
onBeforeUnmount(() => listen(false))

function panelStyle(): Record<string, string> {
  const at = placement.value
  if (at === null) return {}
  return { top: `${at.top}px`, left: `${at.left}px`, maxHeight: `${at.maxHeight}px` }
}
</script>

<template>
  <div ref="root" class="tp">
    <slot name="trigger" :open="open" :toggle="toggle" />
    <Teleport to="body">
      <div v-if="open" class="tp-backdrop" aria-hidden="true"></div>
      <div
        v-if="open"
        v-vertical-scroll-boundary
        ref="panel"
        class="tp-panel"
        :class="[props.align, { placed: placement !== null, above: placement?.side === 'above' }]"
        role="dialog"
        :aria-label="props.label"
        :style="panelStyle()"
        data-popover
      >
        <p class="tp-title">{{ props.label }}</p>
        <slot :close="() => (open = false)" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tp { position: relative; display: inline-flex; min-width: 0; }
/* Fixed layer above every dialog (FuturesDialog backdrop is z-index 200). Hidden until placed (no flash at 0,0). */
.tp-panel {
  position: fixed; top: 0; left: 0; z-index: 1100; box-sizing: border-box;
  width: max-content; min-width: 200px; max-width: min(320px, calc(100vw - 16px)); overflow-y: auto;
  padding: 6px; border: 1px solid var(--color-border-strong); border-radius: 12px; background: var(--color-elevated);
  color: var(--color-text); box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.45); visibility: hidden;
}
.tp-panel.placed { visibility: visible; }
.tp-backdrop, .tp-title { display: none; }
@media (max-width: 640px) {
  .tp-backdrop { display: block; position: fixed; inset: 0; z-index: 1099; background: rgba(0, 0, 0, 0.45); }
  .tp-panel, .tp-panel.left, .tp-panel.right {
    inset: auto 0 0 0; top: auto !important; left: 0 !important; width: auto; min-width: 0; max-width: none; max-height: 70vh !important;
    padding: 8px 12px calc(12px + env(safe-area-inset-bottom)); border-radius: 16px 16px 0 0; border-width: 1px 0 0; visibility: visible;
  }
  .tp-title { display: block; margin: 6px 10px 8px; font-size: 16px; font-weight: 700; color: var(--color-text); }
}
</style>
