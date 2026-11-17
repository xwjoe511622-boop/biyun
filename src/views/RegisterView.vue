<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff, ArrowRight } from '@lucide/vue'
import { useRoute, useRouter } from 'vue-router'
import { apiLanguage } from '@/i18n'
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { isApiError } from '@/core/errors'
import { newSessionKey, session } from '@/core/session'
import { isFeatureEnabled } from '@/core/feature-flags'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { useAuthI18n, translateAuthMessage } from '@/modules/auth/i18n'
import { aliyunNcLanguage, planCaptcha } from '@/modules/auth/captcha'
import { geetestLanguage } from '@/modules/auth/geetest'
import {
  captchaProvider,
  isInvitationCodeRequired,
  isValidEmail,
  isValidPassword,
  isValidPhone,
  isValidVerificationCode,
  maskAccount,
  modeAllowsPhone,
  normalizeCountryCode,
  passwordsMatch,
  readCaptchaRequired,
  registrationMode,
  registrationTabs,
  termsUrlFrom,
  type RegistrationMode,
} from '@/modules/auth/onboarding-state'
import {
  registerEmailCheckInfo,
  registerEmailConfirm,
  registerMobileCheckInfo,
  registerMobileConfirm,
  sendRegisterEmailCode,
  sendRegisterSmsCode,
  type CaptchaProof,
} from '@/modules/api/onboarding.api'
import AuthShell from '@/components/auth/AuthShell.vue'
import AuthCodeField from '@/components/auth/AuthCodeField.vue'
import CaptchaField from '@/components/auth/CaptchaField.vue'

// Registration. Full two-step flow recovered from `PC/common-mixin/register/register.js`:
// step 1 sends the (signed) registration info and gets a purpose token, the code is sent against
// that token, and step 2 confirms the code and may return a login JWT for the new account.
//
// Nothing is persisted: the registration token, the slider proof and the sign-in credential all
// live in this component's memory only. The final confirm only ever runs on an explicit click, and
// stale responses are dropped via the `generation` counter.
const { t } = useAuthI18n()
const route = useRoute()
const router = useRouter()
const market = useMarketStore()
const sessionStore = useSessionStore()

type Tab = 'email' | 'phone'
type Stage = 'form' | 'verify' | 'done'

const PURPOSE = 'register'
const CODE_COOLDOWN_SECONDS = 60

const mode = computed<RegistrationMode>(() => registrationMode(market.publicInfo?.switch))
const tabs = computed<Tab[]>(() => registrationTabs(mode.value))
const tab = ref<Tab>('email')

const email = ref('')
const countryCode = ref('')
const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const invitedCode = ref('')
const code = ref('')
const showPassword = ref(false)

const stage = ref<Stage>('form')
const submitting = ref(false)
const sendingCode = ref(false)
const cooldown = ref(0)
const { text: error, set: setError } = useLocalizedNotice()
const { text: notice, set: setNotice } = useLocalizedNotice()

const registrationToken = ref<string | null>(null)
const autoLoginToken = ref<string | null>(null)
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

/** Cancels a superseded request (new submit, tab switch, leave) instead of letting it finish. */
function beginRequest(): AbortSignal {
  inFlight?.abort()
  inFlight = new AbortController()
  return inFlight.signal
}

function abortRequests(): void {
  inFlight?.abort()
  inFlight = null
}

const inviteRequired = computed(() => isInvitationCodeRequired(market.publicInfo?.switch))
const termsUrl = computed(() => termsUrlFrom(market.publicInfo?.url))
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

const verificationTypeLabel = computed(() => (tab.value === 'email' ? t('auth.common.emailCode') : t('auth.common.phoneCode')))
/** 10-19: the server's email-code switch is off (`switch.email_code_required = "0"`): email sign-up without a code. */
const emailCodeOff = computed(() => tab.value === 'email' && String(market.publicInfo?.switch?.email_code_required ?? '1') === '0')
const cooldownLabel = computed(() => t('auth.common.resendIn', { seconds: cooldown.value }))
const inviteLabel = computed(() =>
  inviteRequired.value ? t('auth.common.inviteCodeRequired') : t('auth.common.inviteCodeOptional'),
)

function accountValue(): string {
  return tab.value === 'email' ? email.value.trim() : phone.value.trim()
}

