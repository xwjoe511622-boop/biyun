<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { prefersReducedMotion } from './fx'

/**
 * Shows `value` (a server figure such as `128`, `100x`, `1.25B`) and, the first time a real figure is on
 * screen, counts up to it once (~1.1 s). Afterwards it shows `value` verbatim, live. Never invents a number:
 * the count only runs from 0 to the figure already received, and `--` is shown as is.
 * float-ok: the count-up interpolates a display string only (money-precision rule, display-only).
 */
const props = defineProps<{ value: string }>()

const el = ref<HTMLElement | null>(null)
const shown = ref(props.value)
let state: 'idle' | 'running' | 'done' = 'idle'
let visible = false
let frame = 0
let io: IntersectionObserver | null = null

const PARTS = /^([^\d]*)(\d+(?:\.(\d+))?)(.*)$/

function start(): void {
  const match = PARTS.exec(props.value)
  if (state !== 'idle' || !visible || match === null) return
  state = 'running'
  const begin = performance.now()
  const step = (now: number): void => {
    const m = PARTS.exec(props.value)
    const k = Math.min(1, (now - begin) / 1100)
    if (m === null || k >= 1) {
      state = 'done'
      shown.value = props.value
      return
    }
    const dp = m[3]?.length ?? 0
    // float-ok: display-only easing of a counter.
    const target = Number(m[2])
    const eased = 1 - Math.pow(1 - k, 4)
    shown.value = `${m[1]}${(target * eased).toFixed(dp)}${m[4]}`
    frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
}

watch(
  () => props.value,
  (next) => {
    if (state !== 'running') shown.value = next
    start()
  },
)

onMounted(() => {
  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined' || el.value === null) {
    state = 'done'
    return
  }
  io = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      visible = true
      io?.disconnect()
      start()
    }
  })
  io.observe(el.value)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  io?.disconnect()
})
</script>

<template>
  <span ref="el">{{ shown }}</span>
</template>
