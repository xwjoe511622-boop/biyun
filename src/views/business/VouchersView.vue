<script setup lang="ts">
/** 卡券中心 (Vouchers), modelled on Binance Reward Center: coupon cards grouped by availability, redeem / abandon. */
import { computed, onMounted, ref, watch } from 'vue'
import { Gift, Percent, Ticket } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizDialog, { type SummaryLine } from '@/components/business/ui/BizDialog.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import StatusPill from '@/components/business/ui/StatusPill.vue'
import { useBizContext, useBizQuery, useNow } from '@/components/business/ui/useBiz'
import { type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { amount, countdown, dateTime, epochMs, field, positive } from '@/modules/business/format'

const { lang, authed, t } = useBizContext()
const now = useNow()
const list = useBizQuery(() => (authed.value ? '/sapi/v1/voucher/list' : null), () => ({ current: '1', size: '100' }))
const refreshKey = ref(0)
function reload() { void list.load(); refreshKey.value++ }
onMounted(reload)
watch(authed, reload)

const ACTIVE = ['ISSUED', 'REDEEMED', 'ACTIVE']
const tab = ref<'active' | 'history'>('active')
const shown = computed(() => list.rows.value.filter(r => (tab.value === 'active') === ACTIVE.includes(field(r, 'status'))))
const readyCount = computed(() => list.rows.value.filter(r => field(r, 'status') === 'ISSUED').length)

function kind(r: BusinessRow) {
  const type = field(r, 'type')
  if (type === 'futures_bonus') return { label: t('vouchersUi.futuresBonus'), icon: Gift }
  if (type.includes('rebate')) return { label: t('vouchersUi.feeRebate'), icon: Percent }
  return { label: t('vouchersUi.tokenVoucher'), icon: Ticket }
}
function usage(r: BusinessRow) {
  const type = field(r, 'type')
  if (type === 'futures_bonus') return t('vouchersUi.useAsFuturesMarginAfterRedemptionProfitsAreYours')
  if (type.includes('rebate')) return t('vouchersUi.afterRedemptionTradingFeesAreRebatedUntilTheAllowance')
  return t('vouchersUi.tokensAreCreditedToYourSpotAccountAfterRedemption')
}

const dlg = ref<{ title: string; path: string; fixed: BusinessParams; summary: SummaryLine[]; notes: string[]; agree?: string; submit: string; danger?: boolean } | null>(null)
function redeem(r: BusinessRow) {
  dlg.value = { get title() { return t('vouchersUi.redeemVoucher') }, path: '/sapi/v1/voucher/redeem', fixed: { voucherId: field(r, 'voucherId') },
    summary: [{ label: field(r, 'name') || kind(r).label, value: `${amount(field(r, 'amount'))} ${field(r, 'asset')}`, tone: 'accent' }, { get label() { return t('vouchersUi.expires') }, value: dateTime(field(r, 'expireTime')) }],
    notes: [usage(r)], get agree() { return t('vouchersUi.iHaveReadTheVoucherTerms') }, get submit() { return t('vouchersUi.redeem') } }
}
function abandon(r: BusinessRow) {
  dlg.value = { get title() { return t('vouchersUi.abandonBonus') }, path: '/sapi/v1/voucher/abandon', fixed: { voucherId: field(r, 'voucherId') },
    summary: [{ get label() { return t('vouchersUi.remaining') }, value: `${amount(field(r, 'remaining'))} ${field(r, 'asset')}` }],
    get notes() { return [t('vouchersUi.theRemainingBonusWillBeReclaimedThisCannotBe')] }, danger: true,
    get agree() { return t('vouchersUi.iConfirmIWantToAbandonThisBonus') }, get submit() { return t('vouchersUi.abandon') } }
}

const recordTabs = computed<RecordTab[]>(() => [
  { id: 'rebates', label: t('vouchersUi.feeRebates'), path: '/sapi/v1/voucher/rebates', paging: true, columns: [
    { key: 'time', label: t('vouchersUi.time'), kind: 'time' }, { key: 'market', label: t('vouchersUi.market'), map: { spot: t('vouchersUi.spot'), futures: t('vouchersUi.futures') } },
    { key: 'fee', label: t('vouchersUi.fee'), kind: 'amount', unit: 'asset' }, { key: 'rebate', label: t('vouchersUi.rebate'), kind: 'amount', unit: 'asset' }, { key: 'status', label: t('vouchersUi.status'), kind: 'status' }] },
  { id: 'reclaims', label: t('vouchersUi.bonusReclaims'), path: '/sapi/v1/voucher/bonus', rowsPath: 'reclaims', columns: [
    { key: 'time', label: t('vouchersUi.time'), kind: 'time' }, { key: 'reason', label: t('vouchersUi.reason'), map: { expired: t('vouchersUi.expired'), abandoned: t('vouchersUi.abandoned'), no_trade: t('vouchersUi.noTrading') } },
    { key: 'reclaimed', label: t('vouchersUi.reclaimed'), kind: 'amount' }, { key: 'status', label: t('vouchersUi.status'), kind: 'status' }] },
])
</script>

<template>
  <BizPage :eyebrow="t('vouchersUi.rewardCenter')" :title="t('vouchersUi.myVouchersBonuses')"
    :subtitle="t('vouchersUi.futuresBonusesFeeRebatesAndOtherRewardsLiveHere')">
    <template v-if="authed" #stats>
      <BizStat :label="t('vouchersUi.readyToRedeem')" :value="String(readyCount)" tone="accent" />
      <BizStat :label="t('vouchersUi.allVouchers')" :value="String(list.rows.value.length)" />
    </template>

    <GuestGate v-if="!authed" :message="t('vouchersUi.logInToViewYourVouchers')" />
    <template v-else>
      <section class="biz-card">
        <header class="biz-card-head">
          <nav class="tabs"><button class="tab" :class="{ active: tab === 'active' }" type="button" @click="tab = 'active'">{{ t('vouchersUi.available') }}</button>
            <button class="tab" :class="{ active: tab === 'history' }" type="button" @click="tab = 'history'">{{ t('vouchersUi.usedExpired') }}</button></nav>
        </header>
        <div v-if="shown.length" class="vc-grid">
          <article v-for="r in shown" :key="field(r, 'voucherId')" class="vc" :class="{ dim: tab === 'history' }">
            <div class="vc-left">
              <strong class="num">{{ amount(field(r, 'amount')) }}</strong><span>{{ field(r, 'asset') }}</span>
            </div>
            <div class="vc-right">
              <div class="vc-title"><component :is="kind(r).icon" :size="15" /> <b>{{ field(r, 'name') || kind(r).label }}</b></div>
              <p class="biz-muted">{{ kind(r).label }}<template v-if="positive(field(r, 'remaining')) && field(r, 'status') !== 'ISSUED'"> · {{ t('vouchersUi.left') }} {{ amount(field(r, 'remaining')) }}</template></p>
              <p class="vc-exp biz-muted">
                <template v-if="field(r, 'status') === 'ISSUED' && countdown(epochMs(field(r, 'claimDeadline')), now, lang)">{{ t('vouchersUi.redeemBy') }} {{ dateTime(field(r, 'claimDeadline')) }}</template>
                <template v-else>{{ t('vouchersUi.validUntil') }} {{ dateTime(field(r, 'expireTime')) }}</template>
              </p>
              <div class="vc-foot">
                <StatusPill :code="field(r, 'status')" :lang="lang" />
                <button v-if="field(r, 'status') === 'ISSUED'" class="btn btn-primary" type="button" @click="redeem(r)">{{ t('vouchersUi.redeem2') }}</button>
                <button v-else-if="field(r, 'type') === 'futures_bonus' && field(r, 'status') === 'REDEEMED'" class="btn btn-ghost" type="button" @click="abandon(r)">{{ t('vouchersUi.abandon2') }}</button>
              </div>
            </div>
          </article>
        </div>
        <p v-else class="biz-empty" :class="{ err: list.error.value }">{{ list.loading.value ? t('vouchersUi.loading') : list.error.value || (tab === 'active' ? t('vouchersUi.noVouchersYetJoinCampaignsToEarnRewards') : t('vouchersUi.noRecordsYet')) }}</p>
      </section>
      <BizRecords :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />
    </template>
    <BizDialog v-if="dlg" :open="true" :lang="lang" :title="dlg.title" :path="dlg.path" :fixed="dlg.fixed" :fields="[]" :summary="dlg.summary"
      :notes="dlg.notes" :agree="dlg.agree" :submit-text="dlg.submit" :danger="dlg.danger" @close="dlg = null" @done="reload" />
  </BizPage>
</template>

<style scoped>
.vc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; padding: 18px 20px; }
.vc { display: grid; grid-template-columns: 110px minmax(0, 1fr); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; background: var(--color-surface); }
.vc.dim { opacity: 0.6; }
.vc-left { position: relative; display: grid; place-content: center; justify-items: center; gap: 2px; padding: 12px; background: var(--color-accent-soft); color: var(--color-accent-text); border-right: 2px dashed var(--color-border-strong); }
.vc-left strong { font-size: 22px; font-weight: 800; }
.vc-left span { font-size: var(--font-size-xs); font-weight: 650; }
.vc-right { display: grid; gap: 4px; padding: 14px 16px; }
.vc-title { display: flex; align-items: center; gap: 6px; font-size: var(--font-size-md); }
.vc-right p { margin: 0; font-size: var(--font-size-xs); }
.vc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
</style>
