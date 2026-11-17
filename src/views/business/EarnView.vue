<script setup lang="ts">
/** 理财 (Simple Earn), modelled on Binance Simple Earn: product list by asset with APR and term, my positions, history. */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Search } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizDialog, { type DialogField, type DialogPreview, type SummaryLine } from '@/components/business/ui/BizDialog.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import StatusPill from '@/components/business/ui/StatusPill.vue'
import { useBizContext, useBizQuery, useSpotBalances } from '@/components/business/ui/useBiz'
import { businessRequest, rowsOf, valueAt, type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { amount, dateOnly, field, percent, positive } from '@/modules/business/format'
import { Decimal, isDecimalString } from '@/modules/finance/decimal'
import { toastError, toastSuccess } from '@/core/toast'

const E = '/sapi/v1/simple-earn'
const { lang, authed, t } = useBizContext()
const spot = useSpotBalances(authed)
const flex = useBizQuery(() => `${E}/flexible/list`, () => ({ current: '1', size: '100' }))
const locked = useBizQuery(() => `${E}/locked/list`, () => ({ current: '1', size: '100' }))
const flexPos = useBizQuery(() => (authed.value ? `${E}/flexible/position` : null), () => ({ current: '1', size: '100' }))
const lockedPos = useBizQuery(() => (authed.value ? `${E}/locked/position` : null), () => ({ current: '1', size: '100' }))
const refreshKey = ref(0)
function reloadAll() { void flex.load(); void locked.load(); void flexPos.load(); void lockedPos.load(); void spot.reload(); refreshKey.value++ }
onMounted(reloadAll)
watch(authed, reloadAll)

interface Product { kind: 'flexible' | 'locked'; id: string; asset: string; apr: string; days: string; min: string; open: boolean; soldOut: boolean; earlyRedeem: boolean; row: BusinessRow }
const products = computed<Product[]>(() => {
  const out: Product[] = []
  for (const r of flex.rows.value) {
    if (field(r, 'status') === 'END') continue
    out.push({ kind: 'flexible', id: field(r, 'productId'), asset: field(r, 'asset'), apr: field(r, 'latestAnnualPercentageRate'), days: '0', min: field(r, 'minPurchaseAmount'),
      open: valueAt(r, 'canPurchase') === true, soldOut: valueAt(r, 'isSoldOut') === true, earlyRedeem: true, row: r })
  }
  for (const r of locked.rows.value) {
    const st = field(r, 'detail.status')
    if (st === 'END') continue
    out.push({ kind: 'locked', id: field(r, 'projectId'), asset: field(r, 'detail.asset'), apr: field(r, 'detail.apr'), days: field(r, 'detail.duration'), min: field(r, 'quota.minimum'),
      open: st === 'PURCHASING' && valueAt(r, 'detail.canPurchase') === true && valueAt(r, 'detail.isSoldOut') !== true, soldOut: valueAt(r, 'detail.isSoldOut') === true, earlyRedeem: valueAt(r, 'detail.earlyRedeemable') === true, row: r })
  }
  return out
})
const termTab = ref<'all' | 'flexible' | 'locked'>('all')
const query = ref('')
const shown = computed(() => products.value
  .filter(p => termTab.value === 'all' || p.kind === termTab.value)
  .filter(p => query.value.trim() === '' || p.asset.toUpperCase().includes(query.value.trim().toUpperCase()))
  .sort((a, b) => a.asset.localeCompare(b.asset) || Number(a.days) - Number(b.days))) // float-ok: term in days (integer)
const bestApr = computed(() => products.value.reduce((best, p) => (isDecimalString(p.apr) && (best === '' || new Decimal(p.apr).gt(best)) ? p.apr : best), ''))
const termLabel = (p: Product) => (p.kind === 'flexible' ? t('earnUi.flexible') : t('earnUi.days', { days: p.days }))

/* ------------------------------------------------------------- dialog */
const dlg = ref<{ title: string; path: string; fixed: BusinessParams; fields: DialogField[]; summary: SummaryLine[]; preview: DialogPreview | null; notes: string[]; agree?: string; agreementKind?: 'earn' | 'loan'; submit: string; danger?: boolean } | null>(null)
const firstRow = (data: BusinessRow) => rowsOf(data, 'rows')[0] ?? data

function subscribe(p: Product) {
  if (!authed.value || !p.open) return
  const isLocked = p.kind === 'locked'
  dlg.value = {
    get title() { return t('earnUi.subscribe', { asset: p.asset, termLabelp: termLabel(p) }) },
    path: `${E}/${p.kind}/subscribe`,
    fixed: isLocked ? { projectId: p.id } : { productId: p.id },
    fields: [{ key: 'amount', get label() { return t('earnUi.amount') }, kind: 'amount', asset: p.asset, available: spot.of(p.asset), min: p.min || null }],
    summary: [
      { get label() { return t('earnUi.estApr') }, value: percent(p.apr), tone: 'up' },
      { get label() { return t('earnUi.term') }, value: termLabel(p) },
      { get label() { return t('earnUi.redemption') }, get value() { return isLocked ? (p.earlyRedeem ? t('earnUi.earlyRedemptionAvailableRewardsClawedBack') : t('earnUi.atMaturity')) : t('earnUi.anytime') } },
    ],
    preview: {
      path: `${E}/${p.kind}/subscriptionPreview`, keys: [isLocked ? 'projectId' : 'productId', 'amount'],
      render: (data) => {
        const r = firstRow(data)
        return isLocked
          ? [{ get label() { return t('earnUi.estTotalReward') }, value: `${amount(field(r, 'totalRewardAmt'))} ${field(r, 'rewardAsset') || p.asset}`, tone: 'up' as const },
              { get label() { return t('earnUi.valueDate') }, value: dateOnly(field(r, 'valueDate')) }, { get label() { return t('earnUi.maturityDate') }, value: dateOnly(field(r, 'deliverDate')) }]
          : [{ get label() { return t('earnUi.estDailyReward') }, value: `${amount(field(r, 'estDailyRealTimeRewards'))} ${field(r, 'rewardAsset') || p.asset}`, tone: 'up' as const }]
      },
    },
    get notes() { return [t('earnUi.aprIsIndicativeAndMayChangeActualRewardsFollow'),
      t('earnUi.fundsMoveFromYourSpotAccountAndReturnThere')] },
    agreementKind: 'earn',
    get agree() { return t('earnUi.iHaveReadAndAgreeToTheSimpleEarn') },
    get submit() { return t('earnUi.confirm') },
  }
}
function redeemFlex(r: BusinessRow, all: boolean) {
  if (valueAt(r, 'canRedeem') !== true) return
  const asset = field(r, 'asset')
  dlg.value = {
    get title() { return all ? t('earnUi.redeemAll', { asset }) : t('earnUi.redeem', { asset }) },
    path: `${E}/flexible/redeem`,
    fixed: { productId: field(r, 'productId'), redeemAll: all ? 'true' : 'false' },
    fields: all ? [] : [{ key: 'amount', get label() { return t('earnUi.amount2') }, kind: 'amount', asset, available: field(r, 'totalAmount') }],
    summary: [{ get label() { return t('earnUi.principal') }, value: `${amount(field(r, 'totalAmount'))} ${asset}` }, { get label() { return t('earnUi.destination') }, get value() { return t('earnUi.spotAccount') } }],
    preview: null,
    get notes() { return [t('earnUi.theRedeemedPartStopsEarningThatDayFundsUsually')] },
    get submit() { return t('earnUi.redeem2') },
  }
}
function redeemLocked(r: BusinessRow) {
  if (valueAt(r, 'canRedeem') !== true || valueAt(r, 'canRedeemEarly') !== true) return
  const asset = field(r, 'asset')
  dlg.value = {
    get title() { return t('earnUi.redeemEarly', { asset }) }, path: `${E}/locked/redeem`, fixed: { positionId: field(r, 'positionId') }, fields: [],
    summary: [{ get label() { return t('earnUi.principal2') }, value: `${amount(field(r, 'amount'))} ${asset}` }, { get label() { return t('earnUi.rewardsPaid') }, value: `${amount(field(r, 'rewardAmt'))} ${asset}`, tone: 'down' }],
    preview: null, danger: true,
    get notes() { return [t('earnUi.earlyRedemptionClawsBackRewardsAlreadyPaidOnlyPrincipal')] },
    get agree() { return t('earnUi.iUnderstandIWillForfeitThisPositionSRewards') },
    get submit() { return t('earnUi.redeemEarly2') },
  }
}
const toggling = ref('')
async function toggle(path: string, params: BusinessParams, key: string) {
  toggling.value = key
  try { await businessRequest(path, params, true); toastSuccess(t('earnUi.updated')); void flexPos.load(); void lockedPos.load() }
  catch (e) { toastError(e instanceof Error ? e.message : String(e)) }
  finally { toggling.value = '' }
}

/* ------------------------------------------------------------- summary */
const holdings = computed(() => flexPos.rows.value.length + lockedPos.rows.value.filter(r => !['REDEEMED', 'redeemed', 'matured'].includes(field(r, 'status'))).length)

const recordTabs = computed<RecordTab[]>(() => {
  const base = (kind: 'flexible' | 'locked', ep: string) => `${E}/${kind}/history/${ep}`
  const sub = (kind: 'flexible' | 'locked'): RecordTab['columns'] => [
    { key: 'time', label: t('earnUi.time'), kind: 'time' }, { key: 'asset', label: t('earnUi.asset'), kind: 'asset' },
    { key: 'amount', label: t('earnUi.amount3'), kind: 'amount', unit: 'asset' }, { key: 'status', label: t('earnUi.status'), kind: 'status' },
    ...(kind === 'locked' ? [{ key: 'deductedRewards', label: t('earnUi.clawedBack'), kind: 'amount' as const, unit: 'asset' }] : []),
  ]
  const rew: RecordTab['columns'] = [{ key: 'time', label: t('earnUi.time'), kind: 'time' }, { key: 'asset', label: t('earnUi.asset'), kind: 'asset' }, { key: 'rewards', label: t('earnUi.reward'), kind: 'amount', unit: 'asset' }]
  return [
    { id: 'fr', label: t('earnUi.flexibleRewards'), path: base('flexible', 'rewardsRecord'), paging: true, columns: rew },
    { id: 'lr', label: t('earnUi.lockedRewards'), path: base('locked', 'rewardsRecord'), paging: true, columns: rew },
    { id: 'fs', label: t('earnUi.flexibleSubscriptions'), path: base('flexible', 'subscriptionRecord'), paging: true, columns: sub('flexible') },
    { id: 'ls', label: t('earnUi.lockedSubscriptions'), path: base('locked', 'subscriptionRecord'), paging: true, columns: sub('locked') },
    { id: 'fd', label: t('earnUi.flexibleRedemptions'), path: base('flexible', 'redemptionRecord'), paging: true, columns: sub('flexible') },
    { id: 'ld', label: t('earnUi.lockedRedemptions'), path: base('locked', 'redemptionRecord'), paging: true, columns: sub('locked') },
  ]
})
const listError = computed(() => flex.error.value || locked.error.value)
</script>

<template>
  <BizPage :eyebrow="t('earnUi.simpleEarn')" :title="t('earnUi.putIdleAssetsToWork')"
    :subtitle="t('earnUi.flexibleProductsRedeemAnytimeLockedProductsEarnMoreFor')">
    <template #stats>
      <BizStat :label="t('earnUi.products')" :value="String(products.length)" />
      <BizStat :label="t('earnUi.topEstApr')" :value="bestApr ? percent(bestApr) : '—'" tone="up" />
      <BizStat v-if="authed" :label="t('earnUi.myPositions')" :value="String(holdings)" />
    </template>
    <template #aside>
      <div class="biz-aside-card">
        <h3>{{ authed ? t('earnUi.myEarn') : t('earnUi.signInToStartEarning') }}</h3>
        <template v-if="authed">
          <div class="biz-kv"><span>{{ t('earnUi.flexible2') }}</span><span class="num">{{ flexPos.rows.value.length }}</span></div>
          <div class="biz-kv"><span>{{ t('earnUi.locked') }}</span><span class="num">{{ lockedPos.rows.value.length }}</span></div>
          <a class="btn" href="#my-positions">{{ t('earnUi.viewPositions') }}</a>
        </template>
        <template v-else>
          <p class="biz-muted" style="margin:0;font-size:13px">{{ t('earnUi.signInToSubscribeAndTrackRewards') }}</p>
          <RouterLink class="btn btn-primary" to="/login">{{ t('earnUi.logIn') }}</RouterLink>
        </template>
      </div>
    </template>

    <section class="biz-card">
      <header class="biz-card-head">
        <nav class="tabs" role="tablist">
          <button v-for="k in (['all', 'flexible', 'locked'] as const)" :key="k" class="tab" :class="{ active: termTab === k }" type="button" @click="termTab = k">
            {{ k === 'all' ? t('earnUi.all') : k === 'flexible' ? t('earnUi.flexible') : t('earnUi.locked2') }}
          </button>
        </nav>
        <label class="biz-search"><Search :size="14" /><input v-model="query" :placeholder="t('earnUi.searchAsset')"></label>
      </header>
      <div class="biz-rows">
        <div class="biz-row earn-head biz-muted">
          <span>{{ t('earnUi.asset') }}</span><span>{{ t('earnUi.estApr2') }}</span><span>{{ t('earnUi.term') }}</span><span>{{ t('earnUi.minimum') }}</span><span />
        </div>
        <div v-for="p in shown" :key="p.kind + p.id" class="biz-row earn-row">
          <span class="biz-coin"><CoinMark :symbol="p.asset" :size="28" /><span>{{ p.asset }}<small>{{ p.kind === 'flexible' ? t('earnUi.flexibleRedeemAnytime') : t('earnUi.lockedAtMaturity') }}</small></span></span>
          <span class="earn-apr num">{{ percent(p.apr) }}</span>
          <span><span class="biz-chip" :class="{ on: p.kind === 'locked' }">{{ termLabel(p) }}</span></span>
          <span class="num">{{ p.min ? `${amount(p.min)} ${p.asset}` : '—' }}</span>
          <span class="biz-actions">
            <RouterLink v-if="!authed" class="btn" to="/login">{{ t('earnUi.logIn2') }}</RouterLink>
            <button v-else class="btn btn-primary" type="button" :disabled="!p.open" @click="subscribe(p)">
              {{ p.soldOut ? t('earnUi.soldOut') : p.open ? t('earnUi.subscribe2') : t('earnUi.subscriptionsPaused') }}
            </button>
          </span>
        </div>
        <p v-if="flex.loading.value && !products.length" class="biz-empty">{{ t('earnUi.loading') }}</p>
        <p v-else-if="listError && !products.length" class="biz-empty err">{{ listError }}</p>
        <p v-else-if="!shown.length" class="biz-empty">{{ t('earnUi.noProductsAvailable') }}</p>
      </div>
    </section>

    <section v-if="authed" id="my-positions" class="biz-card">
      <header class="biz-card-head"><h2>{{ t('earnUi.myPositions') }}</h2></header>
      <div class="biz-rows">
        <div v-for="r in flexPos.rows.value" :key="'f' + field(r, 'productId')" class="biz-row pos-row">
          <span class="biz-coin"><CoinMark :symbol="field(r, 'asset')" :size="26" /><span>{{ field(r, 'asset') }}<small>{{ t('earnUi.flexible') }}</small></span></span>
          <span><span class="biz-label">{{ t('earnUi.principal') }}</span><span class="num">{{ amount(field(r, 'totalAmount')) }}</span></span>
          <span><span class="biz-label">{{ t('earnUi.totalRewards') }}</span><span class="num biz-up">{{ amount(field(r, 'cumulativeTotalRewards')) }}</span></span>
          <span><span class="biz-label">{{ t('earnUi.estApr2') }}</span><span class="num biz-up">{{ percent(field(r, 'latestAnnualPercentageRate')) }}</span></span>
          <span class="pos-auto">
            <span class="biz-label">{{ t('earnUi.autoSubscribe') }}</span>
            <button class="biz-switch" :class="{ on: valueAt(r, 'autoSubscribe') === true }" type="button" :disabled="toggling !== ''"
              :aria-label="t('earnUi.autoSubscribe')"
              @click="toggle(`${E}/flexible/setAutoSubscribe`, { productId: field(r, 'productId'), autoSubscribe: valueAt(r, 'autoSubscribe') === true ? 'false' : 'true' }, 'f' + field(r, 'productId'))" />
          </span>
          <span class="biz-actions">
            <span v-if="valueAt(r, 'canRedeem') === false" class="biz-muted">{{ t('earnUi.redemptionsPaused') }}</span>
            <button class="btn" type="button" :disabled="valueAt(r, 'canRedeem') !== true || !positive(field(r, 'totalAmount'))" @click="redeemFlex(r, false)">{{ t('earnUi.redeem3') }}</button>
            <button class="btn btn-ghost" type="button" :disabled="valueAt(r, 'canRedeem') !== true || !positive(field(r, 'totalAmount'))" @click="redeemFlex(r, true)">{{ t('earnUi.redeemAll2') }}</button>
          </span>
        </div>
        <div v-for="r in lockedPos.rows.value" :key="'l' + field(r, 'positionId')" class="biz-row pos-row">
          <span class="biz-coin"><CoinMark :symbol="field(r, 'asset')" :size="26" /><span>{{ field(r, 'asset') }}<small>{{ t('earnUi.locked2') }} · <StatusPill :code="field(r, 'status')" :lang="lang" /></small></span></span>
          <span><span class="biz-label">{{ t('earnUi.principal2') }}</span><span class="num">{{ amount(field(r, 'amount')) }}</span></span>
          <span><span class="biz-label">{{ t('earnUi.rewards') }}</span><span class="num biz-up">{{ amount(field(r, 'rewardAmt')) }}</span></span>
          <span><span class="biz-label">{{ t('earnUi.maturity') }}</span><span class="num">{{ dateOnly(field(r, 'redeemDate')) }}</span></span>
          <span class="pos-auto">
            <span class="biz-label">{{ t('earnUi.autoRenew') }}</span>
            <button class="biz-switch" :class="{ on: valueAt(r, 'isAutoRenew') === true }" type="button" :disabled="toggling !== '' || valueAt(r, 'isRenewable') !== true"
              :aria-label="t('earnUi.autoRenew2')"
              @click="toggle(`${E}/locked/setAutoSubscribe`, { positionId: field(r, 'positionId'), autoSubscribe: valueAt(r, 'isAutoRenew') === true ? 'false' : 'true' }, 'l' + field(r, 'positionId'))" />
          </span>
          <span class="biz-actions">
            <select class="pos-dest" :value="field(r, 'redeemTo') || 'SPOT'" :disabled="toggling !== ''" :aria-label="t('earnUi.atMaturity2')"
              @change="toggle(`${E}/locked/setRedeemOption`, { positionId: field(r, 'positionId'), redeemTo: ($event.target as HTMLSelectElement).value }, 'd' + field(r, 'positionId'))">
              <option value="SPOT">{{ t('earnUi.toSpotAtMaturity') }}</option>
              <option value="FLEXIBLE">{{ t('earnUi.toFlexibleAtMaturity') }}</option>
            </select>
            <span v-if="valueAt(r, 'canRedeem') === false" class="biz-muted">{{ t('earnUi.redemptionsPaused') }}</span>
            <button v-if="valueAt(r, 'canRedeemEarly') === true" class="btn" :disabled="valueAt(r, 'canRedeem') !== true" type="button" @click="redeemLocked(r)">{{ t('earnUi.redeemEarly3') }}</button>
          </span>
        </div>
        <p v-if="!flexPos.rows.value.length && !lockedPos.rows.value.length" class="biz-empty">{{ t('earnUi.noPositionsYetPickAProductAboveToGet') }}</p>
      </div>
    </section>

    <BizRecords v-if="authed" :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />

    <BizDialog v-if="dlg" :open="dlg !== null" :lang="lang" :title="dlg.title" :path="dlg.path" :fixed="dlg.fixed" :fields="dlg.fields"
      :summary="dlg.summary" :preview="dlg.preview" :notes="dlg.notes" :agree="dlg.agree" :agreement-kind="dlg.agreementKind" :submit-text="dlg.submit" :danger="dlg.danger"
      @close="dlg = null" @done="reloadAll" />
  </BizPage>
</template>

<style scoped>
.earn-head, .earn-row { grid-template-columns: minmax(180px, 1.4fr) 1fr 1fr 1fr minmax(140px, auto); }
.earn-head { padding-top: 10px; padding-bottom: 10px; font-size: var(--font-size-xs); }
.earn-head:hover { background: transparent; }
.earn-apr { color: var(--color-up); font-size: 18px; font-weight: 700; }
.pos-row { grid-template-columns: minmax(160px, 1.2fr) 1fr 1fr 1fr auto minmax(180px, auto); }
.pos-auto { display: grid; justify-items: start; gap: 4px; }
.pos-dest { height: 32px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-size: var(--font-size-xs); }
@media (max-width: 860px) { .earn-head { display: none; } }
</style>
