<script setup lang="ts">
/** 代理商与邀请返佣, modelled on Binance Referral / Affiliate: share link, earnings summary, apply, referral codes, records. */
import { computed, onMounted, ref, watch } from 'vue'
import { Copy, Users, Wallet, BadgeCheck } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizDialog, { type DialogField } from '@/components/business/ui/BizDialog.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import StatusPill from '@/components/business/ui/StatusPill.vue'
import { useBizContext, useBizQuery } from '@/components/business/ui/useBiz'
import { rowOf, rowsOf, valueAt, type BusinessRow } from '@/modules/business/client'
import { amount, dateOnly, field } from '@/modules/business/format'
import { toastError, toastSuccess } from '@/core/toast'
import { isDecimalString, sum } from '@/modules/finance/decimal'

const A = '/sapi/v1/affiliate'
const { lang, authed, t } = useBizContext()
const overview = useBizQuery(() => (authed.value ? `${A}/overview` : null), () => ({}), '')
const application = useBizQuery(() => (authed.value ? `${A}/application` : null), () => ({}), '')
const codes = useBizQuery(() => (authed.value ? `${A}/codes` : null))
const refreshKey = ref(0)
function reload() { void overview.load(); void application.load(); void codes.load(); refreshKey.value++ }
onMounted(reload)
watch(authed, reload)

const ov = computed<BusinessRow>(() => overview.rows.value[0] ?? rowOf(null))
const isAffiliate = computed(() => valueAt(ov.value, 'affiliate') === true)
const app = computed<BusinessRow | null>(() => application.rows.value[0] ?? null)
const applicationStatus = computed(() => field(app.value ?? {}, 'status').toUpperCase())
const canApply = computed(() => !app.value || ['REJECTED', 'MORE_INFO'].includes(applicationStatus.value))
const totals = computed(() => rowsOf(overview.raw.value, 'totals'))
const usdtTotal = computed(() => sum(totals.value.filter(r => field(r, 'asset') === 'USDT').map(r => field(r, 'amount')).filter(isDecimalString)))
const inviteCode = computed(() => field(ov.value, 'inviteCode'))
const linkFor = (code: string) => `${window.location.origin}/register?inviteCode=${encodeURIComponent(code)}`
const inviteLink = computed(() => (inviteCode.value ? linkFor(inviteCode.value) : ''))
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toastSuccess(t('affiliateUi.copied')) } catch { toastError(t('affiliateUi.copyFailedCopyItManually')) }
}

const dlg = ref<{ title: string; path: string; fields: DialogField[]; notes: string[]; submit: string } | null>(null)
function apply() {
  if (!canApply.value || isAffiliate.value) return
  const previous = app.value ?? {}
  const links = valueAt(previous, 'links')
  const previousLinks = Array.isArray(links) ? links.filter((link): link is string => typeof link === 'string').join(', ') : field(previous, 'links')
  dlg.value = { get title() { return applicationStatus.value === 'MORE_INFO' ? t('affiliateUi.updateAffiliateApplication') : t('affiliateUi.applyToBeAnAffiliate') }, path: `${A}/apply`, get submit() { return t('affiliateUi.submit') },
    fields: [
      { key: 'channelType', get label() { return t('affiliateUi.mainChannel') }, kind: 'select', default: field(previous, 'channelType') || 'community', options: [
        { value: 'community', get label() { return t('affiliateUi.communityTelegramGroups') } }, { value: 'social', get label() { return t('affiliateUi.socialMedia') } },
        { value: 'video', get label() { return t('affiliateUi.video') } }, { value: 'website', get label() { return t('affiliateUi.websiteBlog') } }, { value: 'other', get label() { return t('affiliateUi.other') } }] },
      { key: 'links', get label() { return t('affiliateUi.channelLinks') }, kind: 'text', default: previousLinks, get placeholder() { return t('affiliateUi.separateMultipleLinksWithCommas') } },
      { key: 'followers', get label() { return t('affiliateUi.followersMembers') }, kind: 'text', default: field(previous, 'followers'), placeholder: '1000' },
      { key: 'contact', get label() { return t('affiliateUi.contact') }, kind: 'text', default: field(previous, 'contact'), get placeholder() { return t('affiliateUi.emailOrTelegram') } },
    ],
    get notes() { return [t('affiliateUi.weReviewApplicationsWithin3BusinessDaysCheckThe')] } }
}
function newCode() {
  dlg.value = { get title() { return t('affiliateUi.createReferralCode') }, path: `${A}/codes`, get submit() { return t('affiliateUi.create') },
    fields: [
      { key: 'code', get label() { return t('affiliateUi.customCodeOptional') }, kind: 'text', optional: true, get placeholder() { return t('affiliateUi.value416UppercaseLettersOrDigits') } },
      { key: 'kickbackSpot', get label() { return t('affiliateUi.spotKickbackToFriends') }, kind: 'text', default: '0', get hint() { return t('affiliateUi.value050UpTo2Decimals') } },
      { key: 'kickbackFutures', get label() { return t('affiliateUi.futuresKickbackToFriends') }, kind: 'text', default: '0', get hint() { return t('affiliateUi.value050UpTo2Decimals') } },
      { key: 'label', get label() { return t('affiliateUi.labelOptional') }, kind: 'text', optional: true },
    ],
    get notes() { return [t('affiliateUi.kickbackComesOutOfYourCommissionAndCannotExceed')] } }
}

