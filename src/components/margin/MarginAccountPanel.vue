<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, HandCoins, Info, RotateCw, Undo2 } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import RiskGauge from './RiskGauge.vue'
import { canonicalDecimal, isDecimalString, isPositive, sum } from '@/modules/finance/decimal'
import { useMarginI18n } from '@/modules/margin/i18n'
import { displayAmount, formatBurstPrice, formatDailyRate, hasBorrowRule, netAssetsInQuote, accountRiskBand } from '@/modules/margin/risk'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'

const emit = defineEmits<{ (event: 'borrow', coin: string): void; (event: 'repay'): void; (event: 'transfer', coin: string): void }>()

const { t } = useMarginI18n()
const margin = useMarginStore()
const market = useMarketStore()

const acc = computed(() => margin.account)
const pricePrecision = computed(() => market.currentSymbol?.pricePrecision ?? 2)
const hasBorrowing = computed<boolean | null>(() => {
  const value = acc.value
  if (value === null || !isDecimalString(value.baseBorrowBalance) || !isDecimalString(value.quoteBorrowBalance)) return null
  return isPositive(value.baseBorrowBalance) || isPositive(value.quoteBorrowBalance)
})
const band = computed(() => accountRiskBand(acc.value?.riskRate ?? '', hasBorrowing.value))
const ruleSet = computed(() => acc.value !== null && hasBorrowRule(acc.value))

/** Interest owed per coin, summed from open loans — only when every open loan is loaded. */
function openInterest(coin: string): string {
  const list = margin.borrows.open
  if (margin.borrowCounts.open > list.length) return ''
  const values = list.filter(entry => entry.coin === coin && isDecimalString(entry.oweInterest)).map(entry => entry.oweInterest)
  return values.length === 0 ? (margin.borrowCounts.open === 0 && !margin.borrowLoading.open && margin.borrowErrors.open === null ? '0' : '') : sum(values)
}

const rows = computed(() => {
  const value = acc.value
  if (value === null) return []
  return [
    { coin: value.baseCoin, total: value.baseTotalBalance, available: value.baseNormalBalance, borrowed: value.baseBorrowBalance, canBorrow: value.baseCanBorrow, interest: openInterest(value.baseCoin) },
    { coin: value.quoteCoin, total: value.quoteTotalBalance, available: value.quoteNormalBalance, borrowed: value.quoteBorrowBalance, canBorrow: value.quoteCanBorrow, interest: openInterest(value.quoteCoin) },
  ]
})

const netAssets = computed(() => {
  const value = acc.value
  if (value === null) return ''
  return netAssetsInQuote({
    baseTotalBalance: value.baseTotalBalance,
    baseBorrowBalance: value.baseBorrowBalance,
    quoteTotalBalance: value.quoteTotalBalance,
    quoteBorrowBalance: value.quoteBorrowBalance,
    price: canonicalDecimal(market.ticker.close),
  })
})

const show = displayAmount

function refresh(): void {
  void margin.loadAccount()
  void margin.loadBorrows('open')
}
</script>

