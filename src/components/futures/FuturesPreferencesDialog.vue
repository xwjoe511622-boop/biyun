<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toastSuccess } from '@/core/toast'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { usePositionMode, type PositionMode } from '@/modules/futures/position-mode'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useSessionStore } from '@/stores/session'
import FuturesDialog from './FuturesDialog.vue'

/**
 * 偏好设置 → 持仓模式 (Binance: settings icon › Preferences › Position Mode). Hedge (双向) is the default; One-way (单向) is
 * mapped in the browser (`position-mode.ts`). Like Binance, the mode cannot change while any position or order exists:
 * the server's `positionModelCanSwitch` (all contracts, re-read when the dialog opens) plus the positions loaded here.
 */
const emit = defineEmits<{ close: [] }>()
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()
const sessionStore = useSessionStore()
const positionMode = usePositionMode(() => sessionStore.user?.id)

const choice = ref<PositionMode>(positionMode.mode.value)
const checking = ref(true)
const blocked = ref(false)

const canSwitch = computed(() => !checking.value && account.config?.positionModelCanSwitch === true && account.positions.length === 0)

onMounted(async () => {
  try {
    await account.loadConfig(false)
  } finally {
    checking.value = false
  }
})

function save(): void {
  if (choice.value === positionMode.mode.value) {
    emit('close')
    return
  }
  if (!canSwitch.value) {
    blocked.value = true
    return
  }
  if (positionMode.setMode(choice.value)) {
    toastSuccess(t('fut.pm.switched', { mode: t(`fut.pm.${choice.value}`) }), 'fut-prefs')
    emit('close')
  }
}

const options: { value: PositionMode; desc: string }[] = [
  { value: 'oneWay', desc: 'fut.pm.oneWayDesc' },
  { value: 'hedge', desc: 'fut.pm.hedgeDesc' },
]
</script>

<template>
  <FuturesDialog :title="t('fut.pm.settings')" @close="emit('close')">
    <p class="section">{{ t('fut.pm.mode') }}</p>
    <div class="modes" role="radiogroup" :aria-label="t('fut.pm.mode')">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="radio"
        class="mode"
        :class="{ active: choice === option.value }"
        :aria-checked="choice === option.value"
        :data-testid="`fut-pm-${option.value}`"
        @click="choice = option.value; blocked = false"
      >
        <b>{{ t(`fut.pm.${option.value}`) }}<small v-if="positionMode.mode.value === option.value">{{ t('fut.pm.current') }}</small></b>
        <span>{{ t(option.desc) }}</span>
      </button>
    </div>
    <p v-if="checking" class="notice" data-testid="fut-pm-checking">{{ t('fut.pm.checking') }}</p>
    <p v-else-if="blocked || (!canSwitch && choice !== positionMode.mode.value)" class="notice notice-error" data-testid="fut-pm-blocked">{{ t('fut.pm.cannotSwitch') }}</p>
    <p class="note">{{ t('fut.pm.storedNote') }}</p>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">{{ t('fut.cancel') }}</button>
      <button class="btn btn-primary" type="button" data-testid="fut-pm-save" :disabled="checking || (choice !== positionMode.mode.value && !canSwitch)" @click="save">{{ t('fut.confirm') }}</button>
    </template>
  </FuturesDialog>
</template>

<style scoped>
.section { margin: 0 0 8px; font-size: 13px; font-weight: 650; }
.modes { display: grid; gap: 10px; }
.mode { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px solid var(--color-border-strong); border-radius: 12px; text-align: left; transition: border-color 0.15s, background-color 0.15s; }
.mode b { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.mode small { padding: 0 6px; border-radius: 4px; background: var(--color-surface-alt); color: var(--color-text-muted); font-size: 11px; font-weight: 500; }
.mode span { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.mode:hover { border-color: var(--color-text-muted); }
.mode.active { border-color: var(--color-accent); background: var(--color-accent-soft); }
.mode.active b { color: var(--color-accent-text); }
.notice { margin: 12px 0 0; }
.note { margin: 12px 0 0; color: var(--color-text-muted); font-size: 11px; line-height: 1.5; }
</style>
