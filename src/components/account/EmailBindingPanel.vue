<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Mail } from '@lucide/vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import SecurityRow from '@/components/security/SecurityRow.vue'
import {
  EMAIL_OPERATION,
  SMS_OPERATION,
  bindEmail,
  sendEmailCode,
  sendSmsCode,
  updateEmail,
} from '@/modules/api/account-settings.api'
import { translateAccountMessage, useAccountI18n } from '@/modules/account/i18n'
import { isLegacyEmail, maskEmail } from '@/modules/account/account-state'
import {
  isValidVerificationCode,
  redactSensitive,
  type FactorState,
} from '@/modules/security/security-state'
import VerificationCodeField from './VerificationCodeField.vue'

/**
 * Email binding (no email on file) and rebinding.
 *
 * Server contract (source-first, `UserCenterAct`):
 * - `user/email_bind_save_v4` requires only `email` + `emailValidCode`; it fails when an email is
 *   already bound, so this panel swaps to the rebind form in that case.
 * - `user/email_update` requires `emailOldValidCode`, `email`, `emailNewValidCode` and at least one
 *   of `smsValidCode`/`googleCode`, then enforces Google/SMS exactly when those factors are enabled
 *   and rejects the call when both are disabled. That branch is surfaced as a blocking message — it
 *   never weakens or skips verification.
 *
 * Nothing is submitted automatically; every code is requested by an explicit click and every async
 * step snapshots the request generation plus the auth token so a late response can never mutate a
 * different session or a different mode.
 */
const props = defineProps<{
  /** The currently bound email; empty string means none (`/common/user_info`). */
  currentEmail: string
  googleFactor: FactorState
  smsFactor: FactorState
}>()
const emit = defineEmits<{ (event: 'changed'): void }>()
const { t } = useAccountI18n()

const COOLDOWN_SECONDS = 60

type Mode = 'bind' | 'change'
type Slot = 'newEmail' | 'oldEmail' | 'sms'

const open = ref(false)
const mode = ref<Mode>('bind')
const newEmail = ref('')
const newEmailCode = ref('')
const oldEmailCode = ref('')
const googleCode = ref('')
const smsCode = ref('')
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const sending = reactive<Record<Slot, boolean>>({ newEmail: false, oldEmail: false, sms: false })
const cooldowns = reactive<Record<Slot, number>>({ newEmail: 0, oldEmail: 0, sms: 0 })

let generation = 0
let unmounted = false
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let lastToken = session.getToken()
let unsubscribe: (() => void) | null = null

const hasEmail = computed(() => props.currentEmail.trim() !== '')
const maskedCurrent = computed(() => maskEmail(props.currentEmail))

const factorsKnown = computed(() => props.googleFactor !== 'unknown' && props.smsFactor !== 'unknown')
const anyFactorEnabled = computed(
  () => props.googleFactor === 'enabled' || props.smsFactor === 'enabled',
)
const googleRequired = computed(() => props.googleFactor === 'enabled')
const smsRequired = computed(() => props.smsFactor === 'enabled')

function authToken(): string | null {
  return session.getToken()
}

function isStale(gen: number, token: string | null): boolean {
  return unmounted || gen !== generation || token !== authToken()
}

function sensitiveValues(): string[] {
  return [newEmail.value, newEmailCode.value, oldEmailCode.value, googleCode.value, smsCode.value]
}

