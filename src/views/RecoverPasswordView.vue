<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRight } from '@lucide/vue'
import { apiLanguage } from '@/i18n'
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { isApiError } from '@/core/errors'
import { isFeatureEnabled } from '@/core/feature-flags'
import { useMarketStore } from '@/stores/market'
import { useAuthI18n, translateAuthMessage } from '@/modules/auth/i18n'
import { aliyunNcLanguage, planCaptcha } from '@/modules/auth/captcha'
import { geetestLanguage } from '@/modules/auth/geetest'
import {
  captchaProvider,
  isRecoveryTokenExpired,
  isValidEmail,
  isValidPassword,
  isValidPhone,
  isValidVerificationCode,
  maskAccount,
  normalizeCountryCode,
  passwordsMatch,
  readCaptchaRequired,
  registrationMode,
  registrationTabs,
  type PasswordResetChallenge,
} from '@/modules/auth/onboarding-state'
import {
  resetPasswordStepOne,
  resetPasswordStepThree,
  resetPasswordStepTwo,
  sendRecoveryEmailCode,
  sendRecoverySmsCode,
  type CaptchaProof,
  type RecoveryMode,
} from '@/modules/api/onboarding.api'
import AuthShell from '@/components/auth/AuthShell.vue'
import AuthCodeField from '@/components/auth/AuthCodeField.vue'
import CaptchaField from '@/components/auth/CaptchaField.vue'

// Password recovery. Three steps, exactly as `PC/common-mixin/resetPass/resetPass.js`:
//   1. `v4/user/reset_password_step_one` (plain) -> recovery token + required factor flags;
//   2. `v4/user/reset_password_step_two`  (plain) -> SMS/email code + Google code / certificate
//      when the server says they are required;
//   3. `user/reset_password_step_three`   (signed) -> new password.
//
// Server checks are never weakened: the slider, the SMS/email code and any TOTP/certificate the
// server reports as required are always asked for, and a missing/unknown factor flag blocks the
// step instead of silently skipping it. The account-existence error is surfaced verbatim; we do not
// invent a friendly substitute that would leak or hide account state.
const { t } = useAuthI18n()
const market = useMarketStore()

type Tab = RecoveryMode
type Stage = 'form' | 'verify' | 'password' | 'done'

const PURPOSE = 'recover'
const CODE_COOLDOWN_SECONDS = 60

const mode = computed(() => registrationMode(market.publicInfo?.switch))
const tabs = computed<Tab[]>(() => registrationTabs(mode.value))
const tab = ref<Tab>('email')

const email = ref('')
const countryCode = ref('')
const phone = ref('')
const code = ref('')
const googleCode = ref('')
const certificate = ref('')
const password = ref('')
const confirmPassword = ref('')

const stage = ref<Stage>('form')
const challenge = ref<PasswordResetChallenge | null>(null)
const submitting = ref(false)
const sendingCode = ref(false)
const cooldown = ref(0)
const { text: error, set: setError } = useLocalizedNotice()
const { text: notice, set: setNotice } = useLocalizedNotice()
const completedAccount = ref('')

const proof = ref<CaptchaProof | null>(null)
const proofKey = ref('')
const captchaKey = ref('')
const captchaFailed = ref(false)
const captchaErrorKey = ref('')

let generation = 0
let unmounted = false
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let inFlight: AbortController | null = null

/** Cancels a superseded request (new step, tab switch, leave) instead of letting it finish. */
function beginRequest(): AbortSignal {
  inFlight?.abort()
  inFlight = new AbortController()
  return inFlight.signal
}

function abortRequests(): void {
  inFlight?.abort()
  inFlight = null
}

const appkey = computed(() => market.publicInfo?.nc?.nc_appkey ?? '')
const ncPrefix = computed(() => market.publicInfo?.nc?.nc_prefix ?? '')
const ncLanguage = computed(() => aliyunNcLanguage(apiLanguage(), market.publicInfo?.nc?.nc_lang))
const geetestLang = computed(() => geetestLanguage(apiLanguage()))
const configuredVerificationType = computed(() => String(market.publicInfo?.switch?.verificationType ?? '1'))
const captchaRequired = computed(() => readCaptchaRequired(market.publicInfo?.switch))

