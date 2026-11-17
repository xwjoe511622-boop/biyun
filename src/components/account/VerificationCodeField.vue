<script setup lang="ts">
import { computed } from 'vue'

/**
 * A 6-digit verification-code input with a send button and cooldown.
 *
 * Presentation only: the parent owns the request, its generation/duplicate guard and the cooldown
 * timer, and decides which operation type the code belongs to. This keeps every action mode's OTP
 * separate instead of sharing one field across modes.
 */
const props = withDefaults(
  defineProps<{
    id: string
    label: string
    modelValue: string
    sendLabel: string
    sendingLabel: string
    /** Already-formatted cooldown label (e.g. "Resend in 42s"). */
    resendLabel: string
    sending?: boolean
    cooldown?: number
    disabled?: boolean
    invalid?: boolean
    error?: string
  }>(),
  { sending: false, cooldown: 0, disabled: false, invalid: false, error: '' },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'send'): void
}>()

const buttonLabel = computed(() => {
  if (props.sending) {
    return props.sendingLabel
  }
  if (props.cooldown > 0) {
    return props.resendLabel
  }
  return props.sendLabel
})

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <div class="field">
    <label class="field-label" :for="id">{{ label }}</label>
    <div class="code-row">
      <div class="field-input" :class="{ invalid }">
        <input
          :id="id"
          :value="modelValue"
          type="text"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
          :aria-label="label"
          :disabled="disabled"
          @input="onInput"
        />
      </div>
      <button
        class="btn"
        type="button"
        :disabled="disabled || sending || cooldown > 0"
        @click="emit('send')"
      >
        {{ buttonLabel }}
      </button>
    </div>
    <p v-if="error !== ''" class="field-error wrap-anywhere">{{ error }}</p>
  </div>
</template>

<style scoped>
.code-row {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
}

.code-row .field-input {
  flex: 1 1 auto;
  min-width: 0;
}

.code-row .btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
</style>
