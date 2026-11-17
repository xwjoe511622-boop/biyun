<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Lock } from '@lucide/vue'
import SecurityRow from './SecurityRow.vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { requestSecuritySmsCode, updatePassword } from '@/modules/api/security-settings.api'
import { translateSecurityMessage, useSecurityI18n } from '@/modules/security/i18n'
import {
  isValidPassword,
  isValidVerificationCode,
  redactSensitive,
  type FactorState,
} from '@/modules/security/security-state'

/**
 * Login-password change. Factor requirements follow the legacy `ChangePassword` mixin exactly:
 * a Google code when `googleStatus=1`, an SMS code when `isOpenMobileCheck=1`, and no password
 * change at all while both are off (legacy showed a blocking alert). Nothing is submitted
 * automatically and the new/current passwords and codes never leave component memory.
 *
 * The *current* password is only required to be non-empty: it is an existing credential that may
 * predate the current password policy, so the client must not apply the new-password rule to it
 * (`user/password_update` re-checks it server-side via `modifyLoginPasswordSave`). Only the new
 * password must satisfy the legacy rule.
 */
const props = defineProps<{ googleFactor: FactorState; smsFactor: FactorState }>()
const emit = defineEmits<{ (event: 'changed'): void }>()
const { t } = useSecurityI18n()

const SMS_COOLDOWN_SECONDS = 60

const open = ref(false)
const current = ref('')
const next = ref('')
const repeat = ref('')
const googleCode = ref('')
const smsCode = ref('')
const submitting = ref(false)
const sendingSms = ref(false)
const smsCooldown = ref(0)
const error = ref('')
const notice = ref('')

/**
 * Request generation + auth snapshot. Every close / token change / unmount bumps the generation,
 * so a late password/SMS response cannot emit `changed`, log out a *new* session, or surface a
 * stale notice.
 */
let generation = 0
let unmounted = false
let smsTimer: ReturnType<typeof setInterval> | null = null

function authToken(): string | null {
  return session.getToken()
}

function isStale(gen: number, token: string | null): boolean {
  return unmounted || gen !== generation || token !== authToken()
}

/**
 * A factor is usable only when *both* flags are known: an `unknown` flag means we cannot tell
 * which factor the server will require, so `password_update` would be rejected. Never weaken
 * verification by guessing.
 */
const factorsKnown = computed(() => props.googleFactor !== 'unknown' && props.smsFactor !== 'unknown')
/** Legacy alert path: no enabled factor means the password form must stay unusable. */
const anyFactorEnabled = computed(
  () => props.googleFactor === 'enabled' || props.smsFactor === 'enabled',
)
const factorsUsable = computed(() => factorsKnown.value && anyFactorEnabled.value)
const googleRequired = computed(() => props.googleFactor === 'enabled')
const smsRequired = computed(() => props.smsFactor === 'enabled')

const passwordsMatch = computed(() => repeat.value !== '' && next.value === repeat.value)

/** Single source of truth shared by the button state and the `submit()` guard. */
function validate(): string {
  if (!factorsKnown.value) {
    return t('security.password.factorUnknown')
  }
  if (!anyFactorEnabled.value) {
    return t('security.password.factorRequired')
  }
  if (current.value === '') {
    return t('security.password.currentError')
  }
  if (!isValidPassword(next.value)) {
    return t('security.password.ruleError')
  }
  if (!passwordsMatch.value) {
    return t('security.password.mismatch')
  }
  if (next.value === current.value) {
    return t('security.password.sameAsCurrent')
  }
  if (googleRequired.value && !isValidVerificationCode(googleCode.value)) {
    return t('security.password.codeError')
  }
  if (smsRequired.value && !isValidVerificationCode(smsCode.value)) {
    return t('security.password.codeError')
  }
  return ''
}

const canSubmit = computed(() => !submitting.value && validate() === '')

function clearSensitive(): void {
  current.value = ''
  next.value = ''
  repeat.value = ''
  googleCode.value = ''
  smsCode.value = ''
  error.value = ''
  notice.value = ''
}

function clearCodes(): void {
  googleCode.value = ''
  smsCode.value = ''
}

function stopSmsTimer(): void {
  if (smsTimer !== null) {
    clearInterval(smsTimer)
    smsTimer = null
  }
  smsCooldown.value = 0
}

function startSmsCooldown(): void {
  stopSmsTimer()
  smsCooldown.value = SMS_COOLDOWN_SECONDS
  smsTimer = setInterval(() => {
    if (smsCooldown.value <= 1) {
      stopSmsTimer()
    } else {
      smsCooldown.value -= 1
    }
  }, 1000)
}

function closeForm(): void {
  open.value = false
  generation += 1
  submitting.value = false
  sendingSms.value = false
  stopSmsTimer()
  clearSensitive()
}