const captchaPlan = computed(() =>
  planCaptcha({
    provider: captchaProvider(market.publicInfo?.switch),
    appkey: appkey.value,
    captchaRequired: captchaRequired.value,
    sdkEnabled: isFeatureEnabled('loginCaptchaProvider'),
  }),
)

const googleRequired = computed(() => challenge.value?.googleRequired === true)
/** 10-20: e-mail-code switch off (`switch.email_code_required = "0"`): the Google code alone verifies an e-mail account (server rule, user-api reset step two). */
const emailCodeOff = computed(() => tab.value === 'email' && String(market.publicInfo?.switch?.email_code_required ?? '1') === '0')
const certificateRequired = computed(() => challenge.value?.certificateRequired === true)
/** `null` = the server did not return the flag, so we cannot know which factor to ask for. */
const factorsUnknown = computed(
  () =>
    stage.value === 'verify' &&
    challenge.value !== null &&
    (challenge.value.googleRequired === null || challenge.value.certificateRequired === null),
)

const codeLabel = computed(() => (tab.value === 'email' ? t('auth.common.emailCode') : t('auth.common.phoneCode')))
const cooldownLabel = computed(() => t('auth.common.resendIn', { seconds: cooldown.value }))

function accountValue(): string {
  return tab.value === 'email' ? email.value.trim() : phone.value.trim()
}

function challengeKey(): string {
  return `${PURPOSE}:${tab.value}:${accountValue()}`
}

function describeError(value: unknown): string {
  if (isApiError(value)) {
    if (value.code === '10003') {
      return t('auth.error.captchaRequired')
    }
    return translateAuthMessage(t, value.message)
  }
  if (value instanceof Error) {
    return translateAuthMessage(t, value.message)
  }
  return t('auth.error.badRequest')
}

function clearSecrets(): void {
  password.value = ''
  confirmPassword.value = ''
  code.value = ''
  googleCode.value = ''
  certificate.value = ''
  proof.value = null
  proofKey.value = ''
}

function stopCooldown(): void {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  cooldown.value = 0
}

function startCooldown(): void {
  stopCooldown()
  cooldown.value = CODE_COOLDOWN_SECONDS
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) {
      stopCooldown()
    }
  }, 1000)
}

function resetChallenge(): void {
  proof.value = null
  proofKey.value = ''
  captchaFailed.value = false
  captchaErrorKey.value = ''
  captchaKey.value = `${challengeKey()}:${Date.now()}`
}

function onSolved(next: CaptchaProof): void {
  proof.value = next
  proofKey.value = challengeKey()
  captchaFailed.value = false
  captchaErrorKey.value = ''
}

function onCaptchaFailed(messageKey: string): void {
  proof.value = null
  proofKey.value = ''
  captchaFailed.value = true
  captchaErrorKey.value = messageKey
}

function resolvedProof(): CaptchaProof | null {
  if (captchaPlan.value.blocked) {
    return null
  }
  if (captchaPlan.value.proofRequired) {
    if (proof.value === null || proofKey.value !== challengeKey()) {
      return null
    }
    return proof.value
  }
  return { verificationType: configuredVerificationType.value }
}

function blockedReason(): string {
  if (market.publicInfo === null) {
    return 'auth.error.publicInfoMissing'
  }
  if (captchaPlan.value.blocked) {
    if (captchaPlan.value.reason === 'unconfigured') return 'auth.captcha.misconfigured'
    return captchaPlan.value.reason === 'unsupported-provider'
      ? 'auth.captcha.providerUnsupported'
      : 'auth.captcha.sdkDisabled'
  }
  if (captchaPlan.value.proofRequired && resolvedProof() === null) {
    return captchaFailed.value && captchaErrorKey.value !== '' ? captchaErrorKey.value : 'auth.error.captchaRequired'
  }
  return ''
}

/** A dead recovery token restarts the flow instead of leaving the user on a broken step. */
function restartFlow(expired: boolean): void {
  generation += 1
  abortRequests()
  challenge.value = null
  stopCooldown()
  clearSecrets()
  resetChallenge()
  stage.value = 'form'
  notice.value = ''
  error.value = ''
  if (expired) {
    setError(() => t('auth.recover.expired'))
  }
}

