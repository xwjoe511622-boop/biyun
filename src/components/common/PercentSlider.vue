<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * Binance-style percentage slider: drag the thumb (mouse/touch/pen), click anywhere on the rail,
 * click one of the diamond marks (0/25/50/75/100) or use the keyboard (←/→ 1%, PgUp/PgDn 10%,
 * Home/End). Emits integer percentages 0–100; `update:modelValue` fires while dragging and `change`
 * once when the interaction ends, so callers can recompute amounts live without spamming APIs.
 */
const props = withDefaults(defineProps<{
  modelValue: number
  disabled?: boolean
  tone?: 'up' | 'down' | 'accent'
  snapTaps?: boolean
  marks?: number[]
  label?: string
}>(), { disabled: false, tone: 'accent', marks: () => [0, 25, 50, 75, 100], label: 'Percentage' })

const emit = defineEmits<{ 'update:modelValue': [value: number]; change: [value: number] }>()

const rail = ref<HTMLDivElement>()
const dragging = ref(false)
const value = computed(() => Math.max(0, Math.min(100, Math.round(props.modelValue || 0))))

function fromPointer(clientX: number): number {
  const box = rail.value?.getBoundingClientRect()
  if (box === undefined || box.width <= 0) return value.value
  return Math.round(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * 100)
}

/** Last value this slider emitted during a press: the prop only catches up after the parent re-renders. */
let live = 0

function set(next: number, commit: boolean): void {
  const clamped = Math.max(0, Math.min(100, Math.round(next)))
  live = clamped
  if (clamped !== value.value) emit('update:modelValue', clamped)
  if (commit) emit('change', clamped)
}

/** A press without movement (a plain click) keeps the value it picked (an exact mark), not the pointer's rounding. */
let moved = false
let startX = 0

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  const tolerance = props.snapTaps && event.pointerType === 'touch' ? 5 : 2
  if (Math.abs(event.clientX - startX) > tolerance) moved = true
  if (moved) set(fromPointer(event.clientX), false)
}

function stop(event?: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stop)
  window.removeEventListener('pointercancel', stop)
  set(event === undefined || !moved ? live : fromPointer(event.clientX), true)
}

/*
 * A press on a diamond mark picks that mark exactly AND starts a drag. The thumb (pointer-events: none) always rests on
 * a mark at 0/25/50/75/100, so a mark that swallowed the press (the old `pointerdown.stop`) made the thumb undraggable
 * there: dragging it from 0% on the 平仓 tab left 0%, 平多 stayed disabled and "nothing happened" (2026-09-30 owner bug).
 */
function onPointerDown(event: PointerEvent, mark?: number): void {
  if (props.disabled || event.button > 0) return
  event.preventDefault()
  dragging.value = true
  moved = false
  startX = event.clientX
  let picked = mark ?? fromPointer(event.clientX)
  if (props.snapTaps && mark === undefined && rail.value && window.matchMedia('(max-width: 768px)').matches) {
    const box = rail.value.getBoundingClientRect()
    const nearest = props.marks.reduce<number | undefined>((best, tick) =>
      best === undefined || Math.abs(tick - picked) < Math.abs(best - picked) ? tick : best, undefined)
    if (nearest !== undefined && Math.abs(event.clientX - box.left - box.width * nearest / 100) <= 8) picked = nearest
  }
  set(picked, false)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

function onKey(event: KeyboardEvent): void {
  if (props.disabled) return
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }
  if (event.key in steps) set(value.value + steps[event.key], true)
  else if (event.key === 'Home') set(0, true)
  else if (event.key === 'End') set(100, true)
  else return
  event.preventDefault()
}

function pick(mark: number): void {
  if (!props.disabled) set(mark, true)
}

onBeforeUnmount(() => stop())
</script>