function challengeKey(): string {
  return `${PURPOSE}:${tab.value}:${accountValue()}`
}

function describeError(value: unknown): string {
  if (isApiError(value)) {
    // `10003` is the server's "slider verification required" code (legacy `register.js`).
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

function clearPasswords(): void {
  password.value = ''
  confirmPassword.value = ''
}

function clearOtp(): void {
  code.value = ''
  proof.value = null
  proofKey.value = ''
}

/** Always called after a request settles, on unmount and when the flow is abandoned. */
function clearSecrets(): void {
  clearPasswords()
  clearOtp()
  registrationToken.value = null
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

/** Drops the solved proof and asks the widget for a fresh challenge. */
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

/** The proof is only usable for the account/purpose it was solved for, and only when required. */
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

function validateCredentials(): string {
  if (tab.value === 'email') {
    if (!isValidEmail(email.value)) {
      return 'auth.rule.email'
    }
  } else {
    if (normalizeCountryCode(countryCode.value) === '') {
      return 'auth.rule.countryCode'
    }
    if (!isValidPhone(phone.value)) {
      return 'auth.rule.phone'
    }
  }
  if (!isValidPassword(password.value)) {
    return 'auth.rule.password'
  }
  if (!passwordsMatch(password.value, confirmPassword.value)) {
    return 'auth.rule.match'
  }
  if (inviteRequired.value && invitedCode.value.trim() === '') {
    return 'auth.rule.inviteCode'
  }
  return ''
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

async function sendCode(): Promise<void> {
  if (sendingCode.value || cooldown.value > 0) {
    return
  }
  const token = registrationToken.value
  if (token === null) {
    return
  }
  const gen = generation
  const signal = beginRequest()
  sendingCode.value = true
  error.value = ''
  try {
    if (tab.value === 'email') {
      await sendRegisterEmailCode(token, { signal })
    } else {
      await sendRegisterSmsCode(token, countryCode.value, { signal })
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
    setError(() => describeError(value))
    stopCooldown()
  } finally {
    if (gen === generation) {
      sendingCode.value = false
    }
  }
}

async function submitCredentials(): Promise<void> {
  if (submitting.value) {
    return
  }
  error.value = ''
  notice.value = ''
  const validation = validateCredentials()
  if (validation !== '') {
    setError(() => t(validation))
    return
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
    const token =
      tab.value === 'email'
        ? await registerEmailCheckInfo({
            email: email.value.trim(),
            password: password.value,
            confirmPassword: confirmPassword.value,
            invitedCode: invitedCode.value,
            captcha,
            signal: beginRequest(),
          })
        : await registerMobileCheckInfo({
            countryCode: countryCode.value,
            mobileNumber: phone.value,
            password: password.value,
            confirmPassword: confirmPassword.value,
            invitedCode: invitedCode.value,
            captcha,
            signal: beginRequest(),
          })
    if (gen !== generation || unmounted) {
      return
    }
    registrationToken.value = token
    // The registration password is no longer needed once the server has accepted it.
    clearPasswords()
    resetChallenge()
    if (emailCodeOff.value) {
      submitting.value = false
      await confirm()
      return
    }
    stage.value = 'verify'
    await sendCode()
  } catch (value) {
    if (gen !== generation || unmounted) {
      return
    }
    setError(() => describeError(value))
    clearSecrets()
    resetChallenge()
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

async function confirm(): Promise<void> {
  if (submitting.value) {
    return
  }
  error.value = ''
  notice.value = ''
  const token = registrationToken.value
  if (token === null) {
    setError(() => t('auth.error.tokenMissing'))
    return
  }
  const noCode = emailCodeOff.value
  if (!noCode && !isValidVerificationCode(code.value)) {
    setError(() => t('auth.rule.code'))
    return
  }
  const submittedCode = code.value.trim()
  const submittedAccount = accountValue()
  const gen = ++generation
  submitting.value = true
  try {
    const result =
      tab.value === 'email'
        ? await registerEmailConfirm(noCode ? { token, signal: beginRequest() } : { token, emailCode: submittedCode, signal: beginRequest() })
        : await registerMobileConfirm({ token, smsCode: submittedCode, signal: beginRequest() })
    if (gen !== generation || unmounted) {
      return
    }
    clearSecrets()
    stopCooldown()
    completedAccount.value = submittedAccount
    // cookie mode (10-17): the server already set the HttpOnly session cookie of the new account; a token answered by
    // an older server is not adopted (the user signs in normally)
    if (result.cookieSession && session.isAuthenticated()) session.clear()
    autoLoginToken.value = result.cookieSession ? newSessionKey() : null
    stage.value = 'done'
  } catch (value) {
    if (gen !== generation || unmounted) {
      return
    }
    setError(() => describeError(value))
    clearOtp()
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

function backToForm(): void {
  generation += 1
  abortRequests()
  clearSecrets()
  stopCooldown()
  error.value = ''
  notice.value = ''
  resetChallenge()
  stage.value = 'form'
}

function switchTab(next: Tab): void {
  if (next === tab.value || submitting.value) {
    return
  }
  generation += 1
  abortRequests()
  tab.value = next
  clearSecrets()
  stopCooldown()
  error.value = ''
  notice.value = ''
  resetChallenge()
  stage.value = 'form'
}

/** Adopts the cookie session the server already issued for the new account (a fresh session key). */
async function enterExchange(): Promise<void> {
  const token = autoLoginToken.value
  if (token === null) {
    await router.push('/login')
    return
  }
  autoLoginToken.value = null
  session.setToken(token)
  await sessionStore.loadUserInfo()
  // 10-19 email-code switch off: the new account is gated until Google Authenticator is bound
  await router.push(emailCodeOff.value ? { path: '/security', query: { bindGa: '1' } } : '/trade')
}

onMounted(async () => {
  const query = route.query
  const nowType = typeof query.nowType === 'string' ? query.nowType : ''
  const queryEmail = typeof query.email === 'string' ? query.email : ''
  const queryPhone = typeof query.phone === 'string' ? query.phone : ''
  const queryInvite = typeof query.inviteCode === 'string' ? query.inviteCode : ''
  if (queryInvite !== '') {
    invitedCode.value = queryInvite
  }
  if (queryEmail !== '') {
    email.value = queryEmail
  } else if (queryPhone !== '') {
    phone.value = queryPhone
  }

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
    const preferred = modeAllowsPhone(mode.value) && nowType === 'phone' ? 'phone' : available[0]
    tab.value = preferred
  }
  resetChallenge()
})

onBeforeUnmount(() => {
  unmounted = true
  generation += 1
  abortRequests()
  stopCooldown()
  clearSecrets()
  autoLoginToken.value = null
})

watch(accountValue, () => {
  // A proof is bound to the account it was solved for: editing the account invalidates it.
  if (proof.value !== null) {
    resetChallenge()
  }
})
</script>

<template>
  <AuthShell :title="t('auth.register.title')" wide>
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
          {{ entry === 'email' ? t('auth.register.tabEmail') : t('auth.register.tabPhone') }}
        </button>
      </div>

      <template v-if="tab === 'email'">
        <div class="field">
          <label class="field-label" for="register-email">{{ t('auth.common.email') }}</label>
          <div class="field-input">
            <input
              id="register-email"
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
          <label class="field-label" for="register-country">{{ t('auth.common.countryCode') }}</label>
          <div class="field-input">
            <input
              id="register-country"
              v-model="countryCode"
              type="text"
              inputmode="numeric"
              :placeholder="t('auth.common.countryCodePlaceholder')"
              :disabled="submitting"
            />
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="register-phone">{{ t('auth.common.phone') }}</label>
          <div class="field-input">
            <input
              id="register-phone"
              v-model="phone"
              type="tel"
              autocomplete="tel"
              :placeholder="t('auth.register.phonePlaceholder')"
              :disabled="submitting"
            />
          </div>
        </div>
      </template>

      <div class="field">
        <label class="field-label" for="register-password">{{ t('auth.common.password') }}</label>
        <div class="field-input">
          <input
            id="register-password"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="submitting"
          />
          <button
            type="button"
            class="icon-button"
            :title="showPassword ? t('auth.common.hidePassword') : t('auth.common.showPassword')"
            :aria-label="showPassword ? t('auth.common.hidePassword') : t('auth.common.showPassword')"
            @click="showPassword = !showPassword"
          >
            <EyeOff v-if="showPassword" :size="18" /><Eye v-else :size="18" />
          </button>
        </div>
        <p class="field-hint">{{ t('auth.register.passwordHint') }}</p>
      </div>

      <div class="field">
        <label class="field-label" for="register-confirm">{{ t('auth.common.confirmPassword') }}</label>
        <div class="field-input" :class="{ invalid: confirmPassword !== '' && !passwordsMatch(password, confirmPassword) }">
          <input
            id="register-confirm"
            v-model="confirmPassword"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="submitting"
          />
        </div>
        <p v-if="confirmPassword !== '' && !passwordsMatch(password, confirmPassword)" class="field-error">
          {{ t('auth.rule.match') }}
        </p>
      </div>

      <div class="field">
        <label class="field-label" for="register-invite">{{ inviteLabel }}</label>
        <div class="field-input">
          <input
            id="register-invite"
            v-model="invitedCode"
            type="text"
            autocomplete="off"
            :disabled="submitting"
          />
        </div>
        <p class="field-hint">{{ t('auth.register.invitedHint') }}</p>
      </div>

      <CaptchaField
        v-if="market.publicInfo !== null"
        :plan="captchaPlan"
        :appkey="appkey"
        :prefix="ncPrefix"
        :language="ncLanguage"
        :geetest-lang="geetestLang"
        purpose="register"
        :solved="proof !== null"
        :reset-key="captchaKey"
        @solved="onSolved"
        @failed="onCaptchaFailed"
      />

      <p v-if="termsUrl !== null" class="field-hint">
        {{ t('auth.register.termsNotice') }}
        <a :href="termsUrl" target="_blank" rel="noopener noreferrer">{{ t('auth.register.termsLink') }}</a>
      </p>

      <button class="btn btn-primary btn-block" type="button" :disabled="submitting" @click="submitCredentials">
        {{ submitting ? t('auth.common.submitting') : t('auth.register.step1Submit') }}
        <ArrowRight :size="18" />
      </button>
    </div>

    <div v-else-if="stage === 'verify'" class="stack">
      <h2 class="section-title">{{ tab === 'email' ? t('auth.register.step2TitleEmail') : t('auth.register.step2TitlePhone') }}</h2>
      <p class="muted">{{ t('auth.register.step2Hint') }}</p>
      <p class="field-hint wrap-anywhere">{{ t('auth.common.account') }}: {{ maskAccount(completedAccount !== '' ? completedAccount : accountValue()) }}</p>
      <AuthCodeField
        id="register-code"
        :label="verificationTypeLabel"
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
      <div class="row">
        <button class="btn" type="button" :disabled="submitting" @click="backToForm">
          {{ t('auth.register.changeAccount') }}
        </button>
        <button class="btn btn-primary grow" type="button" :disabled="submitting" @click="confirm">
          {{ submitting ? t('auth.common.submitting') : t('auth.register.confirm') }}
        </button>
      </div>
    </div>

    <div v-else class="stack">
      <h2 class="section-title">{{ t('auth.register.doneTitle') }}</h2>
      <p class="muted">
        {{ autoLoginToken !== null ? t('auth.register.doneWithToken') : t('auth.register.doneNoToken') }}
      </p>
      <p class="field-hint wrap-anywhere" v-if="completedAccount !== ''">{{ maskAccount(completedAccount) }}</p>
      <p v-if="autoLoginToken !== null" class="field-hint">{{ t('auth.register.memoryNote') }}</p>
      <button v-if="autoLoginToken !== null" class="btn btn-primary btn-block" type="button" @click="enterExchange">
        {{ t('auth.register.enter') }}
      </button>
      <RouterLink v-else class="btn btn-primary btn-block" to="/login">{{ t('auth.register.toLogin') }}</RouterLink>
    </div>

    <template #footer>
      <span>{{ t('auth.register.haveAccount') }}</span>
      <RouterLink class="link" to="/login">{{ t('auth.register.loginNow') }}</RouterLink>
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

.grow {
  flex: 1 1 auto;
}

.row {
  gap: var(--space-3);
}

.link {
  color: var(--color-text);
  font-weight: 600;
}

.btn-block {
  gap: 10px;
}
</style>
