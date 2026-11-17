<script setup lang="ts">
import { i18n } from '@/i18n/composer'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Copy, Eye, EyeOff, KeyRound, RotateCw, ShieldCheck } from '@lucide/vue'
import SecurityRow from './SecurityRow.vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { startTotpEnrollment, verifyTotpEnrollment, type TotpEnrollment } from '@/modules/api/security-settings.api'
import { translateSecurityMessage, useSecurityI18n } from '@/modules/security/i18n'
import {
  classifyTotpFailure,
  formatSecretGroups,
  isProvisioningUri,
  isSubmittableGoogleKey,
  isValidVerificationCode,
  maskSecret,
  redactSensitive,
  safeQrImage,
  sanitizeOtpInput,
  type FactorState,
} from '@/modules/security/security-state'

/**
 * TOTP enrollment. Requests the server-rendered QR/secret only after an explicit button press —
 * never on mount — and keeps the plaintext secret in component memory only. Closing the panel,
 * unmounting or a session-token change clears it *and* invalidates every in-flight request, so a
 * late enrollment/verification response can never repopulate a secret or emit after the fact.
 * Nothing here touches localStorage/sessionStorage and nothing is written to logs.
 */
const props = defineProps<{ factorState: FactorState }>()
const emit = defineEmits<{ (event: 'enrolled'): void }>()
const { t } = useSecurityI18n()

const starting = ref(false)
const verifying = ref(false)
const enrollment = ref<TotpEnrollment | null>(null)
const revealed = ref(false)
const password = ref('')
const code = ref('')
const error = ref('')
/** Extra guidance under a rejected code (clock drift / new secret). */
const errorHint = ref('')
const copied = ref<'idle' | 'ok' | 'failed'>('idle')
/** Shown once after a successful enrollment (the panel itself closes). */
const enrolledNotice = ref(false)
const codeInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Request generation + auth snapshot. Every close / token change / unmount bumps the generation
 * (and the token is re-read at completion time), so an abandoned request is dropped instead of
 * writing state back into a panel that no longer belongs to that session.
 */
let generation = 0
let unmounted = false

function authToken(): string | null {
  return session.getToken()
}

function isStale(gen: number, token: string | null): boolean {
  return unmounted || gen !== generation || token !== authToken()
}

const statusLabel = computed(() => {
  if (props.factorState === 'enabled') {
    return t('security.enabled')
  }
  return props.factorState === 'disabled' ? t('security.disabled') : t('security.unknown')
})

const qrSrc = computed(() =>
  enrollment.value === null ? '' : safeQrImage(enrollment.value.qrImage, window.location.origin),
)
/** Image returned by the server but rejected for being off-origin. */
const qrBlocked = computed(
  () => enrollment.value !== null && enrollment.value.qrImage.trim() !== '' && qrSrc.value === '',
)
const isProvisioning = computed(
  () => enrollment.value !== null && isProvisioningUri(enrollment.value.secret),
)
const shownSecret = computed(() => {
  if (enrollment.value === null) return ''
  if (!revealed.value) return maskSecret()
  const secret = enrollment.value.secret
  return isProvisioning.value ? secret : formatSecretGroups(secret)
})
/** `user/google_verify` only accepts the base32 `googleKey`, never blank or an `otpauth://` URI. */
const keySubmittable = computed(
  () => enrollment.value !== null && isSubmittableGoogleKey(enrollment.value.secret),
)
const canVerify = computed(
  () =>
    enrollment.value !== null &&
    keySubmittable.value &&
    !starting.value &&
    password.value !== '' &&
    isValidVerificationCode(code.value) &&
    !verifying.value,
)

function clearSensitive(): void {
  enrollment.value = null
  revealed.value = false
  password.value = ''
  code.value = ''
  error.value = ''
  errorHint.value = ''
  copied.value = 'idle'
}

/** Copies the secret without revealing it on screen (clipboard API, textarea fallback). */
async function copySecret(): Promise<void> {
  if (enrollment.value === null) return
  const text = enrollment.value.secret.replace(/\s+/g, '')
  let ok = false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(area)
  }
  copied.value = ok ? 'ok' : 'failed'
  if (copyTimer !== null) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = 'idle'
  }, 2000)
}

/** Digits only, max 6; a complete code with a password present submits by itself. */
function onCodeInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const clean = sanitizeOtpInput(target.value)
  code.value = clean
  if (target.value !== clean) target.value = clean
  if (clean.length === 6 && error.value !== '') {
    error.value = ''
    errorHint.value = ''
  }
}

watch([code, password], ([nextCode]) => {
  if (nextCode.length === 6 && canVerify.value) {
    void verify()
  }
})