function describe(cause: unknown): string {
  if (isApiError(cause)) {
    return translateAccountMessage(t, cause.message)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function setError(cause: unknown): void {
  // Never echo a submitted address, code or OTP back into the UI.
  error.value = redactSensitive(describe(cause), sensitiveValues())
}

function clearSensitive(): void {
  newEmail.value = ''
  newEmailCode.value = ''
  oldEmailCode.value = ''
  googleCode.value = ''
  smsCode.value = ''
  error.value = ''
  notice.value = ''
}

function stopTimer(): void {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  cooldowns.newEmail = 0
  cooldowns.oldEmail = 0
  cooldowns.sms = 0
}

function tick(): void {
  let active = false
  for (const slot of ['newEmail', 'oldEmail', 'sms'] as Slot[]) {
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
  return t('account.email.resendIn', { seconds: cooldowns[slot] })
}

/** Opens the form in a specific mode. Switching modes invalidates any in-flight request. */
function openForm(next: Mode): void {
  generation += 1
  submitting.value = false
  sending.newEmail = false
  sending.oldEmail = false
  sending.sms = false
  stopTimer()
  clearSensitive()
  mode.value = next
  open.value = true
}

/** Invalidates every in-flight request, then drops the drafts and codes. */
function closeForm(): void {
  generation += 1
  open.value = false
  submitting.value = false
  sending.newEmail = false
  sending.oldEmail = false
  sending.sms = false
  stopTimer()
  clearSensitive()
}

function validate(): string {
  if (!isLegacyEmail(newEmail.value)) {
    return t('account.email.emailRule')
  }
  if (mode.value === 'bind') {
    if (!isValidVerificationCode(newEmailCode.value)) {
      return t('account.email.codeRule')
    }
    return ''
  }
  // Rebind mode: the server rejects the call unless Google or SMS is enabled.
  if (!factorsKnown.value) {
    return t('account.email.factorUnknown')
  }
  if (!anyFactorEnabled.value) {
    return t('account.email.noFactor')
  }
  if (!isValidVerificationCode(oldEmailCode.value)) {
    return t('account.email.codeRule')
  }
  if (!isValidVerificationCode(newEmailCode.value)) {
    return t('account.email.codeRule')
  }
  if (googleRequired.value && !isValidVerificationCode(googleCode.value)) {
    return t('account.email.codeRule')
  }
  if (smsRequired.value && !isValidVerificationCode(smsCode.value)) {
    return t('account.email.codeRule')
  }
  return ''
}

const validationMessage = computed(() => (open.value ? validate() : ''))
const canSubmit = computed(() => open.value && !submitting.value && validationMessage.value === '')
/**
 * A rebind is impossible when the account has no second factor (the server rejects it) or when a
 * factor state is unknown (the requirement cannot be determined). In both cases the form is not
 * offered at all instead of showing a submit that can never succeed.
 */
const changeBlocked = computed(
  () => mode.value === 'change' && (!factorsKnown.value || !anyFactorEnabled.value),
)
const blockedMessage = computed(() =>
  factorsKnown.value ? t('account.email.noFactor') : t('account.email.factorUnknown'),
)

async function dispatch(slot: Slot, run: () => Promise<unknown>): Promise<void> {
  if (sending[slot] || cooldowns[slot] > 0) {
    return
  }
  const gen = generation
  const token = authToken()
  sending[slot] = true
  error.value = ''
  notice.value = ''
  try {
    await run()
    if (isStale(gen, token)) {
      return
    }
    notice.value = t('account.email.codeSent')
    startCooldown(slot)
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    setError(cause)
  } finally {
    if (gen === generation) {
      sending[slot] = false
    }
  }
}

function sendNewEmailCode(): void {
  if (!isLegacyEmail(newEmail.value)) {
    error.value = t('account.email.emailRule')
    return
  }
  void dispatch('newEmail', () =>
    sendEmailCode({ email: newEmail.value, operationType: EMAIL_OPERATION.bindEmail }),
  )
}

function sendOldEmailCode(): void {
  void dispatch('oldEmail', () =>
    sendEmailCode({ operationType: EMAIL_OPERATION.updateEmailOld }),
  )
}

function sendSmsVerification(): void {
  void dispatch('sms', () => sendSmsCode({ operationType: SMS_OPERATION.updateEmailOld }))
}

async function submit(): Promise<void> {
  if (!canSubmit.value) {
  // Clickable while only the input is wrong: the click shows why (10-01 audit: disabled with the reason hidden).
    if (open.value && !submitting.value && validationMessage.value !== '') error.value = validationMessage.value
    return
  }
  const gen = generation
  const token = authToken()
  submitting.value = true
  error.value = ''
  notice.value = ''
  try {
    if (mode.value === 'bind') {
      await bindEmail({ email: newEmail.value, emailValidCode: newEmailCode.value })
    } else {
      await updateEmail({
        emailOldValidCode: oldEmailCode.value,
        email: newEmail.value,
        emailNewValidCode: newEmailCode.value,
        smsValidCode: smsRequired.value ? smsCode.value : undefined,
        googleCode: googleRequired.value ? googleCode.value : undefined,
      })
    }
    if (isStale(gen, token)) {
      return
    }
    const saved = t('account.email.saved')
    closeForm()
    notice.value = saved
    emit('changed')
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    setError(cause)
    // Keep the address draft, drop the rejected codes.
    newEmailCode.value = ''
    oldEmailCode.value = ''
    googleCode.value = ''
    smsCode.value = ''
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

onMounted(() => {
  unsubscribe = session.onInvalidate((snapshot) => {
    if (snapshot.token !== lastToken) {
      lastToken = snapshot.token
      // Logout / account switch must clear drafts, codes and any open form.
      closeForm()
    }
  })
})

onBeforeUnmount(() => {
  unmounted = true
  closeForm()
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <section class="settings-section">
    <div class="section-head">
      <h2 class="section-title"><Mail :size="15" aria-hidden="true" />{{ t('account.email.title') }}</h2>
    </div>

    <SecurityRow :label="t('account.email.current')" layout="stacked">
      <template #icon><Mail :size="18" /></template>
      <template #value>
        <span class="value wrap-anywhere">{{ hasEmail ? maskedCurrent : t('account.email.notBound') }}</span>
      </template>
      <template #action>
        <button
          v-if="!open"
          class="btn"
          type="button"
          @click="openForm(hasEmail ? 'change' : 'bind')"
        >
          <Mail :size="14" aria-hidden="true" />
          {{ hasEmail ? t('account.email.change') : t('account.email.bind') }}
        </button>
        <button v-else class="btn btn-ghost" type="button" @click="closeForm">
          {{ t('account.email.cancel') }}
        </button>
      </template>
    </SecurityRow>

    <p v-if="notice !== '' && !open" class="notice notice-info wrap-anywhere">{{ notice }}</p>

    <p v-if="open && changeBlocked" class="notice notice-error wrap-anywhere">{{ blockedMessage }}</p>

    <div v-else-if="open" class="form">
      <p class="form-intro">
        {{ mode === 'bind' ? t('account.email.bindIntro') : t('account.email.changeIntro') }}
      </p>

      <div class="field">
        <label class="field-label" for="account-email-new">{{ t('account.email.newEmail') }}</label>
        <div class="field-input">
          <input
            id="account-email-new"
            v-model="newEmail"
            type="text"
            autocomplete="email"
            :aria-label="t('account.email.newEmail')"
          />
        </div>
      </div>

      <VerificationCodeField
        v-if="mode === 'change'"
        id="account-email-old-code"
        v-model="oldEmailCode"
        :label="t('account.email.oldEmailCode')"
        :send-label="t('account.email.sendCode')"
        :sending-label="t('account.email.sending')"
        :resend-label="resendLabel('oldEmail')"
        :sending="sending.oldEmail"
        :cooldown="cooldowns.oldEmail"
        @send="sendOldEmailCode"
      />

      <VerificationCodeField
        id="account-email-new-code"
        v-model="newEmailCode"
        :label="mode === 'bind' ? t('account.email.bindEmailCode') : t('account.email.newEmailCode')"
        :send-label="t('account.email.sendCode')"
        :sending-label="t('account.email.sending')"
        :resend-label="resendLabel('newEmail')"
        :sending="sending.newEmail"
        :cooldown="cooldowns.newEmail"
        @send="sendNewEmailCode"
      />

      <VerificationCodeField
        v-if="mode === 'change' && smsRequired"
        id="account-email-sms-code"
        v-model="smsCode"
        :label="t('account.email.smsCode')"
        :send-label="t('account.email.sendCode')"
        :sending-label="t('account.email.sending')"
        :resend-label="resendLabel('sms')"
        :sending="sending.sms"
        :cooldown="cooldowns.sms"
        @send="sendSmsVerification"
      />

      <div v-if="mode === 'change' && googleRequired" class="field">
        <label class="field-label" for="account-email-google">{{ t('account.email.googleCode') }}</label>
        <div class="field-input">
          <input
            id="account-email-google"
            v-model="googleCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            :aria-label="t('account.email.googleCode')"
          />
        </div>
      </div>

      <p v-if="error !== ''" class="notice notice-error wrap-anywhere">{{ error }}</p>
      <p v-else-if="notice !== ''" class="notice notice-info wrap-anywhere">{{ notice }}</p>

      <div class="actions">
        <button class="btn btn-primary" type="button" :disabled="!open || submitting" @click="submit">
          {{
            submitting
              ? t('account.email.submitting')
              : mode === 'bind'
                ? t('account.email.submitBind')
                : t('account.email.submitChange')
          }}
        </button>
      </div>
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

.value {
  font-size: var(--font-size-sm);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 460px;
  margin-top: 12px;
}

.form-intro {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.actions {
  display: flex;
  gap: var(--space-2);
}
</style>
