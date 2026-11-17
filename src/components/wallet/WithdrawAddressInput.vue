<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { BookUser, ChevronDown, ClipboardPaste, ShieldCheck } from '@lucide/vue'
import { sameAddress, shortAddress } from '@/modules/wallet/evm'
import { useWalletI18n } from '@/modules/wallet/i18n'
import type { WalletAddress } from '@/modules/wallet/types'

/**
 * Withdrawal address field: free text (paste or type) plus a dropdown of the addresses already saved
 * for the selected network. Picking a saved address only fills the text; the parent decides the mode
 * (saved vs direct) from the text, so a pasted address that is already saved counts as saved too.
 */
const props = withDefaults(defineProps<{
  modelValue: string
  saved: WalletAddress[]
  label: string
  placeholder: string
  networkLabel: string
  /** Contract v2: saved addresses skip the email code, so they carry the "verified" badge. */
  verified: boolean
  invalid?: boolean
  disabled?: boolean
}>(), { invalid: false, disabled: false })
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void; (event: 'manage'): void; (event: 'blur'): void }>()
const { t } = useWalletI18n()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const listId = `saved-list-${useId()}`
const clipboardReadable = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

const area = ref<HTMLTextAreaElement | null>(null)

/** Grow the textarea with the address so long addresses wrap instead of scrolling sideways. */
function fit(): void {
  const el = area.value
  if (el === null) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
watch(() => props.modelValue, () => { void nextTick(fit) })
onMounted(fit)

const current = computed(() => props.saved.find(entry => sameAddress(entry.address, props.modelValue)))

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value.replace(/\s+/g, ''))
}

function pick(entry: WalletAddress): void {
  emit('update:modelValue', entry.address)
  open.value = false
}

async function paste(): Promise<void> {
  try {
    const value = await navigator.clipboard.readText()
    if (value.trim() !== '') emit('update:modelValue', value.trim())
  } catch {
    // Clipboard read denied: the user can still paste with the keyboard.
  }
}

function onFocus(): void {
  if (props.modelValue.trim() === '' && props.saved.length > 0) open.value = true
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
  if (event.key === 'Enter') event.preventDefault()
}

function onDocument(event: MouseEvent): void {
  if (open.value && root.value !== null && !root.value.contains(event.target as Node)) open.value = false
}
document.addEventListener('mousedown', onDocument)
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocument))
</script>

