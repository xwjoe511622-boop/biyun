<script setup lang="ts">
import { ref } from 'vue'
import { CircleCheck } from '@lucide/vue'
import type { NetworkChoice } from '@/modules/wallet/networks'

/**
 * Network cards (radio group). Every detail line comes from the caller, i.e. from server data
 * (confirmations from the deposit address, fee from the withdraw config); nothing is estimated here.
 */
const props = withDefaults(defineProps<{
  choices: NetworkChoice[]
  modelValue: string
  label: string
  details?: Record<string, string[]>
  disabled?: boolean
}>(), { details: () => ({}), disabled: false })
const emit = defineEmits<{ (event: 'update:modelValue', id: string): void }>()
const group = ref<HTMLElement | null>(null)

function select(id: string): void {
  if (!props.disabled && id !== props.modelValue) emit('update:modelValue', id)
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']
  if (!keys.includes(event.key) || props.choices.length === 0) return
  event.preventDefault()
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
  const next = (index + step + props.choices.length) % props.choices.length
  select(props.choices[next].id)
  group.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
}
</script>

<template>
  <div ref="group" class="net-grid" role="radiogroup" :aria-label="label" data-testid="network-picker">
    <button
      v-for="(choice, index) in choices"
      :key="choice.id"
      class="net-card"
      :class="{ active: choice.id === modelValue }"
      type="button"
      role="radio"
      :aria-checked="choice.id === modelValue"
      :tabindex="choice.id === modelValue || (modelValue === '' && index === 0) ? 0 : -1"
      :disabled="disabled"
      :data-network="choice.id"
      @click="select(choice.id)"
      @keydown="onKeydown($event, index)"
    >
      <span class="net-top">
        <span class="net-name">{{ choice.label }}</span>
        <CircleCheck v-if="choice.id === modelValue" class="net-check" :size="16" aria-hidden="true" />
      </span>
      <span v-if="choice.code !== choice.label" class="net-code">{{ choice.code }}</span>
      <span v-for="line in details[choice.id] ?? []" :key="line" class="net-detail">{{ line }}</span>
    </button>
  </div>
</template>

<style scoped>
.net-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.net-card {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-height: 64px; padding: 12px 14px;
  border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt); color: var(--color-text); text-align: left;
  transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
}
.net-card:hover:not(:disabled) { border-color: var(--color-text-muted); }
.net-card:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--color-accent-soft); }
.net-card.active { border-color: var(--color-accent); background: var(--color-accent-soft); }
.net-card:disabled { opacity: 0.55; cursor: not-allowed; }
.net-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
.net-name { font-size: 14px; font-weight: 700; }
.net-check { flex: 0 0 auto; color: var(--color-accent-text); }
.net-code { color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
.net-detail { color: var(--color-text-muted); font-size: 12px; }
@media (max-width: 520px) { .net-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