const recordTabs = computed<RecordTab[]>(() => [
  { id: 'comm', label: t('affiliateUi.commissions'), path: `${A}/commissions`, paging: true, columns: [
    { key: 'time', label: t('affiliateUi.time'), kind: 'time' }, { key: 'inviteeUid', label: t('affiliateUi.friendUid') },
    { key: 'market', label: t('affiliateUi.market'), map: { spot: t('affiliateUi.spot'), futures: t('affiliateUi.futures') } },
    { key: 'amount', label: t('affiliateUi.commission'), kind: 'amount', unit: 'asset' }, { key: 'paid', label: t('affiliateUi.paid'), kind: 'bool' }] },
  { id: 'inv', label: t('affiliateUi.myFriends'), path: `${A}/invitees`, paging: true, columns: [
    { key: 'registerTime', label: t('affiliateUi.registered'), kind: 'time' }, { key: 'uid', label: 'UID' }, { key: 'account', label: t('affiliateUi.account') }] },
  { id: 'daily', label: t('affiliateUi.daily'), path: `${A}/stats/daily`, columns: [
    { key: 'date', label: t('affiliateUi.date'), kind: 'date' }, { key: 'newInvitees', label: t('affiliateUi.newFriends') }, { key: 'traders', label: t('affiliateUi.traders') },
    { key: 'commissionUsdt', label: t('affiliateUi.commissionUsdt'), kind: 'amount' }] },
  { id: 'kick', label: t('affiliateUi.kickbackReceived'), path: '/sapi/v1/referral/kickback', paging: true, columns: [
    { key: 'time', label: t('affiliateUi.time'), kind: 'time' }, { key: 'amount', label: t('affiliateUi.amount'), kind: 'amount', unit: 'asset' }, { key: 'paid', label: t('affiliateUi.paid'), kind: 'bool' }] },
])
</script>

