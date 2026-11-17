<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { BadgeCheck, IdCard, Mail, ShieldAlert, ShieldCheck, Smartphone, UserRound } from '@lucide/vue'
import SecurityRow from '@/components/security/SecurityRow.vue'
import TotpEnrollmentPanel from '@/components/security/TotpEnrollmentPanel.vue'
import PasswordChangePanel from '@/components/security/PasswordChangePanel.vue'
import ActivityPanel from '@/components/security/ActivityPanel.vue'
import EmailBindingPanel from '@/components/account/EmailBindingPanel.vue'
import MobileBindingPanel from '@/components/account/MobileBindingPanel.vue'
import ApiKeysPanel from '@/components/account/ApiKeysPanel.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import GuestGate from '@/components/common/GuestGate.vue'
import { translateSecurityMessage, useSecurityI18n } from '@/modules/security/i18n'
import {
  accountStatusKey,
  firstNonEmptyText,
  readFactorState,
  readKycStatus,
  readText,
  type FactorState,
  type KycStatusKey,
} from '@/modules/security/security-state'
import { session } from '@/core/session'
import { useSessionStore } from '@/stores/session'

/**
 * Account-security settings.
 *
 * Sources:
 * - Profile / binding / KYC summary: `/common/user_info` (`PublicAct.userInfo`,
 *   `api-contracts/openapi/pc-exchange-web-api.openapi.yaml`).
 * - TOTP, password change and login/settings activity: legacy PC paths listed in
 *   `src/modules/api/security-settings.api.ts` and `wallet-security.openapi.yaml`.
 *   Runtime verification boundaries are maintained in the migration document.
 * - Email/phone bindings and API keys use the existing user/openapi contracts.
 */
const { t } = useSecurityI18n()
const router = useRouter()
const sessionStore = useSessionStore()
const route = useRoute()
/** 10-19 email-code switch: sent here after a sign-in / sign-up without email code while Google is not bound yet. */
const bindGaRequired = computed(() => route.query.bindGa === '1' && googleFactor.value !== 'enabled')

const loading = ref(false)
let unmounted = false
let refreshGeneration = 0

const user = computed(() => sessionStore.user)
const authenticated = computed(() => sessionStore.isAuthenticated)

const account = computed(() =>
  firstNonEmptyText(
    user.value?.userAccount,
    user.value?.mobileNumber,
    user.value?.email,
    user.value?.nickName,
  ),
)
const userId = computed(() => readText(user.value?.id))
const nickname = computed(() => readText(user.value?.nickName))
const accountStatus = computed(() => {
  const source = readText(user.value?.accountStatus)
  if (!source.known) return t('security.unknownValue')
  const key = accountStatusKey(source.value)
  return key === null ? t('security.unknown') : t(`security.accountStates.${key}`)
})
const email = computed(() => readText(user.value?.email))
const mobile = computed(() => readText(user.value?.mobileNumber))
const kyc = computed(() => readKycStatus(user.value?.authLevel))
const googleFactor = computed<FactorState>(() => readFactorState(user.value?.googleStatus))
const smsFactor = computed<FactorState>(() => readFactorState(user.value?.isOpenMobileCheck))

const sessionError = computed(() =>
  sessionStore.error === null ? '' : translateSecurityMessage(t, sessionStore.error),
)

function fieldValue(source: { known: boolean; value: string }, emptyKey = 'security.unknownValue'): string {
  if (!source.known) return t('security.unknownValue')
  return source.value.trim() !== '' ? source.value : t(emptyKey)
}

function boundLabel(source: { known: boolean; value: string }): string {
  if (!source.known) {
    return t('security.unknown')
  }
  return source.value.trim() !== '' ? t('security.bound') : t('security.notBound')
}

function factorLabel(state: FactorState): string {
  if (state === 'enabled') {
    return t('security.enabled')
  }
  return state === 'disabled' ? t('security.disabled') : t('security.unknown')
}

function kycLabel(key: KycStatusKey): string {
  return t(`security.kyc.${key}`)
}

async function refresh(): Promise<void> {
  if (!authenticated.value) {
    return
  }
  const gen = ++refreshGeneration
  const token = session.getToken()
  loading.value = true
  try {
    await sessionStore.loadUserInfo()
  } finally {
    // Reset the spinner for the latest request, or for any request whose session was replaced
    // (where no newer request may be coming). A superseded request under the same session leaves
    // `loading` to the newer one.
    if (!unmounted && (gen === refreshGeneration || session.getToken() !== token)) {
      loading.value = false
    }
  }
}

/** Enrollment changed a factor: refresh the server status instead of trusting local state. */
async function onTotpEnrolled(): Promise<void> {
  await refresh()
}

/**
 * Password change: refresh status, then run the real server logout and send the user back to
 * sign-in. The legacy client also called `/user/login_out` here; the local session is dropped
 * either way, so a server-side token invalidation cannot leave this page authenticated.
 */
async function onPasswordChanged(): Promise<void> {
  // The server invalidates the session when the password changes. Guard every step with the token
  // that was live when the change completed: a request finishing after a *new* login must never
  // log that new session out.
  const token = session.getToken()
  await refresh()
  if (unmounted) {
    return
  }
  const current = session.getToken()
  if (current !== null && current !== token) {
    // A different session replaced this one; leave it alone and do not navigate.
    return
  }
  if (current === token) {
    await sessionStore.logout()
    if (unmounted || session.getToken() !== null) {
      return
    }
  }
  // `current === null` here means the server already dropped the session during `refresh()`.
  await router.push('/login')
}

