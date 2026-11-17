<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StateBlock from '@/components/common/StateBlock.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import FundingRateChart from '@/components/futures/FundingRateChart.vue'
import SizeUnitSelect from '@/components/futures/SizeUnitSelect.vue'
import { isApiError } from '@/core/errors'
import { canonicalDecimal, groupDigits } from '@/modules/finance/decimal'
import { fetchFeeRows, fetchFundingRateList } from '@/modules/futures/api'
import { depthDigitToStep, type FuturesContract } from '@/modules/futures/contracts'
import { amountText, formatDateTime } from '@/modules/futures/format'
import { feeForContract } from '@/modules/futures/fees'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { countdownText, fundingRateView, nextFundingTime } from '@/modules/futures/math'
import { signedPercent } from '@/modules/futures/signed'
import type { FeeRow, FundingRateList } from '@/modules/futures/types'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { useFuturesMarketStore } from '@/stores/futures-market'

/**
 * Futures data: funding-rate history (`common/funding_rate_list`), mark/index/funding
 * (`common/public_market_info`) and contract specifications (`common/public_info`).
 */
const { t } = useFuturesI18n()
const market = useFuturesMarketStore()

const PAGE_SIZE = 10
const funding = ref<FundingRateList | null>(null)
const fundingLoading = ref(false)
const fundingError = ref<string | null>(null)
const page = ref(1)
const fees = ref<FeeRow[] | null>(null)
const clock = ref(market.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
let infoTimer: ReturnType<typeof setInterval> | null = null
let request = 0

const contract = computed(() => market.currentContract)
const sizes = useSizeFormat()
/** Contract spec sizes in the chosen unit, with the contract count alongside (USDT at the last price). */
function specSize(contracts: string, entry: FuturesContract): string {
  const last = market.tickers[entry.wsSymbol]?.close ?? ''
  const shown = sizes.sizeWithUnit(contracts, entry, last)
  const raw = `${amountText(contracts)} ${t('fut.contracts')}`
  return shown === raw || shown === '--' ? raw : `${shown} (${raw})`
}
const totalPages = computed(() => Math.max(1, Math.ceil((funding.value?.count ?? 0) / PAGE_SIZE)))

function describe(error: unknown): string {
  return isApiError(error) ? error.message : error instanceof Error ? error.message : String(error)
}

async function loadFunding(): Promise<void> {
  const current = contract.value
  if (current === undefined) return
  const id = (request += 1)
  fundingLoading.value = true
  fundingError.value = null
  try {
    const result = await fetchFundingRateList(current.id, page.value, PAGE_SIZE)
    if (id === request) funding.value = result
  } catch (error) {
    if (id === request) fundingError.value = describe(error)
  } finally {
    if (id === request) fundingLoading.value = false
  }
}

/** Resolve the selected or table row's own fee schedule, independent of other markets. */
function rowFee(entry: FuturesContract | undefined): FeeRow | null {
  return feeForContract(entry, fees.value ?? [])
}
function feeText(entry: FuturesContract | undefined): string {
  const fee = rowFee(entry)
  if (fee === null) return '--'
  const pct = (value: string): string => signedPercent(value, 3, false)
  return `${pct(fee.openMakerFee)} / ${pct(fee.openTakerFee)} · ${pct(fee.closeMakerFee)} / ${pct(fee.closeTakerFee)}`
}

function tick(entry: FuturesContract): string {
  return depthDigitToStep(String(entry.pricePrecision)) || '--'
}

function price(value: string): string {
  const normalized = canonicalDecimal(value)
  return normalized === '' || contract.value === undefined ? '--' : groupDigits(normalized, contract.value.pricePrecision)
}

const current = computed(() => fundingRateView(market.marketInfo.currentFundRate))
const next = computed(() => fundingRateView(market.marketInfo.nextFundRate))
const countdown = computed(() => countdownText(nextFundingTime(clock.value, contract.value?.capitalStartTime ?? null, contract.value?.capitalFrequency ?? null), clock.value))

function choose(name: string): void {
  market.selectContract(name)
}

function changePage(delta: number): void {
  const nextPage = page.value + delta
  if (nextPage < 1 || nextPage > totalPages.value) return
  page.value = nextPage
  void loadFunding()
}

async function bootstrap(): Promise<void> {
  if (!market.loaded) {
    try {
      await market.loadPublicInfo()
    } catch {
      return
    }
  }
  void market.refreshMarketInfo()
  void loadFunding()
  fetchFeeRows().then((rows) => { fees.value = rows }).catch(() => { fees.value = [] })
}

watch(() => market.selectedName, () => {
  page.value = 1
  funding.value = null
  void market.refreshMarketInfo()
  void loadFunding()
})

onMounted(() => {
  void bootstrap()
  clockTimer = setInterval(() => { clock.value = market.now() }, 1000)
  infoTimer = setInterval(() => void market.refreshMarketInfo(), 10_000)
})
onBeforeUnmount(() => {
  if (clockTimer !== null) clearInterval(clockTimer)
  if (infoTimer !== null) clearInterval(infoTimer)
})
</script>

<template>
  <div class="page fdata">
    <header class="fdata-head">
      <div>
        <h1>{{ t('fut.dataTitle') }}</h1>
        <p class="muted">{{ t('fut.dataSubtitle') }}</p>
      </div>
      <RouterLink class="btn btn-primary" to="/futures">{{ t('fut.goTrade') }}</RouterLink>
    </header>

    <StateBlock v-if="market.error !== null" variant="error" :message="`${t('fut.loadFailed')}：${market.error}`" retryable @retry="bootstrap" />
    <StateBlock v-else-if="!market.loaded" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="market.contracts.length === 0" variant="empty" :message="t('fut.noContracts')" />

    <template v-else>
      <div class="chips" role="tablist">
        <button
          v-for="entry in market.contracts" :key="entry.contractName" type="button" role="tab" class="chip-btn"
          :class="{ active: entry.contractName === market.selectedName }" :aria-selected="entry.contractName === market.selectedName"
          @click="choose(entry.contractName)"
        >
          <CoinMark :symbol="entry.base" :size="16" />{{ entry.displayName }}
        </button>
      </div>

      <section class="stats">
        <div class="stat"><span>{{ t('fut.markPrice') }}</span><b class="num">{{ price(market.marketInfo.tagPrice) }}</b></div>
        <div class="stat"><span>{{ t('fut.indexPrice') }}</span><b class="num">{{ price(market.marketInfo.indexPrice) }}</b></div>
        <div class="stat"><span>{{ t('fut.fundingRate') }}</span><b class="num" :class="current.direction">{{ current.text }}</b></div>
        <div class="stat"><span>{{ t('fut.nextFundingRate') }}</span><b class="num" :class="next.direction">{{ next.text }}</b></div>
        <div class="stat"><span>{{ t('fut.countdown') }}</span><b class="num accent">{{ countdown }}</b></div>
      </section>
      <p v-if="market.marketInfoError !== null" class="notice notice-error wrap-anywhere">{{ market.marketInfoError }}</p>

      <section class="panel card">
        <header class="panel-header"><span class="panel-title">{{ t('fut.fundingChart') }} · {{ contract?.displayName }}</span></header>
        <div class="panel-body">
          <StateBlock v-if="fundingLoading && funding === null" variant="loading" :message="t('common.loading')" />
          <StateBlock v-else-if="fundingError !== null" variant="error" :message="fundingError" retryable @retry="loadFunding" />
          <FundingRateChart v-else :rows="funding?.line ?? []" :empty-text="t('common.empty')" />
        </div>
      </section>

      <div class="two-col">
        <section class="panel card">
          <header class="panel-header"><span class="panel-title">{{ t('fut.fundingHistory') }}</span></header>
          <div class="panel-body tight">
            <StateBlock v-if="fundingError === null && (funding?.history.length ?? 0) === 0 && !fundingLoading" variant="empty" />
            <div v-else-if="funding !== null" class="table-scroll">
              <table class="table fit-table">
                <thead><tr><th>{{ t('fut.settleTime') }}</th><th>{{ t('fut.contract') }}</th><th>{{ t('fut.rate') }}</th></tr></thead>
                <tbody>
                  <tr v-for="(row, index) in funding.history" :key="`${row.ctime}-${index}`">
                    <td class="num muted">{{ formatDateTime(row.ctime) }}</td>
                    <td>{{ contract?.displayName ?? row.contractName }}</td>
                    <td class="num" :class="fundingRateView(row.rate).direction">{{ fundingRateView(row.rate).text }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="(funding?.count ?? 0) > PAGE_SIZE" class="pager">
              <button class="btn btn-ghost" type="button" :disabled="page <= 1 || fundingLoading" @click="changePage(-1)">{{ t('common.prev') }}</button>
              <span class="muted num">{{ page }} / {{ totalPages }}</span>
              <button class="btn btn-ghost" type="button" :disabled="page >= totalPages || fundingLoading" @click="changePage(1)">{{ t('common.next') }}</button>
            </div>
          </div>
        </section>

        <section v-if="contract" class="panel card">
          <header class="panel-header"><span class="panel-title">{{ t('fut.specTitle') }} · {{ contract.displayName }}</span></header>
          <dl class="spec panel-body">
            <div><dt>{{ t('fut.contract') }}</dt><dd>{{ contract.contractName }}</dd></div>
            <div><dt>{{ t('fut.marginCoin') }}</dt><dd>{{ contract.marginCoin }}</dd></div>
            <div><dt>{{ t('fut.multiplier') }}</dt><dd class="num">{{ canonicalDecimal(contract.multiplier) || '--' }} {{ contract.multiplierCoin }}</dd></div>
            <div><dt>{{ t('fut.tickSize') }}</dt><dd class="num">{{ tick(contract) }} {{ contract.quote }}</dd></div>
            <div><dt>{{ t('fut.leverageRange2') }}</dt><dd class="num">{{ contract.minLever }}x – {{ contract.maxLever }}x</dd></div>
            <div><dt>{{ t('fut.minVolume') }}</dt><dd class="num">{{ specSize(contract.minOrderVolume, contract) }}</dd></div>
            <div><dt>{{ t('fut.maxVolume') }}</dt><dd class="num">{{ specSize(contract.maxLimitVolume, contract) }}</dd></div>
            <div><dt>{{ t('fut.fundingInterval') }}</dt><dd>{{ contract.capitalFrequency === null ? '--' : t('fut.hours', { n: contract.capitalFrequency }) }}</dd></div>
            <div class="fees"><dt>{{ t('fut.fees') }}</dt><dd class="num" :title="rowFee(contract) === null ? t('fut.feesUnavailable') : ''">{{ feeText(contract) }}</dd></div>
          </dl>
        </section>
      </div>

      <section class="panel card">
        <header class="panel-header"><span class="panel-title">{{ t('fut.specTitle') }}</span><SizeUnitSelect :contract="contract" /></header>
        <div class="table-scroll">
          <table class="table spec-table">
            <thead>
              <tr>
                <th>{{ t('fut.contract') }}</th>
                <th>{{ t('fut.marginCoin') }}</th>
                <th>{{ t('fut.multiplier') }}</th>
                <th>{{ t('fut.tickSize') }}</th>
                <th>{{ t('fut.leverageRange2') }}</th>
                <th>{{ t('fut.minVolume') }}</th>
                <th>{{ t('fut.fundingInterval') }}</th>
                <th>{{ t('fut.fees') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in market.contracts" :key="entry.contractName">
                <td><span class="name"><CoinMark :symbol="entry.base" :size="18" /><b>{{ entry.displayName }}</b></span></td>
                <td>{{ entry.marginCoin }}</td>
                <td class="num">{{ canonicalDecimal(entry.multiplier) || '--' }} {{ entry.multiplierCoin }}</td>
                <td class="num">{{ tick(entry) }}</td>
                <td class="num">{{ entry.minLever }}–{{ entry.maxLever }}x</td>
                <td class="num">{{ specSize(entry.minOrderVolume, entry) }}</td>
                <td>{{ entry.capitalFrequency === null ? '--' : t('fut.hours', { n: entry.capitalFrequency }) }}</td>
                <td class="num" :title="rowFee(entry) === null ? t('fut.feesUnavailable') : ''">{{ feeText(entry) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="fees !== null && rowFee(contract) === null" class="fee-note muted">{{ t('fut.feesUnavailable') }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.fdata { display: flex; flex-direction: column; gap: 16px; }
.fdata-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.fdata-head h1 { margin: 0 0 4px; font-size: 26px; }
.fdata-head p { margin: 0; font-size: 13px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 999px; font-size: 13px; font-weight: 650; color: var(--color-text-secondary); background: var(--color-surface); }
.chip-btn:hover { color: var(--color-text); border-color: var(--color-text-muted); }
.chip-btn.active { border-color: var(--color-accent); color: var(--color-accent-text); background: var(--color-accent-soft); }
.stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.stat { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface); }
.stat span { color: var(--color-text-muted); font-size: 12px; }
.stat b { font-size: 18px; font-weight: 700; }
.stat .up { color: var(--color-up); }
.stat .down { color: var(--color-down); }
.stat .accent { color: var(--color-accent-text); }
.card { overflow: hidden; }
.two-col { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 16px; }
.tight { padding: 0 4px 6px; }
.table td { font-size: 12px; }
.table .up { color: var(--color-up); }
.table .down { color: var(--color-down); }
.spec { display: grid; gap: 10px; margin: 0; }
.spec div { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.spec dt { color: var(--color-text-muted); }
.spec dd { margin: 0; text-align: right; }
.spec .fees { flex-direction: column; gap: 4px; }
.spec .fees dd { text-align: left; }
.table-scroll { overflow-x: auto; }
/* Columns sized by content, not split evenly by the global `table-layout: fixed` (which cut the close fees and the
   settlement time to「…」, QA-060/061); the wrapper scrolls when the content is wider than the card. */
.spec-table { width: max(100%, 900px); table-layout: auto; }
.fit-table { table-layout: auto; }
.name { display: inline-flex; align-items: center; gap: 7px; }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 8px; font-size: 12px; }
.fee-note { margin: 0; padding: 10px 16px 14px; font-size: 12px; }
.notice { margin: 0; }
@media (max-width: 960px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .two-col { grid-template-columns: minmax(0, 1fr); }
}
</style>
