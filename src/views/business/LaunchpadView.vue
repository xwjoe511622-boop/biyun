<script setup lang="ts">
/** 新币申购 (Launchpad), modelled on Binance Launchpad: project card, phase timeline with countdown, my quota and commitment. */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import CoinMark from '@/components/common/CoinMark.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizDialog, { type DialogField, type SummaryLine } from '@/components/business/ui/BizDialog.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import StatusPill from '@/components/business/ui/StatusPill.vue'
import { useBizContext, useBizQuery, useNow, useSpotBalances } from '@/components/business/ui/useBiz'
import { businessRequest, rowOf, valueAt, type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { amount, countdown, dateTime, epochMs, field, positive, progress } from '@/modules/business/format'
import { Decimal, isDecimalString } from '@/modules/finance/decimal'

const LP = '/sapi/v1/launchpad'
const { lang, authed, t } = useBizContext()
const now = useNow()
const spot = useSpotBalances(authed)
const projects = useBizQuery(() => `${LP}/projects`, () => ({ current: '1', size: '50' }))
const quotas = reactive<Record<string, BusinessRow>>({})
const refreshKey = ref(0)

async function loadQuotas() {
  if (!authed.value) return
  for (const r of projects.rows.value) {
    const id = field(r, 'projectId')
    if (!['subscribing', 'snapshot', 'calculated', 'distributing', 'completed'].includes(field(r, 'status'))) continue
    try { quotas[id] = rowOf(await businessRequest(`${LP}/projects/${id}/quota`)) } catch { /* quota is optional */ }
  }
}
async function reload() { await projects.load(); void spot.reload(); refreshKey.value++; await loadQuotas() }
onMounted(() => { void reload() })
watch(authed, () => { void reload() })

const ORDER = ['subscribing', 'snapshot', 'preview', 'calculated', 'distributing', 'completed', 'cancelled']
const list = computed(() => [...projects.rows.value].sort((a, b) => ORDER.indexOf(field(a, 'status')) - ORDER.indexOf(field(b, 'status'))))
const activeCount = computed(() => projects.rows.value.filter(r => ['preview', 'snapshot', 'subscribing'].includes(field(r, 'status'))).length)

interface Phase { key: string; label: string; at: number | null }
function phases(r: BusinessRow): Phase[] {
  return [
    { key: 'snap', label: t('launchpadUi.holdingSnapshot'), at: epochMs(field(r, 'snapshotStart')) },
    { key: 'sub', label: t('launchpadUi.subscriptionOpens'), at: epochMs(field(r, 'subscribeStart')) },
    { key: 'end', label: t('launchpadUi.subscriptionCloses'), at: epochMs(field(r, 'subscribeEnd')) },
  ]
}
function nextPhase(r: BusinessRow): { label: string; left: string } | null {
  for (const p of phases(r)) {
    const left = countdown(p.at, now.value, lang.value)
    if (left) return { label: p.label, left }
  }
  return null
}
const phaseDone = (p: Phase) => p.at !== null && p.at <= now.value

const dlg = ref<{ title: string; path: string; fixed: BusinessParams; fields: DialogField[]; summary: SummaryLine[]; notes: string[]; agree?: string; submit: string } | null>(null)
function commitMax(r: BusinessRow): string | null {
  const q = quotas[field(r, 'projectId')]
  const left = q ? field(q, 'left') : ''
  const max = field(r, 'maxCommit')
  const candidates = [left, max].filter(v => isDecimalString(v) && new Decimal(v).gt(0))
  return candidates.length ? candidates.reduce((a, b) => (new Decimal(a).lt(b) ? a : b)) : null
}
function commit(r: BusinessRow) {
  const quote = field(r, 'quoteCoin')
  dlg.value = {
    get title() { return t('launchpadUi.commitTo', { fieldrtokenCoin: field(r, 'tokenCoin') }) }, path: `${LP}/commit`, fixed: { projectId: field(r, 'projectId') },
    fields: [{ key: 'amount', get label() { return t('launchpadUi.commit', { quote }) }, kind: 'amount', asset: quote, available: spot.of(quote), min: field(r, 'minCommit') || null, max: commitMax(r) }],
    summary: [
      { get label() { return t('launchpadUi.price') }, value: `1 ${field(r, 'tokenCoin')} = ${amount(field(r, 'price'))} ${quote}` },
      { get label() { return t('launchpadUi.closes') }, value: dateTime(field(r, 'subscribeEnd')) },
    ],
    get notes() { return [t('launchpadUi.committedFundsAreLockedAfterTheWindowTokensAre')] },
    get agree() { return t('launchpadUi.iHaveReadTheProjectDetailsAndRulesAnd') },
    get submit() { return t('launchpadUi.commit2') },
  }
}
function uncommit(r: BusinessRow) {
  const quote = field(r, 'quoteCoin')
  const q = quotas[field(r, 'projectId')]
  dlg.value = {
    get title() { return t('launchpadUi.reduceCommitment') }, path: `${LP}/uncommit`, fixed: { projectId: field(r, 'projectId') },
    fields: [{ key: 'amount', get label() { return t('launchpadUi.amount', { quote }) }, kind: 'amount', asset: quote, available: q ? field(q, 'committed') : null }],
    summary: [], get notes() { return [t('launchpadUi.theCancelledAmountIsUnlockedBackToSpot')] }, get submit() { return t('launchpadUi.confirm') },
  }
}

const recordTabs = computed<RecordTab[]>(() => [
  { id: 'records', label: t('launchpadUi.commitments'), path: `${LP}/records`, paging: true, columns: [
    { key: 'time', label: t('launchpadUi.time'), kind: 'time' }, { key: 'asset', label: t('launchpadUi.asset'), kind: 'asset' },
    { key: 'type', label: t('launchpadUi.action'), map: { commit: t('launchpadUi.commit3'), uncommit: t('launchpadUi.uncommit') } },
    { key: 'amount', label: t('launchpadUi.amount2'), kind: 'amount', unit: 'asset' }, { key: 'status', label: t('launchpadUi.status'), kind: 'status' }] },
  { id: 'dist', label: t('launchpadUi.allocationRefunds'), path: `${LP}/records`, rowsPath: 'distributions', columns: [
    { key: 'tokenCoin', label: t('launchpadUi.token'), kind: 'asset' }, { key: 'committed', label: t('launchpadUi.committed'), kind: 'amount', unit: 'quoteCoin' },
    { key: 'allocatedToken', label: t('launchpadUi.tokensReceived'), kind: 'amount', unit: 'tokenCoin' }, { key: 'cost', label: t('launchpadUi.cost'), kind: 'amount', unit: 'quoteCoin' },
    { key: 'refund', label: t('launchpadUi.refund'), kind: 'amount', unit: 'quoteCoin' }, { key: 'status', label: t('launchpadUi.status'), kind: 'status' }] },
])
</script>

<template>
  <BizPage :eyebrow="t('launchpadUi.launchpad')" :title="t('launchpadUi.getEarlyAccessToNewTokens')"
    :subtitle="t('launchpadUi.holdEligibleAssetsToGetAQuotaTokensAre')">
    <template #stats>
      <BizStat :label="t('launchpadUi.liveUpcoming')" :value="String(activeCount)" />
      <BizStat :label="t('launchpadUi.allProjects')" :value="String(projects.rows.value.length)" />
    </template>

    <div v-if="list.length" class="launchpad-projects">
      <article v-for="r in list" :key="field(r, 'projectId')" class="biz-card lp">
        <div class="lp-main">
          <header class="lp-head">
            <CoinMark :symbol="field(r, 'tokenCoin')" :size="44" />
            <div class="lp-title">
              <h3>{{ field(r, 'title') || field(r, 'tokenCoin') }}</h3>
              <p class="biz-muted">{{ t('launchpadUi.commitFor', { fieldrquoteCoin: field(r, 'quoteCoin'), fieldrtokenCoin: field(r, 'tokenCoin') }) }}</p>
            </div>
            <StatusPill :code="field(r, 'status')" :lang="lang" />
          </header>
          <dl class="lp-facts">
            <div><dt>{{ t('launchpadUi.price') }}</dt><dd class="num">1 {{ field(r, 'tokenCoin') }} = {{ amount(field(r, 'price')) }} {{ field(r, 'quoteCoin') }}</dd></div>
            <div><dt>{{ t('launchpadUi.totalSupply') }}</dt><dd class="num">{{ amount(field(r, 'totalSupply')) }} {{ field(r, 'tokenCoin') }}</dd></div>
            <div><dt>{{ t('launchpadUi.perUserCap') }}</dt><dd class="num">{{ positive(field(r, 'userCapToken')) ? `${amount(field(r, 'userCapToken'))} ${field(r, 'tokenCoin')}` : t('launchpadUi.byHoldings') }}</dd></div>
            <div><dt>{{ t('launchpadUi.totalCommitted') }}</dt><dd class="num">{{ amount(field(r, 'totalCommitted')) }} {{ field(r, 'quoteCoin') }}</dd></div>
          </dl>
          <ol class="lp-steps">
            <li v-for="p in phases(r)" :key="p.key" :class="{ done: phaseDone(p) }"><span class="dot" /><b>{{ p.label }}</b><span class="num biz-muted">{{ dateTime(p.at) }}</span></li>
          </ol>
        </div>
        <aside class="lp-side">
          <template v-if="nextPhase(r)">
            <span class="biz-label">{{ t('launchpadUi.in', { label: nextPhase(r)?.label }) }}</span>
            <strong class="lp-count num">{{ nextPhase(r)?.left }}</strong>
          </template>
          <template v-if="authed && quotas[field(r, 'projectId')]">
            <div class="biz-kv"><span>{{ t('launchpadUi.myQuota') }}</span><span class="num">{{ field(quotas[field(r, 'projectId')], 'cap') ? amount(field(quotas[field(r, 'projectId')], 'cap')) : t('launchpadUi.noCap') }}</span></div>
            <div class="biz-kv"><span>{{ t('launchpadUi.committed2') }}</span><span class="num">{{ amount(field(quotas[field(r, 'projectId')], 'committed')) }} {{ field(r, 'quoteCoin') }}</span></div>
            <div v-if="positive(field(quotas[field(r, 'projectId')], 'allocatedToken'))" class="biz-kv"><span>{{ t('launchpadUi.allocated') }}</span><span class="num biz-up">{{ amount(field(quotas[field(r, 'projectId')], 'allocatedToken')) }} {{ field(r, 'tokenCoin') }}</span></div>
            <div v-if="positive(field(r, 'maxCommit'))" class="biz-bar"><i :style="{ width: `${progress(field(quotas[field(r, 'projectId')], 'committed'), field(r, 'maxCommit'))}%` }" /></div>
          </template>
          <RouterLink v-if="!authed" class="btn btn-primary btn-block" to="/login">{{ t('launchpadUi.logInToCommit') }}</RouterLink>
          <template v-else>
            <button class="btn btn-primary btn-block" type="button" :disabled="field(r, 'status') !== 'subscribing'" @click="commit(r)">
              {{ field(r, 'status') === 'subscribing' ? t('launchpadUi.commitNow') : field(r, 'status') === 'preview' || field(r, 'status') === 'snapshot' ? t('launchpadUi.comingSoon') : t('launchpadUi.closed') }}
            </button>
            <button v-if="valueAt(r, 'allowUncommit') === true && field(r, 'status') === 'subscribing' && positive(field(quotas[field(r, 'projectId')] ?? {}, 'committed'))"
              class="btn btn-ghost btn-block" type="button" @click="uncommit(r)">{{ t('launchpadUi.reduceCommitment') }}</button>
          </template>
        </aside>
      </article>
    </div>
    <div v-else class="biz-card"><p class="biz-empty" :class="{ err: projects.error.value }">{{ projects.loading.value ? t('launchpadUi.loading') : projects.error.value || t('launchpadUi.noProjectsYetStayTuned') }}</p></div>

    <BizRecords v-if="authed" :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />
    <BizDialog v-if="dlg" :open="true" :lang="lang" :title="dlg.title" :path="dlg.path" :fixed="dlg.fixed" :fields="dlg.fields" :summary="dlg.summary"
      :notes="dlg.notes" :agree="dlg.agree" :submit-text="dlg.submit" @close="dlg = null" @done="reload" />
  </BizPage>
</template>

<style scoped>
.launchpad-projects { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.lp { display: grid; grid-template-columns: minmax(0, 1fr) 300px; }
.lp-main { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 22px; }
.lp-head { display: flex; align-items: center; gap: 14px; }
.lp-title { flex: 1; min-width: 0; }
.lp-title h3 { margin: 0; font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
.lp-title p { margin: 4px 0 0; font-size: var(--font-size-sm); }
.lp-facts { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: 12px; }
.lp-facts .num { white-space: normal; overflow-wrap: anywhere; }
.lp-facts dt { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.lp-facts dd { margin: 4px 0 0; font-weight: 650; font-size: var(--font-size-sm); }
.lp-steps { list-style: none; min-width: 0; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.lp-steps li { min-width: 0; position: relative; display: grid; gap: 2px; padding-top: 16px; overflow-wrap: anywhere; font-size: var(--font-size-xs); }
.lp-steps .num { white-space: normal; overflow-wrap: anywhere; }
.lp-steps li::before { content: ''; position: absolute; top: 4px; left: 10px; right: -8px; height: 2px; background: var(--color-border); }
.lp-steps li:last-child::before { display: none; }
.lp-steps .dot { position: absolute; top: 0; left: 0; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--color-border-strong); background: var(--color-surface); }
.lp-steps li.done .dot { border-color: var(--color-accent); background: var(--color-accent); }
.lp-steps li.done::before { background: var(--color-accent); }
.lp-side { display: grid; align-content: start; gap: 12px; padding: 22px; border-left: 1px solid var(--color-border); background: var(--color-surface-alt); border-radius: 0 var(--radius-lg) var(--radius-lg) 0; }
.lp-count { font-size: 24px; font-weight: 700; color: var(--color-accent-text); }
@media (max-width: 860px) {
  .lp { grid-template-columns: minmax(0, 1fr); }
  .lp-side { border-left: 0; border-top: 1px solid var(--color-border); border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
  .lp-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
