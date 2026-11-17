<script setup lang="ts">
import { i18n } from '@/i18n/composer'
/**
 * 内账转账面板：现货可用余额 → 同一平台的另一个 UID（`/fe-ex-api/finance/inner_transfer/*`）。
 *
 * - 只做前端展示与流程编排；金额一律精确字符串，不运算、不补 0、不舍入（`groupDigits` 只分组）。
 * - create **绝不自动重试**：结果未知时锁定本次填写，仅提供“查询原转账”和原单号。
 * - 验证码发送复用 `@/modules/api/wallet.api` 的 `sendEmailCode` / `sendSmsCode`（`/wallet-api/validCode/*`，无 body）。
 * - sessionStorage 只保存**本 UID 绑定的原单 requestId**（非金额/非 secret），用于刷新后查询原单。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { useSessionStore } from '@/stores/session'
import { cmp, decimalPlaces, groupDigits, isDecimalString, isPositive } from '@/modules/finance/decimal'
import {
  createTransfer,
  isDefinitiveCreateRejection,
  isPreviewRecoverable,
  isValidRequestId,
  loadTransferConfig,
  newRequestId,
  previewTransfer,
  type TransferConfig,
  type TransferPreview,
  type TransferRecord,
} from '@/modules/api/internal-transfer.api'
import { sendEmailCode, sendSmsCode } from '@/modules/api/wallet.api'
import { useAccountStore } from '@/stores/account'
import CodeField from './CodeField.vue'
import InternalTransferHistory from './InternalTransferHistory.vue'
import GuestGate from '@/components/common/GuestGate.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { useInternalTransferI18n } from './InternalTransferMessages'

const props = withDefaults(defineProps<{ coin?: string }>(), { coin: '' })
const emit = defineEmits<{
  (event: 'submitted', record: TransferRecord): void
  (event: 'transferred', record: TransferRecord): void
}>()
const { t } = useInternalTransferI18n()
const account = useAccountStore()
const sessionStore = useSessionStore()
const errMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const COOLDOWN_SECONDS = 60

const loading = ref(false)
const configError = ref('')
// Keep the original reason so an already-visible refusal follows locale changes.
const configErrorMessage = computed(() => configError.value === '站内转账暂未开放'
  ? t('internalTransfer.notOpen')
  : configError.value)
const configRetryable = ref(true)
const config = ref<TransferConfig | null>(null)

const selectedCoin = ref('')
const toUid = ref('')
const amount = ref('')

const preview = ref<TransferPreview | null>(null)
const previewing = ref(false)
const previewError = ref('')
const previewRecoverable = ref(false)

const confirmOpen = ref(false)
const googleCode = ref('')
const emailCode = ref('')
const smsCode = ref('')

const sendingCode = ref('')
const cooldown = ref(0)
const submitting = ref(false)

const result = ref<TransferRecord | null>(null)
const definitiveError = ref('')
const copyNotice = ref('')
const codeNotice = ref('')
const locked = ref(false)
const lockedRequestId = ref('')
const historyRefresh = ref(0)

let generation = 0
let configVersion = 0
let cooldownTimer: ReturnType<typeof setInterval> | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined
let pendingOwner = ''
const now = ref(Date.now()) // Time only, never a monetary value.
const previewExpired = computed(() => preview.value !== null && preview.value.expireAt <= now.value)

/** 冻结的确认意图：确认一次只生成一个 requestId，重试沿用原值。 */
const frozen = ref<{ requestId: string; previewToken: string; toUid: string; coin: string; amount: string } | null>(null)

function myUid(): string {
  const id = sessionStore.user?.id
  // Non-monetary identifier: safe to stringify.
  return id === undefined ? '' : String(id)
}
function storageKey(uid: string): string {
  return `picat.internalTransfer.req.${uid}`
}

const authenticated = computed(() => sessionStore.isAuthenticated)
const coins = computed(() => config.value?.coins ?? [])
const activeCoin = computed(() => coins.value.find((c) => c.coin === selectedCoin.value.toUpperCase()))
const available = computed(() => {
  const row = account.coinRows.find((r) => r.coin === selectedCoin.value.toUpperCase())
  return row === undefined ? '' : row.available
})
const canUseAvailable = computed(() => available.value !== '' && isDecimalString(available.value))