/** Invalidate every in-flight request, then drop the secret / OTP / password drafts. */
function closeEnrollment(): void {
  generation += 1
  starting.value = false
  verifying.value = false
  clearSensitive()
}

function describe(cause: unknown): string {
  if (isApiError(cause)) {
    return translateSecurityMessage(t, cause.message)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

/** Renders a real error without ever echoing a submitted secret, OTP or password. */
function fail(cause: unknown, values: readonly string[]): void {
  error.value = redactSensitive(describe(cause), values)
}

/** Explicit user action: the enrollment request is never sent on load. */
async function start(): Promise<void> {
  // A refresh while a verification is in flight would race the confirm; block it.
  if (starting.value || verifying.value || props.factorState !== 'disabled') {
    return
  }
  const gen = ++generation
  const token = authToken()
  starting.value = true
  error.value = ''
  errorHint.value = ''
  enrolledNotice.value = false
  try {
    const result = await startTotpEnrollment()
    if (isStale(gen, token)) {
      return
    }
    enrollment.value = result
    revealed.value = false
    code.value = ''
    await nextTick()
    passwordInput.value?.focus()
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    enrollment.value = null
    fail(cause, [])
  } finally {
    if (gen === generation) {
      starting.value = false
    }
  }
}

async function verify(): Promise<void> {
  if (!canVerify.value || enrollment.value === null) {
    return
  }
  const gen = generation
  const token = authToken()
  const secret = enrollment.value.secret
  const submittedCode = code.value.trim()
  const submittedPassword = password.value
  const redactValues = [secret, submittedCode, submittedPassword]
  verifying.value = true
  error.value = ''
  errorHint.value = ''
  try {
    await verifyTotpEnrollment({
      secret,
      code: submittedCode,
      loginPassword: submittedPassword,
    })
    if (isStale(gen, token)) {
      return
    }
    closeEnrollment()
    enrolledNotice.value = true
    emit('enrolled')
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    // Keep only the enrollment secret needed to retry; never keep the rejected OTP. The password
    // is kept when only the code was wrong (retyping it for every 30 s window is the main friction).
    const failure = isApiError(cause) ? classifyTotpFailure(cause.code) : 'other'
    if (failure === 'code') {
      error.value = t('security.totp.wrongCode')
      errorHint.value = t('security.totp.clockHint')
    } else if (failure === 'password') {
      error.value = t('security.totp.wrongPassword')
    } else {
      fail(cause, redactValues)
    }
    code.value = ''
    if (failure !== 'code') password.value = ''
    await nextTick()
    ;(failure === 'code' ? codeInput.value : passwordInput.value)?.focus()
  } finally {
    if (gen === generation) {
      verifying.value = false
    }
  }
}

let lastToken = session.getToken()
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = session.onInvalidate((snapshot) => {
    if (snapshot.token !== lastToken) {
      lastToken = snapshot.token
      // Logout / session replacement must never leave the secret or OTP draft in memory.
      closeEnrollment()
    }
  })
})

