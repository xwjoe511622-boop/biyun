<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from '@lucide/vue'

const { t: uiLabel } = useI18n({ useScope: 'global' })

/** Minimal accessible modal: focus moves in on open, Escape / backdrop close, focus returns on close. */
const props = withDefaults(defineProps<{ open: boolean; title: string; width?: string; busy?: boolean }>(), {
  width: '460px',
  busy: false,
})
const emit = defineEmits<{ (event: 'close'): void }>()

const panel = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
const titleId = `otc-dialog-${Math.random().toString(36).slice(2, 9)}`

function close(): void {
  if (!props.busy) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    const target = panel.value?.querySelector<HTMLElement>('input, textarea, select, button:not(.dialog-x)')
    ;(target ?? panel.value)?.focus()
  } else if (returnFocus !== null) {
    returnFocus.focus()
    returnFocus = null
  }
}, { immediate: true })

onBeforeUnmount(() => { returnFocus = null })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-backdrop" @mousedown.self="close" @keydown="onKeydown">
      <section
        ref="panel"
        class="dialog-panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        :style="{ width }"
      >
        <header class="dialog-head">
          <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
          <button class="icon-button dialog-x" type="button" :aria-label="uiLabel('accessibility.close')" :disabled="busy" @click="close">
            <X :size="18" />
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
  position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center;
  padding: 20px 16px; background: rgba(3, 5, 8, 0.62); backdrop-filter: blur(3px);
  animation: fade 0.18s var(--ease-out);
}
.dialog-panel {
  display: flex; flex-direction: column; max-width: 100%; max-height: calc(100vh - 40px); overflow: hidden;
  border: 1px solid var(--color-border-strong); border-radius: 18px; background: var(--color-elevated);
  box-shadow: var(--shadow-pop); animation: rise-in 0.24s var(--ease-out); outline: none;
}
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px 6px; }
.dialog-title { margin: 0; font-size: 18px; font-weight: 700; }
.dialog-body { padding: 10px 20px 18px; overflow-y: auto; }
.dialog-foot {
  display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px 18px;
  border-top: 1px solid var(--color-border);
}
.dialog-foot :deep(.btn) { min-width: 112px; height: 42px; }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 520px) {
  .dialog-backdrop { align-items: flex-end; padding: 0; }
  .dialog-panel { width: 100% !important; border-radius: 18px 18px 0 0; max-height: 92vh; }
  .dialog-foot :deep(.btn) { flex: 1; min-width: 0; }
}
</style>