function clearPreviewState(): void {
  preview.value = null
  previewError.value = ''
  googleCode.value = ''
  emailCode.value = ''
  smsCode.value = ''
}

function applyServerConfig(next: TransferConfig | null): void {
  config.value = next
  const wanted = props.coin !== '' ? props.coin.toUpperCase() : selectedCoin.value.toUpperCase()
  const keep = next?.coins.find((c) => c.coin === wanted)
  selectedCoin.value = keep?.coin ?? next?.coins[0]?.coin ?? ''
}

async function loadConfig(): Promise<void> {
  if (submitting.value) return
  const current = generation
  const version = ++configVersion
  const token = session.getToken()
  if (!session.isAuthenticated() || token === null) {
    applyServerConfig(null)
    return
  }
  loading.value = true
  configError.value = ''
  try {
    if (sessionStore.user?.id === undefined) await sessionStore.loadUserInfo()
    if (current !== generation || version !== configVersion || token !== session.getToken()) return
    restorePendingFromStorage()
    const next = await loadTransferConfig()
    if (current !== generation || version !== configVersion || token !== session.getToken()) return
    applyServerConfig(next)
    await account.load()
  } catch (e) {
    if (version !== configVersion || token !== session.getToken()) return
    configError.value = errMessage(e)
    configRetryable.value = !(isApiError(e) && e.kind === 'api' && e.code === 'INNER_TRANSFER_ERROR')
    applyServerConfig(null)
  } finally {
    if (version === configVersion && token === session.getToken()) loading.value = false
  }
}

function uidValid(): boolean {
  return /^\d{1,20}$/.test(toUid.value.trim())
}

const amountValid = computed(() => {
  const value = amount.value.trim()
  if (!isDecimalString(value) || !isPositive(value)) return false
  const dp = decimalPlaces(value)
  const precision = activeCoin.value?.precision
  return dp !== null && precision !== undefined && dp <= precision
})

const draftError = computed(() => {
  if (toUid.value.trim() !== '' && !uidValid()) return t('internalTransfer.uidInvalid')
  if (toUid.value.trim() !== '' && toUid.value.trim() === myUid()) return t('internalTransfer.selfUid')
  const value = amount.value.trim()
  if (value === '') return ''
  if (!isDecimalString(value) || !isPositive(value)) return t('internalTransfer.amountInvalid')
  const dp = decimalPlaces(value)
  const precision = activeCoin.value?.precision
  if (dp !== null && precision !== undefined && dp > precision) return t('internalTransfer.precision', { dp: precision })
  return ''
})

const canPreview = computed(() => authenticated.value && myUid() !== '' && !locked.value && !submitting.value
  && !loading.value && result.value === null && canUseAvailable.value && selectedCoin.value !== ''
  && uidValid() && amountValid.value && !previewing.value)

function closeConfirm(): void {
  if (submitting.value || sendingCode.value !== '') return
  confirmOpen.value = false
  googleCode.value = ''
  emailCode.value = ''
  smsCode.value = ''
  codeNotice.value = ''
  if (!locked.value && result.value === null) frozen.value = null
}

async function runPreview(): Promise<void> {
  if (!canPreview.value) return
  const coin = selectedCoin.value.toUpperCase()
  if (toUid.value.trim() === myUid()) {
    previewError.value = t('internalTransfer.selfUid')
    return
  }
  const current = ++generation
  const token = session.getToken()
  const input = { toUid: toUid.value.trim(), coin, amount: amount.value.trim() }
  previewing.value = true
  previewError.value = ''
  preview.value = null
  googleCode.value = ''
  emailCode.value = ''
  smsCode.value = ''
  try {
    const next = await previewTransfer(input)
    if (current !== generation || token !== session.getToken()) return
    if (next.toUid !== input.toUid || next.coin.toUpperCase() !== input.coin || cmp(next.amount, input.amount) !== 0) {
      throw new Error(t('internalTransfer.previewMismatch'))
    }
    preview.value = next
    if (cmp(next.totalDebit, next.available) > 0) {
      previewError.value = t('internalTransfer.aboveAvailable')
    }
  } catch (e) {
    if (current !== generation || token !== session.getToken()) return
    // 预览失败不锁定；过期/参数/security 拒绝可由用户修改后重试。
    previewRecoverable.value = isPreviewRecoverable(e)
    previewError.value = errMessage(e)
  } finally {
    if (current === generation) previewing.value = false
  }
}

