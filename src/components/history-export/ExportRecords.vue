<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Download, RotateCw } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import StatusChip from '@/components/wallet/StatusChip.vue'
import { isApiError } from '@/core/errors'
import { toastError } from '@/core/toast'
import { browserOffsetMin, fetchDownloadLink, type ExportRecord, type ExportStatus } from '@/modules/api/history-export.api'
import { rangeLabel, sizeLabel, wallClock } from './format'
import { useHistoryExportI18n } from './i18n'
import { useHistoryExport } from './state'

/** The user's statements (newest first) with status and a download button for the ready ones. */
const { t } = useHistoryExportI18n()
const state = useHistoryExport()
const offset = browserOffsetMin()
const fetching = ref<string | null>(null)

const TONE: Record<ExportStatus, 'ok' | 'warn' | 'bad' | 'info' | 'muted'> = { queued: 'info', running: 'warn', ready: 'ok', failed: 'bad', expired: 'muted' }

function statusText(entry: ExportRecord): string {
  if (entry.status === 'failed' && (entry.error === 'too_many_rows' || entry.error === 'internal_error')) return `${t('hx.status.failed')} · ${t(`hx.errors.${entry.error}`)}`
  return t(`hx.status.${entry.status}`)
}

async function download(entry: ExportRecord): Promise<void> {
  if (fetching.value !== null) return
  fetching.value = entry.id
  try {
    const link = await fetchDownloadLink(entry.id)
    const a = document.createElement('a')
    a.href = link.url
    a.download = link.fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (error_) {
    toastError(isApiError(error_) || error_ instanceof Error ? error_.message : String(error_))
    void state.loadRecords()
  } finally {
    fetching.value = null
  }
}

onMounted(() => void state.loadRecords())
</script>

<template>
  <section class="hx-records" data-testid="hx-records">
    <header class="bar">
      <h3>{{ t('hx.records') }}</h3>
      <button class="btn btn-ghost" type="button" :disabled="state.loading.value" :title="t('hx.refresh')" :aria-label="t('hx.refresh')" @click="state.loadRecords()"><RotateCw :size="15" /></button>
    </header>
    <StateBlock v-if="state.error.value !== null && state.records.value.length === 0" variant="error" :message="state.error.value" retryable @retry="state.loadRecords()" />
    <StateBlock v-else-if="state.loading.value && state.records.value.length === 0" variant="loading" :message="t('hx.downloading')" />
    <StateBlock v-else-if="state.records.value.length === 0" variant="empty" :message="t('hx.empty')" />
    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ t('hx.col.created') }}</th>
            <th>{{ t('hx.col.kind') }}</th>
            <th>{{ t('hx.col.range') }}</th>
            <th>{{ t('hx.col.status') }}</th>
            <th class="num">{{ t('hx.col.rows') }}</th>
            <th class="num">{{ t('hx.col.action') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in state.records.value" :key="entry.id" :data-testid="`hx-row-${entry.id}`">
            <td class="muted">{{ wallClock(entry.createdAt, offset) }}</td>
            <td>{{ t(`hx.kinds.${entry.kind}`) }}</td>
            <td class="muted">{{ rangeLabel(entry.startTime, entry.endTime, entry.tzOffsetMin) }}</td>
            <td><StatusChip :label="statusText(entry)" :tone="TONE[entry.status]" /></td>
            <td class="num">{{ entry.rows ?? '--' }}<span v-if="entry.fileBytes !== null" class="muted"> · {{ sizeLabel(entry.fileBytes) }}</span></td>
            <td class="num">
              <button
                v-if="entry.status === 'ready'"
                class="link-btn"
                type="button"
                :disabled="fetching !== null"
                :title="entry.expiresAt !== null ? t('hx.expiresAt', { time: wallClock(entry.expiresAt, offset) }) : undefined"
                :data-testid="`hx-download-${entry.id}`"
                @click="download(entry)"
              ><Download :size="13" />{{ fetching === entry.id ? t('hx.downloading') : t('hx.download') }}</button>
              <span v-else class="muted">--</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.hx-records { display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--color-border); }
.bar h3 { margin: 0; font-size: 15px; }
.bar .btn { height: 32px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { padding: 10px 18px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--color-border); }
th { color: var(--color-text-muted); font-size: 11.5px; font-weight: 600; }
.num { text-align: right; }
.muted { color: var(--color-text-muted); }
.link-btn { display: inline-flex; align-items: center; gap: 4px; color: var(--color-accent-text); font-size: 12px; font-weight: 650; }
.link-btn:hover:not(:disabled) { text-decoration: underline; }
.link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
