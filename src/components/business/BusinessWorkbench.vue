<script setup lang="ts">
/**
 * BusinessWorkbench — one reusable, read/write console for every business feature definition.
 *
 * Precision: amounts stay exact decimal **strings**. Money is only ever formatted with `Decimal`
 * (`groupDigits`, `.mul('100').toFixed()`) or shown verbatim; `Number`/`parseFloat`/unary `+` are
 * never applied to amounts. `page`/`size` are UI counts, not money.
 *
 * Account safety: `token` watch bumps an epoch, aborts in-flight reads and wipes every section,
 * preview and dialog so a stale response/`catch` can never write into the next account.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import GuestGate from '@/components/common/GuestGate.vue'
import { toastError, toastInfo, toastSuccess } from '@/core/toast'
import {
  BusinessApiError,
  businessRequest,
  pendingReceipt,
  rowOf,
  rowsOf,
  saveReceipt,
  textOf,
  valueAt,
  type BusinessParams,
  type BusinessRow,
  type PendingBusinessAction,
} from '@/modules/business/client'
import { businessNavigation } from '@/modules/business/definitions'
import type { BusinessAction, BusinessColumn, BusinessDefinition, BusinessField, BusinessSection, Copy } from '@/modules/business/types'
import { Decimal, decimalPlaces, groupDigits, gt, isDecimalString, isZero } from '@/modules/finance/decimal'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{ definition: BusinessDefinition }>()
const { t: L } = useI18n({ useScope: 'global' })
const sessionStore = useSessionStore()

const PAGE_SIZE = 25
const PENDING_TOKENS = ['PENDING', 'PROCESSING', 'REDEEMING', 'RECLAIMING']

const authed = computed(() => sessionStore.token !== null && sessionStore.token !== '')

interface SectionState {
  rows: BusinessRow[]
  raw: unknown
  loading: boolean
  error: string | null
  page: number
  total: string | null
  updatedAt: string
  loaded: boolean
}
const states = reactive<Record<string, SectionState>>({})
const controllers = new Map<string, AbortController>()
let epoch = 0

for (const section of props.definition.sections) {
  states[section.id] = { rows: [], raw: null, loading: false, error: null, page: 1, total: null, updatedAt: '', loaded: false }
}

const activeId = ref(props.definition.sections[0]?.id ?? '')
const visibleSections = computed(() => props.definition.sections)
const activeSection = computed<BusinessSection>(() => props.definition.sections.find((sec) => sec.id === activeId.value) ?? props.definition.sections[0]!)
const showGate = computed(() => activeSection.value.public !== true && !authed.value)
const state = (id: string): SectionState => states[id]!

function nowIso(): string { return new Date().toISOString() }
function pretty(value: unknown): string { try { return JSON.stringify(value, null, 2) } catch { return textOf(value) } }

/** Format a cell without ever turning an amount into a JS number. */
function cell(col: BusinessColumn, row: BusinessRow): { text: string; exact: string } {
  const value = valueAt(row, col.key)
  const exact = textOf(value)
  switch (col.format) {
    case 'money':
      return { text: isDecimalString(exact) ? groupDigits(exact) : exact, exact }
    case 'percent':
      return isDecimalString(exact) ? { text: `${new Decimal(exact).mul('100').toFixed()}%`, exact } : { text: exact, exact }
    case 'boolean':
      return { text: value === true ? L('businessLabels.yes') : value === false ? L('businessLabels.no') : exact, exact }
    case 'status': {
      const labels: Record<string, Copy> = { PURCHASING: 'businessLabels.open', HOLDING: 'businessLabels.holding', SUCCESS: 'businessLabels.success', SUCCEEDS: 'businessLabels.succeeded', FAILED: 'businessLabels.failed', PROCESSING: 'businessLabels.processing', PENDING: 'businessLabels.pending', REDEEMING: 'businessLabels.redeeming', RECLAIMING: 'businessLabels.reclaiming', REDEEMED: 'businessLabels.redeemed', REPAID: 'businessLabels.repaid', ACTIVE: 'businessLabels.active', ONLINE: 'businessLabels.online', OFFLINE: 'businessLabels.offline', DRAFT: 'businessLabels.draft', SUBSCRIBING: 'businessLabels.subscribing', ENDED: 'businessLabels.ended', CLOSED: 'businessLabels.closed', END: 'businessLabels.ended' }
      const label = labels[exact.toUpperCase()]
      return { text: label ? L(label) : exact, exact }
    }
    case 'date': {
      if (/^\d+$/.test(exact)) {
        // Time only (epoch seconds or ms), never money.
        const n = Number.parseInt(exact, 10)
        const date = new Date(exact.length <= 10 ? n * 1000 : n)
        return { text: Number.isNaN(date.getTime()) ? exact : new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date), exact }
      }
      return { text: exact, exact }
    }
    default:
      return { text: value !== null && typeof value === 'object' ? pretty(value) : exact, exact }
  }
}

