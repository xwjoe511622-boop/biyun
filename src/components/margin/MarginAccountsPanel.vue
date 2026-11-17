<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeftRight, ChartCandlestick, RotateCw } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { useMarginI18n } from '@/modules/margin/i18n'
import { displayAmount } from '@/modules/margin/risk'
import { formatBurstPrice, formatDailyRate, formatRiskRate, hasBorrowRule, riskBand, riskColor } from '@/modules/margin/risk'
import type { MarginSymbolAccount } from '@/modules/margin/types'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'

/** Assets page → 杠杆账户: every margin pair from POST lever/finance/balance (`leverMap`). */
const emit = defineEmits<{ (event: 'transfer', payload: { symbol: string; coin: string }): void }>()

const { t } = useMarginI18n()
const margin = useMarginStore()
const market = useMarketStore()
const router = useRouter()

const overview = computed(() => margin.overview)
const accounts = computed(() => overview.value?.accounts ?? [])

function show(value: string, dp = 8): string {
  return displayAmount(value, dp)
}

function precisionFor(account: MarginSymbolAccount): number {
  return market.symbols.find(entry => entry.symbol === account.symbol)?.pricePrecision ?? 8
}

function trade(account: MarginSymbolAccount): void {
  if (account.name !== '') market.selectPair(account.name)
  void router.push('/margin')
}

onMounted(() => {
  void margin.loadOverview()
})
</script>

<template>
  <div class="margin-accounts stack">
    <section class="summary">
      <div>
        <span class="summary-label">{{ t('margin.assets.total') }}</span>
        <strong class="summary-value num">{{ show(overview?.totalBalance ?? '') }} <small>{{ overview?.totalBalanceSymbol ?? '' }}</small></strong>
      </div>
      <button class="btn btn-ghost" type="button" :disabled="margin.overviewLoading" @click="margin.loadOverview()">
        <RotateCw :size="14" aria-hidden="true" />{{ margin.overviewLoading ? t('common.loading') : t('common.refresh') }}
      </button>
    </section>

    <StateBlock v-if="margin.overviewLoading && overview === null" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="margin.overviewError !== null" variant="error" :message="margin.overviewError" retryable @retry="margin.loadOverview()" />
    <StateBlock v-else-if="accounts.length === 0" variant="empty" :message="t('margin.assets.empty')" />
    <div v-else class="cards">
      <article v-for="account in accounts" :key="account.symbol" class="card" data-testid="margin-account-card">
        <header class="card-head">
          <CoinMark :symbol="account.baseCoin" :size="28" />
          <div class="card-title">
            <strong>{{ account.name }}</strong>
            <span class="muted">{{ t('margin.isolated') }}<template v-if="hasBorrowRule(account)"> · {{ account.multiple }}x · {{ t('margin.dailyRate') }} {{ formatDailyRate(account.rate) }}</template><template v-else> · {{ t('margin.dailyRate') }} {{ t('margin.ruleMissing') }}</template></span>
          </div>
          <span class="risk" :style="{ color: riskColor(riskBand(account.riskRate)), borderColor: riskColor(riskBand(account.riskRate)) }">
            {{ t('margin.riskRate') }} {{ formatRiskRate(account.riskRate) }} · {{ t(`margin.band.${riskBand(account.riskRate)}`) }}
          </span>
        </header>
        <table class="table coin-table">
          <thead>
            <tr><th>{{ t('margin.coin') }}</th><th>{{ t('margin.total') }}</th><th>{{ t('margin.available') }}</th><th>{{ t('margin.locked') }}</th><th>{{ t('margin.borrowed') }}</th><th>{{ t('margin.canBorrow') }}</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{{ account.baseCoin }}</td><td class="num">{{ show(account.baseTotalBalance) }}</td><td class="num">{{ show(account.baseNormalBalance) }}</td>
              <td class="num">{{ show(account.baseLockBalance) }}</td><td class="num">{{ show(account.baseBorrowBalance) }}</td><td class="num">{{ show(account.baseCanBorrow) }}</td>
            </tr>
            <tr>
              <td>{{ account.quoteCoin }}</td><td class="num">{{ show(account.quoteTotalBalance) }}</td><td class="num">{{ show(account.quoteNormalBalance) }}</td>
              <td class="num">{{ show(account.quoteLockBalance) }}</td><td class="num">{{ show(account.quoteBorrowBalance) }}</td><td class="num">{{ show(account.quoteCanBorrow) }}</td>
            </tr>
          </tbody>
        </table>
        <footer class="card-foot">
          <span class="muted">{{ t('margin.burstPrice') }} <span class="num">{{ formatBurstPrice(account.burstPrice, precisionFor(account)) }}</span> {{ account.quoteCoin }}</span>
          <span class="muted">≈ <span class="num">{{ show(account.symbolBalance) }}</span> {{ overview?.totalBalanceSymbol ?? '' }}</span>
          <span class="spacer"></span>
          <button class="btn" type="button" @click="emit('transfer', { symbol: account.symbol, coin: account.quoteCoin })"><ArrowLeftRight :size="14" />{{ t('margin.transfer') }}</button>
          <button class="btn btn-primary" type="button" @click="trade(account)"><ChartCandlestick :size="14" />{{ t('margin.assets.trade') }}</button>
        </footer>
      </article>
    </div>
  </div>
</template>

<style scoped>
.margin-accounts { gap: 16px; margin-top: 8px; }
.summary {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 24px 28px;
  border: 1px solid var(--color-border); border-radius: 18px;
  background: radial-gradient(ellipse 50% 140% at 100% 0%, var(--color-accent-soft), transparent 60%), var(--color-surface);
}
.summary-label { color: var(--color-text-muted); font-size: 13px; }
.summary-value { display: block; margin-top: 6px; font-size: 30px; font-weight: 650; letter-spacing: -0.02em; }
.summary-value small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 14px; font-weight: 600; }
.cards { display: grid; gap: 12px; }
.card { border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); overflow: hidden; }
.card-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 18px; border-bottom: 1px solid var(--color-border); }
.card-title { display: flex; flex-direction: column; min-width: 0; }
.card-title strong { font-family: var(--font-display); font-size: 15px; }
.card-title .muted { font-size: 12px; }
.risk { margin-left: auto; padding: 3px 10px; border: 1px solid; border-radius: 999px; font-size: 12px; font-weight: 650; font-family: var(--font-mono); }
.coin-table { table-layout: auto; }
.coin-table th, .coin-table td { font-size: 12.5px; }
.coin-table th:first-child, .coin-table td:first-child { padding-left: 18px; font-weight: 650; }
.coin-table th:last-child, .coin-table td:last-child { padding-right: 18px; }
.card-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 18px; font-size: 12px; }
.card-foot .btn { height: 34px; }
.spacer { flex: 1 1 auto; }
@media (max-width: 720px) {
  .coin-table { display: block; overflow-x: auto; }
  .risk { margin-left: 0; }
}
</style>
