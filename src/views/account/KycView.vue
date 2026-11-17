<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { BadgeCheck, Clock3, IdCard, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion, XCircle } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import PageHead from '@/components/content/PageHead.vue'
import KycForm from '@/components/kyc/KycForm.vue'
import { countryFromDialCode, kycStage, maskName, type KycStage } from '@/modules/kyc/kyc-form'
import { readKycMode } from '@/modules/kyc/kyc.api'
import { useKycI18n } from '@/modules/kyc/i18n'
import { session } from '@/core/session'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

/**
 * Identity verification. Status is `common/user_info.authLevel` + `notPassReason`
 * (`PublicAct.java:1537,1559-1567`); the form submits `user/v4/auth_realname` with photo keys from
 * `common/upload_img` (see `modules/kyc/kyc.api.ts`). Pending reviews are not resubmitted from here
 * because the server would silently reset the review.
 */
const { t } = useKycI18n()
const sessionStore = useSessionStore()
const market = useMarketStore()

const loading = ref(false)
const formOpen = ref(false)
const justSubmitted = ref(false)
let unmounted = false

const authenticated = computed(() => sessionStore.isAuthenticated)
const user = computed(() => sessionStore.user)
const stage = computed<KycStage>(() => (user.value === null ? 'unknown' : kycStage(user.value.authLevel)))
const reason = computed(() => {
  const raw = user.value?.notPassReason
  return typeof raw === 'string' ? raw.trim() : ''
})
const realName = computed(() => (typeof user.value?.realName === 'string' ? maskName(user.value.realName) : ''))
const defaultIso = computed(() => {
  const fromUser = countryFromDialCode(user.value?.countryCode)
  const fromPublic = countryFromDialCode(market.publicInfo?.msg?.default_country_code)
  return fromUser?.[0] ?? fromPublic?.[0] ?? ''
})
const switches = computed(() => market.publicInfo?.switch ?? {})
const mode = computed(() => readKycMode(switches.value.nameVerifiedType))
const uploadBase = computed(() => (String(switches.value.is_open_upload_img ?? '') === '1' ? '/fe-upload-api/' : undefined))
const showForm = computed(() => stage.value === 'unverified' || (stage.value === 'rejected' && formOpen.value))

const stageMeta = computed(() => {
  switch (stage.value) {
    case 'approved': return { icon: BadgeCheck, tone: 'ok' }
    case 'pending': return { icon: Clock3, tone: 'wait' }
    case 'rejected': return { icon: XCircle, tone: 'bad' }
    case 'unverified': return { icon: ShieldAlert, tone: 'idle' }
    default: return { icon: ShieldQuestion, tone: 'idle' }
  }
})

async function refresh(): Promise<void> {
  if (!authenticated.value) return
  const token = session.getToken()
  loading.value = true
  try {
    await sessionStore.loadUserInfo()
  } finally {
    if (!unmounted && session.getToken() === token) loading.value = false
  }
}

async function onSubmitted(): Promise<void> {
  justSubmitted.value = true
  formOpen.value = false
  await refresh()
}

watch(authenticated, (value) => {
  formOpen.value = false
  justSubmitted.value = false
  if (value) void refresh()
}, { immediate: true })
if (market.publicInfo === null) void market.loadPublicInfo().catch(() => undefined)
onBeforeUnmount(() => { unmounted = true })
</script>

