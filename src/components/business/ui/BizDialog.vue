<script setup lang="ts">
import { translateForLocale } from '@/i18n/composer'
/**
 * One action dialog for every product page (subscribe, redeem, stake, borrow, repay, …), Binance-style:
 * a short summary of the product, the amount with "可用 / Max", an optional live estimate from the server, the risk
 * notes and an explicit agreement before the single POST. Amounts stay decimal strings (IRON RULE). A POST is never
 * retried: an unconfirmed result keeps the dialog locked and tells the user to check the records first.
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { BusinessApiError, businessRequest, rowOf, type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { Decimal, isDecimalString } from '@/modules/finance/decimal'
import { amount as fmtAmount, type Lang } from '@/modules/business/format'
import { toastSuccess } from '@/core/toast'
import BusinessAgreement from './BusinessAgreement.vue'

export interface DialogOption { value: string; label: string }
export interface DialogField {
  key: string
  label: string
  kind: 'amount' | 'select' | 'text'
  asset?: string
  available?: string | null
  min?: string | null
  max?: string | null
  scale?: number
  placeholder?: string
  options?: DialogOption[]
  default?: string
  optional?: boolean
  hint?: string
}
export interface SummaryLine { label: string; value: string; tone?: 'up' | 'down' | 'accent' }
export interface DialogPreview { path: string; keys: string[]; render: (row: BusinessRow) => SummaryLine[] }

const props = defineProps<{
  open: boolean
  lang: Lang
  title: string
  path: string
  fixed?: BusinessParams
  fields: DialogField[]
  summary?: SummaryLine[]
  preview?: DialogPreview | null
  notes?: string[]
  agree?: string
  agreementKind?: 'earn' | 'loan'
  submitText?: string
  danger?: boolean
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done', result: BusinessRow): void }>()

const form = reactive<Record<string, string>>({})
const agreed = ref(false)
const agreementReady = ref(false)
const busy = ref(false)
const error = ref('')
const unavailableLoanCoin = ref('')
const locked = ref(false)
const previewLines = ref<SummaryLine[]>([])
const previewError = ref('')
const uiText = (key: string, values?: Record<string, unknown>) => translateForLocale(props.lang, key, values)
const submitError = computed(() => unavailableLoanCoin.value
  ? uiText('error.loanPoolInsufficient', { coin: unavailableLoanCoin.value })
  : locked.value ? uiText('bizDialog.theResultIsNotConfirmedYetCheckYourRecords') : error.value)

watch(() => props.open, (open) => {
  if (!open) return
  for (const k of Object.keys(form)) delete form[k]
  for (const f of props.fields) form[f.key] = f.default ?? (f.kind === 'select' ? (f.options?.[0]?.value ?? '') : '')
  agreed.value = false; busy.value = false; error.value = ''; locked.value = false
  unavailableLoanCoin.value = ''
  previewLines.value = []; previewError.value = ''
}, { immediate: true })

function sanitize(f: DialogField, raw: string): string {
  let v = raw.replace(/[^\d.]/g, '')
  const dot = v.indexOf('.')
  if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
  if (f.scale !== undefined && dot >= 0) v = v.slice(0, dot + 1 + f.scale)
  return v
}
function onAmount(f: DialogField, e: Event) {
  const el = e.target as HTMLInputElement
  const v = sanitize(f, el.value)
  form[f.key] = v
  if (el.value !== v) el.value = v
}
function setMax(f: DialogField) {
  let v = f.available ?? ''
  if (f.max && isDecimalString(f.max) && isDecimalString(v) && new Decimal(f.max).lt(v)) v = f.max
  if (isDecimalString(v)) form[f.key] = new Decimal(v).toDecimalPlaces(f.scale ?? 8, Decimal.ROUND_DOWN).toFixed()
}

function fieldError(f: DialogField): string {
  const v = form[f.key] ?? ''
  if (f.kind !== 'amount') return !f.optional && v.trim() === '' ? uiText('bizDialog.required') : ''
  if (v === '') return f.optional ? '' : uiText('bizDialog.enterAnAmount')
  if (!isDecimalString(v) || new Decimal(v).lte(0)) return uiText('bizDialog.enterAnAmountAbove0')
  if (f.min && isDecimalString(f.min) && new Decimal(v).lt(f.min)) return uiText('bizDialog.minimum', { min: fmtAmount(f.min), asset: f.asset ?? '' })
  if (f.max && isDecimalString(f.max) && new Decimal(v).gt(f.max)) return uiText('bizDialog.maximum', { max: fmtAmount(f.max), asset: f.asset ?? '' })
  if (f.available !== undefined && f.available !== null && isDecimalString(f.available) && new Decimal(v).gt(f.available)) return uiText('bizDialog.insufficientAvailableBalance')
  return ''
}
const errors = computed(() => Object.fromEntries(props.fields.map(f => [f.key, fieldError(f)])))
const touched = reactive<Record<string, boolean>>({})
const valid = computed(() => props.fields.every(f => errors.value[f.key] === ''))
const canSubmit = computed(() => valid.value && (!props.agree || (agreed.value && (!props.agreementKind || agreementReady.value))) && !busy.value && !locked.value)

let timer = 0
let pctrl: AbortController | null = null
watch(() => props.preview ? props.preview.keys.map(k => form[k] ?? props.fixed?.[k] ?? '').join('|') : '', () => {
  if (!props.open || !props.preview) return
  window.clearTimeout(timer)
  pctrl?.abort(); pctrl = null
  previewLines.value = []; previewError.value = ''
  if (!valid.value) return
  timer = window.setTimeout(async () => {
    const p = props.preview
    if (!p) return
    pctrl?.abort(); const mine = new AbortController(); pctrl = mine
    const params: BusinessParams = {}
    for (const k of p.keys) params[k] = form[k] ?? props.fixed?.[k] ?? ''
    try {
      const data = await businessRequest(p.path, params, false, mine.signal)
      if (pctrl === mine) previewLines.value = p.render(rowOf(Array.isArray(data) ? data[0] : data))
    } catch (e) {
      if (pctrl === mine) previewError.value = e instanceof Error ? e.message : String(e)
    }
  }, 350)
})
onBeforeUnmount(() => { window.clearTimeout(timer); pctrl?.abort() })

async function submit() {
  for (const f of props.fields) touched[f.key] = true
  if (!canSubmit.value) return
  busy.value = true; error.value = ''
  unavailableLoanCoin.value = ''
  const params: BusinessParams = { ...(props.fixed ?? {}) }
  for (const f of props.fields) if (!(f.optional && (form[f.key] ?? '') === '')) params[f.key] = form[f.key] ?? ''
  try {
    const result = await businessRequest(props.path, params, true)
    toastSuccess(uiText('bizDialog.submitted'))
    emit('done', rowOf(result))
    emit('close')
  } catch (e) {
    if (e instanceof BusinessApiError && e.unconfirmed) {
      locked.value = true
    } else if (e instanceof BusinessApiError && e.code === '-17004' && props.path === '/sapi/v2/loan/flexible/borrow' && params.loanCoin) {
      unavailableLoanCoin.value = params.loanCoin
    } else {
      error.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dlg-mask" @click.self="!busy && emit('close')">
      <div class="dlg" role="dialog" aria-modal="true" :aria-label="title">
        <header class="dlg-head">
          <h2>{{ title }}</h2>
          <button class="dlg-x" type="button" :aria-label="uiText('bizDialog.close')" :disabled="busy" @click="emit('close')"><X :size="18" /></button>
        </header>

        <dl v-if="summary && summary.length" class="dlg-summary">
          <div v-for="line in summary" :key="line.label"><dt>{{ line.label }}</dt><dd class="num" :class="line.tone">{{ line.value }}</dd></div>
        </dl>

        <div class="dlg-fields">
          <label v-for="f in fields" :key="f.key" class="dlg-field">
            <span class="dlg-label">
              {{ f.label }}
              <span v-if="f.kind === 'amount' && f.available !== undefined && f.available !== null" class="dlg-avail">
                {{ uiText('bizDialog.available') }} <b class="num">{{ fmtAmount(f.available) }}</b> {{ f.asset }}
              </span>
            </span>
            <span v-if="f.kind === 'amount'" class="dlg-input" :class="{ bad: touched[f.key] && errors[f.key] }">
              <input :value="form[f.key]" inputmode="decimal" autocomplete="off" :placeholder="f.placeholder ?? (f.min ? uiText('bizDialog.min', { min: fmtAmount(f.min) }) : uiText('bizDialog.enterAmount'))"
                @input="onAmount(f, $event)" @blur="touched[f.key] = true">
              <span class="dlg-unit">{{ f.asset }}</span>
              <button v-if="f.available !== undefined && f.available !== null" class="dlg-max" type="button" @click="setMax(f)">{{ uiText('bizDialog.max') }}</button>
            </span>
            <select v-else-if="f.kind === 'select'" v-model="form[f.key]" class="dlg-select">
              <option v-for="o in f.options ?? []" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input v-else v-model="form[f.key]" class="dlg-text" :placeholder="f.placeholder" autocomplete="off" @blur="touched[f.key] = true">
            <span v-if="touched[f.key] && errors[f.key]" class="dlg-err">{{ errors[f.key] }}</span>
            <span v-else-if="f.hint" class="dlg-hint">{{ f.hint }}</span>
          </label>
        </div>

        <dl v-if="previewLines.length" class="dlg-summary dlg-preview">
          <div v-for="line in previewLines" :key="line.label"><dt>{{ line.label }}</dt><dd class="num" :class="line.tone">{{ line.value }}</dd></div>
        </dl>
        <p v-else-if="previewError" class="dlg-hint">{{ previewError }}</p>

        <ul v-if="notes && notes.length" class="dlg-notes">
          <li v-for="n in notes" :key="n">{{ n }}</li>
        </ul>
        <BusinessAgreement v-if="agreementKind" :kind="agreementKind" :lang="lang" @ready="agreementReady = $event; agreed = false" />
        <label v-if="agree" class="dlg-agree"><input v-model="agreed" type="checkbox" :disabled="!!agreementKind && !agreementReady"> <span>{{ agree }}</span></label>

        <p v-if="submitError" class="dlg-error" role="alert">{{ submitError }}</p>
        <button class="btn btn-primary btn-block" :class="{ danger }" type="button" :disabled="!canSubmit" @click="submit">
          {{ busy ? uiText('bizDialog.submitting') : (submitText ?? uiText('bizDialog.confirm')) }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dlg-mask { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: rgba(8, 10, 14, 0.55); }
.dlg { width: min(440px, 100%); min-width: 0; max-height: calc(100vh - 32px); overflow-y: auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 22px; border-radius: var(--radius-lg); background: var(--color-elevated); border: 1px solid var(--color-border); box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.45); }
.dlg > *, .dlg-field > * { min-width: 0; overflow-wrap: anywhere; }
.dlg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dlg-head h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: var(--font-size-lg); font-weight: 700; }
.dlg-x { flex-shrink: 0; display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.dlg-x:hover { background: var(--color-hover); color: var(--color-text); }
.dlg-summary { margin: 0; display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--radius); background: var(--color-surface-alt); }
.dlg-summary div { min-width: 0; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-size: var(--font-size-sm); }
.dlg-summary dt { color: var(--color-text-muted); }
.dlg-summary dd { min-width: 0; max-width: 100%; margin: 0 0 0 auto; white-space: normal; overflow-wrap: anywhere; font-weight: 600; text-align: right; }
.dlg-summary dd.up { color: var(--color-up); }
.dlg-summary dd.down { color: var(--color-down); }
.dlg-summary dd.accent { color: var(--color-accent-text); }
.dlg-preview { background: var(--color-accent-soft); }
.dlg-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.dlg-field { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.dlg-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; font-size: var(--font-size-sm); color: var(--color-text-secondary); font-weight: 550; }
.dlg-avail { color: var(--color-text-muted); font-weight: 400; }
.dlg-avail b { white-space: normal; overflow-wrap: anywhere; color: var(--color-text); font-weight: 600; }
.dlg-input { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface); }
.dlg-input:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.dlg-input.bad { border-color: var(--color-down); }
.dlg-input input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--color-text); font: 600 16px var(--font-mono); }
.dlg-unit { color: var(--color-text-muted); font-size: var(--font-size-sm); font-weight: 600; }
.dlg-max { border: 0; background: transparent; color: var(--color-accent-text); font-weight: 700; font-size: var(--font-size-sm); cursor: pointer; padding: 4px; }
.dlg-select, .dlg-text { min-width: 0; width: 100%; max-width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text); font-size: var(--font-size-md); }
.dlg-err { color: var(--color-down); font-size: var(--font-size-xs); }
.dlg-hint { margin: 0; color: var(--color-text-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.dlg-notes { margin: 0; padding-left: 18px; display: grid; gap: 4px; color: var(--color-text-muted); font-size: var(--font-size-xs); line-height: 1.55; }
.dlg-agree { display: flex; gap: 8px; align-items: flex-start; font-size: var(--font-size-xs); color: var(--color-text-secondary); line-height: 1.5; cursor: pointer; }
.dlg-agree input { margin-top: 2px; accent-color: var(--color-accent); }
.dlg-error { margin: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--color-down-soft); color: var(--color-down); font-size: var(--font-size-sm); }
.btn.danger { background: var(--color-down); border-color: var(--color-down); color: #fff; }
</style>