function extraFields(row: BusinessRow, columns: BusinessColumn[]): Array<[string, string]> {
  const known = new Set(columns.map((col) => col.key.split('.')[0]))
  return Object.entries(row).filter(([key]) => !known.has(key)).map(([key, value]) => [key, textOf(value)])
}

async function loadSection(section: BusinessSection): Promise<void> {
  if (section.public !== true && !authed.value) return
  const runEpoch = epoch
  const token = sessionStore.token
  const st = state(section.id)
  controllers.get(section.id)?.abort()
  const controller = new AbortController()
  controllers.set(section.id, controller)
  st.loading = true
  st.error = null
  try {
    const params: BusinessParams = {}
    if (section.paging === true) { params.current = String(st.page); params.size = String(PAGE_SIZE) }
    const data = await businessRequest(section.path, params, false, controller.signal)
    if (runEpoch !== epoch || sessionStore.token !== token || controllers.get(section.id) !== controller) return
    const path = section.rowsPath ?? (Array.isArray(data) ? '' : 'rows')
    st.raw = data
    st.rows = rowsOf(data, path, section.singleton === true)
    st.total = rowOf(data).total !== undefined ? textOf(rowOf(data).total) : null
    st.loaded = true
    st.updatedAt = nowIso()
    if (receipt.value !== null && section.public !== true) recordsReloaded.value = true
  } catch (error) {
    if (runEpoch !== epoch || sessionStore.token !== token || controller.signal.aborted) return
    st.rows = []
    st.raw = null
    st.total = null
    st.loaded = false
    st.updatedAt = ''
    st.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (runEpoch === epoch && controllers.get(section.id) === controller) {
      st.loading = false
      controllers.delete(section.id)
    }
  }
}

async function ensureSections(ids: string[]): Promise<void> {
  for (const id of ids) {
    const sec = props.definition.sections.find((s) => s.id === id)
    if (sec !== undefined && !state(id).loaded && !state(id).loading) await loadSection(sec)
  }
}

function refreshAll(): void { for (const sec of visibleSections.value) void loadSection(sec) }
function refreshActive(): void { void loadSection(activeSection.value) }
function changePage(delta: number): void {
  const st = state(activeSection.value.id)
  st.page = Math.max(1, st.page + delta)
  void loadSection(activeSection.value)
}
function canNext(): boolean {
  const st = state(activeSection.value.id)
  // Several handlers return the count of this page, rather than the complete filtered count.
  return !st.loading && st.rows.length >= PAGE_SIZE
}

// ---- inspect (GET only) -------------------------------------------------------------------------
const drawer = ref<{ title: string; columns: BusinessColumn[]; rows: BusinessRow[]; raw: unknown; error: string | null; loading: boolean } | null>(null)
let inspectGeneration = 0
async function inspect(action: BusinessAction, row: BusinessRow): Promise<void> {
  if (!authed.value) { toastInfo(L('businessLabels.pleaseSignIn')); return }
  const spec = action.inspect
  if (spec === undefined) return
  const idValue = textOf(valueAt(row, spec.idKey))
  const hasTemplate = spec.path.includes('{id}')
  const path = hasTemplate ? spec.path.replace('{id}', encodeURIComponent(idValue)) : spec.path
  const params: BusinessParams = hasTemplate ? {} : { [spec.queryKey ?? spec.idKey]: idValue }
  const generation = ++inspectGeneration
  drawer.value = { title: L(action.label), columns: spec.columns, rows: [], raw: null, error: null, loading: true }
  const runEpoch = epoch
  const token = sessionStore.token
  try {
    const data = await businessRequest(path, params, false)
    if (runEpoch !== epoch || sessionStore.token !== token || generation !== inspectGeneration || drawer.value === null) return
    const rowPath = spec.rowsPath ?? (Array.isArray(data) ? '' : 'rows')
    drawer.value = { title: L(action.label), columns: spec.columns, rows: rowsOf(data, rowPath, spec.singleton === true), raw: data, error: null, loading: false }
  } catch (error) {
    if (runEpoch !== epoch || sessionStore.token !== token || generation !== inspectGeneration || drawer.value === null) return
    drawer.value = { title: L(action.label), columns: spec.columns, rows: [], raw: null, error: error instanceof Error ? error.message : String(error), loading: false }
  }
}

