<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  QrCode,
  ShieldCheck,
  Trash,
} from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import {
  SMS_OPERATION,
  createApiKey,
  deleteApiKey,
  fetchApiKeys,
  sendSmsCode,
  updateApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from '@/modules/api/account-settings.api'
import { translateAccountMessage, useAccountI18n } from '@/modules/account/i18n'
import { maskApiSecret, normalizeIpAllowlist } from '@/modules/account/account-state'
import {
  isValidVerificationCode,
  redactSensitive,
  safeQrImage,
  totalPages,
  type FactorState,
} from '@/modules/security/security-state'
import VerificationCodeField from './VerificationCodeField.vue'

/**
 * API-key management: list, create, edit the IP allowlist / label, and delete.
 *
 * Source contract (`OpenApiAct`, `APImanagement.js`, `modifyApi.js`):
 * - `my_api_list` / `create_open_api` / `update_open_api` / `delete_open_api` only.
 * - Create, edit and (since 2026-10-16) delete require Google when `googleStatus=1` and an SMS code
 *   when `isOpenMobileCheck=1` (both, if both are enabled); delete sends `{ token, codes }` (an older
 *   server ignores the codes).
 * - Permissions (2026-10-16): every key reads and trades spot; the optional `authority` switches
 *   `earn` / `loan` (Binance "Enable …" style, default off) unlock API-key writes on the earn
 *   service. Sent on create/edit, shown in the list (an old server returns none → all off).
 * - `openapi/open_api_one` is intentionally never called: it re-fetches and renders a stored
 *   secret. Only a freshly created secret is shown, once, and kept in memory.
 *
 * Every read snapshots a request version plus the auth token; every mutation snapshots a generation
 * plus the token. Stale success/error/finally paths are dropped, old rows are cleared the moment the
 * session changes, and duplicate submissions are blocked.
 */
const props = defineProps<{
  authenticated: boolean
  googleFactor: FactorState
  smsFactor: FactorState
}>()
const { t } = useAccountI18n()

const COOLDOWN_SECONDS = 60
const PAGE_SIZE = 10

type Slot = 'create' | 'edit' | 'delete'
const SLOTS: readonly Slot[] = ['create', 'edit', 'delete']

const items = ref<ApiKeySummary[]>([])
const count = ref(0)
const page = ref(1)
const loading = ref(false)
const listError = ref('')

const createOpen = ref(false)
const createLabel = ref('')
const createIps = ref('')
const createSmsCode = ref('')
const createGoogleCode = ref('')
const createEarn = ref(false)
const createLoan = ref(false)
const creating = ref(false)
const createError = ref('')

const editing = ref<ApiKeySummary | null>(null)
const editLabel = ref('')
const editIps = ref('')
const editSmsCode = ref('')
const editGoogleCode = ref('')
const editEarn = ref(false)
const editLoan = ref(false)
const saving = ref(false)
const editError = ref('')

/** The key whose delete form is open (codes are asked like create/edit). */
const deleteTarget = ref<ApiKeySummary | null>(null)
const deleteSmsCode = ref('')
const deleteGoogleCode = ref('')
const deleteError = ref('')
const deletingToken = ref<string | null>(null)

const created = ref<CreatedApiKey | null>(null)
const secretRevealed = ref(false)
const copyNotice = ref('')

const sending = reactive<Record<Slot, boolean>>({ create: false, edit: false, delete: false })
const cooldowns = reactive<Record<Slot, number>>({ create: 0, edit: 0, delete: 0 })

let listVersion = 0
let generation = 0
let unmounted = false
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let sessionToken = session.getToken()
let unsubscribe: (() => void) | null = null

const factorsKnown = computed(() => props.googleFactor !== 'unknown' && props.smsFactor !== 'unknown')
const anyFactorEnabled = computed(
  () => props.googleFactor === 'enabled' || props.smsFactor === 'enabled',
)
const googleRequired = computed(() => props.googleFactor === 'enabled')
const smsRequired = computed(() => props.smsFactor === 'enabled')
/** Create/edit are only offered when both factors are known and at least one is enabled. */
const canOperate = computed(() => props.authenticated && factorsKnown.value && anyFactorEnabled.value)

const pages = computed(() => totalPages(count.value, PAGE_SIZE))
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < pages.value)
const pageInfo = computed(() =>
  t('account.apiKeys.page', { page: page.value, pages: pages.value, total: count.value }),
)
const qrSrc = computed(() => (created.value === null ? '' : safeQrImage(created.value.qrCode, window.location.origin)))
const shownSecret = computed(() =>
  created.value === null || !secretRevealed.value ? maskApiSecret() : created.value.secretKey,
)

