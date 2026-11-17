<script setup lang="ts">
/**
 * One 6-digit verification code input, optionally with a "send code" button. The countdown and the
 * send request are owned by the parent so one cooldown can guard every channel of a form.
 */
withDefaults(defineProps<{
  modelValue: string
  label: string
  sendLabel?: string
  canSend?: boolean
  sendable?: boolean
  disabled?: boolean
  invalid?: boolean
}>(), { sendLabel: '', canSend: false, sendable: false, disabled: false, invalid: false })
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void; (event: 'send'): void }>()

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement
  // Digits only, at most 6: pasted "123 456" or "123-456" still works.
  const digits = target.value.replace(/\D/g, '').slice(0, 6)
  if (digits !== target.value) target.value = digits
  emit('update:modelValue', digits)
}
</script>

<template>
  <label class="field code-field">
    <span class="field-label">{{ label }}</span>
    <span class="field-input" :class="{ invalid }">
      <input
        :value="modelValue"
        class="code-input num"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        :aria-label="label"
        :disabled="disabled"
        placeholder="······"
        @input="onInput"
      />
      <button
        v-if="sendable"
        class="send-btn"
        type="button"
        :disabled="!canSend || disabled"
        @click.prevent="emit('send')"
      >{{ sendLabel }}</button>
    </span>
  </label>
</template>

<style scoped>
.code-input { letter-spacing: 0.3em; font-size: 16px !important; font-family: var(--font-mono) !important; }
.code-input::placeholder { letter-spacing: 0.2em; }
.send-btn {
  flex: 0 0 auto; height: 30px; padding: 0 10px; border-radius: 6px; color: var(--color-accent-text); font-size: 13px; font-weight: 650;
}
.send-btn:hover:not(:disabled) { background: var(--color-accent-soft); }
.send-btn:disabled { color: var(--color-text-muted); cursor: not-allowed; }
</style>