<template>
  <BizPage :eyebrow="t('affiliateUi.referral')" :title="t('affiliateUi.inviteFriendsEarnTogether')"
    :subtitle="t('affiliateUi.earnAShareOfTheTradingFeesOfFriends')">
    <template v-if="authed" #stats>
      <BizStat :label="t('affiliateUi.friendsInvited')" :value="field(ov, 'invitees') || '0'" />
      <BizStat :label="t('affiliateUi.totalEarnedUsdt')" :value="usdtTotal ? amount(usdtTotal, 4) : '0'" tone="up" />
      <BizStat :label="t('affiliateUi.spotFuturesRate')" :value="`${field(ov, 'spotRate') || '0'}% / ${field(ov, 'futuresRate') || '0'}%`" />
    </template>
    <template v-if="authed" #aside>
      <div class="biz-aside-card">
        <h3>{{ t('affiliateUi.myReferralLink') }}</h3>
        <template v-if="inviteCode">
          <div class="af-copy"><span class="biz-muted">{{ t('affiliateUi.code') }}</span><b class="num">{{ inviteCode }}</b><button class="btn btn-ghost" type="button" :aria-label="t('affiliateUi.copyCode')" @click="copy(inviteCode)"><Copy :size="14" /></button></div>
          <div class="af-copy"><span class="af-link num">{{ inviteLink }}</span><button class="btn btn-primary" type="button" @click="copy(inviteLink)">{{ t('affiliateUi.copyLink') }}</button></div>
        </template>
        <p v-else class="biz-muted af-small">{{ t('affiliateUi.noReferralCodeYet') }}</p>
      </div>
    </template>

    <GuestGate v-if="!authed" :message="t('affiliateUi.logInToGetYourReferralLink')" />
    <template v-else>
      <section class="af-steps">
        <div class="biz-card af-step"><Copy :size="20" /><b>{{ t('affiliateUi.shareYourLink') }}</b><span class="biz-muted">{{ t('affiliateUi.sendYourLinkOrCodeToFriends') }}</span></div>
        <div class="biz-card af-step"><Users :size="20" /><b>{{ t('affiliateUi.friendsSignUpAndTrade') }}</b><span class="biz-muted">{{ t('affiliateUi.theyRegisterWithYourCodeAndTrade') }}</span></div>
        <div class="biz-card af-step"><Wallet :size="20" /><b>{{ t('affiliateUi.earnCommission') }}</b><span class="biz-muted">{{ t('affiliateUi.commissionSettlesDailyToYourSpotAccount') }}</span></div>
      </section>

      <section class="biz-card">
        <header class="biz-card-head">
          <h2><BadgeCheck :size="18" class="af-badge" /> {{ isAffiliate ? t('affiliateUi.affiliate', { fieldovtier: field(ov, 'tier') || '-' }) : t('affiliateUi.affiliateProgram') }}</h2>
          <button v-if="isAffiliate" class="btn btn-primary" type="button" @click="newCode">{{ t('affiliateUi.newCode') }}</button>
          <button v-else-if="canApply" class="btn btn-primary" type="button" @click="apply">{{ applicationStatus === 'MORE_INFO' ? t('affiliateUi.updateAndResubmit') : t('affiliateUi.applyNow') }}</button>
        </header>
        <div v-if="!isAffiliate" class="biz-card-body af-apply">
          <p class="biz-muted">{{ t('affiliateUi.runACommunityChannelOrWebsiteAffiliatesEarnUp') }}</p>
          <div v-if="app" class="af-app"><span>{{ t('affiliateUi.application') }}</span><StatusPill :code="field(app, 'status')" :lang="lang" /><span class="biz-muted">{{ dateOnly(field(app, 'time')) }}</span>
            <span v-if="field(app, 'remark')" class="biz-muted">· {{ field(app, 'remark') }}</span></div>
        </div>
        <table v-else-if="codes.rows.value.length" class="table af-table table-cards">
          <thead><tr><th class="left">{{ t('affiliateUi.code2') }}</th><th class="left">{{ t('affiliateUi.label') }}</th><th>{{ t('affiliateUi.spotKickback') }}</th><th>{{ t('affiliateUi.futuresKickback') }}</th><th>{{ t('affiliateUi.friends') }}</th><th>{{ t('affiliateUi.status') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in codes.rows.value" :key="field(c, 'code')">
              <td class="left num card-title" data-label=""><b>{{ field(c, 'code') }}</b></td><td class="left" :data-label="t('affiliateUi.label')">{{ field(c, 'label') || '—' }}</td>
              <td class="num" :data-label="t('affiliateUi.spotKickback')">{{ field(c, 'kickbackSpot') || '0' }}%</td><td class="num" :data-label="t('affiliateUi.futuresKickback')">{{ field(c, 'kickbackFutures') || '0' }}%</td>
              <td class="num" :data-label="t('affiliateUi.friends')">{{ field(c, 'invitees') || '0' }}</td>
              <td :data-label="t('affiliateUi.status')">{{ valueAt(c, 'enabled') === true ? t('affiliateUi.enabled') : t('affiliateUi.disabled') }}</td>
              <td class="af-act" data-label=""><button :disabled="valueAt(c, 'enabled') !== true" class="btn btn-ghost" type="button" @click="copy(linkFor(field(c, 'code')))">{{ t('affiliateUi.copyLink') }}</button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="biz-empty">{{ t('affiliateUi.noCodesYetCreateOneToStart') }}</p>
      </section>

      <BizRecords :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />
    </template>
    <BizDialog v-if="dlg" :open="true" :lang="lang" :title="dlg.title" :path="dlg.path" :fields="dlg.fields" :notes="dlg.notes" :submit-text="dlg.submit"
      @close="dlg = null" @done="reload" />
  </BizPage>
</template>

<style scoped>
.af-copy { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius); background: var(--color-surface-alt); font-size: var(--font-size-sm); }
.af-copy b { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.af-link { white-space: nowrap; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.af-small { margin: 0; font-size: var(--font-size-sm); }
.af-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.af-step { display: grid; gap: 6px; padding: 18px 20px; color: var(--color-accent-text); }
.af-step b { color: var(--color-text); font-size: var(--font-size-md); }
.af-step span { font-size: var(--font-size-sm); }
.af-badge { vertical-align: -3px; color: var(--color-accent); }
.af-apply p { margin: 0 0 12px; line-height: 1.6; font-size: var(--font-size-sm); }
.af-app { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--font-size-sm); }
.af-table { table-layout: auto; }
.af-table th:first-child, .af-table td:first-child { padding-left: 20px; }
.af-table .left { text-align: left; }
@media (max-width: 860px) { .af-steps { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .af-table td.af-act { justify-content: flex-end; } }
</style>
