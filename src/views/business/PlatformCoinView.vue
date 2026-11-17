<script setup lang="ts">
/** 平台币: fee-discount preferences (spot + futures, like Binance "Use BNB to pay fees"), dividends, trade mining, burns. */
import { computed, onMounted, ref, watch } from 'vue'
import { Coins } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import { useBizContext, useBizQuery } from '@/components/business/ui/useBiz'
import { businessRequest, rowOf, valueAt } from '@/modules/business/client'
import { field, percent } from '@/modules/business/format'
import { Decimal, isDecimalString } from '@/modules/finance/decimal'
import { toastError, toastSuccess } from '@/core/toast'

const PC = '/sapi/v1/platcoin'
const { lang, authed, t } = useBizContext()
const info = useBizQuery(() => `${PC}/info`, () => ({}), '')
const spotPref = useBizQuery(() => (authed.value ? `${PC}/feeBurn` : null), () => ({}), '')
const futPref = useBizQuery(() => (authed.value ? '/fapi/v1/feeBurn' : null), () => ({}), '')
function reload() { void info.load(); void spotPref.load(); void futPref.load() }
onMounted(reload)
watch(authed, reload)

const notIssued = computed(() => info.errorCode.value === '-1300' || (!info.loading.value && !info.error.value && field(info.rows.value[0] ?? {}, 'asset') === ''))
const rule = computed(() => info.rows.value[0] ?? rowOf(null))
const coin = computed(() => field(rule.value, 'asset'))
/** "0.75" multiplier → "25% off". */
function discount(mult: string): string {
  if (!isDecimalString(mult)) return '—'
  const off = new Decimal(1).minus(mult)
  return off.gt(0) ? t('platformcoinUi.off', { toFixed: percent(off.toFixed()) }) : t('platformcoinUi.noDiscount')
}
const spotOn = computed(() => valueAt(spotPref.rows.value[0] ?? {}, 'spotFeeDeduct') === true)
const futOn = computed(() => valueAt(futPref.rows.value[0] ?? {}, 'feeBurn') === true)
const saving = ref('')
async function setPref(kind: 'spot' | 'futures', on: boolean) {
  saving.value = kind
  try {
    if (kind === 'spot') await businessRequest(`${PC}/feeBurn`, { spotFeeDeduct: on ? 'true' : 'false' }, true)
    else await businessRequest('/fapi/v1/feeBurn', { feeBurn: on ? 'true' : 'false' }, true)
    toastSuccess(t('platformcoinUi.updated'))
    void spotPref.load(); void futPref.load()
  } catch (e) { toastError(e instanceof Error ? e.message : String(e)) }
  finally { saving.value = '' }
}
const recordTabs = computed<RecordTab[]>(() => [
  { id: 'div', label: t('platformcoinUi.dividends'), path: `${PC}/dividends`, paging: true, columns: [
    { key: 'periodEnd', label: t('platformcoinUi.period'), kind: 'date' }, { key: 'asset', label: t('platformcoinUi.asset'), kind: 'asset' },
    { key: 'avgHolding', label: t('platformcoinUi.avgHolding'), kind: 'amount' }, { key: 'amount', label: t('platformcoinUi.dividend'), kind: 'amount', unit: 'asset' }, { key: 'status', label: t('platformcoinUi.status'), kind: 'status' }] },
  { id: 'mine', label: t('platformcoinUi.tradeMining'), path: `${PC}/mining`, paging: true, columns: [
    { key: 'date', label: t('platformcoinUi.date'), kind: 'date' }, { key: 'feeUsdt', label: t('platformcoinUi.feesUsdt'), kind: 'amount' },
    { key: 'reward', label: t('platformcoinUi.reward'), kind: 'amount', unit: 'asset' }, { key: 'status', label: t('platformcoinUi.status'), kind: 'status' }] },
])
</script>