// ---- write dialog -------------------------------------------------------------------------------
interface DialogState { action: BusinessAction; row: BusinessRow | null; form: Record<string, string>; accepted: boolean }
const dialog = ref<DialogState | null>(null)
const writing = ref(false)

function fieldOptions(field: BusinessField): Array<{ value: string; label: string }> {
  if (field.options !== undefined) return field.options.map((o) => ({ value: o.value, label: L(o.label) }))
  if (field.optionsFrom !== undefined) {
    const seen = new Set<string>()
    const out: Array<{ value: string; label: string }> = []
    for (const row of state(field.optionsFrom.section).rows) {
      const value = textOf(valueAt(row, field.optionsFrom.key))
      if (value !== '' && !seen.has(value)) { seen.add(value); out.push({ value, label: value }) }
    }
    return out
  }
  return []
}

async function openAction(action: BusinessAction, row: BusinessRow | null): Promise<void> {
  if (!authed.value) { toastInfo(L('businessLabels.pleaseSignIn')); return }
  if (writing.value || receipt.value !== null || restoringReceipt.value || !receiptStorageReady.value) return
  const runEpoch = epoch
  const token = sessionStore.token
  const needs = action.fields.map((f) => f.optionsFrom?.section).filter((s): s is string => s !== undefined)
  if (needs.length > 0) await ensureSections(needs)
  if (runEpoch !== epoch || sessionStore.token !== token || receipt.value !== null) return
  const form: Record<string, string> = {}
  for (const field of action.fields) {
    if (field.from !== undefined && row !== null) form[field.key] = textOf(valueAt(row, field.from))
    else form[field.key] = field.default ?? ''
  }
  preview.value = null
  dialog.value = { action, row, form, accepted: false }
}

function validate(field: BusinessField): string | null {
  const value = (dialog.value?.form[field.key] ?? '').trim()
  if (value === '') return field.required === true ? `${L(field.label)}: ${L('businessLabels.required')}` : null
  if (field.type === 'decimal') {
    if (!isDecimalString(value)) return `${L(field.label)}: ${L('businessLabels.mustBeANonNegativeDecimalString')}`
    const scale = decimalPlaces(value)
    if (scale === null || scale > (field.scale ?? 16)) return `${L(field.label)}: ${L('businessLabels.tooManyDecimalPlaces')}`
    if (!(field.zero === true && isZero(value)) && !gt(value, '0')) return `${L(field.label)}: ${L('businessLabels.mustBeGreaterThan0')}`
    if (field.max !== undefined && isDecimalString(field.max) && gt(value, field.max)) return `${L(field.label)}: ${L('businessLabels.aboveTheMaximum')} ${field.max}`
  } else if (field.type === 'integer') {
    if (!/^(?:0|[1-9]\d*)$/.test(value) || (BigInt(value) === 0n && field.zero !== true) || BigInt(value) > 9223372036854775807n) return `${L(field.label)}: ${L('businessLabels.mustBeAValidIntegerString')}`
  } else if (field.type === 'select' && !fieldOptions(field).some(option => option.value === value)) {
    return `${L(field.label)}: ${L('businessLabels.chooseAConfiguredOption')}`
  }
  return null
}

const preview = ref<{ path: string; rows: BusinessRow[]; columns: BusinessColumn[]; signature: string; raw: unknown } | null>(null)
const previewLoading = ref(false)
let previewGeneration = 0
const previewRequired = computed(() => {
  const current = dialog.value
  const spec = current?.action.preview
  return current !== null && spec !== undefined && (spec.when?.(current.form) ?? true)
})
function previewSignature(action: BusinessAction): string {
  const fields = action.preview?.fields ?? []
  return JSON.stringify(fields.map((key) => [key, dialog.value?.form[key] ?? '']))
}
watch(() => (dialog.value === null ? '' : JSON.stringify(dialog.value.form)), () => {
  if (dialog.value !== null) dialog.value.accepted = false
  const action = dialog.value?.action
  if (action?.preview !== undefined && preview.value !== null && preview.value.signature !== previewSignature(action)) preview.value = null
})

