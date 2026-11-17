import { computed, ref, shallowRef } from 'vue'
import { isApiError } from '@/core/errors'
import { fetchExportInfo, fetchExports, type ExportInfo, type ExportRecord } from '@/modules/api/history-export.api'

/**
 * Shared history-export state (the dialog, the archived-range notice and the records list read the same info and
 * list). Reads are lazy: nothing is requested until a component asks, so pages that never show an export entry
 * make no extra call. While a statement is queued or being generated the list refreshes every 5 s.
 */
const info = shallowRef<ExportInfo | null>(null)
const records = shallowRef<ExportRecord[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let infoPromise: Promise<ExportInfo | null> | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function describe(error_: unknown): string {
  return isApiError(error_) || error_ instanceof Error ? error_.message : String(error_)
}

async function loadInfo(force = false): Promise<ExportInfo | null> {
  if (!force && info.value !== null) return info.value
  if (infoPromise === null) {
    infoPromise = fetchExportInfo()
      .then((value) => {
        info.value = value
        return value
      })
      .catch(() => null)
      .finally(() => {
        infoPromise = null
      })
  }
  return infoPromise
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (records.value.some(entry => entry.status === 'queued' || entry.status === 'running')) {
    timer = setTimeout(() => void loadRecords(), 5000)
  }
}

async function loadRecords(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    records.value = await fetchExports()
  } catch (error_) {
    error.value = describe(error_)
  } finally {
    loading.value = false
    schedule()
  }
}

function reset(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  info.value = null
  records.value = []
  error.value = null
}

export function useHistoryExport() {
  return {
    info,
    records,
    loading,
    error,
    pending: computed(() => records.value.filter(entry => entry.status === 'queued' || entry.status === 'running').length),
    loadInfo,
    loadRecords,
    reset,
  }
}