function openConfirm(): void {
  if (preview.value === null || preview.value.expireAt <= Date.now() || locked.value || submitting.value || result.value !== null) return
  const sameIntent = frozen.value !== null && frozen.value.previewToken === preview.value.previewToken
  if (!sameIntent) {
    let id: string
    try { id = newRequestId() } catch (error) {
      previewError.value = errMessage(error)
      return
    }
    frozen.value = {
      requestId: id,
      previewToken: preview.value.previewToken,
      toUid: preview.value.toUid,
      coin: preview.value.coin,
      amount: preview.value.amount,
    }
  }
  confirmOpen.value = true
}

function persistPendingKey(id: string): void {
  const uid = myUid()
  if (uid === '' || !isValidRequestId(id) || typeof sessionStorage === 'undefined') return
  pendingOwner = uid
  try { sessionStorage.setItem(storageKey(uid), id) } catch { /* storage blocked */ }
}
function clearPendingKey(): void {
  const uid = pendingOwner || myUid()
  if (uid === '' || typeof sessionStorage === 'undefined') return
  try { sessionStorage.removeItem(storageKey(uid)) } catch { /* storage blocked */ }
  pendingOwner = ''
}

function startCooldown(): void {
  cooldown.value = COOLDOWN_SECONDS
  if (cooldownTimer !== undefined) clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) {
      cooldown.value = 0
      if (cooldownTimer !== undefined) clearInterval(cooldownTimer)
      cooldownTimer = undefined
    }
  }, 1000)
}

async function sendCode(channel: 'email' | 'sms'): Promise<void> {
  if (!confirmOpen.value || submitting.value || sendingCode.value !== '' || cooldown.value > 0) return
  if (channel === 'email' ? !emailRequired.value : !smsRequired.value) return
  const current = generation
  const token = session.getToken()
  sendingCode.value = channel
  codeNotice.value = ''
  try {
    // 已修复路由：走 wallet.api 的 /wallet-api/validCode/*，无 body。
    if (channel === 'email') await sendEmailCode()
    else await sendSmsCode()
    if (current !== generation || token !== session.getToken()) return
    startCooldown()
    codeNotice.value = t('internalTransfer.codeSent')
  } catch (e) {
    if (current !== generation || token !== session.getToken()) return
    codeNotice.value = `${t('internalTransfer.sendFailed')}: ${errMessage(e)}`
  } finally {
    if (current === generation) sendingCode.value = ''
  }
}

const emailRequired = computed(() => preview.value?.security.emailRequired === true)
const smsRequired = computed(() => preview.value?.security.smsRequired === true)
const codesReady = computed(() => {
  if (!/^\d{6}$/.test(googleCode.value)) return false
  if (emailRequired.value && !/^\d{6}$/.test(emailCode.value)) return false
  if (smsRequired.value && !/^\d{6}$/.test(smsCode.value)) return false
  return true
})