<template>
  <section class="margin-account" :aria-label="t('margin.account')">
    <header class="head">
      <span class="title">{{ t('margin.account') }}</span>
      <span class="tag">{{ t('margin.isolated') }}</span>
      <button class="icon-button refresh" type="button" :disabled="margin.accountLoading" :title="t('margin.refresh')" :aria-label="t('margin.refresh')" @click="refresh">
        <RotateCw :size="14" :class="{ spin: margin.accountLoading }" aria-hidden="true" />
      </button>
    </header>

    <!-- A failed refresh keeps the last snapshot (with the reason below the risk block); the error block is for "nothing yet". -->
    <StateBlock v-if="margin.accountError !== null && acc === null" variant="error" :message="margin.accountError" retryable @retry="refresh" />
    <StateBlock v-else-if="acc === null && margin.accountLoading" variant="loading" :message="t('common.loading')" />
    <template v-else-if="acc !== null">
      <div class="risk">
        <!-- float-ok: not money (kebab-case prop name risk-rate) -->
        <RiskGauge :risk-rate="acc.riskRate" :has-borrowing="hasBorrowing" :band-label="t(`margin.band.${band}`)" :label="t('margin.riskRate')" />
        <dl class="stats">
          <div>
            <dt>{{ t('margin.burstPrice') }}</dt>
            <dd class="num" :class="{ down: band === 'danger' || band === 'liquidation' }" data-testid="burst-price">{{ formatBurstPrice(acc.burstPrice, pricePrecision) }}</dd>
          </div>
          <div>
            <dt :title="t('margin.netAssetsHint')">{{ t('margin.netAssets') }} <Info :size="11" aria-hidden="true" /></dt>
            <dd class="num" :title="`${netAssets} ${acc.quoteCoin} · ${t('margin.displayTruncated')}`">{{ show(netAssets, pricePrecision) }} <small>{{ acc.quoteCoin }}</small></dd>
          </div>
          <div>
            <dt>{{ t('margin.dailyRate') }}</dt>
            <dd class="num">{{ ruleSet ? formatDailyRate(acc.rate) : t('margin.ruleMissing') }}</dd>
          </div>
          <div>
            <dt>{{ t('margin.maxLeverage') }}</dt>
            <dd class="num">{{ ruleSet ? `${acc.multiple}x` : t('margin.ruleMissing') }}</dd>
          </div>
        </dl>
      </div>

      <p v-if="margin.accountError !== null" class="field-error refresh-error wrap-anywhere">{{ margin.accountError }}</p>
      <ul class="coins">
        <li v-for="row in rows" :key="row.coin" class="coin-row">
          <div class="coin-head"><b>{{ row.coin }}</b><span class="num">{{ t('margin.total') }} {{ show(row.total) }}</span></div>
          <dl class="coin-grid">
            <div><dt>{{ t('margin.available') }}</dt><dd class="num">{{ show(row.available) }}</dd></div>
            <div><dt>{{ t('margin.borrowed') }}</dt><dd class="num">{{ show(row.borrowed) }}</dd></div>
            <div><dt>{{ t('margin.canBorrow') }}</dt><dd class="num">{{ show(row.canBorrow) }}</dd></div>
            <div><dt>{{ t('margin.interest') }}</dt><dd class="num">{{ show(row.interest) }}</dd></div>
          </dl>
        </li>
      </ul>

      <div class="actions">
        <button class="btn btn-primary" type="button" data-testid="open-borrow" @click="emit('borrow', acc.quoteCoin)"><HandCoins :size="14" aria-hidden="true" />{{ t('margin.borrow') }}</button>
        <button class="btn" type="button" data-testid="open-repay" @click="emit('repay')"><Undo2 :size="14" aria-hidden="true" />{{ t('margin.repay') }}</button>
        <button class="btn" type="button" data-testid="open-transfer" @click="emit('transfer', acc.quoteCoin)"><ArrowLeftRight :size="14" aria-hidden="true" />{{ t('margin.transfer') }}</button>
      </div>
      <p class="legend">{{ t('margin.riskLegend') }}</p>
      <p v-if="acc.riskRate !== '' && acc.riskRate !== '0'" class="legend muted-note">{{ t('margin.riskStale') }}</p>
    </template>
  </section>
</template>

<style scoped>
.margin-account { background: var(--color-surface); }
.head { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--color-border); }
.title { font-family: var(--font-display); font-size: 14px; font-weight: 650; }
.tag { height: 18px; padding: 0 6px; border-radius: 4px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 10.5px; font-weight: 700; line-height: 18px; }
.refresh { margin-left: auto; width: 30px; height: 30px; flex-basis: 30px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.risk { display: grid; grid-template-columns: minmax(0, 1fr); justify-items: center; gap: 10px; padding: 14px 12px 6px; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; width: 100%; margin: 0; }
.stats div { min-width: 0; padding: 8px 10px; border-radius: 9px; background: var(--color-surface-alt); }
.stats dt { display: flex; align-items: center; gap: 3px; color: var(--color-text-muted); font-size: 11px; }
.stats dd { margin: 3px 0 0; font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; }
.stats small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 10.5px; }
.coins { display: grid; gap: 0; margin: 4px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--color-border); }
.coin-row { padding: 9px 12px; border-bottom: 1px solid var(--color-border); }
.coin-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12.5px; }
.coin-head .num { color: var(--color-text-secondary); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }
.coin-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 12px; margin: 6px 0 0; }
.coin-grid div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 6px; min-width: 0; font-size: 11.5px; }
.coin-grid dt { color: var(--color-text-muted); white-space: nowrap; }
.coin-grid dd { margin: 0 0 0 auto; min-width: 0; max-width: 100%; overflow-wrap: anywhere; text-align: right; }
.actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 12px 12px 4px; }
.actions .btn { height: 34px; padding: 0 6px; gap: 4px; font-size: 12px; }
.refresh-error { margin: 4px 12px 0; }
.legend { margin: 6px 12px 0; color: var(--color-text-muted); font-size: 10.5px; line-height: 1.5; }
.muted-note { margin-bottom: 10px; opacity: 0.85; }
.legend:last-child { margin-bottom: 12px; }
</style>