function authToken(): string | null {
  return session.getToken()
}

function describe(cause: unknown): string {
  if (isApiError(cause)) {
    if (cause.kind === 'parse') {
      return t('account.error.malformed')
    }
    return translateAccountMessage(t, cause.message)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function redact(cause: unknown, values: readonly string[]): string {
  return redactSensitive(describe(cause), values)
}

function clearCreate(): void {
  generation += 1
  createOpen.value = false
  creating.value = false
  sending.create = false
  cooldowns.create = 0
  createLabel.value = ''
  createIps.value = ''
  createSmsCode.value = ''
  createGoogleCode.value = ''
  createEarn.value = false
  createLoan.value = false
  createError.value = ''
  stopTimerIfIdle()
}

function clearEdit(): void {
  generation += 1
  editing.value = null
  saving.value = false
  sending.edit = false
  cooldowns.edit = 0
  editLabel.value = ''
  editIps.value = ''
  editSmsCode.value = ''
  editGoogleCode.value = ''
  editEarn.value = false
  editLoan.value = false
  editError.value = ''
  stopTimerIfIdle()
}

function clearDelete(): void {
  generation += 1
  deleteTarget.value = null
  sending.delete = false
  cooldowns.delete = 0
  deleteSmsCode.value = ''
  deleteGoogleCode.value = ''
  deleteError.value = ''
  stopTimerIfIdle()
}

function closeCreated(): void {
  created.value = null
  secretRevealed.value = false
  copyNotice.value = ''
}

/** Drops list rows, forms and any in-memory secret — used on session change and unmount. */
function clearAll(): void {
  listVersion += 1
  items.value = []
  count.value = 0
  page.value = 1
  loading.value = false
  listError.value = ''
  deletingToken.value = null
  clearCreate()
  clearEdit()
  clearDelete()
  closeCreated()
  stopTimerIfIdle()
}

function stopTimer(): void {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  cooldowns.create = 0
  cooldowns.edit = 0
  cooldowns.delete = 0
}

function stopTimerIfIdle(): void {
  if (cooldowns.create === 0 && cooldowns.edit === 0 && cooldowns.delete === 0) {
    stopTimer()
  }
}

function tick(): void {
  let active = false
  for (const slot of SLOTS) {
    if (cooldowns[slot] > 0) {
      cooldowns[slot] -= 1
    }
    if (cooldowns[slot] > 0) {
      active = true
    }
  }
  if (!active) {
    stopTimer()
  }
}

function startCooldown(slot: Slot): void {
  cooldowns[slot] = COOLDOWN_SECONDS
  if (cooldownTimer === null) {
    cooldownTimer = setInterval(tick, 1000)
  }
}

function resendLabel(slot: Slot): string {
  return t('account.apiKeys.resendIn', { seconds: cooldowns[slot] })
}

async function load(): Promise<void> {
  if (!props.authenticated) {
    clearAll()
    return
  }
  const version = ++listVersion
  const token = session.getToken()
  sessionToken = token
  const requestedPage = page.value
  loading.value = true
  listError.value = ''
  try {
    const result = await fetchApiKeys({ page: requestedPage, pageSize: PAGE_SIZE })
    if (unmounted || version !== listVersion || token !== authToken()) return
    items.value = result.items
    count.value = result.count
  } catch (cause) {
    if (unmounted || version !== listVersion || token !== authToken()) return
    items.value = []
    count.value = 0
    listError.value = isApiError(cause) && cause.kind === 'parse'
      ? t('account.error.listMalformed')
      : translateAccountMessage(t, describe(cause))
  } finally {
    if (version === listVersion && !unmounted) {
      loading.value = false
    }
  }
}

function go(delta: number): void {
  const target = page.value + delta
  if (target < 1 || target > pages.value) {
    return
  }
  page.value = target
  void load()
}

function openCreate(): void {
  if (!canOperate.value) {
    return
  }
  generation += 1
  clearCreate()
  clearEdit()
  clearDelete()
  closeCreated()
  createOpen.value = true
}

function openEdit(item: ApiKeySummary): void {
  if (!canOperate.value) {
    return
  }
  generation += 1
  clearCreate()
  clearEdit()
  clearDelete()
  closeCreated()
  editing.value = item
  editLabel.value = item.label
  editIps.value = item.ips
  editEarn.value = item.permissions.earn
  editLoan.value = item.permissions.loan
}

function normalizedIps(raw: string): { ok: true; value: string } | { ok: false } {
  const result = normalizeIpAllowlist(raw)
  return result.ok ? { ok: true, value: result.value } : { ok: false }
}

function validateCreate(): string {
  if (createLabel.value.trim() === '') {
    return t('account.apiKeys.labelRule')
  }
  if (!normalizedIps(createIps.value).ok) {
    return t('account.apiKeys.ipRule')
  }
  if (googleRequired.value && !isValidVerificationCode(createGoogleCode.value)) {
    return t('account.apiKeys.codeRule')
  }
  if (smsRequired.value && !isValidVerificationCode(createSmsCode.value)) {
    return t('account.apiKeys.codeRule')
  }
  return ''
}

function validateEdit(): string {
  if (editLabel.value.trim() === '') {
    return t('account.apiKeys.labelRule')
  }
  if (!normalizedIps(editIps.value).ok) {
    return t('account.apiKeys.ipRule')
  }
  if (googleRequired.value && !isValidVerificationCode(editGoogleCode.value)) {
    return t('account.apiKeys.codeRule')
  }
  if (smsRequired.value && !isValidVerificationCode(editSmsCode.value)) {
    return t('account.apiKeys.codeRule')
  }
  return ''
}

const createValidation = computed(() => (createOpen.value ? validateCreate() : ''))
const canCreate = computed(() => createOpen.value && !creating.value && createValidation.value === '')
const editValidation = computed(() => (editing.value !== null ? validateEdit() : ''))
const canSave = computed(() => editing.value !== null && !saving.value && editValidation.value === '')

function validateDelete(): string {
  if (googleRequired.value && !isValidVerificationCode(deleteGoogleCode.value)) {
    return t('account.apiKeys.codeRule')
  }
  if (smsRequired.value && !isValidVerificationCode(deleteSmsCode.value)) {
    return t('account.apiKeys.codeRule')
  }
  return ''
}

const deleteValidation = computed(() => (deleteTarget.value !== null ? validateDelete() : ''))
/** Delete needs the factor state to be known so the right codes are asked (the server enforces them). */
const canDelete = computed(() => props.authenticated && factorsKnown.value)

function sendCreateCode(): void {
  void dispatch('create', () => sendSmsCode({ operationType: SMS_OPERATION.openApi }))
}

function sendEditCode(): void {
  void dispatch('edit', () => sendSmsCode({ operationType: SMS_OPERATION.openApi }))
}

function sendDeleteCode(): void {
  void dispatch('delete', () => sendSmsCode({ operationType: SMS_OPERATION.openApi }))
}

function setSlotError(slot: Slot, message: string): void {
  if (slot === 'create') {
    createError.value = message
  } else if (slot === 'edit') {
    editError.value = message
  } else {
    deleteError.value = message
  }
}

function slotCodes(slot: Slot): string[] {
  if (slot === 'create') return [createSmsCode.value, createGoogleCode.value]
  if (slot === 'edit') return [editSmsCode.value, editGoogleCode.value]
  return [deleteSmsCode.value, deleteGoogleCode.value]
}

async function dispatch(slot: Slot, run: () => Promise<unknown>): Promise<void> {
  if (sending[slot] || cooldowns[slot] > 0) {
    return
  }
  const gen = generation
  const token = authToken()
  sending[slot] = true
  setSlotError(slot, '')
  try {
    await run()
    if (unmounted || gen !== generation || token !== authToken()) return
    startCooldown(slot)
  } catch (cause) {
    if (unmounted || gen !== generation || token !== authToken()) return
    setSlotError(slot, redact(cause, slotCodes(slot)))
  } finally {
    if (gen === generation) {
      sending[slot] = false
    }
  }
}

async function submitCreate(): Promise<void> {
  if (!canCreate.value) {
  // Clickable while only the input is wrong: the click shows why (10-01 audit: disabled with the reason hidden).
    if (createOpen.value && !creating.value && createValidation.value !== '') createError.value = createValidation.value
    return
  }
  const ips = normalizedIps(createIps.value)
  if (!ips.ok) {
    return
  }
  const gen = generation
  const token = authToken()
  const label = createLabel.value
  const values = [createSmsCode.value, createGoogleCode.value]
  creating.value = true
  createError.value = ''
  try {
    const result = await createApiKey({
      believeIps: ips.value,
      label,
      permissions: { earn: createEarn.value, loan: createLoan.value },
      smsValidCode: smsRequired.value ? createSmsCode.value : undefined,
      googleCode: googleRequired.value ? createGoogleCode.value : undefined,
    })
    if (unmounted || gen !== generation || token !== authToken()) return
    createOpen.value = false
    creating.value = false
    createLabel.value = ''
    createIps.value = ''
    createSmsCode.value = ''
    createGoogleCode.value = ''
    created.value = result
    secretRevealed.value = false
    copyNotice.value = ''
    page.value = 1
    await load()
  } catch (cause) {
    if (unmounted || gen !== generation || token !== authToken()) return
    createError.value = redact(cause, values)
    createSmsCode.value = ''
    createGoogleCode.value = ''
  } finally {
    if (gen === generation) {
      creating.value = false
    }
  }
}

async function submitEdit(): Promise<void> {
  const target = editing.value
  if (!canSave.value || target === null) {
  // Clickable while only the input is wrong: the click shows why (10-01 audit: disabled with the reason hidden).
    if (target !== null && !saving.value && editValidation.value !== '') editError.value = editValidation.value
    return
  }
  const ips = normalizedIps(editIps.value)
  if (!ips.ok) {
    return
  }
  const gen = generation
  const token = authToken()
  const values = [editSmsCode.value, editGoogleCode.value]
  saving.value = true
  editError.value = ''
  try {
    await updateApiKey({
      token: target.token,
      believeIps: ips.value,
      label: editLabel.value,
      permissions: { earn: editEarn.value, loan: editLoan.value },
      smsValidCode: smsRequired.value ? editSmsCode.value : undefined,
      googleCode: googleRequired.value ? editGoogleCode.value : undefined,
    })
    if (unmounted || gen !== generation || token !== authToken()) return
    const savedLabel = editLabel.value
    const savedIps = ips.value
    const savedPermissions = { earn: editEarn.value, loan: editLoan.value }
    editing.value = null
    saving.value = false
    editSmsCode.value = ''
    editGoogleCode.value = ''
    // Reflect the edit locally, then confirm with a fresh read.
    items.value = items.value.map((item) =>
      item.token === target.token ? { ...item, label: savedLabel, ips: savedIps, permissions: savedPermissions } : item,
    )
    await load()
  } catch (cause) {
    if (unmounted || gen !== generation || token !== authToken()) return
    editError.value = redact(cause, values)
    editSmsCode.value = ''
    editGoogleCode.value = ''
  } finally {
    if (gen === generation) {
      saving.value = false
    }
  }
}

function requestDelete(item: ApiKeySummary): void {
  if (!canDelete.value) {
    return
  }
  generation += 1
  clearCreate()
  clearEdit()
  clearDelete()
  closeCreated()
  deleteTarget.value = item
}

function cancelDelete(): void {
  clearDelete()
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (target === null || deletingToken.value !== null) {
    return
  }
  const problem = validateDelete()
  if (problem !== '') {
    deleteError.value = problem
    return
  }
  const gen = generation
  const token = authToken()
  const values = [deleteSmsCode.value, deleteGoogleCode.value]
  deletingToken.value = target.token
  deleteError.value = ''
  try {
    await deleteApiKey({
      token: target.token,
      smsValidCode: smsRequired.value ? deleteSmsCode.value : undefined,
      googleCode: googleRequired.value ? deleteGoogleCode.value : undefined,
    })
    if (unmounted || gen !== generation || token !== authToken()) return
    clearDelete()
    items.value = items.value.filter((item) => item.token !== target.token)
    // Reload so the count and pagination come from the server.
    await load()
  } catch (cause) {
    if (unmounted || gen !== generation || token !== authToken()) return
    deleteError.value = redact(cause, values)
    deleteSmsCode.value = ''
    deleteGoogleCode.value = ''
  } finally {
    deletingToken.value = null
  }
}

function permissionText(item: ApiKeySummary): string {
  const parts = [t('account.apiKeys.permRead')]
  if (item.permissions.earn) parts.push(t('account.apiKeys.permEarnShort'))
  if (item.permissions.loan) parts.push(t('account.apiKeys.permLoanShort'))
  return parts.join(' · ')
}

async function copyText(value: string): Promise<boolean> {
  if (value === '') {
    return false
  }
  try {
    const clipboard = navigator.clipboard
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      return false
    }
    await clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

async function copySecret(): Promise<void> {
  if (created.value === null) {
    return
  }
  const ok = await copyText(created.value.secretKey)
  copyNotice.value = ok ? t('account.apiKeys.copied') : t('account.apiKeys.copyFailed')
}

watch(
  () => props.authenticated,
  (authenticated) => {
    if (authenticated) {
      void load()
    } else {
      clearAll()
    }
  },
)

onMounted(() => {
  unsubscribe = session.onInvalidate((snapshot) => {
    if (snapshot.token === sessionToken) {
      return
    }
    sessionToken = snapshot.token
    // Clear the previous account's rows, forms and any in-memory secret immediately.
    clearAll()
    if (session.isAuthenticated()) {
      void load()
    }
  })
  if (props.authenticated) {
    void load()
  }
})

onBeforeUnmount(() => {
  unmounted = true
  clearAll()
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <section class="settings-section">
    <div class="section-head">
      <h2 class="section-title"><KeyRound :size="15" aria-hidden="true" />{{ t('account.apiKeys.title') }}</h2>
      <button
        v-if="canOperate && !createOpen && editing === null"
        class="btn"
        type="button"
        @click="openCreate"
      >
        <Plus :size="14" aria-hidden="true" />
        {{ t('account.apiKeys.create') }}
      </button>
    </div>

    <p class="section-desc">{{ t('account.apiKeys.description') }}</p>
    <p class="section-note">{{ t('account.apiKeys.capabilityNote') }}</p>

    <p v-if="!factorsKnown" class="notice notice-error wrap-anywhere">
      {{ t('account.apiKeys.factorUnknown') }}
    </p>
    <p v-else-if="!anyFactorEnabled" class="notice notice-error wrap-anywhere">
      {{ t('account.apiKeys.noFactor') }}
    </p>

    <!-- Created secret: shown once, masked by default, cleared on close/unmount/logout. -->
    <div v-if="created !== null" class="secret-result">
      <div class="secret-head">
        <ShieldCheck :size="16" aria-hidden="true" />
        <strong>{{ t('account.apiKeys.secretTitle') }}</strong>
      </div>
      <p class="field-hint">{{ t('account.apiKeys.secretHint') }}</p>
      <div class="secret-line">
        <span class="secret-label">{{ t('account.apiKeys.apiKeyLabel') }}</span>
        <code class="secret-value wrap-anywhere">{{ created.token }}</code>
      </div>
      <div class="secret-line">
        <span class="secret-label">{{ t('account.apiKeys.secretLabel') }}</span>
        <code class="secret-value wrap-anywhere">{{ shownSecret }}</code>
        <button
          class="icon-button"
          type="button"
          :aria-label="secretRevealed ? t('account.apiKeys.hideSecret') : t('account.apiKeys.showSecret')"
          :title="secretRevealed ? t('account.apiKeys.hideSecret') : t('account.apiKeys.showSecret')"
          @click="secretRevealed = !secretRevealed"
        >
          <EyeOff v-if="secretRevealed" :size="16" /><Eye v-else :size="16" />
        </button>
        <button
          class="icon-button"
          type="button"
          :aria-label="t('account.apiKeys.copy')"
          :title="t('account.apiKeys.copy')"
          @click="copySecret"
        >
          <Copy :size="16" />
        </button>
      </div>
      <img v-if="qrSrc !== ''" class="qr" :src="qrSrc" :alt="t('account.apiKeys.qrAlt')" referrerpolicy="no-referrer" />
      <p v-if="copyNotice !== ''" class="field-hint">{{ copyNotice }}</p>
      <div class="actions">
        <button class="btn" type="button" @click="closeCreated">{{ t('account.apiKeys.close') }}</button>
      </div>
    </div>

    <!-- Create form -->
    <form v-if="createOpen" class="form" @submit.prevent="submitCreate">
      <h3 class="form-title"><QrCode :size="15" aria-hidden="true" />{{ t('account.apiKeys.createTitle') }}</h3>
      <div class="field">
        <label class="field-label" for="api-label">{{ t('account.apiKeys.labelField') }}</label>
        <div class="field-input">
          <input id="api-label" v-model="createLabel" type="text" :aria-label="t('account.apiKeys.labelField')" />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="api-ips">{{ t('account.apiKeys.ipField') }}</label>
        <div class="field-input">
          <input id="api-ips" v-model="createIps" type="text" :aria-label="t('account.apiKeys.ipField')" />
        </div>
      </div>
      <fieldset class="field perms">
        <legend class="field-label">{{ t('account.apiKeys.permissions') }}</legend>
        <label class="perm"><input type="checkbox" checked disabled />{{ t('account.apiKeys.permRead') }}</label>
        <label class="perm"><input v-model="createEarn" type="checkbox" />{{ t('account.apiKeys.permEarn') }}</label>
        <label class="perm"><input v-model="createLoan" type="checkbox" />{{ t('account.apiKeys.permLoan') }}</label>
      </fieldset>
      <VerificationCodeField
        v-if="smsRequired"
        id="api-create-sms"
        v-model="createSmsCode"
        :label="t('account.apiKeys.smsCode')"
        :send-label="t('account.apiKeys.sendCode')"
        :sending-label="t('account.apiKeys.sending')"
        :resend-label="resendLabel('create')"
        :sending="sending.create"
        :cooldown="cooldowns.create"
        @send="sendCreateCode"
      />
      <div v-if="googleRequired" class="field">
        <label class="field-label" for="api-create-google">{{ t('account.apiKeys.googleCode') }}</label>
        <div class="field-input">
          <input
            id="api-create-google"
            v-model="createGoogleCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            :aria-label="t('account.apiKeys.googleCode')"
          />
        </div>
      </div>
      <p v-if="createError !== ''" class="notice notice-error wrap-anywhere">{{ createError }}</p>
      <div class="actions">
        <button class="btn btn-primary" type="submit" :disabled="creating">
          {{ creating ? t('account.apiKeys.submitting') : t('account.apiKeys.submitCreate') }}
        </button>
        <button class="btn btn-ghost" type="button" @click="clearCreate">{{ t('account.apiKeys.cancel') }}</button>
      </div>
    </form>

    <!-- Edit form -->
    <form v-if="editing !== null" class="form" @submit.prevent="submitEdit">
      <h3 class="form-title"><Pencil :size="15" aria-hidden="true" />{{ t('account.apiKeys.editTitle') }}</h3>
      <div class="field">
        <label class="field-label" for="api-edit-label">{{ t('account.apiKeys.labelField') }}</label>
        <div class="field-input">
          <input id="api-edit-label" v-model="editLabel" type="text" :aria-label="t('account.apiKeys.labelField')" />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="api-edit-ips">{{ t('account.apiKeys.ipField') }}</label>
        <div class="field-input">
          <input id="api-edit-ips" v-model="editIps" type="text" :aria-label="t('account.apiKeys.ipField')" />
        </div>
      </div>
      <fieldset class="field perms">
        <legend class="field-label">{{ t('account.apiKeys.permissions') }}</legend>
        <label class="perm"><input type="checkbox" checked disabled />{{ t('account.apiKeys.permRead') }}</label>
        <label class="perm"><input v-model="editEarn" type="checkbox" />{{ t('account.apiKeys.permEarn') }}</label>
        <label class="perm"><input v-model="editLoan" type="checkbox" />{{ t('account.apiKeys.permLoan') }}</label>
      </fieldset>
      <VerificationCodeField
        v-if="smsRequired"
        id="api-edit-sms"
        v-model="editSmsCode"
        :label="t('account.apiKeys.smsCode')"
        :send-label="t('account.apiKeys.sendCode')"
        :sending-label="t('account.apiKeys.sending')"
        :resend-label="resendLabel('edit')"
        :sending="sending.edit"
        :cooldown="cooldowns.edit"
        @send="sendEditCode"
      />
      <div v-if="googleRequired" class="field">
        <label class="field-label" for="api-edit-google">{{ t('account.apiKeys.googleCode') }}</label>
        <div class="field-input">
          <input
            id="api-edit-google"
            v-model="editGoogleCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            :aria-label="t('account.apiKeys.googleCode')"
          />
        </div>
      </div>
      <p v-if="editError !== ''" class="notice notice-error wrap-anywhere">{{ editError }}</p>
      <div class="actions">
        <button class="btn btn-primary" type="submit" :disabled="saving">
          {{ saving ? t('account.apiKeys.submitting') : t('account.apiKeys.submitEdit') }}
        </button>
        <button class="btn btn-ghost" type="button" @click="clearEdit">{{ t('account.apiKeys.cancel') }}</button>
      </div>
    </form>

    <!-- Delete form: the bound second factors, like create/edit -->
    <form v-if="deleteTarget !== null" class="form" @submit.prevent="confirmDelete">
      <h3 class="form-title"><Trash :size="15" aria-hidden="true" />{{ t('account.apiKeys.deleteTitle') }}</h3>
      <p class="field-hint wrap-anywhere">
        {{ deleteTarget.label }} · <code class="mono">{{ deleteTarget.token }}</code>
      </p>
      <p class="field-hint">{{ t('account.apiKeys.deleteConfirm') }}</p>
      <p v-if="anyFactorEnabled" class="field-hint">{{ t('account.apiKeys.deleteFactorHint') }}</p>
      <VerificationCodeField
        v-if="smsRequired"
        id="api-delete-sms"
        v-model="deleteSmsCode"
        :label="t('account.apiKeys.smsCode')"
        :send-label="t('account.apiKeys.sendCode')"
        :sending-label="t('account.apiKeys.sending')"
        :resend-label="resendLabel('delete')"
        :sending="sending.delete"
        :cooldown="cooldowns.delete"
        @send="sendDeleteCode"
      />
      <div v-if="googleRequired" class="field">
        <label class="field-label" for="api-delete-google">{{ t('account.apiKeys.googleCode') }}</label>
        <div class="field-input">
          <input
            id="api-delete-google"
            v-model="deleteGoogleCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            :aria-label="t('account.apiKeys.googleCode')"
          />
        </div>
      </div>
      <p v-if="deleteError !== ''" class="notice notice-error wrap-anywhere">{{ deleteError }}</p>
      <div class="actions">
        <button class="btn btn-danger-text" type="submit" :disabled="deletingToken !== null">
          {{ deletingToken !== null ? t('account.apiKeys.deleting') : t('account.apiKeys.deleteConfirmYes') }}
        </button>
        <button class="btn btn-ghost" type="button" @click="cancelDelete">{{ t('account.apiKeys.cancel') }}</button>
      </div>
    </form>

    <StateBlock v-if="loading && items.length === 0" variant="loading" :message="t('account.apiKeys.loading')" />
    <StateBlock v-else-if="listError !== ''" variant="error" :message="listError" retryable @retry="load" />
    <StateBlock v-else-if="items.length === 0" variant="empty" :message="t('account.apiKeys.empty')" />
    <table v-else class="table api-keys">
      <thead>
        <tr>
          <th>{{ t('account.apiKeys.label') }}</th>
          <th>{{ t('account.apiKeys.ips') }}</th>
          <th>{{ t('account.apiKeys.token') }}</th>
          <th>{{ t('account.apiKeys.permissions') }}</th>
          <th class="col-actions">{{ t('account.apiKeys.edit') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.token">
          <td class="wrap-anywhere">{{ item.label }}</td>
          <td class="wrap-anywhere">{{ item.ips === '' ? t('account.apiKeys.noIp') : item.ips }}</td>
          <td class="wrap-anywhere"><code class="mono">{{ item.token }}</code></td>
          <td class="wrap-anywhere">{{ permissionText(item) }}</td>
          <td class="col-actions">
            <button class="btn btn-ghost" type="button" :disabled="!canOperate" @click="openEdit(item)">
              <Pencil :size="14" aria-hidden="true" />{{ t('account.apiKeys.edit') }}
            </button>
            <button class="btn btn-ghost danger" type="button" :disabled="!canDelete" @click="requestDelete(item)">
              <Trash :size="14" aria-hidden="true" />{{ t('account.apiKeys.delete') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="count > PAGE_SIZE" class="pager">
      <button class="btn btn-ghost" type="button" :disabled="!hasPrev || loading" @click="go(-1)">
        <ChevronLeft :size="14" aria-hidden="true" />{{ t('account.apiKeys.prev') }}
      </button>
      <span class="pager-info num">{{ pageInfo }}</span>
      <button class="btn btn-ghost" type="button" :disabled="!hasNext || loading" @click="go(1)">
        {{ t('account.apiKeys.next') }}<ChevronRight :size="14" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.settings-section {
  margin-top: 18px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border-strong);
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
}

.section-desc {
  margin: 10px 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.section-note {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 460px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
}

.form-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.secret-result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 520px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--color-up);
  border-radius: var(--radius-sm);
  background: var(--color-up-soft);
}

.secret-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-up);
}

.secret-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.secret-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.secret-value {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.qr {
  width: 148px;
  height: 148px;
  image-rendering: pixelated;
  background: #ffffff;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  object-fit: contain;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.api-keys {
  margin-top: 12px;
}

.col-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.perms {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.perm {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.mono {
  font-family: var(--font-mono);
}

.btn.danger {
  color: var(--color-down);
}

.btn-danger-text {
  color: var(--color-down);
}

.pager {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: 10px;
}

.pager-info {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

@media (max-width: 640px) {
  .api-keys thead {
    display: none;
  }

  .api-keys tbody tr {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
  }

  .api-keys tbody td {
    border: none;
    padding: 2px 0;
  }

  .col-actions {
    flex: 1 1 100%;
    justify-content: flex-start;
  }
}
</style>
