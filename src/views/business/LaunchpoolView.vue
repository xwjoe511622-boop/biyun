<script setup lang="ts">
/** 质押挖矿 (Launchpool), modelled on Binance Launchpool: one card per pool with reward pool, hourly output, est. APR, my stake. */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import CoinMark from '@/components/common/CoinMark.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizDialog, { type DialogField, type SummaryLine } from '@/components/business/ui/BizDialog.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import StatusPill from '@/components/business/ui/StatusPill.vue'
import { useBizContext, useBizQuery, useNow, useSpotBalances } from '@/components/business/ui/useBiz'
import { type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { amount, countdown, dateTime, epochMs, field, percent, positive, progress } from '@/modules/business/format'
import { Decimal, isDecimalString } from '@/modules/finance/decimal'

const P = '/sapi/v1/launchpool'
const { lang, authed, t } = useBizContext()
const now = useNow()
const spot = useSpotBalances(authed)
const pools = useBizQuery(() => `${P}/pools`, () => ({ current: '1', size: '50' }))
const refreshKey = ref(0)
function reload() { void pools.load(); void spot.reload(); refreshKey.value++ }
onMounted(reload)
watch(authed, reload)

const live = computed(() => pools.rows.value.filter(r => field(r, 'status') === 'online'))
const others = computed(() => pools.rows.value.filter(r => field(r, 'status') !== 'online'))
const totalUnclaimed = computed(() => pools.rows.value.filter(r => positive(field(r, 'myUnclaimed'))).length)

function remainingCap(r: BusinessRow): string | null {
  const max = field(r, 'maxStakePerUser')
  if (!isDecimalString(max) || new Decimal(max).lte(0)) return null
  const mine = field(r, 'myStaked')
  const left = new Decimal(max).minus(isDecimalString(mine) ? mine : '0')
  return left.gt(0) ? left.toFixed() : '0'
}

const dlg = ref<{ title: string; path: string; fixed: BusinessParams; fields: DialogField[]; summary: SummaryLine[]; notes: string[]; agree?: string; submit: string } | null>(null)
function stake(r: BusinessRow) {
  const coin = field(r, 'stakeCoin')
  dlg.value = {
    get title() { return t('launchpoolUi.stakeToEarn', { coin, fieldrrewardCoin: field(r, 'rewardCoin') }) }, path: `${P}/stake`, fixed: { poolId: field(r, 'poolId') },
    fields: [{ key: 'amount', get label() { return t('launchpoolUi.amount') }, kind: 'amount', asset: coin, available: spot.of(coin), min: field(r, 'minStake') || null, max: remainingCap(r) }],
    summary: [
      { get label() { return t('launchpoolUi.estApr') }, value: field(r, 'estApr') ? percent(field(r, 'estApr')) : '—', tone: 'up' },
      { get label() { return t('launchpoolUi.hourlyOutput') }, value: `${amount(field(r, 'hourlyReward'))} ${field(r, 'rewardCoin')}` },
      { get label() { return t('launchpoolUi.ends') }, value: dateTime(field(r, 'endTime')) },
    ],
    get notes() { return [t('launchpoolUi.stakedAssetsAreLockedFromSpotAndCanBe'),
      t('launchpoolUi.estAprChangesWithTotalStakeAndPricesAnd')] },
    get agree() { return t('launchpoolUi.iUnderstandTheLaunchpoolRulesAndRisks') },
    get submit() { return t('launchpoolUi.stake') },
  }
}
function unstake(r: BusinessRow) {
  const coin = field(r, 'stakeCoin')
  dlg.value = {
    get title() { return t('launchpoolUi.unstake', { coin }) }, path: `${P}/unstake`, fixed: { poolId: field(r, 'poolId') },
    fields: [{ key: 'amount', get label() { return t('launchpoolUi.amount2') }, kind: 'amount', asset: coin, available: field(r, 'myStaked') }],
    summary: [{ get label() { return t('launchpoolUi.staked') }, value: `${amount(field(r, 'myStaked'))} ${coin}` }],
    get notes() { return [t('launchpoolUi.unstakedAssetsReturnToSpotAndStopEarning')] }, get submit() { return t('launchpoolUi.unstake2') },
  }
}
function claim(r: BusinessRow) {
  dlg.value = {
    get title() { return t('launchpoolUi.claimRewards') }, path: `${P}/claim`, fixed: { poolId: field(r, 'poolId') }, fields: [],
    summary: [{ get label() { return t('launchpoolUi.claimable') }, value: `${amount(field(r, 'myUnclaimed'))} ${field(r, 'rewardCoin')}`, tone: 'up' }],
    get notes() { return [t('launchpoolUi.rewardsArePaidToYourSpotAccount')] }, get submit() { return t('launchpoolUi.claim') },
  }
}

const recordTabs = computed<RecordTab[]>(() => [
  { id: 'claims', label: t('launchpoolUi.claims'), path: `${P}/records`, rowsPath: 'claims', paging: true, columns: [
    { key: 'time', label: t('launchpoolUi.time'), kind: 'time' }, { key: 'asset', label: t('launchpoolUi.asset'), kind: 'asset' },
    { key: 'amount', label: t('launchpoolUi.amount3'), kind: 'amount', unit: 'asset' }, { key: 'status', label: t('launchpoolUi.status'), kind: 'status' }] },
  { id: 'stakes', label: t('launchpoolUi.stakes'), path: `${P}/records`, rowsPath: 'stakes', paging: true, columns: [
    { key: 'time', label: t('launchpoolUi.time'), kind: 'time' }, { key: 'type', label: t('launchpoolUi.action'), map: { stake: t('launchpoolUi.stake2'), unstake: t('launchpoolUi.unstake3') } },
    { key: 'amount', label: t('launchpoolUi.amount3'), kind: 'amount' }, { key: 'status', label: t('launchpoolUi.status'), kind: 'status' }] },
  { id: 'rewards', label: t('launchpoolUi.rewards'), path: `${P}/rewards`, paging: true, columns: [
    { key: 'hour', label: t('launchpoolUi.hour'), kind: 'time' }, { key: 'asset', label: t('launchpoolUi.asset'), kind: 'asset' },
    { key: 'averageStake', label: t('launchpoolUi.avgStake'), kind: 'amount' }, { key: 'reward', label: t('launchpoolUi.reward'), kind: 'amount', unit: 'asset' }] },
])
</script>

<template>
  <BizPage :eyebrow="t('launchpoolUi.launchpool')" :title="t('launchpoolUi.stakeToFarmNewTokens')"
    :subtitle="t('launchpoolUi.stakeAssetsInAPoolAndEarnNewTokens')">
    <template #stats>
      <BizStat :label="t('launchpoolUi.livePools')" :value="String(live.length)" />
      <BizStat v-if="authed" :label="t('launchpoolUi.poolsWithRewards')" :value="String(totalUnclaimed)" tone="up" />
    </template>

    <div v-if="pools.rows.value.length" class="pool-grid">
      <article v-for="r in [...live, ...others]" :key="field(r, 'poolId')" class="biz-card pool">
        <header class="pool-head">
          <span class="pool-coins"><CoinMark :symbol="field(r, 'stakeCoin')" :size="34" /><CoinMark class="pool-reward" :symbol="field(r, 'rewardCoin')" :size="24" /></span>
          <div class="pool-title">
            <h3>{{ t('launchpoolUi.stakeEarn', { fieldrstakeCoin: field(r, 'stakeCoin'), fieldrrewardCoin: field(r, 'rewardCoin') }) }}</h3>
            <p class="biz-muted">{{ field(r, 'status') === 'online' && countdown(epochMs(field(r, 'endTime')), now, lang) ? t('launchpoolUi.endsIn', { countdownepochMsfieldrendTimenowlang: countdown(epochMs(field(r, 'endTime')), now, lang) }) : dateTime(field(r, 'endTime')) }}</p>
          </div>
          <StatusPill :code="field(r, 'status')" :lang="lang" />
        </header>
        <div class="pool-apr">
          <span class="biz-label">{{ t('launchpoolUi.estApr') }}</span>
          <strong class="num">{{ field(r, 'estApr') ? percent(field(r, 'estApr')) : '—' }}</strong>
        </div>
        <dl class="pool-stats">
          <div><dt>{{ t('launchpoolUi.totalRewards') }}</dt><dd class="num">{{ amount(field(r, 'totalReward')) }} {{ field(r, 'rewardCoin') }}</dd></div>
          <div><dt>{{ t('launchpoolUi.perHour') }}</dt><dd class="num">{{ amount(field(r, 'hourlyReward')) }} {{ field(r, 'rewardCoin') }}</dd></div>
          <div><dt>{{ t('launchpoolUi.totalStaked') }}</dt><dd class="num">{{ amount(field(r, 'totalStaked')) }} {{ field(r, 'stakeCoin') }}</dd></div>
          <div><dt>{{ t('launchpoolUi.participants') }}</dt><dd class="num">{{ field(r, 'participants') || '0' }}</dd></div>
        </dl>
        <div class="pool-progress">
          <div class="biz-kv"><span>{{ t('launchpoolUi.distributed') }}</span><span class="num">{{ amount(field(r, 'distributed')) }} / {{ amount(field(r, 'totalReward')) }}</span></div>
          <div class="biz-bar"><i :style="{ width: `${progress(field(r, 'distributed'), field(r, 'totalReward'))}%` }" /></div>
        </div>
        <div v-if="authed" class="pool-mine">
          <div><span class="biz-label">{{ t('launchpoolUi.myStake') }}</span><span class="num">{{ amount(field(r, 'myStaked') || '0') }} {{ field(r, 'stakeCoin') }}</span></div>
          <div><span class="biz-label">{{ t('launchpoolUi.claimable2') }}</span><span class="num biz-up">{{ amount(field(r, 'myUnclaimed') || '0') }} {{ field(r, 'rewardCoin') }}</span></div>
        </div>
        <footer class="pool-actions">
          <RouterLink v-if="!authed" class="btn btn-primary btn-block" to="/login">{{ t('launchpoolUi.logInToJoin') }}</RouterLink>
          <template v-else>
            <button class="btn btn-primary" type="button" :disabled="field(r, 'status') !== 'online'" @click="stake(r)">{{ t('launchpoolUi.stake2') }}</button>
            <button class="btn" type="button" :disabled="!positive(field(r, 'myStaked'))" @click="unstake(r)">{{ t('launchpoolUi.unstake3') }}</button>
            <button class="btn" type="button" :disabled="!positive(field(r, 'myUnclaimed'))" @click="claim(r)">{{ t('launchpoolUi.claim') }}</button>
          </template>
        </footer>
      </article>
    </div>
    <div v-else class="biz-card"><p class="biz-empty" :class="{ err: pools.error.value }">{{ pools.loading.value ? t('launchpoolUi.loading') : pools.error.value || t('launchpoolUi.noPoolsYetStayTuned') }}</p></div>

    <BizRecords v-if="authed" :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />

    <BizDialog v-if="dlg" :open="true" :lang="lang" :title="dlg.title" :path="dlg.path" :fixed="dlg.fixed" :fields="dlg.fields" :summary="dlg.summary"
      :notes="dlg.notes" :agree="dlg.agree" :submit-text="dlg.submit" @close="dlg = null" @done="reload" />
  </BizPage>
</template>

<style scoped>
.pool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.pool { display: grid; gap: 16px; padding: 20px; }
.pool-head { display: flex; align-items: center; gap: 12px; }
.pool-coins { position: relative; flex: none; width: 44px; height: 40px; }
.pool-reward { position: absolute; right: 0; bottom: 0; border: 2px solid var(--color-surface); border-radius: 50%; }
.pool-title { flex: 1; min-width: 0; }
.pool-title h3 { margin: 0; font-size: var(--font-size-md); font-weight: 700; }
.pool-title p { margin: 2px 0 0; font-size: var(--font-size-xs); }
.pool-apr strong { display: block; color: var(--color-up); font-size: 28px; font-weight: 700; line-height: 1.2; }
.pool-stats { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
.pool-stats dt { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.pool-stats dd { margin: 2px 0 0; font-weight: 600; font-size: var(--font-size-sm); }
.pool-progress { display: grid; gap: 6px; }
.pool-mine { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; border-radius: var(--radius); background: var(--color-surface-alt); font-weight: 600; }
.pool-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.pool-actions .btn-block { grid-column: 1 / -1; }
</style>