<template>
  <div class="pct" :class="[`tone-${tone}`, { disabled, dragging }]">
    <div
      ref="rail"
      class="pct-rail"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      :aria-label="label"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="value"
      :aria-valuetext="`${value}%`"
      :aria-disabled="disabled"
      @pointerdown="onPointerDown"
      @keydown="onKey"
    >
      <span class="pct-track"><i :style="{ width: `${value}%` }"></i></span>
      <button
        v-for="mark in marks"
        :key="mark"
        class="pct-mark"
        :class="{ reached: value >= mark && value > 0 }"
        :style="{ left: `${mark}%` }"
        type="button"
        tabindex="-1"
        :aria-label="`${mark}%`"
        :disabled="disabled"
        @pointerdown.stop="onPointerDown($event, mark)"
      ></button>
      <span class="pct-thumb" :style="{ left: `${value}%` }"></span>
      <span class="pct-tip num" :style="{ left: `${value}%` }">{{ value }}%</span>
    </div>
    <div class="pct-labels">
      <button v-for="mark in marks" :key="mark" type="button" class="pct-label num" :style="{ left: `${mark}%` }" :disabled="disabled" @click="pick(mark)">{{ mark }}%</button>
    </div>
  </div>
</template>

<style scoped>
.pct { --tone: var(--color-accent); position: relative; padding: 10px 7px 0; user-select: none; touch-action: none; container-type: inline-size; }
.tone-up { --tone: var(--color-up); }
.tone-down { --tone: var(--color-down); }
.pct-rail { position: relative; height: 16px; cursor: pointer; outline: none; }
.pct.disabled .pct-rail { cursor: not-allowed; opacity: 0.5; }
.pct-track { position: absolute; left: 0; right: 0; top: 7px; height: 3px; border-radius: 3px; background: var(--color-border-strong); overflow: hidden; }
.pct-track i { display: block; height: 100%; background: var(--tone); transition: width 0.12s var(--ease-out); }
.pct.dragging .pct-track i { transition: none; }
.pct-mark {
  position: absolute; top: 3px; width: 10px; height: 10px; margin-left: -5px; padding: 0;
  transform: rotate(45deg); border: 2px solid var(--color-border-strong); border-radius: 2px;
  background: var(--color-surface); cursor: pointer; transition: border-color 0.15s, background-color 0.15s;
}
.pct-mark.reached { border-color: var(--tone); background: var(--tone); }
.pct-thumb {
  position: absolute; top: 1px; width: 14px; height: 14px; margin-left: -7px;
  transform: rotate(45deg); border: 3px solid var(--tone); border-radius: 3px; background: var(--color-surface);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone) 18%, transparent); transition: left 0.12s var(--ease-out), box-shadow 0.15s;
  pointer-events: none;
}
.pct.dragging .pct-thumb, .pct.dragging .pct-tip { transition: none; }
.pct.dragging .pct-thumb { box-shadow: 0 0 0 6px color-mix(in srgb, var(--tone) 24%, transparent); }
.pct-tip {
  position: absolute; bottom: 20px; transform: translateX(-50%);
  padding: 2px 6px; border-radius: 5px; background: var(--color-elevated); border: 1px solid var(--color-border-strong);
  color: var(--color-text); font-size: 11px; white-space: nowrap; opacity: 0; transition: opacity 0.12s, left 0.12s var(--ease-out); pointer-events: none; z-index: 2;
}
.pct-rail:hover .pct-tip, .pct-rail:focus-visible .pct-tip, .pct.dragging .pct-tip { opacity: 1; }
.pct-rail:focus-visible .pct-thumb { box-shadow: 0 0 0 4px var(--color-accent-soft), 0 0 0 1px var(--color-accent); }
.pct-labels { position: relative; height: 16px; margin-top: 2px; }
.pct-label { position: absolute; transform: translateX(-50%); padding: 0 2px; color: var(--color-text-muted); font-size: 10px; line-height: 16px; }
.pct-label:first-child { transform: none; }
.pct-label:last-child { transform: translateX(-100%); }
.pct-label:hover:not(:disabled) { color: var(--color-text); }
/* Short rails (phone tickets): "75%" ran into "100%"; keep 0 / 50 / 100 (the marks still snap to 25 and 75). */
@container (max-width: 230px) {
  .pct-label:nth-child(2), .pct-label:nth-child(4) { visibility: hidden; }
}
</style>
