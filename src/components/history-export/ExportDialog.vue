<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FileDown } from '@lucide/vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { isApiError } from '@/core/errors'
import { toastSuccess } from '@/core/toast'
import {
  browserOffsetMin,
  createExport,
  isExportKind,
  localDayStartMs,
  presetRange,
  type ExportKind,
} from '@/modules/api/history-export.api'
import { zoneLabel } from './format'
import { useHistoryExportI18n } from './i18n'
import { useHistoryExport } from './state'

/**
 * Binance-style "Export history" dialog: record type, time range (past 3 / 6 / 12 months or a custom date range in
 * the device's zone), the limits, then Generate. The range is turned into UTC epoch ms here (the only conversion);
 * the file is built on the server and appears in the export records.
 */
const props = withDefaults(defineProps<{ open: boolean; kinds: readonly ExportKind[]; initialKind?: ExportKind; initialFrom?: string; initialTo?: string }>(), {
  initialKind: undefined,
  initialFrom: '',
  initialTo: '',
})
const emit = defineEmits<{ (event: 'close'): void; (event: 'created', id: string): void }>()

const { t } = useHistoryExportI18n()
const state = useHistoryExport()

type Preset = 'd90' | 'd180' | 'd365' | 'custom'
const PRESETS: Preset[] = ['d90', 'd180', 'd365', 'custom']
const kind = ref<ExportKind>(props.kinds[0] ?? 'spot_orders')
const preset = ref<Preset>('d90')
const from = ref('')
const to = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const offset = browserOffsetMin()

watch(() => props.open, (open) => {
  if (!open) return
  error.value = null
  kind.value = props.initialKind !== undefined && props.kinds.includes(props.initialKind) ? props.initialKind : (props.kinds[0] ?? 'spot_orders')
  if (props.initialFrom !== '') {
    preset.value = 'custom'
    from.value = props.initialFrom
    to.value = props.initialTo
  } else {
    preset.value = 'd90'
  }
  void state.loadInfo(true)
}, { immediate: true })

const maxDays = computed(() => state.info.value?.maxRangeDays ?? 366)

/** `[startTime, endTime)` in UTC ms, or an error key. */
const range = computed<{ startTime: number; endTime: number } | { error: 'badRange' | 'tooLong' }>(() => {
  if (preset.value !== 'custom') return presetRange(Number(preset.value.slice(1)), Date.now(), offset) // float-ok: not money (day count of the preset)
  const start = localDayStartMs(from.value, offset)
  const endDay = localDayStartMs(to.value, offset)
  if (start === null || endDay === null || endDay < start) return { error: 'badRange' }
  const endTime = endDay + 86_400_000
  if (endTime - start > maxDays.value * 86_400_000) return { error: 'tooLong' }
  return { startTime: start, endTime }
})
const rangeError = computed(() => ('error' in range.value ? (range.value.error === 'tooLong' ? t('hx.tooLong', { days: maxDays.value }) : t('hx.badRange')) : null))

async function submit(): Promise<void> {
  if (submitting.value || 'error' in range.value || !isExportKind(kind.value)) return
  submitting.value = true
  error.value = null
  try {
    const id = await createExport({ kind: kind.value, startTime: range.value.startTime, endTime: range.value.endTime, tzOffsetMin: offset })
    toastSuccess(t('hx.created'))
    void state.loadInfo(true)
    void state.loadRecords()
    emit('created', id)
    emit('close')
  } catch (error_) {
    error.value = isApiError(error_) || error_ instanceof Error ? error_.message : String(error_)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <DialogShell :open="open" :title="t('hx.title')" width="480px" @close="emit('close')">
    <label class="field">
      <span>{{ t('hx.kind') }}</span>
      <select v-model="kind" data-testid="hx-kind">
        <option v-for="entry in kinds" :key="entry" :value="entry">{{ t(`hx.kinds.${entry}`) }}</option>
      </select>
    </label>
    <div class="field">
      <span>{{ t('hx.range') }}</span>
      <div class="presets" role="radiogroup" :aria-label="t('hx.range')">
        <button
          v-for="entry in PRESETS"
          :key="entry"
          type="button"
          role="radio"
          class="chip"
          :class="{ active: preset === entry }"
          :aria-checked="preset === entry"
          :data-testid="`hx-preset-${entry}`"
          @click="preset = entry"
        >{{ t(`hx.presets.${entry}`) }}</button>
      </div>
    </div>
    <div v-if="preset === 'custom'" class="dates">
      <label class="field">
        <span>{{ t('hx.from') }}</span>
        <input v-model="from" type="date" :max="to || undefined" data-testid="hx-from" />
      </label>
      <label class="field">
        <span>{{ t('hx.to') }}</span>
        <input v-model="to" type="date" :min="from || undefined" data-testid="hx-to" />
      </label>
    </div>
    <p class="note">{{ t('hx.zone', { zone: zoneLabel(offset) }) }}</p>
    <p v-if="state.info.value !== null" class="note" data-testid="hx-rules">
      {{ t('hx.rules', { days: state.info.value.maxRangeDays, per: state.info.value.per30Days, used: state.info.value.used30Days, keep: state.info.value.retentionDays }) }}
    </p>
    <p v-if="rangeError !== null && preset === 'custom' && from !== '' && to !== ''" class="notice notice-error">{{ rangeError }}</p>
    <p v-if="error !== null" class="notice notice-error wrap-anywhere" data-testid="hx-error">{{ error }}</p>
    <template #footer>
      <button class="btn" type="button" :disabled="submitting" @click="emit('close')">{{ t('hx.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="submitting || rangeError !== null" data-testid="hx-submit" @click="submit">
        <FileDown :size="15" aria-hidden="true" />{{ submitting ? t('hx.submitting') : t('hx.submit') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: 6px; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.field select, .field input {
  height: 38px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: 9px; background: var(--color-surface-alt);
  color: var(--color-text); font-size: 13px; font-weight: 500; outline: none;
}
.field select:focus, .field input:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  height: 32px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 999px; background: transparent;
  color: var(--color-text-secondary); font-size: 12.5px; font-weight: 600;
}
.chip.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); }
.dates { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.note { margin: 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.notice { margin: 0; }
</style>
