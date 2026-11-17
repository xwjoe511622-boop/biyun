<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CheckCircle2, Circle, KeyRound, UserRound } from '@lucide/vue'
import { fetchOtcProfile, requestFundPasswordSms, setFundPassword, updateNickname, type OtcProfile } from '@/modules/otc/api'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { isValidPassword, readFactorState } from '@/modules/security/security-state'
import { useSessionStore } from '@/stores/session'

/**
 * C2C personal settings: nickname (`user/nickname_update`, UserCenterAct.java:404), fund password
 * (`v4/capital_password/reset`, UserAct.java:593 — SMS op 6 first time / 7 reset, legacy
 * modifySettings.js) and the OTC profile summary (`otc/person_home_page`, PersonalPageAct.java:225).
 */
const { t } = useOtcI18n()
const sessionStore = useSessionStore()

const user = computed(() => sessionStore.user)
const uid = computed(() => (user.value?.id === undefined || user.value?.id === null ? '' : String(user.value.id)))
const currentNickname = computed(() => (typeof user.value?.nickName === 'string' ? user.value.nickName : ''))
const fundSet = computed(() => String(user.value?.isCapitalPwordSet ?? '') === '1')
const fundKnown = computed(() => user.value?.isCapitalPwordSet !== undefined && user.value?.isCapitalPwordSet !== null)
const kycDone = computed(() => sessionStore.authLevel === 1)
const googleOn = computed(() => readFactorState(user.value?.googleStatus) === 'enabled')
const smsOn = computed(() => readFactorState(user.value?.isOpenMobileCheck) === 'enabled')
const showSms = computed(() => smsOn.value || !googleOn.value)

const profile = ref<OtcProfile | null>(null)
const nickname = ref('')
const nickBusy = ref(false)
const nickMsg = ref('')
const nickErr = ref('')

const pwd = ref('')
const pwd2 = ref('')
const sms = ref('')
const google = ref('')
const pwdBusy = ref(false)
const pwdMsg = ref('')
const pwdErr = ref('')
const smsSending = ref(false)
const cooldown = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

const pwdIssue = computed(() => {
  if (pwd.value !== '' && !isValidPassword(pwd.value)) return t('otc.settings.weak')
  if (pwd2.value !== '' && pwd.value !== pwd2.value) return t('otc.settings.mismatch')
  return ''
})
const pwdReady = computed(() => {
  if (!isValidPassword(pwd.value) || pwd.value !== pwd2.value) return false
  if (googleOn.value && !/^\d{6}$/.test(google.value)) return false
  if (showSms.value && !/^\d{6}$/.test(sms.value)) return false
  return !pwdBusy.value
})

async function saveNickname(): Promise<void> {
  const value = nickname.value.trim()
  if (value === '' || nickBusy.value) return
  nickBusy.value = true
  nickMsg.value = ''
  nickErr.value = ''
  try {
    await updateNickname(value)
    nickMsg.value = t('otc.settings.nicknameSaved')
    await sessionStore.loadUserInfo()
  } catch (err) {
    nickErr.value = describeOtcError(t, err)
  } finally {
    nickBusy.value = false
  }
}

async function sendSms(): Promise<void> {
  if (smsSending.value || cooldown.value > 0) return
  smsSending.value = true
  pwdErr.value = ''
  try {
    await requestFundPasswordSms(fundSet.value)
    cooldown.value = 60
    timer = setInterval(() => {
      cooldown.value -= 1
      if (cooldown.value <= 0 && timer !== null) { clearInterval(timer); timer = null }
    }, 1000)
  } catch (err) {
    pwdErr.value = describeOtcError(t, err)
  } finally {
    smsSending.value = false
  }
}

async function savePassword(): Promise<void> {
  if (!pwdReady.value) return
  pwdBusy.value = true
  pwdMsg.value = ''
  pwdErr.value = ''
  try {
    await setFundPassword({
      newCapitalPwd: pwd.value,
      smsAuthCode: showSms.value ? sms.value : undefined,
      googleCode: googleOn.value ? google.value : undefined,
    })
    pwd.value = ''
    pwd2.value = ''
    sms.value = ''
    google.value = ''
    pwdMsg.value = t('otc.settings.passwordSaved')
    await sessionStore.loadUserInfo()
  } catch (err) {
    pwdErr.value = describeOtcError(t, err)
  } finally {
    pwdBusy.value = false
  }
}

