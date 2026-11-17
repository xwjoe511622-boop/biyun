<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { Check, Copy } from '@lucide/vue'
import { useWalletI18n } from '@/modules/wallet/i18n'

const props = withDefaults(defineProps<{
  value: string
  /** Visible label; defaults to "Copy". */
  label?: string
  /** Icon-only button (the label becomes the accessible name). */
  compact?: boolean
  /** Prominent filled style for the main address card. */
  strong?: boolean
}>(), { label: '', compact: false, strong: false })
const { t } = useWalletI18n()

const copied = ref(false)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(area)
  return ok
}

async function copy(): Promise<void> {
  const text = props.value
  if (text === '') {
    return
  }
  let ok = false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) {
    ok = legacyCopy(text)
  }
  copied.value = ok
  failed.value = !ok
  if (timer !== null) {
    clearTimeout(timer)
  }
  timer = setTimeout(() => {
    copied.value = false
    failed.value = false
  }, 1500)
}

onBeforeUnmount(() => {
  if (timer !== null) {
    clearTimeout(timer)
  }
})
</script>

<template>
  <button
    class="btn copy-btn"
    :class="{ 'btn-ghost': !strong, strong, compact, copied }"
    type="button"
    :disabled="value === ''"
    :aria-label="compact ? (copied ? t('wallet.deposit.copied') : (label || t('wallet.deposit.copy'))) : undefined"
    :title="compact ? (label || t('wallet.deposit.copy')) : undefined"
    @click="copy"
  >
    <Check v-if="copied" :size="compact ? 14 : 13" aria-hidden="true" />
    <Copy v-else :size="compact ? 14 : 13" aria-hidden="true" />
    <template v-if="!compact">{{ copied ? t('wallet.deposit.copied') : (label || t('wallet.deposit.copy')) }}</template>
  </button>
  <span class="sr-only" role="status" aria-live="polite">{{ failed ? t('wallet.deposit.copyFailed') : '' }}</span>
</template>

<style scoped>
.copy-btn {
  height: 26px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
}

.copy-btn.compact {
  width: 28px;
  height: 28px;
  padding: 0;
  flex: 0 0 28px;
}

.copy-btn.strong {
  height: 40px;
  padding: 0 16px;
  font-size: var(--font-size-sm);
}

.copy-btn.copied {
  color: var(--color-up);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