async function submit(): Promise<void> {
  if (submitting.value || sendingCode.value !== '' || locked.value || frozen.value === null || preview.value === null || !codesReady.value || preview.value.expireAt <= Date.now()) return
  const current = ++generation
  const token = session.getToken()
  submitting.value = true
  const expectedId = frozen.value.requestId
  persistPendingKey(expectedId)
  definitiveError.value = ''
  try {
    const record = await createTransfer({
      toUid: frozen.value.toUid,
      coin: frozen.value.coin,
      amount: frozen.value.amount,
      previewToken: frozen.value.previewToken,
      requestId: frozen.value.requestId,
      googleCode: googleCode.value,
      emailValidCode: emailRequired.value ? emailCode.value : undefined,
      smsAuthCode: smsRequired.value ? smsCode.value : undefined,
    })
    if (current !== generation || token !== session.getToken()) return
    if (record.requestId !== expectedId) throw new Error(t('internalTransfer.previewMismatch'))
    confirmOpen.value = false
    googleCode.value = ''
    emailCode.value = ''
    smsCode.value = ''
    result.value = record
    locked.value = true
    lockedRequestId.value = record.requestId
    historyRefresh.value += 1
    void account.load()
    if (record.status === 'done') {
      locked.value = false
      clearPendingKey()
      emit('submitted', record)
      emit('transferred', record)
    } else if (record.status === 'pending' || record.status === 'review') {
      // 已受理但未终态：保留原单号供查询，不允许用同一 draft 再发一笔。
      emit('submitted', record)
    } else {
      // failed / rejected：终态但非成功，展示真实 reason。
      clearPendingKey()
      locked.value = false
    }
  } catch (e) {
    if (current !== generation || token !== session.getToken()) return
    googleCode.value = ''
    emailCode.value = ''
    smsCode.value = ''
    if (isDefinitiveCreateRejection(e)) {
      // 服务端明确拒绝：可回编辑，原 requestId 作废。
      definitiveError.value = errMessage(e)
      confirmOpen.value = false
      frozen.value = null
      preview.value = null
      clearPendingKey()
    } else {
      // 结果未知：锁定，仅可查询原单，禁止换新号重发。
      confirmOpen.value = false
      locked.value = true
      lockedRequestId.value = frozen.value.requestId
      historyRefresh.value += 1
    }
  } finally {
    if (current === generation) submitting.value = false
  }
}

function onRecordsLoaded(records: TransferRecord[]): void {
  if (lockedRequestId.value === '') return
  const found = records.find((r) => r.requestId === lockedRequestId.value)
  if (found === undefined) return
  const previouslyDone = result.value?.status === 'done'
  result.value = found
  if (found.status === 'done' || found.status === 'failed' || found.status === 'rejected') {
    // 原单为终态：解锁，可发起新的转账。
    locked.value = false
    clearPendingKey()
    void account.load()
    if (found.status === 'done' && !previouslyDone) emit('transferred', found)
  } else {
    locked.value = true
  }
  // pending / review：保持锁定，不允许发送另一笔同 draft。
}

function newTransfer(): void {
  if (!resultFinal.value || submitting.value) return
  generation += 1
  preview.value = null
  previewError.value = ''
  definitiveError.value = ''
  result.value = null
  lockedRequestId.value = ''
  frozen.value = null
  locked.value = false
  toUid.value = ''
  amount.value = ''
  googleCode.value = ''
  emailCode.value = ''
  smsCode.value = ''
  clearPendingKey()
}

const resultMessage = computed(() => {
  const r = result.value
  if (r === null) return ''
  if (r.status === 'pending') return t('internalTransfer.resultPending')
  if (r.status === 'review') return t('internalTransfer.resultReview')
  if (r.status === 'done') return t('internalTransfer.resultDone')
  if (r.status === 'failed') return t('internalTransfer.resultFailed', { reason: r.reason })
  return t('internalTransfer.resultRejected', { reason: r.reason })
})
/** 只有 done / failed / rejected 是终态；pending / review 不允许用同一 draft 再发一笔。 */
const resultFinal = computed(() => {
  const status = result.value?.status
  return status === 'done' || status === 'failed' || status === 'rejected'
})

async function copyRequestId(): Promise<void> {
  const id = lockedRequestId.value !== '' ? lockedRequestId.value : (frozen.value?.requestId ?? '')
  if (id === '') return
  try {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) throw new Error(i18n.global.t('clientFailure.clipboardUnavailable'))
    await navigator.clipboard.writeText(id)
    copyNotice.value = t('internalTransfer.copied')
  } catch {
    copyNotice.value = t('internalTransfer.copyFailed')
  }
}

function restorePendingFromStorage(): void {
  const uid = myUid()
  if (uid === '' || typeof sessionStorage === 'undefined') return
  try {
    const stored = sessionStorage.getItem(storageKey(uid))
    if (stored !== null && isValidRequestId(stored)) {
      locked.value = true
      pendingOwner = uid
      lockedRequestId.value = stored
      historyRefresh.value += 1
    }
  } catch { /* storage blocked */ }
}