async function sendCode(): Promise<void> {
  if (sendingCode.value || cooldown.value > 0) {
    return
  }
  const token = challenge.value?.token
  if (token === undefined) {
    return
  }
  const gen = generation
  const signal = beginRequest()
  sendingCode.value = true
  error.value = ''
  try {
    if (tab.value === 'email') {
      await sendRecoveryEmailCode(token, { signal })
    } else {
      await sendRecoverySmsCode(token, { signal })
    }
    if (gen !== generation) {
      return
    }
    const recipient = maskAccount(accountValue())
    setNotice(() => t('auth.common.codeSentTo', { account: recipient }))
    startCooldown()
  } catch (value) {
    if (gen !== generation) {
      return
    }
    notice.value = ''
    if (isApiError(value) && isRecoveryTokenExpired(value.code)) {
      restartFlow(true)
      return
    }
    setError(() => describeError(value))
    stopCooldown()
  } finally {
    if (gen === generation) {
      sendingCode.value = false
    }
  }
}

async function submitAccount(): Promise<void> {
  if (submitting.value) {
    return
  }
  error.value = ''
  notice.value = ''
  if (tab.value === 'email') {
    if (!isValidEmail(email.value)) {
      setError(() => t('auth.rule.email'))
      return
    }
  } else {
    if (normalizeCountryCode(countryCode.value) === '') {
      setError(() => t('auth.rule.countryCode'))
      return
    }
    if (!isValidPhone(phone.value)) {
      setError(() => t('auth.rule.phone'))
      return
    }
  }
  const blocked = blockedReason()
  if (blocked !== '') {
    setError(() => t(blocked))
    return
  }
  const captcha = resolvedProof()
  if (captcha === null) {
    setError(() => t('auth.error.captchaRequired'))
    return
  }

  const gen = ++generation
  submitting.value = true
  try {
    const next = await resetPasswordStepOne({
      mode: tab.value,
      email: email.value,
      mobileNumber: phone.value,
      captcha,
      signal: beginRequest(),
    })
    if (gen !== generation || unmounted) {
      return
    }
    challenge.value = next
    resetChallenge()
    stage.value = 'verify'
    await sendCode()
  } catch (value) {
    if (gen !== generation || unmounted) {
      return
    }
    setError(() => describeError(value))
    // The slider proof is single-use and the account may have been rejected: drop it either way.
    resetChallenge()
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

async function submitFactors(): Promise<void> {
  if (submitting.value) {
    return
  }
  error.value = ''
  notice.value = ''
  const token = challenge.value?.token
  if (token === undefined) {
    restartFlow(true)
    return
  }
  if (challenge.value?.googleRequired === null || challenge.value?.certificateRequired === null) {
    setError(() => t('auth.error.factorUnknown'))
    return
  }
  if (emailCodeOff.value && !googleRequired.value) {
    setError(() => t('auth.recover.emailOffNoGoogle'))
    return
  }
  if (!emailCodeOff.value && !isValidVerificationCode(code.value)) {
    setError(() => t('auth.rule.code'))
    return
  }
  if (googleRequired.value && !isValidVerificationCode(googleCode.value)) {
    setError(() => t('auth.rule.code'))
    return
  }
  if (certificateRequired.value && certificate.value.trim() === '') {
    setError(() => t('auth.common.required'))
    return
  }

  const gen = ++generation
  submitting.value = true
  try {
    await resetPasswordStepTwo({
      token,
      mode: tab.value,
      code: emailCodeOff.value ? '' : code.value.trim(),
      emailCodeOff: emailCodeOff.value,
      googleCode: googleCode.value,
      certificateNumber: certificate.value,
      signal: beginRequest(),
    })
    if (gen !== generation || unmounted) {
      return
    }
    clearSecrets()
    stage.value = 'password'
  } catch (value) {
    if (gen !== generation || unmounted) {
      return
    }
    if (isApiError(value) && isRecoveryTokenExpired(value.code)) {
      restartFlow(true)
      return
    }
    setError(() => describeError(value))
    clearSecrets()
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

async function submitPassword(): Promise<void> {
  if (submitting.value) {
    return
  }
  error.value = ''
  notice.value = ''
  const token = challenge.value?.token
  if (token === undefined) {
    restartFlow(true)
    return
  }
  if (!isValidPassword(password.value)) {
    setError(() => t('auth.rule.password'))
    return
  }
  if (!passwordsMatch(password.value, confirmPassword.value)) {
    setError(() => t('auth.rule.match'))
    return
  }

  const gen = ++generation
  submitting.value = true
  try {
    await resetPasswordStepThree({ token, password: password.value, signal: beginRequest() })
    if (gen !== generation || unmounted) {
      return
    }
    completedAccount.value = accountValue()
    challenge.value = null
    stopCooldown()
    clearSecrets()
    stage.value = 'done'
  } catch (value) {
    if (gen !== generation || unmounted) {
      return
    }
    if (isApiError(value) && isRecoveryTokenExpired(value.code)) {
      restartFlow(true)
      return
    }
    setError(() => describeError(value))
    clearSecrets()
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

function switchTab(next: Tab): void {
  if (next === tab.value || submitting.value) {
    return
  }
  tab.value = next
  restartFlow(false)
}

onMounted(async () => {
  if (market.publicInfo === null) {
    try {
      await market.loadPublicInfo()
    } catch {
      // The submit path surfaces the real problem; the form still renders.
    }
  }
  if (unmounted) {
    return
  }
  const available = tabs.value
  if (available.length > 0) {
    tab.value = available[0]
  }
  resetChallenge()
})

onBeforeUnmount(() => {
  unmounted = true
  generation += 1
  abortRequests()
  stopCooldown()
  clearSecrets()
  challenge.value = null
})

watch(accountValue, () => {
  if (proof.value !== null) {
    resetChallenge()
  }
})
</script>

<template>
  <AuthShell :title="t('auth.recover.title')" :subtitle="t('auth.recover.subtitle')">
    <template #notice>
      <p v-if="notice !== ''" class="notice notice-info wrap-anywhere">{{ notice }}</p>
      <p v-if="error !== ''" class="notice notice-error wrap-anywhere">{{ error }}</p>
    </template>

    <div v-if="stage === 'form'" class="stack">
      <div v-if="tabs.length > 1" class="tabs">
        <button
          v-for="entry in tabs"
          :key="entry"
          type="button"
          class="tab"
          :class="{ active: tab === entry }"
          :disabled="submitting"
          @click="switchTab(entry)"
        >
          {{ entry === 'email' ? t('auth.recover.tabEmail') : t('auth.recover.tabPhone') }}
        </button>
      </div>

      <template v-if="tab === 'email'">
        <div class="field">
          <label class="field-label" for="recover-email">{{ t('auth.common.email') }}</label>
          <div class="field-input">
            <input
              id="recover-email"
              v-model="email"
              type="email"
              autocomplete="email"
              :placeholder="t('auth.register.emailPlaceholder')"
              :disabled="submitting"
            />
          </div>
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label class="field-label" for="recover-country">{{ t('auth.common.countryCode') }}</label>
          <div class="field-input">
            <input
              id="recover-country"
              v-model="countryCode"
              type="text"
              inputmode="numeric"
              :placeholder="t('auth.common.countryCodePlaceholder')"
              :disabled="submitting"
            />
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="recover-phone">{{ t('auth.common.phone') }}</label>
          <div class="field-input">
            <input
              id="recover-phone"
              v-model="phone"
              type="tel"
              autocomplete="tel"
              :placeholder="t('auth.register.phonePlaceholder')"
              :disabled="submitting"
            />
          </div>
        </div>
      </template>

      <CaptchaField
        v-if="market.publicInfo !== null"
        :plan="captchaPlan"
        :appkey="appkey"
        :prefix="ncPrefix"
        :language="ncLanguage"
        :geetest-lang="geetestLang"
        purpose="recover"
        :solved="proof !== null"
        :reset-key="captchaKey"
        @solved="onSolved"
        @failed="onCaptchaFailed"
      />

      <button class="btn btn-primary btn-block" type="button" :disabled="submitting" @click="submitAccount">
        {{ submitting ? t('auth.common.submitting') : t('auth.recover.step1Submit') }}
        <ArrowRight :size="18" />
      </button>
    </div>

    <div v-else-if="stage === 'verify'" class="stack">
      <h2 class="section-title">{{ t('auth.recover.step2Title') }}</h2>
      <p class="muted">{{ t('auth.recover.step2Hint') }}</p>
      <p class="field-hint wrap-anywhere">{{ t('auth.common.account') }}: {{ maskAccount(accountValue()) }}</p>
      <p v-if="factorsUnknown" class="notice notice-error wrap-anywhere">{{ t('auth.error.factorUnknown') }}</p>

      <p v-if="emailCodeOff" class="notice wrap-anywhere" data-testid="recover-email-off">
        {{ googleRequired ? t('auth.recover.emailOffHint') : t('auth.recover.emailOffNoGoogle') }}
      </p>
      <AuthCodeField
        v-if="!emailCodeOff"
        id="recover-code"
        :label="codeLabel"
        v-model="code"
        :placeholder="t('auth.common.codePlaceholder')"
        :send-label="t('auth.common.sendCode')"
        :sending-label="t('auth.common.sending')"
        :resend-label="cooldownLabel"
        :sending="sendingCode"
        :cooldown="cooldown"
        :disabled="submitting"
        @send="sendCode"
      />

      <div v-if="googleRequired" class="field">
        <label class="field-label" for="recover-google">{{ t('auth.recover.googleCode') }}</label>
        <div class="field-input">
          <input
            id="recover-google"
            v-model="googleCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            :disabled="submitting"
          />
        </div>
      </div>

      <div v-if="certificateRequired" class="field">
        <label class="field-label" for="recover-certificate">{{ t('auth.recover.certificate') }}</label>
        <div class="field-input">
          <input id="recover-certificate" v-model="certificate" type="text" autocomplete="off" :disabled="submitting" />
        </div>
        <p class="field-hint">{{ t('auth.recover.certificateHint') }}</p>
      </div>

      <button class="btn btn-primary btn-block" type="button" :disabled="submitting || factorsUnknown" @click="submitFactors">
        {{ submitting ? t('auth.common.submitting') : t('auth.common.next') }}
        <ArrowRight :size="18" />
      </button>
    </div>

    <div v-else-if="stage === 'password'" class="stack">
      <h2 class="section-title">{{ t('auth.recover.step3Title') }}</h2>
      <p class="muted">{{ t('auth.recover.step3Hint') }}</p>
      <div class="field">
        <label class="field-label" for="recover-password">{{ t('auth.common.password') }}</label>
        <div class="field-input">
          <input
            id="recover-password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>
        <p class="field-hint">{{ t('auth.rule.password') }}</p>
      </div>
      <div class="field">
        <label class="field-label" for="recover-confirm">{{ t('auth.common.confirmPassword') }}</label>
        <div class="field-input" :class="{ invalid: confirmPassword !== '' && !passwordsMatch(password, confirmPassword) }">
          <input
            id="recover-confirm"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>
        <p v-if="confirmPassword !== '' && !passwordsMatch(password, confirmPassword)" class="field-error">
          {{ t('auth.rule.match') }}
        </p>
      </div>
      <button class="btn btn-primary btn-block" type="button" :disabled="submitting" @click="submitPassword">
        {{ submitting ? t('auth.common.submitting') : t('auth.recover.submit') }}
      </button>
    </div>

    <div v-else class="stack">
      <h2 class="section-title">{{ t('auth.recover.doneTitle') }}</h2>
      <p class="muted">{{ t('auth.recover.doneHint') }}</p>
      <p class="field-hint wrap-anywhere" v-if="completedAccount !== ''">{{ maskAccount(completedAccount) }}</p>
      <RouterLink class="btn btn-primary btn-block" to="/login">{{ t('auth.recover.toLogin') }}</RouterLink>
    </div>

    <template #footer>
      <RouterLink class="link" to="/login">{{ t('auth.recover.toLogin') }}</RouterLink>
    </template>
  </AuthShell>
</template>

<style scoped>
.section-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.tabs {
  display: flex;
  gap: var(--space-4);
  overflow-y: hidden;
  border-bottom: 1px solid var(--color-border);
}

.tab {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  padding: 0 0 10px;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
}

.tab.active {
  color: var(--color-text);
  font-weight: 600;
  border-bottom-color: var(--color-accent);
}

.tab:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.link {
  color: var(--color-text);
  font-weight: 600;
}

.btn-block {
  gap: 10px;
}
</style>
