<script setup lang="ts">
/** Borrowing, LTV, rates and records for the platform's current collateralized-loan contract. */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import CoinMark from '@/components/common/CoinMark.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizDialog, { type DialogField, type SummaryLine } from '@/components/business/ui/BizDialog.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import { useBizContext, useBizQuery, useSpotBalances } from '@/components/business/ui/useBiz'
import { valueAt, type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { amount, field, percent, progress } from '@/modules/business/format'
import { Decimal, isDecimalString } from '@/modules/finance/decimal'

const LN = '/sapi/v2/loan/flexible'
const { lang, authed, t } = useBizContext()
const spot = useSpotBalances(authed)
const loanable = useBizQuery(() => `${LN}/loanable/data`)
const collateral = useBizQuery(() => `${LN}/collateral/data`)
const ongoing = useBizQuery(() => (authed.value ? `${LN}/ongoing/orders` : null), () => ({ current: '1', size: '50' }))
const refreshKey = ref(0)
function reload() { void loanable.load(); void collateral.load(); void ongoing.load(); void spot.reload(); refreshKey.value++ }
onMounted(reload)
watch(authed, reload)

const loanCoin = ref('')
const collCoin = ref('')
watch(loanable.rows, rows => { if (!loanCoin.value && rows.length) loanCoin.value = field(rows[0], 'loanCoin') })
watch(collateral.rows, rows => { if (!collCoin.value && rows.length) collCoin.value = field(rows[0], 'collateralCoin') })
const loanRow = computed(() => loanable.rows.value.find(r => field(r, 'loanCoin') === loanCoin.value) ?? null)
const collRow = computed(() => collateral.rows.value.find(r => field(r, 'collateralCoin') === collCoin.value) ?? null)
const canBorrow = computed(() => !!loanRow.value && valueAt(loanRow.value, 'canBorrow') === true)
const minApr = computed(() => loanable.rows.value.map(r => field(r, 'annualInterestRate')).filter(isDecimalString)
  .reduce((m, v) => (m === '' || new Decimal(v).lt(m) ? v : m), ''))

const dlg = ref<{ title: string; path: string; fixed: BusinessParams; fields: DialogField[]; summary: SummaryLine[]; notes: string[]; agree?: string; agreementKind?: 'earn' | 'loan'; submit: string; danger?: boolean } | null>(null)
function borrow() {
  if (!loanRow.value || !collRow.value || !canBorrow.value) return
  const lc = loanCoin.value
  const cc = collCoin.value
  dlg.value = {
    get title() { return t('loansUi.borrowWith', { cc, lc }) }, path: `${LN}/borrow`, fixed: { loanCoin: lc, collateralCoin: cc },
    fields: [
      { key: 'loanAmount', get label() { return t('loansUi.loanAmount') }, kind: 'amount', asset: lc, min: field(loanRow.value, 'flexibleMinLimit') || null, max: field(loanRow.value, 'flexibleMaxLimit') || null },
    ],
    summary: [
      { get label() { return t('loansUi.annualRate') }, value: percent(field(loanRow.value, 'annualInterestRate')), tone: 'accent' },
      { get label() { return t('loansUi.initialLtv') }, value: percent(field(collRow.value, 'initialLTV')) },
      { get label() { return t('loansUi.marginCallLtv') }, value: percent(field(collRow.value, 'marginCallLTV')) },
      { get label() { return t('loansUi.liquidationLtv') }, value: percent(field(collRow.value, 'liquidationLTV')), tone: 'down' },
    ],
    get notes() { return [t('loansUi.thisRequestSpecifiesTheLoanAmountRequiredCollateralIs'),
      t('loansUi.ltvReferenceValueOfOutstandingPrincipalAndInterestCollateral'),
      t('loansUi.interestIsChargedHourlyInAdvanceIncludingTheFirst')] },
    agreementKind: 'loan',
    get agree() { return t('loansUi.iAgreeToTheLoansTermsAndUnderstandThe') },
    get submit() { return t('loansUi.borrow') },
  }
}
function repay(r: BusinessRow, all: boolean) {
  const lc = field(r, 'loanCoin')
  dlg.value = {
    get title() { return all ? t('loansUi.repayAll', { lc }) : t('loansUi.repay', { lc }) }, path: `${LN}/repay`,
    fixed: { loanCoin: lc, collateralCoin: field(r, 'collateralCoin'), fullRepayment: all ? 'true' : 'false', collateralReturn: 'true' },
    fields: [
      { key: 'repaymentType', get label() { return t('loansUi.repayWith') }, kind: 'select', options: [{ value: '1', get label() { return t('loansUi.inSpot', { lc }) } }, { value: '2', get label() { return t('loansUi.collateral') } }] },
      ...(all ? [] : [{ key: 'repayAmount', get label() { return t('loansUi.amount') }, kind: 'amount' as const, asset: lc, available: spot.of(lc), max: field(r, 'totalDebt') }]),
    ],
    summary: [{ get label() { return t('loansUi.totalDebt') }, value: `${amount(field(r, 'totalDebt'))} ${lc}` }, { get label() { return t('loansUi.interest') }, value: `${amount(field(r, 'interest'))} ${lc}` }],
    get notes() { return [t('loansUi.interestIsRepaidFirstThenPrincipalCollateralReturnsTo')] },
    get submit() { return t('loansUi.repay2') },
  }
}
function adjust(r: BusinessRow) {
  const cc = field(r, 'collateralCoin')
  dlg.value = {
    get title() { return t('loansUi.adjustCollateral', { cc }) }, path: `${LN}/adjust/ltv`, fixed: { loanCoin: field(r, 'loanCoin'), collateralCoin: cc },
    fields: [
      { key: 'direction', get label() { return t('loansUi.action') }, kind: 'select', options: [{ value: 'ADDITIONAL', get label() { return t('loansUi.addLowerRisk') } }, { value: 'REDUCED', get label() { return t('loansUi.remove') } }] },
      { key: 'adjustmentAmount', get label() { return t('loansUi.amount2') }, kind: 'amount', asset: cc, available: spot.of(cc) },
    ],
    summary: [{ get label() { return t('loansUi.currentLtv') }, value: percent(field(r, 'currentLTV')) }, { get label() { return t('loansUi.collateral2') }, value: `${amount(field(r, 'collateralAmount'))} ${cc}` }],
    get notes() { return [t('loansUi.removingCollateralRaisesLtvAndMayTriggerAMargin')] },
    get submit() { return t('loansUi.confirm') },
  }
}
function ltvTone(r: BusinessRow): string {
  const c = collateral.rows.value.find(x => field(x, 'collateralCoin') === field(r, 'collateralCoin'))
  const ltv = field(r, 'currentLTV')
  if (!c || !isDecimalString(ltv)) return ''
  if (new Decimal(ltv).gte(field(c, 'marginCallLTV') || '1')) return 'danger'
  if (new Decimal(ltv).gte(field(c, 'initialLTV') || '1')) return 'warn'
  return 'safe'
}
function liqLine(r: BusinessRow): string {
  return field(collateral.rows.value.find(x => field(x, 'collateralCoin') === field(r, 'collateralCoin')) ?? {}, 'liquidationLTV')
}

const recordTabs = computed<RecordTab[]>(() => [
  { id: 'borrow', label: t('loansUi.borrows'), path: `${LN}/borrow/history`, paging: true, columns: [
    { key: 'borrowTime', label: t('loansUi.time'), kind: 'time' }, { key: 'loanCoin', label: t('loansUi.loan'), kind: 'asset' },
    { key: 'initialLoanAmount', label: t('loansUi.amount3'), kind: 'amount', unit: 'loanCoin' }, { key: 'initialCollateralAmount', label: t('loansUi.collateral3'), kind: 'amount', unit: 'collateralCoin' }, { key: 'status', label: t('loansUi.status'), kind: 'status' }] },
  { id: 'repay', label: t('loansUi.repayments'), path: `${LN}/repay/history`, paging: true, columns: [
    { key: 'repayTime', label: t('loansUi.time'), kind: 'time' }, { key: 'loanCoin', label: t('loansUi.asset'), kind: 'asset' },
    { key: 'repaymentType', label: t('loansUi.method'), map: { '1': t('loansUi.spotBalance'), '2': t('loansUi.collateral') } },
    { key: 'repayAmount', label: t('loansUi.repaid'), kind: 'amount', unit: 'loanCoin' }, { key: 'status', label: t('loansUi.status'), kind: 'status' }] },
  { id: 'adj', label: t('loansUi.collateralChanges'), path: `${LN}/ltv/adjustment/history`, paging: true, columns: [
    { key: 'adjustTime', label: t('loansUi.time'), kind: 'time' }, { key: 'direction', label: t('loansUi.action'), map: { ADDITIONAL: t('loansUi.add'), REDUCED: t('loansUi.remove2') } },
    { key: 'collateralAmount', label: t('loansUi.amount2'), kind: 'amount', unit: 'collateralCoin' }, { key: 'afterLTV', label: t('loansUi.ltvAfter'), kind: 'percent' }] },
  { id: 'liq', label: t('loansUi.liquidations'), path: `${LN}/liquidation/history`, paging: true, columns: [
    { key: 'liquidationStartingTime', label: t('loansUi.time'), kind: 'time' }, { key: 'loanCoin', label: t('loansUi.loan'), kind: 'asset' },
    { key: 'liquidationDebt', label: t('loansUi.debt'), kind: 'amount', unit: 'loanCoin' }, { key: 'liquidationCollateralAmount', label: t('loansUi.collateral4'), kind: 'amount', unit: 'collateralCoin' }] },
])
</script>

<template>
  <BizPage :eyebrow="t('loansUi.cryptoLoans')" :title="t('loansUi.borrowWithoutSellingYourCrypto')"
    :subtitle="t('loansUi.borrowSupportedAssetsAgainstCryptoCollateralWithHourlyInterest')">
    <template #stats>
      <BizStat :label="t('loansUi.loanAssets')" :value="String(loanable.rows.value.length)" />
      <BizStat :label="t('loansUi.fromApr')" :value="minApr ? percent(minApr) : '—'" tone="accent" />
      <BizStat v-if="authed" :label="t('loansUi.activeLoans')" :value="String(ongoing.rows.value.length)" />
    </template>
    <template #aside>
      <div class="biz-aside-card ln-panel">
        <h3>{{ t('loansUi.borrow2') }}</h3>
        <label class="ln-sel"><span>{{ t('loansUi.borrow3') }}</span>
          <select v-model="loanCoin"><option v-for="r in loanable.rows.value" :key="field(r, 'loanCoin')" :value="field(r, 'loanCoin')">{{ field(r, 'loanCoin') }}</option></select></label>
        <label class="ln-sel"><span>{{ t('loansUi.collateral3') }}</span>
          <select v-model="collCoin"><option v-for="r in collateral.rows.value" :key="field(r, 'collateralCoin')" :value="field(r, 'collateralCoin')">{{ field(r, 'collateralCoin') }}</option></select></label>
        <div v-if="loanRow" class="biz-kv"><span>{{ t('loansUi.annualRate') }}</span><span class="num">{{ percent(field(loanRow, 'annualInterestRate')) }}</span></div>
        <div v-if="collRow" class="biz-kv"><span>{{ t('loansUi.initialLtv') }}</span><span class="num">{{ percent(field(collRow, 'initialLTV')) }}</span></div>
        <RouterLink v-if="!authed" class="btn btn-primary" to="/login">{{ t('loansUi.logInToBorrow') }}</RouterLink>
        <button v-else class="btn btn-primary" type="button" :disabled="!loanRow || !collRow || !canBorrow" @click="borrow">{{ canBorrow ? t('loansUi.borrowNow') : t('loansUi.newBorrowingPaused') }}</button>
      </div>
    </template>

    <section v-if="authed" class="biz-card">
      <header class="biz-card-head"><h2>{{ t('loansUi.activeLoans2') }}</h2></header>
      <div v-if="ongoing.rows.value.length" class="ln-grid">
        <article v-for="r in ongoing.rows.value" :key="field(r, 'orderId') || field(r, 'loanCoin') + field(r, 'collateralCoin')" class="ln-card">
          <header class="ln-head">
            <span class="biz-coin"><CoinMark :symbol="field(r, 'loanCoin')" :size="28" /><span>{{ field(r, 'loanCoin') }}<small>{{ t('loansUi.collateral3') }} {{ field(r, 'collateralCoin') }}</small></span></span>
            <span class="ln-ltv num" :class="ltvTone(r)">{{ percent(field(r, 'currentLTV')) }}</span>
          </header>
          <div class="ln-gauge"><div class="biz-bar"><i :class="ltvTone(r)" :style="{ width: `${progress(field(r, 'currentLTV'), liqLine(r) || '1')}%` }" /></div>
            <span class="biz-muted">{{ t('loansUi.ltvLiquidation') }} {{ percent(liqLine(r)) }}</span></div>
          <dl class="ln-facts">
            <div><dt>{{ t('loansUi.totalDebt') }}</dt><dd class="num">{{ amount(field(r, 'totalDebt')) }} {{ field(r, 'loanCoin') }}</dd></div>
            <div><dt>{{ t('loansUi.interest2') }}</dt><dd class="num">{{ amount(field(r, 'interest')) }}</dd></div>
            <div><dt>{{ t('loansUi.collateral5') }}</dt><dd class="num">{{ amount(field(r, 'collateralAmount')) }} {{ field(r, 'collateralCoin') }}</dd></div>
          </dl>
          <footer class="ln-actions">
            <button class="btn btn-primary" type="button" @click="repay(r, false)">{{ t('loansUi.repay3') }}</button>
            <button class="btn" type="button" @click="adjust(r)">{{ t('loansUi.adjust') }}</button>
            <button class="btn btn-ghost" type="button" @click="repay(r, true)">{{ t('loansUi.repayAll2') }}</button>
          </footer>
        </article>
      </div>
      <p v-else class="biz-empty" :class="{ err: ongoing.error.value }">{{ ongoing.loading.value ? t('loansUi.loading') : ongoing.error.value || t('loansUi.noActiveLoans') }}</p>
    </section>

    <section class="ln-rates">
      <div class="biz-card">
        <header class="biz-card-head"><h2>{{ t('loansUi.loanableAssets') }}</h2></header>
        <table class="table ln-table table-cards"><thead><tr><th class="left">{{ t('loansUi.asset') }}</th><th>{{ t('loansUi.annualRate') }}</th><th>{{ t('loansUi.limits') }}</th></tr></thead>
          <tbody><tr v-for="r in loanable.rows.value" :key="field(r, 'loanCoin')"><td class="left card-title" data-label=""><span class="biz-coin"><CoinMark :symbol="field(r, 'loanCoin')" :size="20" />{{ field(r, 'loanCoin') }}</span></td>
            <td class="num" :data-label="t('loansUi.annualRate')">{{ percent(field(r, 'annualInterestRate')) }}</td><td class="num" :data-label="t('loansUi.limits')">{{ amount(field(r, 'flexibleMinLimit')) }} – {{ amount(field(r, 'flexibleMaxLimit')) }}</td></tr></tbody></table>
      </div>
      <div class="biz-card">
        <header class="biz-card-head"><h2>{{ t('loansUi.collateralAssets') }}</h2></header>
        <table class="table ln-table table-cards"><thead><tr><th class="left">{{ t('loansUi.asset') }}</th><th>{{ t('loansUi.initialLtv') }}</th><th>{{ t('loansUi.marginCall') }}</th><th>{{ t('loansUi.liquidation') }}</th></tr></thead>
          <tbody><tr v-for="r in collateral.rows.value" :key="field(r, 'collateralCoin')"><td class="left card-title" data-label=""><span class="biz-coin"><CoinMark :symbol="field(r, 'collateralCoin')" :size="20" />{{ field(r, 'collateralCoin') }}</span></td>
            <td class="num" :data-label="t('loansUi.initialLtv')">{{ percent(field(r, 'initialLTV')) }}</td><td class="num" :data-label="t('loansUi.marginCall')">{{ percent(field(r, 'marginCallLTV')) }}</td><td class="num" :data-label="t('loansUi.liquidation')">{{ percent(field(r, 'liquidationLTV')) }}</td></tr></tbody></table>
      </div>
    </section>

    <BizRecords v-if="authed" :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />
    <BizDialog v-if="dlg" :open="true" :lang="lang" :title="dlg.title" :path="dlg.path" :fixed="dlg.fixed" :fields="dlg.fields" :summary="dlg.summary"
      :notes="dlg.notes" :agree="dlg.agree" :agreement-kind="dlg.agreementKind" :submit-text="dlg.submit" :danger="dlg.danger" @close="dlg = null" @done="reload" />
  </BizPage>
</template>

<style scoped>
.ln-panel { min-width: 320px; }
@media (max-width: 860px) { .ln-panel { min-width: 0; } }
.ln-sel { display: grid; grid-template-columns: 56px 1fr; align-items: center; gap: 8px; font-size: var(--font-size-sm); color: var(--color-text-muted); }
.ln-sel select { height: 40px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text); font-weight: 600; }
.ln-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 14px; padding: 18px 20px; }
.ln-card { display: grid; gap: 14px; padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
.ln-head { display: flex; align-items: center; justify-content: space-between; }
.ln-ltv { font-size: 20px; font-weight: 700; }
.ln-ltv.safe, .biz-bar i.safe { color: var(--color-up); }
.ln-ltv.warn { color: var(--color-warning); }
.ln-ltv.danger { color: var(--color-down); }
.biz-bar i.safe { background: var(--color-up); }
.biz-bar i.warn { background: var(--color-warning); }
.biz-bar i.danger { background: var(--color-down); }
.ln-gauge { display: grid; gap: 6px; font-size: var(--font-size-xs); }
.ln-facts { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.ln-facts dt { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.ln-facts dd { margin: 2px 0 0; white-space: normal; overflow-wrap: anywhere; font-weight: 600; font-size: var(--font-size-sm); }
.ln-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.ln-rates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.ln-table { table-layout: auto; }
.ln-table th:first-child, .ln-table td:first-child { padding-left: 20px; }
.ln-table th:last-child, .ln-table td:last-child { padding-right: 20px; }
.ln-table .left { text-align: left; }
@media (max-width: 860px) { .ln-rates { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 420px) { .ln-grid { padding: 14px; } .ln-card { padding: 14px; } .ln-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