async function readPreview(): Promise<void> {
  const current = dialog.value
  const spec = current?.action.preview
  if (current === null || spec === undefined || !previewRequired.value) return
  for (const field of current.action.fields) { const issue = validate(field); if (issue !== null) { toastError(issue); return } }
  const signature = previewSignature(current.action)
  const generation = ++previewGeneration
  previewLoading.value = true
  const params: BusinessParams = {}
  for (const key of spec.fields) params[key] = current.form[key] ?? ''
  const runEpoch = epoch
  const token = sessionStore.token
  try {
    const data = await businessRequest(spec.path, params, false)
    if (runEpoch !== epoch || sessionStore.token !== token || dialog.value !== current || generation !== previewGeneration || signature !== previewSignature(current.action)) return
    const path = spec.rowsPath ?? ''
    preview.value = { path: spec.path, rows: rowsOf(data, path, !Array.isArray(data)), columns: spec.columns, signature, raw: data }
  } catch (error) {
    if (runEpoch !== epoch || sessionStore.token !== token || dialog.value !== current || generation !== previewGeneration) return
    preview.value = null
    toastError(error instanceof Error ? error.message : String(error))
  } finally {
    if (runEpoch === epoch && generation === previewGeneration) previewLoading.value = false
  }
}

const canConfirm = computed(() => {
  const current = dialog.value
  if (current === null || !current.accepted || writing.value || previewLoading.value || receipt.value !== null || restoringReceipt.value || !receiptStorageReady.value || !authed.value) return false
  if (previewRequired.value && (preview.value?.signature !== previewSignature(current.action) || preview.value.rows.length === 0)) return false
  return true
})

function resultPending(row: BusinessRow): boolean {
  if (row.pending === true) return true
  const status = textOf(row.status)
  const repay = textOf(row.repayStatus)
  if (repay.toLowerCase().includes('repaying') || (status + repay).toLowerCase().includes('processing')) return true
  const haystack = `${status} ${repay} ${textOf(row.depositStatus)} ${textOf(valueAt(row, 'reclaim.result'))}`.toUpperCase()
  return PENDING_TOKENS.some((token) => haystack.includes(token))
}

const receipt = ref<PendingBusinessAction | null>(null)
const restoringReceipt = ref(true)
const receiptStorageReady = ref(false)
const recordsReloaded = ref(false)
const unlockAccepted = ref(false)

async function submit(): Promise<void> {
  const current = dialog.value
  if (current === null || !canConfirm.value) return
  for (const field of current.action.fields) {
    const issue = validate(field)
    if (issue !== null) { toastError(issue); return }
  }
  const values: BusinessParams = { ...(current.action.defaults ?? {}) }
  for (const field of current.action.fields) values[field.key] = current.form[field.key] ?? ''
  const pending: PendingBusinessAction = { label: L(current.action.label), path: current.action.path, fields: values, result: {}, time: nowIso() }
  const token = sessionStore.token
  const runEpoch = epoch
  writing.value = true
  try { await saveReceipt(props.definition.id, pending) } catch {
    if (runEpoch === epoch) { writing.value = false; toastError(L('businessLabels.couldNotPersistTheReceiptSubmissionCancelled')) }
    return
  }
  if (sessionStore.token !== token || runEpoch !== epoch) return
  receipt.value = pending
  recordsReloaded.value = false
  try {
    const data = await businessRequest(current.action.path, values, true)
    if (sessionStore.token !== token || runEpoch !== epoch) return
    const result = rowOf(data)
    pending.result = result
    receipt.value = { ...pending }
    if (resultPending(result)) {
      await saveReceipt(props.definition.id, pending)
      if (runEpoch !== epoch || sessionStore.token !== token) return
      dialog.value = null
      toastInfo(L('businessLabels.requestProcessingReceiptKeptConfirmViaRecordsAndDo'))
      refreshAll()
    } else {
      await saveReceipt(props.definition.id, null)
      if (runEpoch !== epoch || sessionStore.token !== token) return
      receipt.value = null
      dialog.value = null
      const failure = textOf(result.status).toUpperCase() === 'FAILED' || textOf(result.repayStatus).toUpperCase() === 'FAILED' || result.success === false || textOf(valueAt(result, 'reclaim.result')).startsWith('Failed')
      if (failure) toastError(L('businessLabels.requestRefusedCheckTheRecord'))
      else toastSuccess(L('businessLabels.operationCompletedVerifyPositionsAndRecords'))
      refreshAll()
    }
  } catch (error) {
    if (sessionStore.token !== token || runEpoch !== epoch) return
    if (error instanceof BusinessApiError && error.unconfirmed) {
      dialog.value = null
      toastError(error.message)
      refreshAll()
    } else if (error instanceof BusinessApiError) {
      try { await saveReceipt(props.definition.id, null) } catch { toastError(L('businessLabels.cannotUpdateTheReceiptKeepItAndCheckRecords')); return }
      if (runEpoch !== epoch || sessionStore.token !== token) return
      receipt.value = null
      toastError(error.message)
    } else {
      toastError(error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (sessionStore.token === token && runEpoch === epoch) writing.value = false
  }
}

async function unlock(): Promise<void> {
  if (!recordsReloaded.value || !unlockAccepted.value || writing.value) return
  const runEpoch = epoch
  const token = sessionStore.token
  try { await saveReceipt(props.definition.id, null) } catch { toastError(L('businessLabels.couldNotUpdateTheReceipt')); return }
  if (runEpoch !== epoch || sessionStore.token !== token) return
  receipt.value = null
  unlockAccepted.value = false
  toastInfo(L('businessLabels.submissionLockReleased'))
}

// ---- account switch: wipe everything, never leak across accounts ---------------------------------
watch(() => sessionStore.token, async () => {
  epoch += 1
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  for (const section of props.definition.sections) {
    states[section.id] = { rows: [], raw: null, loading: false, error: null, page: 1, total: null, updatedAt: '', loaded: false }
  }
  dialog.value = null
  preview.value = null
  drawer.value = null
  recordsReloaded.value = false
  unlockAccepted.value = false
  writing.value = false
  previewLoading.value = false
  receipt.value = null
  await restoreReceipt()
  const first = visibleSections.value[0]
  if (first !== undefined) { activeId.value = first.id; void loadSection(first) }
})

async function restoreReceipt(): Promise<void> {
  const runEpoch = epoch
  const token = sessionStore.token
  restoringReceipt.value = true
  receiptStorageReady.value = false
  try { const saved = await pendingReceipt(props.definition.id); if (runEpoch === epoch && sessionStore.token === token) { receipt.value = saved; receiptStorageReady.value = true } }
  catch { if (runEpoch === epoch) toastError(L('businessLabels.cannotReadSubmissionReceiptsWritesAreUnavailable')) }
  finally { if (runEpoch === epoch) restoringReceipt.value = false }
}

onMounted(async () => {
  await restoreReceipt()
  const first = visibleSections.value[0]
  if (first !== undefined) { activeId.value = first.id; void loadSection(first) }
})

const modalElement = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
watch(() => dialog.value !== null || drawer.value !== null, async open => {
  if (open) { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; await nextTick(); modalElement.value?.querySelector<HTMLElement>('input, select, button')?.focus() }
  else previousFocus?.focus()
})
function modalKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !writing.value) { dialog.value = null; drawer.value = null; event.preventDefault(); return }
  if (event.key !== 'Tab') return
  const nodes = Array.from(modalElement.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])
  const first = nodes[0], last = nodes[nodes.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}

