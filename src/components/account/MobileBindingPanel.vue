<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Smartphone } from '@lucide/vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import SecurityRow from '@/components/security/SecurityRow.vue'
import {
  SMS_OPERATION,
  bindMobile,
  sendSmsCode,
  updateMobile,
} from '@/modules/api/account-settings.api'
import { translateAccountMessage, useAccountI18n } from '@/modules/account/i18n'
import { isValidDialCode, isValidMobile, maskMobile } from '@/modules/account/account-state'
import {
  isValidVerificationCode,
  redactSensitive,
  type FactorState,
} from '@/modules/security/security-state'
import VerificationCodeField from './VerificationCodeField.vue'

/**
 * Phone binding (no number on file) and rebinding.
 *
 * Server contract (source-first, `UserCenterAct`):
 * - `user/mobile_bind_save` requires `countryCode`, `smsAuthCode`, `mobileNumber`, plus a Google
 *   code when Google verification is enabled.
 * - `user/mobile_update` additionally requires `authenticationCode` — a code sent to the *current*
 *   number (legacy `SmsOperateTypeEnum.UpdateMobileNum = 3`). SMS verification is inherent to the
 *   change (both the old and the new number receive a code), so no separate SMS-factor gate exists.
 *
 * The dial code defaults to the account's `countryCode` from `/common/user_info`; the legacy site
 * offered a country picker, which is a runtime follow-up (see the migration report).
 */
const props = defineProps<{
  /** The currently bound number; empty string means none. */
  currentMobile: string
  /** Dial code from the profile (e.g. `+86`), used only as the field default. */
  countryCode: string
  googleFactor: FactorState
}>()
const emit = defineEmits<{ (event: 'changed'): void }>()
const { t } = useAccountI18n()

const COOLDOWN_SECONDS = 60

type Mode = 'bind' | 'change'
type Slot = 'newMobile' | 'oldMobile'

const open = ref(false)
const mode = ref<Mode>('bind')
const dialCode = ref('')
const newMobile = ref('')
const newMobileCode = ref('')
const oldMobileCode = ref('')
const googleCode = ref('')
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const sending = reactive<Record<Slot, boolean>>({ newMobile: false, oldMobile: false })
const cooldowns = reactive<Record<Slot, number>>({ newMobile: 0, oldMobile: 0 })

let generation = 0
let unmounted = false
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let lastToken = session.getToken()
let unsubscribe: (() => void) | null = null

const hasMobile = computed(() => props.currentMobile.trim() !== '')
const maskedCurrent = computed(() => maskMobile(props.currentMobile))

const googleKnown = computed(() => props.googleFactor !== 'unknown')
const googleRequired = computed(() => props.googleFactor === 'enabled')

function authToken(): string | null {
  return session.getToken()
}

function isStale(gen: number, token: string | null): boolean {
  return unmounted || gen !== generation || token !== authToken()
}

function sensitiveValues(): string[] {
  return [newMobile.value, newMobileCode.value, oldMobileCode.value, googleCode.value]
}

