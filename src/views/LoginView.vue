<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRight, Eye, EyeOff, ShieldCheck } from '@lucide/vue'
import { useRouter } from 'vue-router'
import { apiLanguage } from '@/i18n'
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { isApiError } from '@/core/errors'
import { isFeatureEnabled } from '@/core/feature-flags'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { useAuthI18n, translateAuthMessage } from '@/modules/auth/i18n'
import { aliyunNcLanguage, planCaptcha } from '@/modules/auth/captcha'
import { geetestLanguage } from '@/modules/auth/geetest'
import {
  captchaProvider,
  isValidVerificationCode,
  maskAccount,
  readCaptchaRequired,
  readLoginVerifyType,
  verifyTypeLabelKey,
} from '@/modules/auth/onboarding-state'
import { sendLoginCode, type CaptchaProof } from '@/modules/api/onboarding.api'
import AuthShell from '@/components/auth/AuthShell.vue'
import AuthCodeField from '@/components/auth/AuthCodeField.vue'
import CaptchaField from '@/components/auth/CaptchaField.vue'

// Login. Credential + challenge state stays in the (main-owned) session store, whose
// `requestLogin` / `confirmLogin` already drop stale responses and cancelled challenges.
//
// What this view adds on top of the original implementation:
// - the same slider adapter as register/recovery, so a configured Aliyun NC slider is solved for
//   real instead of blocking the form (or, worse, submitting a forged proof);
// - the step-two code send (`operationType` 25 / 4) with a cooldown, which the legacy page had and
//   this client was missing;
// - secrets are wiped on success, on failure, when going back and on unmount, and the final
//   confirm only runs on an explicit click.
const { t } = useAuthI18n()
const router = useRouter()
const market = useMarketStore()
const sessionStore = useSessionStore()

const PURPOSE = 'login'
const CODE_COOLDOWN_SECONDS = 60

const account = ref('')
const countryCode = ref('')
const password = ref('')
const showPassword = ref(false)
const authCode = ref('')
const { text: localError, set: setError } = useLocalizedNotice()
const { text: notice, set: setNotice } = useLocalizedNotice()
const sendingCode = ref(false)
const cooldown = ref(0)

const proof = ref<CaptchaProof | null>(null)
const proofKey = ref('')
const captchaKey = ref('')
const captchaFailed = ref(false)
const captchaErrorKey = ref('')

let cooldownTimer: ReturnType<typeof setInterval> | null = null
let unmounted = false

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

const challengeToken = computed(() => sessionStore.challenge?.token ?? null)
const verifyType = computed(() => readLoginVerifyType(sessionStore.challenge?.verifyType))
const verifyLabel = computed(() => (verifyType.value === null ? t('auth.common.code') : t(verifyTypeLabelKey(verifyType.value))))
const cooldownLabel = computed(() => t('auth.common.resendIn', { seconds: cooldown.value }))

const credentialError = computed(() => {
  if (localError.value !== '') {
    return localError.value
  }
  return sessionStore.error === null ? '' : describeError(sessionStore.error)
})

// A previous failure must not latch the button off: the user has to be able to retry.
const canSubmitCredentials = computed(
  () => account.value.trim() !== '' && password.value !== '' && !sessionStore.loading,
)

function accountValue(): string {
  return account.value.trim()
}

function challengeKey(): string {
  return `${PURPOSE}:${accountValue()}`
}

/**
 * Store and API errors are real server messages, or one of our own i18n keys (`auth.*`) / the
 * store's (`error.*`); keys are translated so no raw key is ever shown.
 */
function describeError(message: string): string {
  const translated = translateAuthMessage(t, message)
  return translated.startsWith('error.') ? t(translated) : translated
}