onBeforeUnmount(() => {
  epoch += 1
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
})
</script>

<template>
  <div class="biz">
    <nav class="biz-nav" :aria-label="L('businessLabels.businessNavigation')">
      <RouterLink v-for="item in businessNavigation" :key="item.path" class="biz-nav-link" :class="{ active: item.definition.id === definition.id }" :to="item.path">
        {{ L(item.definition.title) }}
      </RouterLink>
    </nav>

    <header class="biz-head">
      <div>
        <h1>{{ L(definition.title) }}</h1>
        <p class="biz-intro">{{ L(definition.intro) }}</p>
      </div>
      <div class="biz-head-right">
        <span class="biz-status" :class="{ ok: authed }">{{ authed ? L('businessLabels.signedIn') : L('businessLabels.guest') }}</span>
        <button class="btn" type="button" :disabled="state(activeSection.id).loading" @click="refreshActive">{{ L('businessLabels.refresh') }}</button>
      </div>
    </header>
    <p v-if="definition.notice !== undefined" class="biz-notice">{{ L(definition.notice) }}</p>
    <p class="biz-hint">{{ L('businessLabels.timesAreInUtcAnEmptyValueMeansThe') }}</p>
    <p v-if="authed && !restoringReceipt && !receiptStorageReady" class="biz-error">{{ L('businessLabels.submissionReceiptsCannotBeReadWritesAreUnavailableReconcile') }}</p>

    <section v-if="receipt !== null" class="biz-receipt">
      <strong>{{ L('businessLabels.unconfirmedSubmissionReceipt') }}</strong>
      <p>{{ receipt.label }} · {{ receipt.path }} · {{ receipt.time }}</p>
      <dl class="biz-receipt-fields">
        <div v-for="(value, key) in receipt.fields" :key="key"><dt>{{ key }}</dt><dd class="num">{{ value }}</dd></div>
      </dl>
      <pre class="biz-raw">{{ pretty(receipt.result) }}</pre>
      <div class="biz-receipt-actions">
        <button class="btn" type="button" @click="refreshAll">{{ L('businessLabels.checkRecords') }}</button>
        <label class="biz-check"><input v-model="unlockAccepted" type="checkbox" :disabled="!recordsReloaded || writing" />{{ L('businessLabels.iHaveCheckedTheRecordsReleaseTheSubmissionLock') }}</label>
        <button class="btn" type="button" :disabled="!recordsReloaded || !unlockAccepted || writing" @click="unlock">{{ L('businessLabels.releaseLock') }}</button>
      </div>
      <p v-if="!recordsReloaded" class="biz-hint">{{ L('businessLabels.releaseIsEnabledOnlyAfterAtLeastOnePrivate') }}</p>
    </section>

    <div v-if="definition.actions !== undefined && definition.actions.length > 0" class="biz-global-actions">
      <button v-for="action in definition.actions" :key="action.id" class="btn btn-primary" type="button" :disabled="!authed || writing || receipt !== null || restoringReceipt || !receiptStorageReady" @click="openAction(action, null)">{{ L(action.label) }}</button>
      <RouterLink v-if="!authed" class="btn" to="/login">{{ L('businessLabels.signInToContinue') }}</RouterLink>
    </div>

    <div class="biz-body">
      <aside class="biz-sections">
        <button v-for="section in visibleSections" :key="section.id" class="biz-section-link" :class="{ active: section.id === activeSection.id }" type="button" @click="activeId = section.id; loadSection(section)">
          {{ L(section.label) }}
        </button>
      </aside>

      <main class="biz-main">
        <GuestGate v-if="showGate" :message="L('businessLabels.signInToViewThisSection')" />
        <template v-else>
          <div class="biz-section-head">
            <h2>{{ L(activeSection.label) }}</h2>
            <span v-if="state(activeSection.id).updatedAt" class="biz-hint">{{ L('businessLabels.updated') }} {{ state(activeSection.id).updatedAt }}</span>
            <span class="spacer" />
            <button class="btn" type="button" :disabled="state(activeSection.id).loading" @click="refreshActive">{{ L('businessLabels.refresh') }}</button>
          </div>
          <p v-if="activeSection.note !== undefined" class="biz-hint">{{ L(activeSection.note) }}</p>
          <p v-if="rowOf(state(activeSection.id).raw).enabled === false" class="biz-notice">{{ L('businessLabels.thisFeatureIsNotEnabledConfiguredRulesAreShown') }}</p>

          <p v-if="state(activeSection.id).loading" class="biz-hint">{{ L('businessLabels.loading') }}</p>
          <p v-else-if="state(activeSection.id).error !== null" class="biz-error">{{ L('businessLabels.readFailed') }}：{{ state(activeSection.id).error }}</p>
          <p v-else-if="state(activeSection.id).rows.length === 0" class="biz-hint">{{ L(activeSection.empty) }}</p>

          <div v-else class="biz-table-wrap">
            <table class="biz-table">
              <thead>
                <tr>
                  <th v-for="col in activeSection.columns" :key="col.key">{{ L(col.label) }}</th>
                  <th v-if="(activeSection.actions ?? []).length > 0">{{ L('businessLabels.action') }}</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="(row, index) in state(activeSection.id).rows" :key="index">
                  <tr>
                    <td v-for="col in activeSection.columns" :key="col.key" :title="cell(col, row).exact">
                      <span :class="{ num: col.format === 'money' || col.format === 'percent' }">{{ cell(col, row).text || '—' }}</span>
                    </td>
                    <td v-if="(activeSection.actions ?? []).length > 0" class="biz-row-actions">
                      <template v-for="action in activeSection.actions ?? []" :key="action.id">
                        <button v-if="action.visible === undefined || action.visible(row)" class="btn btn-ghost" type="button" :disabled="!authed || (!action.inspect && (writing || receipt !== null || restoringReceipt || !receiptStorageReady))" @click="action.inspect !== undefined ? inspect(action, row) : openAction(action, row)">
                          {{ L(action.label) }}
                        </button>
                      </template>
                    </td>
                  </tr>
                  <tr>
                    <td :colspan="activeSection.columns.length + ((activeSection.actions ?? []).length > 0 ? 1 : 0)">
                      <details class="biz-detail">
                        <summary>{{ L('businessLabels.moreFields') }}</summary>
                        <dl class="biz-detail-grid">
                          <div v-for="[key, value] in extraFields(row, activeSection.columns)" :key="key"><dt>{{ key }}</dt><dd class="num">{{ value }}</dd></div>
                        </dl>
                        <details><summary>{{ L('businessLabels.rawJson') }}</summary><pre class="biz-raw">{{ pretty(row) }}</pre></details>
                      </details>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <div v-if="activeSection.paging === true && state(activeSection.id).error === null" class="biz-pager">
            <button class="btn" type="button" :disabled="state(activeSection.id).page <= 1 || state(activeSection.id).loading" @click="changePage(-1)">{{ L('businessLabels.previous') }}</button>
            <span class="biz-hint">{{ L('businessLabels.page') }} {{ state(activeSection.id).page }} · {{ L('businessLabels.rowsHere') }} {{ state(activeSection.id).rows.length }}</span>
            <button class="btn" type="button" :disabled="!canNext()" @click="changePage(1)">{{ L('businessLabels.next') }}</button>
          </div>
        </template>
      </main>
    </div>

    <div v-if="drawer !== null || dialog !== null" class="biz-backdrop" aria-hidden="true" />
    <div v-if="drawer !== null" ref="modalElement" class="biz-drawer" role="dialog" aria-modal="true" :aria-label="drawer.title" @keydown="modalKey">
      <div class="biz-drawer-head"><strong>{{ drawer.title }}</strong><button class="btn" type="button" @click="drawer = null">{{ L('businessLabels.close') }}</button></div>
      <p v-if="drawer.loading" class="biz-hint">{{ L('businessLabels.loading') }}</p>
      <p v-else-if="drawer.error !== null" class="biz-error">{{ drawer.error }}</p>
      <p v-else-if="drawer.rows.length === 0" class="biz-hint">{{ L('businessLabels.noRecords') }}</p>
      <div v-else class="biz-table-wrap">
        <table class="biz-table">
          <thead><tr><th v-for="col in drawer.columns" :key="col.key">{{ L(col.label) }}</th></tr></thead>
          <tbody><tr v-for="(row, index) in drawer.rows" :key="index"><td v-for="col in drawer.columns" :key="col.key" :title="cell(col, row).exact">{{ cell(col, row).text }}</td></tr></tbody>
        </table>
      </div>
    </div>

    <div v-if="dialog !== null" ref="modalElement" class="biz-modal" role="dialog" aria-modal="true" :aria-label="L(dialog.action.label)" @keydown="modalKey">
      <div class="biz-modal-card">
        <div class="biz-modal-head"><strong>{{ L(dialog.action.label) }}</strong><button class="btn" type="button" :disabled="writing" @click="dialog = null">{{ L('businessLabels.cancel') }}</button></div>
        <p class="biz-hint">{{ L(dialog.action.note) }}</p>
        <div class="biz-field" v-for="field in dialog.action.fields" :key="field.key">
          <label :for="`biz-field-${field.key}`">{{ L(field.label) }}</label>
          <input v-if="field.readonly === true" :id="`biz-field-${field.key}`" class="biz-input" type="text" :value="dialog.form[field.key]" readonly />
          <select v-else-if="field.type === 'select'" :id="`biz-field-${field.key}`" v-model="dialog.form[field.key]" class="biz-input" :disabled="writing">
            <option value="">{{ L('businessLabels.select') }}</option>
            <option v-for="option in fieldOptions(field)" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <input v-else-if="field.type === 'decimal' || field.type === 'integer'" :id="`biz-field-${field.key}`" v-model="dialog.form[field.key]" class="biz-input num" type="text" :inputmode="field.type === 'integer' ? 'numeric' : 'decimal'" :disabled="writing" />
          <textarea v-else-if="field.type === 'textarea'" :id="`biz-field-${field.key}`" v-model="dialog.form[field.key]" class="biz-input" :disabled="writing" />
          <input v-else :id="`biz-field-${field.key}`" v-model="dialog.form[field.key]" class="biz-input" type="text" :disabled="writing" />
        </div>

        <template v-if="previewRequired">
          <button class="btn" type="button" :disabled="writing || previewLoading" @click="readPreview">{{ previewLoading ? L('businessLabels.reading') : L('businessLabels.readPreview') }}</button>
          <p v-if="preview === null" class="biz-hint">{{ L('businessLabels.readThePreviewAfterAnyAmountChangeItIs' ) }}</p>
          <div v-else class="biz-table-wrap">
            <table class="biz-table">
              <thead><tr><th v-for="col in preview.columns" :key="col.key">{{ L(col.label) }}</th></tr></thead>
              <tbody><tr v-for="(row, index) in preview.rows" :key="index"><td v-for="col in preview.columns" :key="col.key">{{ cell(col, row).text }}</td></tr></tbody>
            </table>
          </div>
        </template>

        <label class="biz-check"><input v-model="dialog.accepted" type="checkbox" :disabled="writing" />{{ L('businessLabels.iHaveReadAndConfirmedTheFieldsAndRules') }}</label>
        <div class="biz-modal-actions">
          <button class="btn" type="button" :disabled="writing" @click="dialog = null">{{ L('businessLabels.cancel') }}</button>
          <button class="btn btn-primary" type="button" :disabled="!canConfirm" @click="submit">{{ writing ? L('businessLabels.submitting') : L('businessLabels.confirmSubmit') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.biz { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6); width: 100%; max-width: 1600px; margin: 0 auto; min-width: 0; box-sizing: border-box; }
.biz-nav { display: flex; gap: var(--space-2); overflow-x: auto; padding-bottom: var(--space-1); }
.biz-nav-link { flex: 0 0 auto; padding: 6px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-pill); color: var(--color-text-secondary); font-size: var(--font-size-sm); text-decoration: none; }
.biz-nav-link.active { border-color: var(--color-accent); color: var(--color-accent-text); background: var(--color-accent-soft); }
.biz-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.biz-head h1 { margin: 0; font-size: var(--font-size-xl); }
.biz-intro { margin: 4px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-sm); max-width: 720px; }
.biz-head-right { display: flex; align-items: center; gap: var(--space-2); }
.biz-status { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.biz-status.ok { color: var(--color-up); }
.biz-notice { margin: 0; padding: var(--space-3); border-left: 3px solid var(--color-accent); background: var(--color-accent-soft); color: var(--color-text-secondary); font-size: var(--font-size-sm); }
.biz-receipt { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--color-warning); border-radius: var(--radius); background: var(--color-warning-soft); }
.biz-receipt-fields { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0; }
.biz-receipt-fields dt { color: var(--color-text-muted); font-size: var(--font-size-2xs); }
.biz-receipt-fields dd { margin: 0; font-size: var(--font-size-sm); }
.biz-receipt-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.biz-global-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.biz-body { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: var(--space-4); align-items: start; }
.biz-sections { display: flex; flex-direction: column; gap: var(--space-1); }
.biz-section-link { text-align: left; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--radius-sm); background: var(--color-surface-alt); color: var(--color-text-secondary); cursor: pointer; font-size: var(--font-size-sm); }
.biz-section-link.active { border-color: var(--color-accent); color: var(--color-accent-text); }
.biz-main { min-width: 0; }
.biz-section-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }
.biz-section-head h2 { margin: 0; font-size: var(--font-size-lg); }
.spacer { flex: 1; }
.biz-table-wrap { overflow-x: auto; }
.biz-table { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
.biz-table th, .biz-table td { border-bottom: 1px solid var(--color-border); padding: 12px; text-align: left; white-space: nowrap; }
.biz-table th { color: var(--color-text-muted); font-weight: 500; background: var(--color-surface-alt); }
.biz-main { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-4); }
.biz-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / .45); z-index: 199; }
.biz-table td .num, .num { font-family: var(--font-mono); }
.biz-row-actions { display: flex; gap: var(--space-1); }
.biz-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 2px 12px; margin: 4px 0; }
.biz-detail-grid dt { color: var(--color-text-muted); font-size: var(--font-size-2xs); }
.biz-detail-grid dd { margin: 0; font-size: var(--font-size-xs); }
.biz-raw { margin: 4px 0; padding: var(--space-2); max-height: 240px; overflow: auto; background: var(--color-bg-deep); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: var(--font-size-2xs); white-space: pre-wrap; word-break: break-all; }
.biz-pager { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); }
.biz-hint { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.biz-error { color: var(--color-down); font-size: var(--font-size-sm); }
.biz-check { display: inline-flex; align-items: center; gap: 6px; font-size: var(--font-size-sm); }
.biz-drawer, .biz-modal { position: fixed; right: 0; top: 0; bottom: 0; width: min(700px, 94vw); box-sizing: border-box; padding: var(--space-6); background: var(--color-elevated); box-shadow: var(--shadow-pop); overflow: auto; z-index: 200; }
.biz-drawer-head, .biz-modal-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2); }
.biz-modal { right: auto; left: 50%; top: 5vh; bottom: auto; transform: translateX(-50%); border-radius: var(--radius-lg); max-height: 90vh; }
.biz-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--space-2); }
.biz-field label { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.biz-input { padding: 6px 8px; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-size: var(--font-size-sm); }
.biz-modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
@media (max-width: 720px) {
  .biz { padding: var(--space-3); }
  .biz-body { grid-template-columns: minmax(0, 1fr); }
  .biz-sections { flex-direction: row; overflow-x: auto; }
}
</style>