function describe(cause: unknown): string {
  if (isApiError(cause)) {
    return translateAccountMessage(t, cause.message)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function setError(cause: unknown): void {
  error.value = redactSensitive(describe(cause), sensitiveValues())
}

function clearSensitive(): void {
  dialCode.value = props.countryCode.trim()
  newMobile.value = ''
  newMobileCode.value = ''
  oldMobileCode.value = ''
  googleCode.value = ''
  error.value = ''
  notice.value = ''
}

function stopTimer(): void {
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  cooldowns.newMobile = 0
  cooldowns.oldMobile = 0
}

function tick(): void {
  let active = false
  for (const slot of ['newMobile', 'oldMobile'] as Slot[]) {
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
  return t('account.mobile.resendIn', { seconds: cooldowns[slot] })
}

function openForm(next: Mode): void {
  generation += 1
  submitting.value = false
  sending.newMobile = false
  sending.oldMobile = false
  stopTimer()
  clearSensitive()
  mode.value = next
  open.value = true
}

function closeForm(): void {
  generation += 1
  open.value = false
  submitting.value = false
  sending.newMobile = false
  sending.oldMobile = false
  stopTimer()
  clearSensitive()
}

function validate(): string {
  if (!isValidDialCode(dialCode.value)) {
    return t('account.mobile.countryRule')
  }
  if (!isValidMobile(newMobile.value)) {
    return t('account.mobile.mobileRule')
  }
  if (!isValidVerificationCode(newMobileCode.value)) {
    return t('account.mobile.codeRule')
  }
  if (mode.value === 'change' && !isValidVerificationCode(oldMobileCode.value)) {
    return t('account.mobile.codeRule')
  }
  if (!googleKnown.value) {
    return t('account.mobile.factorUnknown')
  }
  if (googleRequired.value && !isValidVerificationCode(googleCode.value)) {
    return t('account.mobile.codeRule')
  }
  return ''
}

const validationMessage = computed(() => (open.value ? validate() : ''))
const canSubmit = computed(() => open.value && !submitting.value && validationMessage.value === '')
/**
 * When a factor state is unknown the server requirement cannot be determined, so the form is not
 * offered instead of showing an operation that must fail.
 */
const formBlocked = computed(() => !googleKnown.value)

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
    notice.value = t('account.mobile.codeSent')
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

function sendNewMobileCode(): void {
  if (!isValidDialCode(dialCode.value) || !isValidMobile(newMobile.value)) {
    error.value = t('account.mobile.mobileRule')
    return
  }
  void dispatch('newMobile', () =>
    sendSmsCode({
      countryCode: dialCode.value.trim(),
      mobile: newMobile.value,
      operationType: SMS_OPERATION.bindMobile,
    }),
  )
}

function sendOldMobileCode(): void {
  void dispatch('oldMobile', () => sendSmsCode({ operationType: SMS_OPERATION.updateMobileOld }))
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
      await bindMobile({
        countryCode: dialCode.value,
        mobileNumber: newMobile.value,
        smsAuthCode: newMobileCode.value,
        googleCode: googleRequired.value ? googleCode.value : undefined,
      })
    } else {
      await updateMobile({
        countryCode: dialCode.value,
        mobileNumber: newMobile.value,
        smsAuthCode: newMobileCode.value,
        authenticationCode: oldMobileCode.value,
        googleCode: googleRequired.value ? googleCode.value : undefined,
      })
    }
    if (isStale(gen, token)) {
      return
    }
    const saved = t('account.mobile.saved')
    closeForm()
    notice.value = saved
    emit('changed')
  } catch (cause) {
    if (isStale(gen, token)) {
      return
    }
    setError(cause)
    newMobileCode.value = ''
    oldMobileCode.value = ''
    googleCode.value = ''
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
      <h2 class="section-title">
        <Smartphone :size="15" aria-hidden="true" />{{ t('account.mobile.title') }}
      </h2>
    </div>

    <SecurityRow :label="t('account.mobile.current')" layout="stacked">
      <template #icon><Smartphone :size="18" /></template>
      <template #value>
        <span class="value wrap-anywhere">{{ hasMobile ? maskedCurrent : t('account.mobile.notBound') }}</span>
      </template>
      <template #action>
        <button
          v-if="!open"
          class="btn"
          type="button"
          @click="openForm(hasMobile ? 'change' : 'bind')"
        >
          <Smartphone :size="14" aria-hidden="true" />
          {{ hasMobile ? t('account.mobile.change') : t('account.mobile.bind') }}
        </button>
        <button v-else class="btn btn-ghost" type="button" @click="closeForm">
          {{ t('account.mobile.cancel') }}
        </button>
      </template>
    </SecurityRow>

    <p v-if="notice !== '' && !open" class="notice notice-info wrap-anywhere">{{ notice }}</p>

    <p v-if="open && formBlocked" class="notice notice-error wrap-anywhere">
      {{ t('account.mobile.factorUnknown') }}
    </p>

    <div v-else-if="open" class="form">
      <p class="form-intro">
        {{ mode === 'bind' ? t('account.mobile.bindIntro') : t('account.mobile.changeIntro') }}
      </p>

      <div class="field">
        <label class="field-label" for="account-mobile-country">{{ t('account.mobile.countryCode') }}</label>
        <div class="field-input">
          <input
            id="account-mobile-country"
            v-model="dialCode"
            type="tel"
            autocomplete="tel-country-code"
            :aria-label="t('account.mobile.countryCode')"
            placeholder="+86"
          />
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="account-mobile-new">{{ t('account.mobile.newMobile') }}</label>
        <div class="field-input">
          <input
            id="account-mobile-new"
            v-model="newMobile"
            type="tel"
            inputmode="numeric"
            autocomplete="tel"
            :aria-label="t('account.mobile.newMobile')"
          />
        </div>
      </div>

      <VerificationCodeField
        v-if="mode === 'change'"
        id="account-mobile-old-code"
        v-model="oldMobileCode"
        :label="t('account.mobile.oldMobileCode')"
        :send-label="t('account.mobile.sendCode')"
        :sending-label="t('account.mobile.sending')"
        :resend-label="resendLabel('oldMobile')"
        :sending="sending.oldMobile"
        :cooldown="cooldowns.oldMobile"
        @send="sendOldMobileCode"
      />

      <VerificationCodeField
        id="account-mobile-new-code"
        v-model="newMobileCode"
        :label="t('account.mobile.newMobileCode')"
        :send-label="t('account.mobile.sendCode')"
        :sending-label="t('account.mobile.sending')"
        :resend-label="resendLabel('newMobile')"
        :sending="sending.newMobile"
        :cooldown="cooldowns.newMobile"
        @send="sendNewMobileCode"
      />

      <div v-if="googleRequired" class="field">
        <label class="field-label" for="account-mobile-google">{{ t('account.mobile.googleCode') }}</label>
        <div class="field-input">
          <input
            id="account-mobile-google"
            v-model="googleCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            :aria-label="t('account.mobile.googleCode')"
          />
        </div>
      </div>

      <p v-if="error !== ''" class="notice notice-error wrap-anywhere">{{ error }}</p>
      <p v-else-if="notice !== ''" class="notice notice-info wrap-anywhere">{{ notice }}</p>

      <div class="actions">
        <button class="btn btn-primary" type="button" :disabled="!open || submitting" @click="submit">
          {{
            submitting
              ? t('account.mobile.submitting')
              : mode === 'bind'
                ? t('account.mobile.submitBind')
                : t('account.mobile.submitChange')
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