function describe(cause: unknown): string {
  if (isApiError(cause)) {
    return translateSecurityMessage(t, cause.message)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

/** Renders a real error without echoing a submitted password or OTP. */
function fail(cause: unknown): void {
  const values = [current.value, next.value, repeat.value, googleCode.value, smsCode.value]
  const message = redactSensitive(describe(cause), values)
  clearCodes()
  error.value = message
}

async function sendSms(): Promise<void> {
  // One pending request at a time, and no re-send until the legacy 60s cooldown elapses.
  if (sendingSms.value || smsCooldown.value > 0) {
    return
  }
  const gen = generation
  const token = authToken()
  sendingSms.value = true
  error.value = ''
  notice.value = ''
  try {
    // `operationType: 5` is the legacy password-change code (`ChangePassword.js#getCodeClick`).
    await requestSecuritySmsCode(5)
    if (isStale(gen, token)) {
      return
    }
    notice.value = t('security.password.codeSent')
    startSmsCooldown()
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    fail(cause)
  } finally {
    if (gen === generation) {
      sendingSms.value = false
    }
  }
}

async function submit(): Promise<void> {
  // Guarded here, not only on the button: form Enter / repeated submits cannot duplicate the
  // request or bypass the factor gate.
  if (submitting.value) {
    return
  }
  const validation = validate()
  if (validation !== '') {
    error.value = validation
    return
  }
  const gen = generation
  const token = authToken()
  submitting.value = true
  error.value = ''
  notice.value = ''
  try {
    await updatePassword({
      loginPword: current.value,
      newLoginPword: next.value,
      ...(smsRequired.value ? { smsAuthCode: smsCode.value.trim() } : {}),
      ...(googleRequired.value ? { googleCode: googleCode.value.trim() } : {}),
    })
    if (isStale(gen, token)) {
      return
    }
    // Clear drafts before the parent refreshes status and enforces the server-side logout.
    closeForm()
    emit('changed')
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    fail(cause)
  } finally {
    if (gen === generation) {
      submitting.value = false
    }
  }
}

let lastToken = session.getToken()
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = session.onInvalidate((snapshot) => {
    if (snapshot.token !== lastToken) {
      lastToken = snapshot.token
      closeForm()
    }
  })
})

onBeforeUnmount(() => {
  unmounted = true
  clearSensitive()
  stopSmsTimer()
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <SecurityRow :label="t('security.password.section')" :description="t('security.password.description')" layout="stacked">
    <template #icon><Lock :size="18" /></template>
    <template #action>
      <button v-if="factorsUsable && !open" class="btn" type="button" @click="open = true">
        {{ t('security.password.action') }}
      </button>
      <button v-else-if="open" class="btn btn-ghost" type="button" :disabled="submitting" @click="closeForm">
        {{ t('security.close') }}
      </button>
    </template>

    <template #body>
      <p v-if="!factorsKnown" class="notice">
        {{ t('security.password.blocked') }} {{ t('security.password.factorUnknown') }}
      </p>
      <p v-else-if="!anyFactorEnabled" class="notice">
        {{ t('security.password.blocked') }} {{ t('security.password.factorRequired') }}
      </p>

      <form v-else-if="open" class="password-form stack" @submit.prevent="submit">
        <div class="field">
          <label class="field-label" for="password-current">{{ t('security.password.current') }}</label>
          <div class="field-input">
            <input
              id="password-current"
              v-model="current"
              type="password"
              autocomplete="current-password"
              :aria-label="t('security.password.current')"
            />
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="password-next">{{ t('security.password.next') }}</label>
          <div class="field-input">
            <input
              id="password-next"
              v-model="next"
              type="password"
              autocomplete="new-password"
              :aria-label="t('security.password.next')"
            />
          </div>
          <p class="field-hint">{{ t('security.password.rule') }}</p>
        </div>
        <div class="field">
          <label class="field-label" for="password-repeat">{{ t('security.password.repeat') }}</label>
          <div class="field-input" :class="{ invalid: repeat !== '' && !passwordsMatch }">
            <input
              id="password-repeat"
              v-model="repeat"
              type="password"
              autocomplete="new-password"
              :aria-label="t('security.password.repeat')"
            />
          </div>
          <p v-if="repeat !== '' && !passwordsMatch" class="field-error">{{ t('security.password.mismatch') }}</p>
        </div>

        <div v-if="googleRequired" class="field">
          <label class="field-label" for="password-google">{{ t('security.password.googleCode') }}</label>
          <div class="field-input">
            <input
              id="password-google"
              v-model="googleCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              :aria-label="t('security.password.googleCode')"
            />
          </div>
        </div>

        <div v-if="smsRequired" class="field">
          <label class="field-label" for="password-sms">{{ t('security.password.smsCode') }}</label>
          <div class="field-input">
            <input
              id="password-sms"
              v-model="smsCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              :aria-label="t('security.password.smsCode')"
            />
            <button
              class="btn btn-ghost"
              type="button"
              :disabled="sendingSms || smsCooldown > 0"
              @click="sendSms"
            >
              {{
                sendingSms
                  ? t('security.password.sending')
                  : smsCooldown > 0
                    ? t('security.password.resendIn', { seconds: smsCooldown })
                    : t('security.password.sendCode')
              }}
            </button>
          </div>
        </div>

        <p v-if="notice !== ''" class="notice notice-info">{{ notice }}</p>
        <p v-if="error !== ''" class="notice notice-error wrap-anywhere">{{ error }}</p>

        <button class="btn btn-primary submit" type="submit" :disabled="submitting">
          {{ submitting ? t('security.password.submitting') : t('security.password.submit') }}
        </button>
      </form>
    </template>
  </SecurityRow>
</template>

<style scoped>
.password-form {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
  max-width: 420px;
  gap: var(--space-3);
}

.submit {
  align-self: flex-start;
  min-width: 140px;
}
</style>