<template>
  <BizPage :eyebrow="t('platformcoinUi.platformToken')" :title="t('platformcoinUi.holdThePlatformTokenGetMore')"
    :subtitle="t('platformcoinUi.payFeesWithThePlatformTokenForADiscount')">
    <section v-if="notIssued" class="biz-card pc-soon">
      <Coins :size="40" class="pc-soon-icon" />
      <h2>{{ t('platformcoinUi.platformTokenComingSoon') }}</h2>
      <p class="biz-muted">{{ t('platformcoinUi.onceLaunchedYouCanEnableFeeDiscountsAndTrack') }}</p>
    </section>
    <template v-else>
      <section class="pc-benefits">
        <article class="biz-card pc-benefit">
          <span class="biz-coin"><CoinMark :symbol="coin" :size="30" /><span>{{ t('platformcoinUi.spotFeeDiscount') }}<small>{{ discount(field(rule, 'spotDiscount')) }}</small></span></span>
          <div class="pc-toggle">
            <span class="biz-muted">{{ t('platformcoinUi.useToPaySpotFees', { coin }) }}</span>
            <button class="biz-switch" :class="{ on: spotOn }" type="button" :disabled="!authed || saving !== '' || valueAt(rule, 'spotFeeDeduct') !== true" :aria-label="t('platformcoinUi.spotDeduction')" @click="setPref('spot', !spotOn)" />
          </div>
        </article>
        <article class="biz-card pc-benefit">
          <span class="biz-coin"><CoinMark :symbol="coin" :size="30" /><span>{{ t('platformcoinUi.futuresFeeDiscount') }}<small>{{ discount(field(rule, 'futuresDiscount')) }}</small></span></span>
          <div class="pc-toggle">
            <span class="biz-muted">{{ t('platformcoinUi.useToPayFuturesFees', { coin }) }}</span>
            <button class="biz-switch" :class="{ on: futOn }" type="button" :disabled="!authed || saving !== ''" :aria-label="t('platformcoinUi.futuresDeduction')" @click="setPref('futures', !futOn)" />
          </div>
        </article>
        <article class="biz-card pc-benefit">
          <span class="biz-coin"><CoinMark :symbol="coin" :size="30" /><span>{{ t('platformcoinUi.holderDividends') }}<small>{{ valueAt(rule, 'dividend') === true ? t('platformcoinUi.active') : t('platformcoinUi.notActive') }}</small></span></span>
          <p class="biz-muted pc-desc">{{ t('platformcoinUi.platformRevenueIsSharedByAverageHoldingPerPeriod') }}</p>
        </article>
        <article class="biz-card pc-benefit">
          <span class="biz-coin"><CoinMark :symbol="coin" :size="30" /><span>{{ t('platformcoinUi.tradeMining') }}<small>{{ valueAt(rule, 'mining') === true ? t('platformcoinUi.active') : t('platformcoinUi.notActive') }}</small></span></span>
          <p class="biz-muted pc-desc">{{ t('platformcoinUi.earnPlatformTokensBackFromYourDailyTradingFees') }}</p>
        </article>
      </section>
      <p v-if="!authed" class="biz-notice">{{ t('platformcoinUi.logInToEnableFeeDiscountsAndViewYour') }}</p>
      <BizRecords v-else :lang="lang" :tabs="recordTabs" />
    </template>
  </BizPage>
</template>

<style scoped>
.pc-soon { display: grid; justify-items: center; gap: 10px; padding: 56px 24px; text-align: center; }
.pc-soon h2 { margin: 0; font-size: 22px; }
.pc-soon p { margin: 0; max-width: 520px; line-height: 1.6; }
.pc-soon-icon { color: var(--color-accent); }
.pc-benefits { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.pc-benefit { display: grid; gap: 14px; padding: 20px; align-content: start; }
.pc-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: var(--font-size-sm); }
.pc-desc { margin: 0; font-size: var(--font-size-sm); line-height: 1.6; }
</style>
