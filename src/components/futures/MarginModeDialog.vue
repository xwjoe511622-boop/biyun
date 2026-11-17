<script setup lang="ts">
import { computed, ref } from 'vue'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { useFuturesAccountStore } from '@/stores/futures-account'
import FuturesDialog from './FuturesDialog.vue'

/** Cross / isolated switch through `user/margin_model_edit` (1 cross, 2 isolated). */
const props = defineProps<{ current: 1 | 2; canSwitch: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()

const choice = ref<1 | 2>(props.current)
const error = ref<string | null>(null)
const saving = computed(() => account.busy === 'marginModel')

async function save(): Promise<void> {
  if (choice.value === props.current) {
    emit('close')
    return
  }
  error.value = null
  const result = await account.setMarginModel(choice.value)
  if (result === null) emit('close')
  else error.value = result
}
</script>

<template>
  <FuturesDialog :title="t('fut.marginModeTitle')" :busy="saving" @close="emit('close')">
    <div class="modes">
      <button type="button" class="mode" :class="{ active: choice === 1 }" :aria-pressed="choice === 1" :disabled="saving" @click="choice = 1">
        <b>{{ t('fut.cross') }}</b>
        <span>{{ t('fut.crossDesc') }}</span>
      </button>
      <button type="button" class="mode" :class="{ active: choice === 2 }" :aria-pressed="choice === 2" :disabled="saving" @click="choice = 2">
        <b>{{ t('fut.isolated') }}</b>
        <span>{{ t('fut.isolatedDesc') }}</span>
      </button>
    </div>
    <p v-if="!canSwitch" class="notice">{{ t('fut.modeLocked') }}</p>
    <p v-if="error !== null" class="notice notice-error wrap-anywhere">{{ error }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="saving" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="saving" @click="save">{{ saving ? t('fut.saving') : t('fut.confirm') }}</button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.modes { display: grid; gap: 10px; }
.mode { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px solid var(--color-border-strong); border-radius: 12px; text-align: left; transition: border-color 0.15s, background-color 0.15s; }
.mode b { font-size: 14px; }
.mode span { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.mode:hover:not(:disabled) { border-color: var(--color-text-muted); }
.mode.active { border-color: var(--color-accent); background: var(--color-accent-soft); }
.mode.active b { color: var(--color-accent-text); }
.notice { margin: 12px 0 0; }
</style>