function handleSessionChange(): void {
  // Clear all private display data. Keep only the UID-bound requestId until its original result is confirmed.
  generation += 1
  pendingOwner = ''
  if (cooldownTimer !== undefined) { clearInterval(cooldownTimer); cooldownTimer = undefined }
  cooldown.value = 0
  loading.value = false
  previewing.value = false
  submitting.value = false
  sendingCode.value = ''
  configError.value = ''
  codeNotice.value = ''
  copyNotice.value = ''
  applyServerConfig(null)
  preview.value = null
  previewError.value = ''
  definitiveError.value = ''
  result.value = null
  locked.value = false
  lockedRequestId.value = ''
  frozen.value = null
  toUid.value = ''
  amount.value = ''
  googleCode.value = ''
  emailCode.value = ''
  smsCode.value = ''
  confirmOpen.value = false
  if (session.isAuthenticated()) {
    restorePendingFromStorage()
    void loadConfig()
  }
}

onMounted(() => {
  expiryTimer = setInterval(() => { now.value = Date.now() }, 1000) // Time only, not money.
  if (session.isAuthenticated()) {
    restorePendingFromStorage()
    void loadConfig()
  }
})
onBeforeUnmount(() => {
  generation += 1
  if (cooldownTimer !== undefined) clearInterval(cooldownTimer)
  if (expiryTimer !== undefined) clearInterval(expiryTimer)
})

watch(() => props.coin, () => {
  if (props.coin !== '' && !locked.value && !submitting.value && !confirmOpen.value && result.value === null
    && coins.value.some(c => c.coin === props.coin.toUpperCase())) selectedCoin.value = props.coin.toUpperCase()
})
watch(() => sessionStore.token, handleSessionChange, { flush: 'sync' })
watch([selectedCoin, toUid, amount], () => {
  if (submitting.value || locked.value) return
  if (previewing.value || preview.value !== null) generation += 1
  previewing.value = false
  frozen.value = null
  clearPreviewState()
}, { flush: 'sync' })
</script>

