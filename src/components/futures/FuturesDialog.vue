<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from '@lucide/vue'
import { useFuturesI18n } from '@/modules/futures/i18n'

/** Modal shell for the futures dialogs: backdrop click / Escape close, focus moves into the panel. */
const props = withDefaults(defineProps<{ title: string; width?: number; busy?: boolean }>(), { width: 420, busy: false })
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLDivElement>()
const { t } = useFuturesI18n()

function close(): void {
  if (!props.busy) emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
  void nextTick(() => panel.value?.focus())
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fd-backdrop" @mousedown.self="close">
      <div ref="panel" class="fd-panel" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" :style="{ '--fd-width': `${width}px` }">
        <header class="fd-head">
          <h3>{{ title }}</h3>
          <button class="fd-close" type="button" :aria-label="t('fut.cancel')" :disabled="busy" @click="close"><X :size="16" /></button>
        </header>
        <div v-vertical-scroll-boundary class="fd-body"><slot /></div>
        <footer v-if="$slots.footer" class="fd-foot"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fd-backdrop {
  position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(3, 5, 8, 0.62); backdrop-filter: blur(3px); animation: fd-fade 0.16s ease-out;
}
.fd-panel {
  width: min(var(--fd-width), 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; outline: none;
  border: 1px solid var(--color-border-strong); border-radius: 16px; background: var(--color-elevated);
  box-shadow: var(--shadow-pop); animation: rise-in 0.2s var(--ease-out);
}
.fd-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 6px; }
.fd-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.fd-close { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; color: var(--color-text-muted); }
.fd-close:hover:not(:disabled) { background: var(--color-hover); color: var(--color-text); }
.fd-body { padding: 10px 18px 16px; overflow-y: auto; }
.fd-foot { display: flex; gap: 10px; padding: 0 18px 18px; }
.fd-foot :deep(.btn) { flex: 1; height: 42px; border-radius: 10px; }
@keyframes fd-fade { from { opacity: 0; } to { opacity: 1; } }
</style>