watch(currentNickname, (value) => { nickname.value = value }, { immediate: true })
watch(uid, async (value) => {
  profile.value = null
  if (value === '') return
  try {
    profile.value = await fetchOtcProfile(value)
  } catch {
    profile.value = null
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
  pwd.value = ''
  pwd2.value = ''
})
</script>

<template>
  <div class="settings-grid">
    <section class="card">
      <h3 class="card-title">{{ t('otc.settings.requirements') }}</h3>
      <ul class="reqs">
        <li :class="{ ok: currentNickname !== '' }">
          <CheckCircle2 v-if="currentNickname !== ''" :size="17" /><Circle v-else :size="17" />{{ t('otc.settings.reqNickname') }}
        </li>
        <li :class="{ ok: kycDone }">
          <CheckCircle2 v-if="kycDone" :size="17" /><Circle v-else :size="17" />{{ t('otc.settings.reqKyc') }}
          <RouterLink v-if="!kycDone" class="req-link" to="/kyc">{{ t('otc.settings.goKyc') }}</RouterLink>
        </li>
        <li :class="{ ok: fundSet }">
          <CheckCircle2 v-if="fundSet" :size="17" /><Circle v-else :size="17" />{{ t('otc.settings.reqFund') }}
        </li>
      </ul>
      <dl v-if="profile !== null" class="stats">
        <div><dt>{{ t('otc.settings.completeOrders') }}</dt><dd class="num">{{ profile.completeOrders || '--' }}</dd></div>
        <div><dt>{{ t('otc.settings.complaints') }}</dt><dd class="num">{{ profile.complainNum || '--' }}</dd></div>
      </dl>
    </section>

    <section class="card">
      <h3 class="card-title"><UserRound :size="16" />{{ t('otc.settings.nickname') }}</h3>
      <form class="stack-form" @submit.prevent="saveNickname">
        <label class="field">
          <span class="field-label">{{ t('otc.settings.nicknameHint') }}</span>
          <span class="field-input"><input v-model="nickname" maxlength="32" :placeholder="t('otc.settings.nicknamePlaceholder')" /></span>
        </label>
        <p v-if="nickErr !== ''" class="field-error" role="alert">{{ nickErr }}</p>
        <p v-if="nickMsg !== ''" class="ok-note" role="status">{{ nickMsg }}</p>
        <button class="btn btn-primary" type="submit" :disabled="nickBusy || nickname.trim() === '' || nickname.trim() === currentNickname">
          {{ nickBusy ? t('common.loading') : t('otc.settings.saveNickname') }}
        </button>
      </form>
    </section>

    <section class="card wide">
      <h3 class="card-title">
        <KeyRound :size="16" />{{ t('otc.settings.fundPassword') }}
        <span class="chip" :class="{ set: fundSet }">{{ !fundKnown ? t('otc.settings.unknown') : fundSet ? t('otc.settings.fundPasswordSet') : t('otc.settings.fundPasswordUnset') }}</span>
      </h3>
      <p class="field-hint">{{ t('otc.settings.fundPasswordHint') }}</p>
      <form class="pwd-form" @submit.prevent="savePassword">
        <label class="field">
          <span class="field-label">{{ t('otc.settings.newPassword') }}</span>
          <span class="field-input"><input v-model="pwd" type="password" autocomplete="new-password" maxlength="23" /></span>
        </label>
        <label class="field">
          <span class="field-label">{{ t('otc.settings.confirmPassword') }}</span>
          <span class="field-input"><input v-model="pwd2" type="password" autocomplete="new-password" maxlength="23" /></span>
        </label>
        <label v-if="showSms" class="field">
          <span class="field-label">{{ t('otc.paymentMethods.smsCode') }}</span>
          <span class="field-input">
            <input v-model="sms" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
            <button class="code-btn" type="button" :disabled="smsSending || cooldown > 0" @click="sendSms">
              {{ smsSending ? t('otc.paymentMethods.sending') : cooldown > 0 ? t('otc.paymentMethods.resend', { n: cooldown }) : t('otc.paymentMethods.sendCode') }}
            </button>
          </span>
        </label>
        <label v-if="googleOn" class="field">
          <span class="field-label">{{ t('otc.paymentMethods.googleCode') }}</span>
          <span class="field-input"><input v-model="google" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></span>
        </label>
        <p v-if="pwdIssue !== ''" class="field-error full">{{ pwdIssue }}</p>
        <p v-if="pwdErr !== ''" class="notice notice-error full" role="alert">{{ pwdErr }}</p>
        <p v-if="pwdMsg !== ''" class="ok-note full" role="status">{{ pwdMsg }}</p>
        <div class="full">
          <button class="btn btn-primary" type="submit" :disabled="!pwdReady">{{ pwdBusy ? t('common.loading') : t('otc.settings.savePassword') }}</button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.card { display: flex; flex-direction: column; gap: 12px; padding: 18px 20px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-surface-alt); }
.card.wide { grid-column: 1 / -1; }
.card-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 700; }
.card-title svg { color: var(--color-accent-text); }
.card-title .chip { margin-left: 4px; }
.chip.set { border-color: transparent; background: var(--color-up-soft); color: var(--color-up); }
.reqs { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.reqs li { display: flex; align-items: center; gap: 8px; color: var(--color-text-secondary); font-size: 13.5px; }
.reqs li svg { color: var(--color-text-muted); }
.reqs li.ok { color: var(--color-text); }
.reqs li.ok svg { color: var(--color-up); }
.req-link { margin-left: auto; color: var(--color-accent-text); font-weight: 700; font-size: 12.5px; }
.stats { display: flex; gap: 28px; margin: 6px 0 0; padding-top: 12px; border-top: 1px dashed var(--color-border-strong); }
.stats div { display: flex; flex-direction: column; gap: 2px; }
.stats dt { color: var(--color-text-muted); font-size: 12px; }
.stats dd { margin: 0; font-size: 18px; font-weight: 650; }
.stack-form { display: flex; flex-direction: column; gap: 10px; }
.stack-form .btn { align-self: flex-start; }
.pwd-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.full { grid-column: 1 / -1; margin: 0; }
.code-btn { color: var(--color-accent-text); font-size: 12px; font-weight: 700; white-space: nowrap; }
.code-btn:disabled { color: var(--color-text-muted); cursor: not-allowed; }
.ok-note { margin: 0; color: var(--color-up); font-weight: 600; font-size: 13px; }
@media (max-width: 760px) {
  .settings-grid, .pwd-form { grid-template-columns: 1fr; }
}
</style>
