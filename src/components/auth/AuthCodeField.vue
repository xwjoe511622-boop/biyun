<script setup lang="ts">
import { computed } from 'vue'

// A 6-digit code input with a send button and cooldown, scoped to the auth flows.
//
// Presentation only: the parent owns the request, its generation/duplicate guard, the cooldown
// timer and which server `operationType` the code belongs to. The code value never leaves the
// parent component's memory.
const props = withDefaults(
  defineProps<{
    id: string
    label: string
    modelValue: string
    sendLabel: string
    sendingLabel: string
    /** Already-formatted cooldown label (e.g. "Resend in 42s"). */
    resendLabel: string
    placeholder?: string
    sending?: boolean
    cooldown?: number
    disabled?: boolean
    /** Hide the send button for factors that have no self-service code (Google TOTP). */
    hideSend?: boolean
  }>(),
  { placeholder: '', sending: false, cooldown: 0, disabled: false, hideSend: false },
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
      <div class="field-input">
        <input
          :id="id"
          :value="modelValue"
          type="text"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
          :placeholder="placeholder"
          :aria-label="label"
          :disabled="disabled"
          @input="onInput"
        />
      </div>
      <button
        v-if="!hideSend"
        class="btn send"
        type="button"
        :disabled="disabled || sending || cooldown > 0"
        @click="emit('send')"
      >
        {{ buttonLabel }}
      </button>
    </div>
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

.code-row .send {
  flex: 0 0 auto;
  white-space: nowrap;
}
</style>