<template>
  <div class="page kyc-page">
    <PageHead :icon="IdCard" :eyebrow="t('kyc.eyebrow')" :title="t('kyc.title')" :lead="t('kyc.lead')">
      <button v-if="authenticated" class="btn btn-ghost" type="button" :disabled="loading" @click="refresh"><RefreshCw :size="15" aria-hidden="true" />{{ t('kyc.refresh') }}</button>
    </PageHead>

    <GuestGate v-if="!authenticated" :message="t('kyc.loginRequired')" :icon="IdCard" />

    <template v-else>
      <p v-if="sessionStore.error" class="notice notice-error wrap-anywhere">{{ sessionStore.error }}</p>

      <div v-if="loading && user === null" class="panel status-card sk"><span></span><span></span></div>
      <section v-else class="panel status-card" :class="stageMeta.tone">
        <span class="status-icon"><component :is="stageMeta.icon" :size="26" aria-hidden="true" /></span>
        <div class="status-copy">
          <span class="status-chip">{{ t(`kyc.stage.${stage}`) }}</span>
          <template v-if="stage === 'approved'">
            <h2>{{ t('kyc.approvedTitle') }}</h2>
            <p>{{ t('kyc.approvedBody') }}</p>
            <p v-if="realName !== ''" class="kv"><span>{{ t('kyc.verifiedName') }}</span><strong>{{ realName }}</strong></p>
          </template>
          <template v-else-if="stage === 'pending'">
            <h2>{{ t('kyc.pendingTitle') }}</h2>
            <p>{{ justSubmitted ? t('kyc.submitted') : t('kyc.pendingBody') }}</p>
          </template>
          <template v-else-if="stage === 'rejected'">
            <h2>{{ t('kyc.rejectedTitle') }}</h2>
            <p class="reason wrap-anywhere">{{ reason !== '' ? t('kyc.rejectedReason', { reason }) : t('kyc.noReason') }}</p>
          </template>
          <template v-else-if="stage === 'unverified'">
            <h2>{{ t('kyc.start') }}</h2>
            <p>{{ t('kyc.lead') }}</p>
          </template>
          <template v-else>
            <h2>{{ t('kyc.stage.unknown') }}</h2>
            <p>{{ t('kyc.unknownBody') }}</p>
          </template>
        </div>
        <button v-if="stage === 'rejected' && !formOpen" class="btn btn-primary" type="button" @click="formOpen = true">{{ t('kyc.resubmit') }}</button>
      </section>

      <p v-if="showForm && (mode === 'faceplusplus' || mode === 'yushan')" class="notice notice-info">{{ t('kyc.modeAuto', { mode: mode === 'faceplusplus' ? 'Face++' : 'Yushan' }) }}</p>
      <p v-else-if="showForm && mode === 'none'" class="notice">{{ t('kyc.modeNone') }}</p>

      <div v-if="showForm" class="form-wrap">
        <KycForm :key="defaultIso" :default-country-iso="defaultIso" :upload-base="uploadBase" @submitted="onSubmitted" />
        <aside class="tips panel">
          <ShieldCheck :size="20" aria-hidden="true" />
          <ul>
            <li>{{ t('kyc.photos.firstPhotoHint') }}</li>
            <li>{{ t('kyc.photos.thirdPhotoHint') }}</li>
            <li>{{ t('kyc.uploadRule') }}</li>
            <li>{{ t('kyc.privacy') }}</li>
          </ul>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kyc-page { max-width: 1120px; }
.status-card { display: flex; align-items: center; gap: 20px; padding: 24px 26px; margin-bottom: 18px; }
.status-icon { display: inline-flex; flex: 0 0 56px; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 16px; background: var(--color-surface-alt); color: var(--color-text-muted); }
.status-card.ok .status-icon { background: var(--color-up-soft); color: var(--color-up); }
.status-card.wait .status-icon { background: var(--color-accent-soft); color: var(--color-accent-text); }
.status-card.bad .status-icon { background: var(--color-down-soft); color: var(--color-down); }
.status-copy { flex: 1 1 auto; min-width: 0; }
.status-copy h2 { margin: 6px 0 4px; font-size: 19px; }
.status-copy p { margin: 0; color: var(--color-text-secondary); font-size: 13.5px; line-height: 1.6; }
.status-chip { display: inline-flex; height: 22px; align-items: center; padding: 0 9px; border-radius: 11px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .03em; }
.ok .status-chip { background: var(--color-up-soft); color: var(--color-up); }
.wait .status-chip { background: var(--color-accent-soft); color: var(--color-accent-text); }
.bad .status-chip { background: var(--color-down-soft); color: var(--color-down); }
.reason { color: var(--color-down) !important; }
.kv { display: flex; gap: 10px; margin-top: 8px !important; }
.kv span { color: var(--color-text-muted); }
.sk span { display: block; height: 18px; border-radius: 6px; background: var(--color-surface-alt); }
.sk span:first-child { width: 56px; height: 56px; border-radius: 16px; }
.sk span:last-child { flex: 1; }
.notice { margin: 0 0 16px; }
.form-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 18px; align-items: start; }
.tips { position: sticky; top: calc(var(--header-h) + 24px); padding: 20px; color: var(--color-accent-text); }
.tips ul { margin: 12px 0 0; padding-left: 18px; color: var(--color-text-secondary); font-size: 12.5px; line-height: 1.7; }
.tips li + li { margin-top: 6px; }
@media (max-width: 960px) {
  .form-wrap { grid-template-columns: minmax(0, 1fr); }
  .tips { display: none; }
}
@media (max-width: 640px) {
  .status-card { flex-wrap: wrap; padding: 18px; gap: 14px; }
  .status-icon { flex-basis: 44px; width: 44px; height: 44px; }
  .status-card .btn { width: 100%; }
}
</style>