onBeforeUnmount(() => {
  unmounted = true
  if (copyTimer !== null) clearTimeout(copyTimer)
  closeEnrollment()
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <SecurityRow :label="t('security.totpTitle')" :description="t('security.totp.description')" layout="stacked">
    <template #icon><KeyRound :size="18" /></template>
    <template #value>
      <span class="chip" :class="factorState">{{ statusLabel }}</span>
    </template>
    <template #action>
      <button
        v-if="factorState === 'disabled' && enrollment === null"
        class="btn"
        type="button"
        :disabled="starting"
        @click="start"
      >
        <ShieldCheck :size="14" aria-hidden="true" />
        {{ starting ? t('security.totp.starting') : t('security.totp.start') }}
      </button>
      <button v-else-if="enrollment !== null" class="btn btn-ghost" type="button" @click="closeEnrollment">
        {{ t('security.close') }}
      </button>
    </template>

    <template #body>
      <p v-if="enrolledNotice && enrollment === null" class="notice notice-success" role="status">
        {{ t('security.totp.verified') }} {{ t('security.totp.afterEnable') }}
      </p>
      <p v-if="factorState === 'unknown'" class="notice">{{ t('security.unknownValue') }} — {{ t('security.unknown') }}</p>

      <div v-if="enrollment !== null" class="enroll">
        <p class="enroll-step">{{ t('security.totp.step1') }}</p>
        <p class="enroll-hint">{{ t('security.totp.scan') }}</p>

        <img
          v-if="qrSrc !== ''"
          class="qr"
          :src="qrSrc"
          :alt="i18n.global.t('securityLabel.authenticatorQrCode')"
          referrerpolicy="no-referrer"
        />
        <p v-else-if="qrBlocked" class="notice notice-error">{{ t('security.totp.qrBlocked') }}</p>
        <p v-else class="notice">{{ t('security.totp.qrUnavailable') }}</p>

        <div v-if="enrollment.secret !== ''" class="secret">
          <span class="secret-label">
            {{ isProvisioning ? t('security.totp.provisioningUri') : t('security.totp.manualKey') }}
          </span>
          <code class="secret-value wrap-anywhere">{{ shownSecret }}</code>
          <button
            v-if="keySubmittable"
            class="icon-button"
            type="button"
            :aria-label="t('security.totp.copySecret')"
            :title="t('security.totp.copySecret')"
            @click="copySecret"
          >
            <Check v-if="copied === 'ok'" :size="16" /><Copy v-else :size="16" />
          </button>
          <button
            class="icon-button"
            type="button"
            :aria-label="revealed ? t('security.totp.hideSecret') : t('security.totp.showSecret')"
            :title="revealed ? t('security.totp.hideSecret') : t('security.totp.showSecret')"
            @click="revealed = !revealed"
          >
            <EyeOff v-if="revealed" :size="16" /><Eye v-else :size="16" />
          </button>
        </div>
        <p v-if="copied !== 'idle'" class="field-hint" role="status">
          {{ copied === 'ok' ? t('security.totp.copied') : t('security.totp.copyFailed') }}
        </p>
        <p class="notice notice-warn">{{ t('security.totp.backupHint') }}</p>
        <p class="field-hint">{{ t('security.totp.secretHint') }}</p>

        <p v-if="!keySubmittable" class="notice notice-error wrap-anywhere">
          {{ t('security.totp.keyUnusable') }}
        </p>
        <div v-else class="verify stack">
          <p class="enroll-step">{{ t('security.totp.step2') }}</p>
          <div class="field">
            <label class="field-label" for="totp-password">{{ t('security.totp.loginPassword') }}</label>
            <div class="field-input">
              <input
                id="totp-password"
                ref="passwordInput"
                v-model="password"
                type="password"
                autocomplete="current-password"
                :aria-label="t('security.totp.loginPassword')"
              />
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="totp-code">{{ t('security.totp.code') }}</label>
            <div class="field-input">
              <input
                id="totp-code"
                ref="codeInput"
                :value="code"
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                maxlength="12"
                autocomplete="one-time-code"
                enterkeyhint="done"
                class="otp-input"
                :placeholder="t('security.totp.codePlaceholder')"
                :aria-label="t('security.totp.code')"
                @input="onCodeInput"
                @keydown.enter.prevent="verify"
              />
            </div>
          </div>
          <p class="field-hint">{{ t('security.totp.autoSubmit') }}</p>
          <p v-if="error !== ''" class="notice notice-error wrap-anywhere" role="alert">{{ error }}</p>
          <p v-if="errorHint !== ''" class="field-hint wrap-anywhere">{{ errorHint }}</p>
          <div class="row">
            <button class="btn" type="button" :disabled="starting || verifying" @click="start">
              <RotateCw :size="14" aria-hidden="true" />
              {{ t('security.totp.refresh') }}
            </button>
            <button class="btn btn-primary" type="button" :disabled="!canVerify" @click="verify">
              {{ verifying ? t('security.totp.verifying') : t('security.totp.verify') }}
            </button>
          </div>
        </div>
      </div>

      <p v-else-if="error !== ''" class="notice notice-error wrap-anywhere">{{ error }}</p>
    </template>
  </SecurityRow>
</template>

<style scoped>
.chip.enabled {
  border-color: var(--color-up);
  color: var(--color-up);
}

.chip.disabled {
  color: var(--color-text-secondary);
}

.enroll {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
  max-width: 460px;
}

.enroll-hint {
  margin: 0 0 10px;
  color: var(--color-text-secondary);
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

.secret {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 10px;
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

.verify {
  margin-top: 14px;
  gap: var(--space-3);
}

.enroll-step {
  margin: 0 0 6px;
  font-weight: 600;
  font-size: var(--font-size-sm);
}

.otp-input {
  font-family: var(--font-mono);
  letter-spacing: 0.3em;
  font-size: var(--font-size-lg, 18px);
}

.otp-input::placeholder {
  letter-spacing: normal;
  font-family: inherit;
  font-size: var(--font-size-sm);
}

.notice-success {
  background: var(--color-up-soft, transparent);
  border-color: var(--color-up);
  color: var(--color-up);
}

.notice-warn {
  margin-top: 10px;
}

.row {
  flex-wrap: wrap;
}

@media (max-width: 480px) {
  .qr {
    width: 180px;
    height: 180px;
  }
}
</style>
