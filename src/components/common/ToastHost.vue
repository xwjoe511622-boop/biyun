<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, CircleCheck, Info, X } from '@lucide/vue'
import { dismissToast, useToasts, type Toast } from '@/core/toast'

/**
 * Fixed, top-centre toast stack (see `@/core/toast`). Out of the page flow, so showing or expiring a message never
 * moves the trading panels. Success/info auto-dismiss after ~3 s, errors after ~5 s; hovering pauses the timer.
 * Screen readers: the stack is a polite live region, errors are `role="alert"`.
 */
const { t } = useI18n()
const toasts = useToasts()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function arm(toast: Toast): void {
  if (timers.has(toast.id)) return
  timers.set(toast.id, setTimeout(() => {
    timers.delete(toast.id)
    dismissToast(toast.id)
  }, toast.timeout))
}

function pause(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
}

function resume(toast: Toast): void {
  arm({ ...toast, timeout: Math.min(toast.timeout, 1500) })
}

function close(id: number): void {
  pause(id)
  dismissToast(id)
}

watch(toasts, (list) => {
  const live = new Set(list.map((toast) => toast.id))
  for (const [id, timer] of timers) if (!live.has(id)) { clearTimeout(timer); timers.delete(id) }
  list.forEach(arm)
}, { immediate: true })

onBeforeUnmount(() => {
  timers.forEach((timer) => clearTimeout(timer))
  timers.clear()
})

const visible = ref(typeof document === 'undefined' || document.visibilityState === 'visible')
const onVisibility = (): void => { visible.value = document.visibilityState === 'visible' }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
onBeforeUnmount(() => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-relevant="additions" data-testid="toast-host">
    <!-- Animate only while the page is visible: in a background tab CSS transitions never finish and leaving toasts would stay in the DOM. -->
    <TransitionGroup name="toast" :css="visible">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :class="toast.tone"
        :role="toast.tone === 'error' ? 'alert' : 'status'"
        :data-testid="`toast-${toast.tone}`"
        @mouseenter="pause(toast.id)"
        @mouseleave="resume(toast)"
      >
        <CircleCheck v-if="toast.tone === 'success'" :size="16" aria-hidden="true" />
        <CircleAlert v-else-if="toast.tone === 'error'" :size="16" aria-hidden="true" />
        <Info v-else :size="16" aria-hidden="true" />
        <span class="toast-text wrap-anywhere">{{ toast.message }}</span>
        <button class="toast-close" type="button" :title="t('common.close')" :aria-label="t('common.close')" @click="close(toast.id)"><X :size="14" /></button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed; top: 68px; left: 50%; z-index: 1000; display: flex; flex-direction: column; align-items: center; gap: 8px;
  width: min(440px, calc(100vw - 32px)); transform: translateX(-50%); pointer-events: none;
}
.toast {
  display: flex; align-items: flex-start; gap: 8px; max-width: 100%; padding: 10px 10px 10px 12px; pointer-events: auto;
  border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-elevated); color: var(--color-text);
  box-shadow: var(--shadow-pop); font-size: 13px; line-height: 18px;
}
.toast > svg { flex: 0 0 auto; margin-top: 1px; }
.toast.success > svg { color: var(--color-up); }
.toast.error { border-color: var(--color-down-soft); }
.toast.error > svg { color: var(--color-down); }
.toast.info > svg { color: var(--color-accent-text); }
.toast-text { flex: 1 1 auto; min-width: 0; }
.toast-close { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 20px; height: 20px; border-radius: 5px; color: var(--color-text-muted); }
.toast-close:hover { color: var(--color-text); background: var(--color-hover); }
/* opacity/transform only, so entering and leaving toasts never register as layout shifts */
.toast-enter-active, .toast-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }
.toast-leave-active { position: absolute; }
.toast-move { transition: transform 0.18s ease; }
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active, .toast-leave-active, .toast-move { transition: none; }
}
</style>