onBeforeUnmount(() => {
  unmounted = true
})

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="security-page">
    <header class="page-head">
      <h1 class="page-title">{{ t('security.title') }}</h1>
    </header>

    <GuestGate v-if="!authenticated" :message="t('security.loginRequired')" :icon="ShieldCheck" />

    <template v-else>
      <p v-if="sessionError !== ''" class="notice notice-error wrap-anywhere">{{ sessionError }}</p>
      <p v-if="bindGaRequired" class="notice notice-error wrap-anywhere" data-testid="bind-ga-required">{{ t('security.bindGaRequired') }}</p>

      <section class="settings-section">
        <div class="section-head">
          <h2 class="section-title"><UserRound :size="15" aria-hidden="true" />{{ t('security.sectionProfile') }}</h2>
          <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">
            {{ loading ? t('security.loading') : t('security.refresh') }}
          </button>
        </div>
        <template v-if="loading && user === null">
          <StateBlock variant="loading" :message="t('security.loading')" />
        </template>
        <template v-else>
          <SecurityRow :label="t('security.account')" layout="stacked">
            <template #value><span class="value wrap-anywhere">{{ fieldValue(account) }}</span></template>
          </SecurityRow>
          <SecurityRow :label="t('security.userId')">
            <template #value><span class="value num">{{ fieldValue(userId) }}</span></template>
          </SecurityRow>
          <SecurityRow :label="t('security.nickname')" layout="stacked">
            <template #value><span class="value wrap-anywhere">{{ fieldValue(nickname, 'security.notSet') }}</span></template>
          </SecurityRow>
          <SecurityRow :label="t('security.accountStatus')" layout="stacked">
            <template #value><span class="value wrap-anywhere">{{ accountStatus }}</span></template>
          </SecurityRow>
          <SecurityRow
            :label="t('security.kycTitle')"
          >
            <template #icon><IdCard :size="18" /></template>
            <template #value>
              <span class="chip" :class="kyc.key === 'verified' ? 'enabled' : ''">{{ kycLabel(kyc.key) }}</span>
            </template>
          </SecurityRow>
        </template>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2 class="section-title"><ShieldCheck :size="15" aria-hidden="true" />{{ t('security.sectionBinding') }}</h2>
        </div>
        <SecurityRow :label="t('security.email')" layout="stacked">
          <template #icon><Mail :size="18" /></template>
          <template #value>
            <span v-if="!email.known || email.value.trim() !== ''" class="value wrap-anywhere">{{ fieldValue(email) }}</span>
            <span class="chip">{{ boundLabel(email) }}</span>
          </template>
        </SecurityRow>
        <SecurityRow :label="t('security.mobile')">
          <template #icon><Smartphone :size="18" /></template>
          <template #value>
            <span v-if="!mobile.known || mobile.value.trim() !== ''" class="value wrap-anywhere">{{ fieldValue(mobile) }}</span>
            <span class="chip">{{ boundLabel(mobile) }}</span>
          </template>
        </SecurityRow>
        <SecurityRow :label="t('security.totpTitle')">
          <template #icon><BadgeCheck :size="18" /></template>
          <template #value>
            <span class="chip" :class="googleFactor">{{ factorLabel(googleFactor) }}</span>
          </template>
        </SecurityRow>
        <SecurityRow :label="t('security.smsFactor')">
          <template #icon><Smartphone :size="18" /></template>
          <template #value>
            <span class="chip" :class="smsFactor">{{ factorLabel(smsFactor) }}</span>
          </template>
        </SecurityRow>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <h2 class="section-title"><ShieldAlert :size="15" aria-hidden="true" />{{ t('security.sectionSecurity') }}</h2>
        </div>
        <PasswordChangePanel :google-factor="googleFactor" :sms-factor="smsFactor" @changed="onPasswordChanged" />
        <TotpEnrollmentPanel :factor-state="googleFactor" @enrolled="onTotpEnrolled" />
      </section>

      <section class="settings-section">
        <ActivityPanel :authenticated="authenticated" />
      </section>

      <EmailBindingPanel
        v-if="email.known"
        :current-email="email.value"
        :google-factor="googleFactor"
        :sms-factor="smsFactor"
        @changed="refresh"
      />
      <MobileBindingPanel
        v-if="mobile.known"
        :current-mobile="mobile.value"
        :country-code="readText(user?.countryCode).value"
        :google-factor="googleFactor"
        @changed="refresh"
      />
      <ApiKeysPanel :authenticated="authenticated" :google-factor="googleFactor" :sms-factor="smsFactor" />

    </template>
  </div>
</template>

<style scoped>
.security-page {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 28px 24px 56px;
}

.page-head {
  padding-bottom: 8px;
}

.page-title {
  margin: 0;
  font-size: 30px;
  font-weight: 750;
  line-height: 1.25;
}

.page-sub {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.signed-out {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  max-width: 420px;
  padding-top: 16px;
}

/* Every section (including the binding / API key panels, whose root is also .settings-section) is a card. */
.security-page > .settings-section {
  margin-top: 16px;
  padding: 6px 22px 10px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: var(--color-surface);
}

.security-page :deep(.settings-section > :last-child) { border-bottom: 0; }

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 52px;
  border-bottom: 1px solid var(--color-border);
}

.security-page :deep(.section-title) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text);
}

.security-page :deep(.section-title svg) { color: var(--color-accent-text); }

.value {
  font-size: var(--font-size-sm);
}

.chip.enabled {
  border-color: transparent;
  background: var(--color-up-soft);
  color: var(--color-up);
}

.chip.disabled {
  color: var(--color-text-secondary);
}

.source-note {
  margin: 14px 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

@media (max-width: 640px) {
  .security-page {
    padding: 16px 14px 48px;
  }

  .page-title {
    font-size: 22px;
  }
}
@media (max-width: 720px) { .page-title { display: none; } }
</style>
