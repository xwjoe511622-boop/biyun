<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { X } from '@lucide/vue'

/**
 * Minimal accessible modal used by the transfer, borrow and repay dialogs:
 * teleported to <body>, `role="dialog"` + `aria-modal`, Escape / backdrop close, focus moves into the
 * dialog on open and returns to the previously focused element on close.
 */
const props = withDefaults(defineProps<{ open: boolean; title: string; width?: string; closeLabel?: string }>(), {
  width: '440px',
  closeLabel: 'Close',
})
const emit = defineEmits<{ (event: 'close'): void }>()

const panel = ref<HTMLElement | null>(null)
const titleId = `dialog-title-${useId()}`
let previous: HTMLElement | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || panel.value === null) return

  const targets = Array.from(panel.value.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
  )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
    && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden')
  const first = targets[0]
  const last = targets.at(-1)
  if (!first || !last) {
    event.preventDefault()
    panel.value.focus()
  } else if (!targets.includes(document.activeElement as HTMLElement)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, (open) => {
  if (open) {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void nextTick(() => {
      const target = panel.value?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled]):not(.dialog-close)')
      ;(target ?? panel.value)?.focus()
    })
  } else if (previous !== null) {
    previous.focus()
    previous = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  previous = null
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-backdrop" @mousedown.self="emit('close')" @keydown="onKeydown">
      <section
        ref="panel"
        class="dialog-panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        :style="{ '--dialog-width': width }"
      >
        <header class="dialog-head">
          <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
          <button class="icon-button dialog-close" type="button" :aria-label="closeLabel" :title="closeLabel" @click="emit('close')">
            <X :size="16" aria-hidden="true" />
          </button>
        </header>
        <div class="dialog-body"><slot /></div>
        <footer v-if="$slots.footer" class="dialog-foot"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(3, 5, 8, 0.58); backdrop-filter: blur(3px); animation: fade-in 0.16s var(--ease-out);
}
.dialog-panel {
  width: min(var(--dialog-width), 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--color-border-strong); border-radius: 16px; background: var(--color-elevated); box-shadow: var(--shadow-pop);
  animation: rise-in 0.2s var(--ease-out); outline: none;
}
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 12px 12px 20px; }
.dialog-title { margin: 0; font-size: 17px; font-weight: 700; }
.dialog-close { width: 32px; height: 32px; flex-basis: 32px; }
.dialog-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 20px 16px; overflow-y: auto; }
.dialog-foot { display: flex; gap: 10px; padding: 14px 20px 18px; border-top: 1px solid var(--color-border); }
.dialog-foot :deep(.btn) { flex: 1 1 0; height: 42px; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 480px) {
  .dialog-backdrop { align-items: flex-end; padding: 0; }
  .dialog-panel { width: 100%; border-radius: 16px 16px 0 0; max-height: 92vh; }
}
</style>
