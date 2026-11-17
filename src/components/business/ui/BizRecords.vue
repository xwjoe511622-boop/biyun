<script setup lang="ts">
import { translateForLocale } from '@/i18n/composer'
/** "历史记录" card: tabs of the user's records, each a paged table with formatted cells (no raw IDs or JSON). */
import { computed, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import StatusPill from './StatusPill.vue'
import { vScrollFade } from '@/core/scroll-fade'
import { businessRequest, rowOf, rowsOf, textOf, type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { amount, dateTime, dateOnly, feeRate, field, percent, type Lang } from '@/modules/business/format'

export interface RecordColumn {
  key: string
  label: string
  kind?: 'text' | 'asset' | 'amount' | 'percent' | 'fee' | 'time' | 'date' | 'status' | 'bool'
  /** For amounts: a row key holding the asset symbol, or a literal prefixed with '=' (e.g. '=USDT'). */
  unit?: string
  map?: Record<string, string>
}
export interface RecordTab { id: string; label: string; path: string; rowsPath?: string; paging?: boolean; params?: BusinessParams; columns: RecordColumn[] }

const props = defineProps<{ lang: Lang; tabs: RecordTab[]; title?: string; refreshKey?: number }>()
const uiText = (key: string, values?: Record<string, unknown>) => translateForLocale(props.lang, key, values)
const active = ref(props.tabs[0]?.id ?? '')
const page = ref(1)
const SIZE = 10
const rows = ref<BusinessRow[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const tab = computed(() => props.tabs.find(t => t.id === active.value) ?? props.tabs[0])
let seq = 0

async function load() {
  const t = tab.value
  if (!t) return
  const mine = ++seq
  loading.value = true; error.value = ''
  const params: BusinessParams = { ...(t.params ?? {}) }
  if (t.paging) { params.current = String(page.value); params.size = String(SIZE) }
  try {
    const data = await businessRequest(t.path, params)
    if (mine !== seq) return
    rows.value = rowsOf(data, t.rowsPath ?? 'rows')
    const tot = textOf(rowOf(data).total)
    total.value = /^\d+$/.test(tot) ? Number(tot) : rows.value.length // float-ok: row count
  } catch (e) {
    if (mine !== seq) return
    rows.value = []; total.value = 0
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === seq) loading.value = false
  }
}
watch([active, page, () => props.refreshKey], () => { void load() }, { immediate: true })
function select(id: string) { if (active.value !== id) { active.value = id; page.value = 1 } }
const pages = computed(() => Math.max(1, Math.ceil(total.value / SIZE)))

function unitOf(row: BusinessRow, c: RecordColumn): string {
  if (!c.unit) return ''
  return c.unit.startsWith('=') ? c.unit.slice(1) : field(row, c.unit)
}
function cell(row: BusinessRow, c: RecordColumn): string {
  const v = field(row, c.key)
  switch (c.kind) {
    case 'amount': return `${amount(v)}${unitOf(row, c) ? ` ${unitOf(row, c)}` : ''}`
    case 'percent': return percent(v)
    case 'fee': return feeRate(v)
    case 'time': return dateTime(v)
    case 'date': return dateOnly(v)
    case 'bool': return v === 'true' ? uiText('bizRecords.yes') : uiText('bizRecords.no')
    default: return c.map?.[v] ?? (v === '' ? '—' : v)
  }
}
const isLeft = (c: RecordColumn) => c.kind === 'asset' || c.kind === 'text' || c.kind === undefined
</script>

<template>
  <section class="rec card">
    <header class="rec-head">
      <h2>{{ title ?? uiText('bizRecords.history') }}</h2>
      <nav v-if="tabs.length > 1" class="tabs" role="tablist">
        <button v-for="t in tabs" :key="t.id" class="tab" :class="{ active: t.id === active }" type="button" role="tab" :aria-selected="t.id === active" @click="select(t.id)">{{ t.label }}</button>
      </nav>
    </header>
    <div v-scroll-fade class="rec-scroll x-scroll">
      <table class="table rec-table table-cards">
        <thead><tr><th v-for="c in tab?.columns ?? []" :key="c.key" :class="{ left: isLeft(c) }">{{ c.label }}</th></tr></thead>
        <tbody v-if="!loading && !error && rows.length">
          <tr v-for="(row, i) in rows" :key="i">
            <td v-for="c in tab?.columns ?? []" :key="c.key" :data-label="c.label" :class="{ left: isLeft(c), num: !isLeft(c) && c.kind !== 'status' }">
              <span v-if="c.kind === 'asset'" class="rec-asset"><CoinMark :symbol="field(row, c.key)" :size="18" />{{ field(row, c.key) || '—' }}</span>
              <StatusPill v-else-if="c.kind === 'status'" :code="field(row, c.key)" :lang="lang" />
              <template v-else>{{ cell(row, c) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="loading" class="rec-state">{{ uiText('bizRecords.loading') }}</p>
      <p v-else-if="error" class="rec-state err">{{ error }} <button class="btn btn-ghost" type="button" @click="load">{{ uiText('bizRecords.retry') }}</button></p>
      <p v-else-if="!rows.length" class="rec-state">{{ uiText('bizRecords.noRecordsYet') }}</p>
    </div>
    <footer v-if="tab?.paging && pages > 1" class="rec-pager">
      <button class="btn btn-ghost" type="button" :disabled="page <= 1" :aria-label="uiText('bizRecords.previous')" @click="page--"><ChevronLeft :size="16" /></button>
      <span class="num">{{ page }} / {{ pages }}</span>
      <button class="btn btn-ghost" type="button" :disabled="page >= pages" :aria-label="uiText('bizRecords.next')" @click="page++"><ChevronRight :size="16" /></button>
    </footer>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.rec { overflow: hidden; }
.rec-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--color-border); }
.rec-head h2 { margin: 0; font-size: var(--font-size-lg); font-weight: 700; }
.rec-head .tabs { flex-wrap: wrap; }
.rec-table { table-layout: auto; min-width: 640px; }
.rec-table th:first-child, .rec-table td:first-child { padding-left: 20px; }
.rec-table th:last-child, .rec-table td:last-child { padding-right: 20px; }
.rec-table .left { text-align: left; }
.rec-asset { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.rec-state { margin: 0; padding: 36px 16px; text-align: center; color: var(--color-text-muted); font-size: var(--font-size-sm); }
.rec-state.err { color: var(--color-down); }
.rec-pager { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: var(--font-size-sm); }
</style>