<template>
  <section class="internal-transfer">
    <h3>{{ t('internalTransfer.title') }}</h3>
    <p class="muted">{{ t('internalTransfer.subtitle') }}</p>

    <GuestGate v-if="!authenticated" :message="t('internalTransfer.gateMessage')" />

    <template v-else>
      <StateBlock v-if="loading" variant="loading" :message="t('internalTransfer.loading')" />
      <StateBlock v-else-if="configError !== ''" variant="error" :message="configErrorMessage" :retryable="configRetryable" @retry="loadConfig" />
      <p v-else-if="coins.length === 0" class="muted" aria-live="polite">{{ t('internalTransfer.noCoins') }}</p>

      <template v-if="locked || result !== null || (!loading && configError === '' && coins.length > 0)">
        <p v-if="locked && result === null" class="notice notice-error" role="alert" aria-live="assertive">
          {{ t('internalTransfer.unknownLocked') }}
        </p>
        <p v-if="locked && lockedRequestId !== ''" class="locked-id">
          <span class="muted">{{ t('internalTransfer.requestId') }}：</span>
          <code class="num">{{ lockedRequestId }}</code>
          <button class="btn btn-ghost" type="button" @click="copyRequestId">{{ t('internalTransfer.copyId') }}</button>
          <span v-if="copyNotice !== ''" class="muted" role="status" aria-live="polite">{{ copyNotice }}</span>
        </p>

        <form class="transfer-form" @submit.prevent="runPreview">
        <div class="grid">
          <label class="field">
            <span class="field-label">{{ t('internalTransfer.coin') }}</span>
            <select v-model="selectedCoin" class="field-input" :disabled="locked || submitting || confirmOpen || result !== null">
              <option v-for="c in coins" :key="c.coin" :value="c.coin">{{ c.coin }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">{{ t('internalTransfer.toUid') }}</span>
            <input v-model="toUid" class="field-input num" type="text" inputmode="numeric" autocomplete="off" maxlength="20" :disabled="locked || submitting || confirmOpen || result !== null" :placeholder="t('internalTransfer.toUidPlaceholder')" />
          </label>

          <label class="field">
            <span class="field-label">{{ t('internalTransfer.amount') }}</span>
            <input v-model="amount" class="field-input num" type="text" inputmode="decimal" autocomplete="off" maxlength="64" :disabled="locked || submitting || confirmOpen || result !== null" :placeholder="t('internalTransfer.amountPlaceholder')" />
            <span class="field-hint muted">{{ t('internalTransfer.available') }}：{{ canUseAvailable ? groupDigits(available) : '—' }} {{ selectedCoin }}</span>
          </label>
        </div>

        <p v-if="activeCoin" class="muted hint">{{ t('internalTransfer.freeAmountHint', { amount: groupDigits(activeCoin.freeAmount), coin: activeCoin.coin }) }}</p>
        <p v-if="account.error" class="notice notice-error" role="alert">{{ account.error }}</p>
        <p v-if="draftError && result === null && !locked" class="notice notice-error" role="status">{{ draftError }}</p>
        <p v-if="previewError !== ''" class="notice notice-error" role="alert" :data-recoverable="previewRecoverable">{{ previewError }}</p>

        <div class="actions">
          <button class="btn" type="submit" :disabled="!canPreview">
            {{ previewing ? t('internalTransfer.loading') : t('internalTransfer.preview') }}
          </button>
          <button class="btn" type="button" :disabled="submitting || previewing || confirmOpen" @click="loadConfig">{{ t('internalTransfer.refresh') }}</button>
        </div>
        </form>

        <div v-if="preview !== null" class="preview-card" aria-live="polite">
          <dl class="facts">
            <div class="fact"><dt>{{ t('internalTransfer.recipient') }}</dt><dd>{{ preview.recipientLabel }}</dd></div>
            <div class="fact"><dt>{{ t('internalTransfer.fee') }}</dt><dd class="num">{{ groupDigits(preview.fee) }} {{ preview.coin }}</dd></div>
            <div class="fact"><dt>{{ t('internalTransfer.totalDebit') }}</dt><dd class="num">{{ groupDigits(preview.totalDebit) }} {{ preview.coin }}</dd></div>
            <div class="fact"><dt>{{ t('internalTransfer.receiveAmount') }}</dt><dd class="num">{{ groupDigits(preview.receiveAmount) }} {{ preview.coin }}</dd></div>
          </dl>
          <p v-if="preview.requiresApproval" class="notice" role="note">{{ t('internalTransfer.approvalHint') }}</p>
          <div class="actions">
            <button class="btn btn-primary" type="button" :disabled="locked || submitting || result !== null || previewExpired || previewError !== ''" @click="openConfirm">
              {{ t('internalTransfer.submit') }}
            </button>
          </div>
          <p v-if="previewExpired" class="notice notice-error" role="status">{{ t('internalTransfer.previewExpired') }}</p>
        </div>

        <div v-if="result !== null" class="result" aria-live="polite">
          <p class="notice">{{ resultMessage }}</p>
          <p class="muted">{{ t('internalTransfer.requestId') }}：<code class="num">{{ result.requestId }}</code></p>
          <div class="actions">
            <button v-if="!locked && resultFinal" class="btn" type="button" @click="newTransfer">{{ t('internalTransfer.newTransfer') }}</button>
          </div>
        </div>

        <p v-if="definitiveError !== ''" class="notice notice-error" role="alert">{{ definitiveError }}</p>
        <button v-if="lockedRequestId !== '' && locked" class="btn" type="button" @click="historyRefresh += 1">{{ t('internalTransfer.queryOriginal') }}</button>

      </template>
      <InternalTransferHistory
        :request-id="locked ? lockedRequestId : ''"
        :refresh-key="historyRefresh"
        @records-loaded="onRecordsLoaded"
      />
    </template>

    <DialogShell :open="confirmOpen" :title="t('internalTransfer.confirmTitle')" width="460px" :close-label="t('internalTransfer.cancel')" @close="closeConfirm">
      <template v-if="preview !== null">
        <p class="muted">{{ t('internalTransfer.confirmHint') }}</p>
        <dl class="facts">
          <div class="fact"><dt>{{ t('internalTransfer.recipient') }}</dt><dd>{{ preview.recipientLabel }}（{{ preview.toUid }}）</dd></div>
          <div class="fact"><dt>{{ t('internalTransfer.amount') }}</dt><dd class="num">{{ groupDigits(preview.amount) }} {{ preview.coin }}</dd></div>
          <div class="fact"><dt>{{ t('internalTransfer.fee') }}</dt><dd class="num">{{ groupDigits(preview.fee) }} {{ preview.coin }}</dd></div>
          <div class="fact"><dt>{{ t('internalTransfer.totalDebit') }}</dt><dd class="num">{{ groupDigits(preview.totalDebit) }} {{ preview.coin }}</dd></div>
          <div class="fact"><dt>{{ t('internalTransfer.receiveAmount') }}</dt><dd class="num">{{ groupDigits(preview.receiveAmount) }} {{ preview.coin }}</dd></div>
        </dl>
        <p class="muted" aria-live="polite">{{ t('internalTransfer.securityHint') }}</p>
        <p v-if="codeNotice" class="notice" role="status" aria-live="polite">{{ codeNotice }}</p>
        <p v-if="previewExpired" class="notice notice-error" role="status">{{ t('internalTransfer.previewExpired') }}</p>
        <CodeField v-model="googleCode" :label="t('internalTransfer.googleCode')" :disabled="submitting" />
        <div v-if="emailRequired" class="code-row">
          <CodeField v-model="emailCode" :label="t('internalTransfer.emailCode')" :disabled="submitting" />
          <button class="btn btn-ghost" type="button" :disabled="sendingCode !== '' || cooldown > 0 || submitting" @click="sendCode('email')">
            {{ cooldown > 0 ? t('internalTransfer.resendIn', { seconds: cooldown }) : t('internalTransfer.sendCode') }}
          </button>
        </div>
        <div v-if="smsRequired" class="code-row">
          <CodeField v-model="smsCode" :label="t('internalTransfer.smsCode')" :disabled="submitting" />
          <button class="btn btn-ghost" type="button" :disabled="sendingCode !== '' || cooldown > 0 || submitting" @click="sendCode('sms')">
            {{ cooldown > 0 ? t('internalTransfer.resendIn', { seconds: cooldown }) : t('internalTransfer.sendCode') }}
          </button>
        </div>
      </template>
      <template #footer>
        <button class="btn" type="button" :disabled="submitting || sendingCode !== ''" @click="closeConfirm">{{ t('internalTransfer.back') }}</button>
        <button class="btn btn-primary" type="button" :disabled="submitting || sendingCode !== '' || !codesReady || previewExpired" @click="submit">
          {{ submitting ? t('internalTransfer.loading') : t('internalTransfer.confirm') }}
        </button>
      </template>
    </DialogShell>
  </section>
</template>

<style scoped>
.internal-transfer { display: flex; flex-direction: column; gap: 10px; }
.internal-transfer h3 { margin: 0; font-size: 15px; }
.muted { color: var(--color-text-muted); }
.hint { font-size: 12px; margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.transfer-form { display: grid; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-hint { font-size: 12px; }
.actions { display: flex; gap: 10px; }
.preview-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--color-border-strong); border-radius: 12px; background: var(--color-surface-alt); }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; }
.fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fact dt { color: var(--color-text-muted); font-size: 11.5px; }
.fact dd { margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.code-row { display: flex; align-items: flex-end; gap: 8px; }
.result { display: flex; flex-direction: column; gap: 6px; }
.locked-id { display: flex; align-items: center; gap: 8px; margin: 0; flex-wrap: wrap; }
.locked-id code { overflow-wrap: anywhere; }
.notice { padding: 10px 12px; border-radius: 10px; background: var(--color-accent-soft); font-size: 13px; margin: 0; }
.notice-error { color: var(--color-down); }
.num { font-family: var(--font-mono); }
@media (max-width: 480px) { .facts { grid-template-columns: 1fr; } .code-row { flex-wrap: wrap; } }
</style>