function describeThrown(value: unknown): string {
  if (isApiError(value)) {
    return describeError(value.message)
  }
  return value instanceof Error ? describeError(value.message) : t('auth.error.badRequest')
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

function clearSecrets(): void {
  password.value = ''
  authCode.value = ''
  proof.value = null
  proofKey.value = ''
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

async function sendCode(): Promise<void> {
  if (sendingCode.value || cooldown.value > 0 || sessionStore.loading) {
    return
  }
  const token = challengeToken.value
  const type = verifyType.value
  if (token === null || type === null || type === '1') {
    return
  }
  localError.value = ''
  sendingCode.value = true
  try {
    await sendLoginCode(type, token)
    const recipient = maskAccount(accountValue())
    setNotice(() => t('auth.common.codeSentTo', { account: recipient }))
    startCooldown()
  } catch (value) {
    if (unmounted) {
      return
    }
    notice.value = ''
    setError(() => describeThrown(value))
    stopCooldown()
  } finally {
    sendingCode.value = false
  }
}

async function submitCredentials(): Promise<void> {
  if (sessionStore.loading) {
    return
  }
  localError.value = ''
  notice.value = ''
  if (accountValue() === '' || password.value === '') {
    setError(() => t('auth.common.required'))
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
  const submittedPassword = password.value
  const submittedAccount = accountValue()
  const isEmail = submittedAccount.includes('@')
  const challenge = await sessionStore.requestLogin({
    mobileNumber: submittedAccount,
    loginPword: submittedPassword,
    ...(isEmail || countryCode.value.trim() === ''
      ? {}
      : { countryCode: countryCode.value.trim().replace(/^\+/, '') }),
    // `verificationType` plus whichever vendor fields the solved proof carries (Aliyun
    // `csessionid/sig/token/scene` or Geetest `geetest_challenge/validate/seccode`).
    ...captcha,
  })
  // The password is never kept after the request settles, and the slider proof is single-use.
  password.value = ''
  resetChallenge()
  if (challenge === null) {
    const message = sessionStore.error ?? 'auth.error.badRequest'
    setError(() => describeError(message))
    return
  }
  notice.value = ''
  if (challenge.verifyType === '0') {
    // 10-19 email-code switch off and no Google bound: no second factor; the account is gated until Google is bound
    await finishWithoutCode()
    return
  }
  await sendCode()
}

async function finishWithoutCode(): Promise<void> {
  const ok = await sessionStore.confirmLogin('', '0')
  if (ok) {
    await router.push({ path: '/security', query: { bindGa: '1' } })
    return
  }
  const message = sessionStore.error ?? 'auth.error.badRequest'
  setError(() => describeError(message))
}

async function confirm(): Promise<void> {
  if (sessionStore.loading) {
    return
  }
  localError.value = ''
  notice.value = ''
  const type = verifyType.value
  if (type === null) {
    setError(() => t('auth.error.tokenMissing'))
    return
  }
  if (!isValidVerificationCode(authCode.value)) {
    setError(() => t('auth.rule.code'))
    return
  }
  const ok = await sessionStore.confirmLogin(authCode.value.trim(), type)
  authCode.value = ''
  if (ok) {
    stopCooldown()
    await router.push('/trade')
    return
  }
  const message = sessionStore.error ?? 'auth.error.verifyCode'
  setError(() => describeError(message))
}

function backToCredentials(): void {
  stopCooldown()
  clearSecrets()
  sessionStore.cancelChallenge()
  localError.value = ''
  notice.value = ''
  resetChallenge()
}

onMounted(async () => {
  if (market.publicInfo === null) {
    try {
      await market.loadPublicInfo()
    } catch {
      // Login still renders; the submit path surfaces the real server error.
    }
  }
  if (unmounted) {
    return
  }
  resetChallenge()
})

onBeforeUnmount(() => {
  unmounted = true
  stopCooldown()
  clearSecrets()
})

watch(accountValue, () => {
  // A solved proof belongs to the account it was solved for.
  if (proof.value !== null) {
    resetChallenge()
  }
})
</script>

<template>
  <AuthShell
    :title="sessionStore.challenge === null ? t('auth.login.title') : t('auth.login.securityTitle')"
    :subtitle="t('auth.login.subtitle')"
  >
    <template #notice>
      <p v-if="notice !== ''" class="notice notice-info wrap-anywhere">{{ notice }}</p>
      <p v-if="credentialError !== '' && sessionStore.challenge === null" class="notice notice-error wrap-anywhere">
        {{ credentialError }}
      </p>
    </template>

    <template v-if="sessionStore.isAuthenticated">
      <p class="notice notice-info wrap-anywhere">
        {{ t('auth.login.loggedInAs', { account: String(sessionStore.user?.userAccount ?? sessionStore.user?.email ?? '') }) }}
      </p>
      <RouterLink class="btn btn-primary btn-block" to="/trade">{{ t('auth.login.toTrade') }}</RouterLink>
    </template>

    <div v-else-if="sessionStore.challenge === null" class="stack">
      <p class="secure-domain"><ShieldCheck :size="15" aria-hidden="true" />{{ t('auth.login.secureDomain') }}</p>
      <div class="field">
        <label class="field-label" for="login-account">{{ t('auth.login.account') }}</label>
        <div class="field-input">
          <input
            id="login-account"
            v-model="account"
            type="text"
            autocomplete="username"
            :placeholder="t('auth.login.accountPlaceholder')"
            :disabled="sessionStore.loading"
          />
        </div>
      </div>

      <div v-if="account !== '' && !account.includes('@')" class="field">
        <label class="field-label" for="login-country">{{ t('auth.login.countryCode') }}</label>
        <div class="field-input">
          <input
            id="login-country"
            v-model="countryCode"
            type="text"
            inputmode="numeric"
            :placeholder="t('auth.common.countryCodePlaceholder')"
            :disabled="sessionStore.loading"
          />
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="login-password">{{ t('auth.login.password') }}</label>
        <div class="field-input">
          <input
            id="login-password"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            :placeholder="t('auth.login.passwordPlaceholder')"
            :disabled="sessionStore.loading"
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
      </div>

      <CaptchaField
        v-if="market.publicInfo !== null"
        :plan="captchaPlan"
        :appkey="appkey"
        :prefix="ncPrefix"
        :language="ncLanguage"
        :geetest-lang="geetestLang"
        purpose="login"
        :solved="proof !== null"
        :reset-key="captchaKey"
        @solved="onSolved"
        @failed="onCaptchaFailed"
      />

      <button class="btn btn-primary btn-block" type="button" :disabled="!canSubmitCredentials" @click="submitCredentials">
        {{ sessionStore.loading ? t('auth.login.submitting') : t('auth.login.submit') }}
        <ArrowRight :size="18" />
      </button>
    </div>

    <div v-else class="stack">
      <p class="notice notice-info wrap-anywhere">{{ t('auth.login.step2Hint') }}</p>
      <AuthCodeField
        id="login-code"
        :label="verifyLabel"
        v-model="authCode"
        :placeholder="t('auth.login.codePlaceholder')"
        :send-label="t('auth.common.sendCode')"
        :sending-label="t('auth.common.sending')"
        :resend-label="cooldownLabel"
        :sending="sendingCode"
        :cooldown="cooldown"
        :disabled="sessionStore.loading"
        :hide-send="verifyType === '1'"
        @send="sendCode"
      />
      <p v-if="credentialError !== ''" class="notice notice-error wrap-anywhere">{{ credentialError }}</p>
      <div class="row">
        <button class="btn" type="button" :disabled="sessionStore.loading" @click="backToCredentials">
          {{ t('auth.login.back') }}
        </button>
        <button class="btn btn-primary grow" type="button" :disabled="sessionStore.loading" @click="confirm">
          {{ sessionStore.loading ? t('auth.login.submitting') : t('auth.login.confirm') }}
        </button>
      </div>
    </div>

    <template #footer>
      <RouterLink class="link" to="/recover-password">{{ t('auth.login.forgot') }}</RouterLink>
      <span class="muted">·</span>
      <RouterLink class="link" to="/register">{{ t('auth.login.registerNow') }}</RouterLink>
    </template>
  </AuthShell>
</template>

<style scoped>
.secure-domain {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
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