<template>
  <div ref="root" class="addr-field">
    <div class="addr-box" :class="{ invalid, focused: open }">
      <textarea
        ref="area"
        class="addr-input num"
        :value="modelValue"
        rows="1"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        :aria-label="label"
        :aria-invalid="invalid"
        :placeholder="placeholder"
        :disabled="disabled"
        data-testid="withdraw-address"
        @input="onInput"
        @focus="onFocus"
        @blur="emit('blur')"
        @keydown="onKeydown"
      />
      <span class="addr-tools">
        <button v-if="clipboardReadable && modelValue === ''" class="tool" type="button" :disabled="disabled" @click="paste">
          <ClipboardPaste :size="14" aria-hidden="true" />{{ t('wallet.wd.paste') }}
        </button>
        <button
          class="tool"
          type="button"
          aria-haspopup="listbox"
          :aria-expanded="open"
          :aria-controls="listId"
          :disabled="disabled"
          data-testid="saved-toggle"
          @click="open = !open"
        >
          <BookUser :size="14" aria-hidden="true" />{{ t('wallet.wd.saved') }}<span v-if="saved.length > 0" class="count">{{ saved.length }}</span>
          <ChevronDown :size="13" aria-hidden="true" />
        </button>
      </span>
    </div>
    <p v-if="current !== undefined && current.label !== ''" class="addr-label">
      <ShieldCheck v-if="verified" :size="13" aria-hidden="true" />{{ current.label }}
    </p>

    <div v-if="open" class="saved-pop">
      <header class="saved-head">
        <span>{{ t('wallet.wd.savedTitle', { network: networkLabel }) }}</span>
        <button class="saved-manage" type="button" @click="open = false; emit('manage')">{{ t('wallet.wd.manageBook') }}</button>
      </header>
      <ul :id="listId" class="saved-list" role="listbox" :aria-label="t('wallet.wd.savedTitle', { network: networkLabel })">
        <li
          v-for="entry in saved"
          :key="entry.id"
          class="saved-option"
          role="option"
          :aria-selected="sameAddress(entry.address, modelValue)"
          tabindex="0"
          :data-address-id="entry.id"
          @mousedown.prevent
          @click="pick(entry)"
          @keydown.enter.prevent="pick(entry)"
        >
          <span class="saved-top">
            <span class="saved-name">{{ entry.label || shortAddress(entry.address) }}</span>
            <span class="saved-badge" :class="{ verified }">
              <ShieldCheck v-if="verified" :size="11" aria-hidden="true" />{{ verified ? t('wallet.wd.verifiedBadge') : t('wallet.wd.savedBadge') }}
            </span>
          </span>
          <span class="saved-addr num">{{ entry.address }}{{ entry.tag !== '' ? ` / ${entry.tag}` : '' }}</span>
        </li>
        <li v-if="saved.length === 0" class="saved-empty">{{ t('wallet.wd.savedEmpty') }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.addr-field { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.addr-box {
  display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 6px 8px 6px 14px;
  border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt);
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}
.addr-box:hover { border-color: var(--color-text-muted); }
.addr-box:focus-within, .addr-box.focused { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); background: var(--color-surface); }
.addr-box.invalid { border-color: var(--color-down); box-shadow: 0 0 0 3px var(--color-down-soft); }
.addr-input {
  flex: 1 1 auto; min-width: 0; min-height: 22px; padding: 8px 0; border: 0; outline: 0; resize: none; overflow: hidden;
  background: transparent; color: var(--color-text); font-family: var(--font-mono); font-size: 14px; line-height: 1.45;
  width: 100%; white-space: pre-wrap; word-break: break-all;
}
.addr-input::placeholder { color: var(--color-text-muted); font-family: var(--font-sans); }
.addr-tools { display: inline-flex; flex: 0 0 auto; gap: 2px; }
.tool {
  display: inline-flex; align-items: center; gap: 5px; height: 34px; padding: 0 10px; border-radius: 7px;
  color: var(--color-text-secondary); font-size: 12.5px; font-weight: 600; white-space: nowrap;
}
.tool:hover:not(:disabled) { background: var(--color-hover); color: var(--color-text); }
.count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 11px; }
.addr-label { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--color-up); font-size: 12px; font-weight: 600; }

.saved-pop {
  position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; right: 0; overflow: hidden;
  border: 1px solid var(--color-border-strong); border-radius: 12px; background: var(--color-elevated); box-shadow: var(--shadow-pop);
}
.saved-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px 6px; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.saved-manage { color: var(--color-accent-text); font-size: 12px; font-weight: 600; }
.saved-list { max-height: 280px; margin: 0; padding: 0 6px 6px; overflow-y: auto; list-style: none; }
.saved-option { display: flex; flex-direction: column; gap: 3px; padding: 10px; border-radius: 8px; cursor: pointer; outline: none; }
.saved-option:hover, .saved-option:focus-visible, .saved-option[aria-selected='true'] { background: var(--color-hover); }
.saved-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.saved-name { font-size: 13.5px; font-weight: 650; }
.saved-badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 10.5px; font-weight: 650; white-space: nowrap; }
.saved-badge.verified { background: var(--color-up-soft); color: var(--color-up); }
.saved-addr { white-space: normal; color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 12px; word-break: break-all; }
.saved-empty { padding: 16px; color: var(--color-text-muted); font-size: 12.5px; text-align: center; }
@media (max-width: 520px) {
  .addr-box { flex-wrap: wrap; padding: 6px 8px 6px 12px; }
  .addr-input { flex-basis: 100%; }
  .addr-tools { width: 100%; justify-content: flex-end; }
  .tool { height: 30px; }
}
</style>
