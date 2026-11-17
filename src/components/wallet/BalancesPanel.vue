<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, RotateCw, Search } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import AssetValuation from '@/components/wallet/AssetValuation.vue'
import PortfolioValuationDetails from '@/components/wallet/PortfolioValuationDetails.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { buildCoinRows, coinMeta, isZeroRow, type CoinRow } from '@/modules/wallet/coins'
import { useValuationPrefs } from '@/modules/wallet/use-valuation'
import { sum } from '@/modules/finance/decimal'
import { byDecimalDesc } from '@/components/home/binance/use-home-markets'
import { HIDDEN_MASK, coinBtcValue, coinUsdValue, formatCoinAmount, formatValuation, usdLine } from '@/modules/wallet/valuation'
import { WALLET_MESSAGES } from '@/modules/wallet/i18n'
import { availableBalance, findCoinBalance, lockedBalance } from '@/modules/market/symbols'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { PORTFOLIO_MESSAGES, usePortfolioOverview } from '@/modules/wallet/use-portfolio-overview'

/**
 * `overview`: whole-portfolio total (spot + futures + margin) above the spot holdings.
 * `spot`: the spot account on its own — its total is the sum of the spot holdings only.
 */
const props = withDefaults(defineProps<{ scope?: 'overview' | 'spot' }>(), { scope: 'overview' })
const emit = defineEmits<{ (event: 'select', coin: string, action?: 'deposit' | 'withdraw'): void }>()
const { t } = useI18n({ useScope: 'local', messages: {
  'zh-CN': { ...WALLET_MESSAGES['zh-CN'], ...PORTFOLIO_MESSAGES['zh-CN'], spotTotal: '现货账户资产', spotScope: '现货账户内全部币种的可用与冻结余额，按行情估值。', searchEmpty: '没有匹配的资产，请更换搜索条件。', zeroFiltered: '匹配的资产均为零余额，取消“隐藏零余额”即可查看。', btcUnavailable: '暂无数据', btcUnavailableReason: '缺少当前余额或折合 BTC 所需的行情，暂不估值。' },
  'en-US': { ...WALLET_MESSAGES['en-US'], ...PORTFOLIO_MESSAGES['en-US'], spotTotal: 'Spot account', spotScope: 'Available and frozen balances of every coin in the spot account, valued at market prices.', searchEmpty: 'No assets match your search. Try another search.', zeroFiltered: 'Matching assets have zero balances. Clear “Hide zero balances” to show them.', btcUnavailable: 'Unavailable', btcUnavailableReason: 'A current balance or market quote required for BTC valuation is unavailable.' },
} })

const account = useAccountStore()
const market = useMarketStore()
const sessionStore = useSessionStore()
const { total: overviewTotal, balance: overviewBalance, unrealized: overviewPnl, readAtMs: overviewReadAt, loading: overviewLoading, unavailable: overviewFailed, reload: load, spotReady } = usePortfolioOverview()

const search = ref('')
/** Phones: coins whose card is expanded (available / frozen / BTC value / deposit & withdraw). */
const expanded = ref<Set<string>>(new Set())
function toggle(coin: string): void {
  const next = new Set(expanded.value)
  if (next.has(coin)) next.delete(coin)
  else next.add(coin)
  expanded.value = next
}
/** Phones (owner 2026-11-17): holdings by value, zero balances hidden until the user asks for them. */
const phone = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches
const hideZero = ref(phone)

const allRows = computed<CoinRow[]>(() => spotReady.value ? buildCoinRows(account.allCoinMap, market.publicInfo) : [])
const matchingRows = computed<CoinRow[]>(() => {
  const needle = search.value.trim().toUpperCase()
  return allRows.value.filter((row) => {
    if (needle === '') {
      return true
    }
    return row.coin.includes(needle) || row.showName.toUpperCase().includes(needle)
  })
})
const rows = computed(() => matchingRows.value.filter(row => !hideZero.value || !isZeroRow(row)))
const cardRows = computed(() => [...rows.value].sort(byDecimalDesc((row: CoinRow) => coinUsdValue(row.coin, row.total, row.btcValuation, market.tickers))))
const emptyMessage = computed(() => allRows.value.length === 0 ? t('assets.empty')
  : matchingRows.value.length === 0 ? t('searchEmpty') : t('zeroFiltered'))

const valuation = useValuationPrefs()

/** Spot-only total in BTC: the sum of each holding's BTC value ('' when any quote is missing). */
const spotTotalBtc = computed(() => {
  if (!spotReady.value) return ''
  const values = allRows.value.map(row => coinBtcValue(row.coin, row.total, market.tickers))
  return values.some(value => value === '') ? '' : sum(values)
})

// A transfer moves value between spot, futures and margin; the parent reloads all three (QA-072).
defineExpose({ reload: load })

/** Coin amount at the coin's display precision (max 8, trailing zeros trimmed); masked when hidden. */
function format(value: string, coin: string): string {
  if (valuation.hidden.value) return HIDDEN_MASK
  return value === '' ? '--' : formatCoinAmount(value, coinMeta(market.publicInfo, coin).showPrecision)
}

function btcValue(row: CoinRow): string {
  if (valuation.hidden.value) return HIDDEN_MASK
  const value = coinBtcValue(row.coin, row.total, market.tickers)
  return value === '' ? t('btcUnavailable') : formatValuation(value, 'BTC')
}

function btcTitle(row: CoinRow): string | undefined {
  return !valuation.hidden.value && coinBtcValue(row.coin, row.total, market.tickers) === '' ? t('btcUnavailableReason') : undefined
}

function usdValue(row: CoinRow): string {
  return valuation.hidden.value ? '' : usdLine(coinUsdValue(row.coin, row.total, row.btcValuation, market.tickers))
}

/** Keeps the table honest about which balances are actually loaded. */
function rowAvailable(row: CoinRow): string {
  const entry = findCoinBalance(account.allCoinMap, row.coin)
  return availableBalance(entry)
}

function rowLocked(row: CoinRow): string {
  const entry = findCoinBalance(account.allCoinMap, row.coin)
  return lockedBalance(entry)
}
</script>

<template>
  <div class="stack balances">
    <section class="summary">
      <div class="summary-main">
        <template v-if="props.scope === 'spot'">
          <AssetValuation :label="t('spotTotal')" :total="spotTotalBtc" symbol="BTC" :rows="allRows" :max-font="34" />
          <small class="overview-scope">{{ t('spotScope') }}</small>
        </template>
        <template v-else>
          <AssetValuation :label="t('portfolioTotal')" :total="overviewTotal" symbol="USDT" :max-font="34" />
          <PortfolioValuationDetails :balance="overviewBalance" :unrealized="overviewPnl" :read-at-ms="overviewReadAt" />
          <small class="overview-scope scope-note">{{ t('portfolioScope') }}</small>
          <small v-if="overviewLoading" class="overview-scope" role="status">{{ t(overviewTotal === '' ? 'portfolioLoading' : 'portfolioRefreshing') }}</small>
          <small v-else-if="overviewFailed" class="overview-scope" role="status">{{ t('portfolioFailed') }}</small>
        </template>
      </div>
      <div class="summary-actions">
        <button class="btn btn-primary summary-move" type="button" @click="emit('select', rows[0]?.coin ?? '', 'deposit')"><ArrowDownToLine :size="15" />{{ t('wallet.tab.deposit') }}</button>
        <button class="btn summary-move" type="button" @click="emit('select', rows[0]?.coin ?? '', 'withdraw')"><ArrowUpFromLine :size="15" />{{ t('wallet.tab.withdraw') }}</button>
        <button class="btn btn-ghost" type="button" :disabled="account.loading || overviewLoading" @click="load">
          <RotateCw :size="14" aria-hidden="true" />
          <span class="refresh-text">{{ account.loading ? t('common.loading') : t('common.refresh') }}</span>
        </button>
      </div>
    </section>

    <section class="holdings">
      <div class="wallet-toolbar">
        <label class="wallet-search">
          <Search :size="14" aria-hidden="true" />
          <input
            v-model="search"
            type="search"
            :placeholder="t('wallet.searchPlaceholder')"
            :aria-label="t('wallet.searchPlaceholder')"
          />
        </label>
        <label class="wallet-toggle">
          <input v-model="hideZero" type="checkbox" />
          {{ t('wallet.hideZero') }}
        </label>
      </div>

      <StateBlock v-if="!sessionStore.isAuthenticated" variant="empty" :message="t('assets.loginRequired')" />
      <StateBlock
        v-else-if="(account.loading || overviewLoading) && !spotReady"
        variant="loading"
        :message="t('common.loading')"
      />
      <StateBlock v-else-if="account.error !== null" variant="error" :message="account.error" retryable @retry="load" />
      <StateBlock v-else-if="!spotReady" variant="error" :message="t('portfolioFailed')" retryable @retry="load" />
      <StateBlock v-else-if="rows.length === 0" variant="empty" :message="emptyMessage" />
      <template v-else>
      <ul class="coin-cards">
        <li v-for="row in cardRows" :key="row.coin" class="coin-card" :class="{ open: expanded.has(row.coin) }">
          <button class="coin-card-head" type="button" :aria-expanded="expanded.has(row.coin)" @click="toggle(row.coin)">
            <CoinMark :symbol="row.coin" :size="32" />
            <span class="coin-names">
              <span class="coin-code-main">{{ row.coin }}</span>
              <span class="coin-name ellipsis">{{ row.showName }}</span>
            </span>
            <span class="coin-card-total">
              <span class="num strong">{{ format(row.total, row.coin) }}</span>
              <small v-if="usdValue(row) !== ''" class="usd-sub">{{ usdValue(row) }}</small>
            </span>
            <ChevronDown :size="16" class="coin-card-chevron" aria-hidden="true" />
          </button>
          <div v-if="expanded.has(row.coin)" class="coin-card-body">
            <dl class="coin-card-grid">
              <div><dt>{{ t('wallet.available') }}</dt><dd class="num">{{ format(rowAvailable(row), row.coin) }}</dd></div>
              <div><dt>{{ t('wallet.locked') }}</dt><dd class="num">{{ format(rowLocked(row), row.coin) }}</dd></div>
              <div><dt>{{ t('wallet.btcValue') }}</dt><dd class="num">{{ btcValue(row) }}</dd></div>
            </dl>
            <div class="coin-card-actions">
              <button class="btn btn-primary" type="button" @click="emit('select', row.coin, 'deposit')"><ArrowDownToLine :size="14" />{{ t('wallet.tab.deposit') }}</button>
              <button class="btn" type="button" @click="emit('select', row.coin, 'withdraw')"><ArrowUpFromLine :size="14" />{{ t('wallet.tab.withdraw') }}</button>
            </div>
          </div>
        </li>
      </ul>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th class="col-coin">{{ t('wallet.coin') }}</th>
              <th>{{ t('wallet.available') }}</th>
              <th>{{ t('wallet.locked') }}</th>
              <th>{{ t('wallet.total') }}</th>
              <th>{{ t('wallet.btcValue') }}</th>
              <th class="col-actions">{{ t('wallet.tab.deposit') }} / {{ t('wallet.tab.withdraw') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.coin">
              <td class="col-coin">
                <button class="coin-link" type="button" @click="emit('select', row.coin)">
                  <CoinMark :symbol="row.coin" :size="30" />
                  <span class="coin-names">
                    <span class="coin-code-main">{{ row.coin }}</span>
                    <span class="coin-name ellipsis">{{ row.showName }}</span>
                  </span>
                </button>
              </td>
              <td class="num">{{ format(rowAvailable(row), row.coin) }}</td>
              <td class="num muted-num">{{ format(rowLocked(row), row.coin) }}</td>
              <td class="num strong">{{ format(row.total, row.coin) }}</td>
              <td class="num muted-num" :title="btcTitle(row)" data-testid="holding-btc-value">
                {{ btcValue(row) }}
                <small v-if="usdValue(row) !== ''" class="usd-sub">{{ usdValue(row) }}</small>
              </td>
              <td class="state-cells">
                <button class="icon-button" type="button" :title="t('wallet.tab.deposit')" :aria-label="`${t('wallet.tab.deposit')} ${row.coin}`" @click="emit('select', row.coin, 'deposit')"><ArrowDownToLine :size="15" /></button>
                <button class="icon-button" type="button" :title="t('wallet.tab.withdraw')" :aria-label="`${t('wallet.tab.withdraw')} ${row.coin}`" @click="emit('select', row.coin, 'withdraw')"><ArrowUpFromLine :size="15" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.balances { gap: 16px; margin-top: 8px; }
.summary {
  position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  padding: 26px 28px; overflow: hidden; border: 1px solid var(--color-border); border-radius: 18px;
  background: radial-gradient(ellipse 50% 140% at 100% 0%, var(--color-accent-soft), transparent 60%), var(--color-surface);
}
.summary-main { flex: 1 1 320px; min-width: 0; }
.overview-scope { display: block; margin-top: 6px; font-size: 12px; color: var(--color-text-muted); line-height: 1.5; }
.usd-sub { display: block; color: var(--color-text-muted); font-size: 11px; }
.summary-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.summary-actions .btn { height: 40px; }
.holdings { border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); overflow: hidden; }
.wallet-toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 18px; border-bottom: 1px solid var(--color-border); }
.wallet-search {
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius-pill); background: var(--color-surface-alt); color: var(--color-text-muted);
}
.wallet-search:focus-within { border-color: var(--color-accent); }
.wallet-search input { width: 180px; border: none; outline: none; background: transparent; color: var(--color-text); font-size: 13px; }
.wallet-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: 13px; }
.wallet-toggle input { accent-color: var(--color-accent); }
.table-scroll { overflow-x: auto; }
.table { table-layout: auto; }
.table th { padding-top: 12px; padding-bottom: 12px; }
.table td { padding-top: 14px; padding-bottom: 14px; }
.table th:first-child, .table td:first-child { padding-left: 18px; }
.table th:last-child, .table td:last-child { padding-right: 18px; }
.table tbody tr:last-child td { border-bottom: 0; }
.coin-link { display: inline-flex; align-items: center; gap: 12px; text-align: left; min-width: 0; }
.coin-names { display: flex; flex-direction: column; min-width: 0; }
.coin-code-main { font-family: var(--font-display); font-weight: 700; font-size: 14px; }
.coin-name { max-width: 220px; color: var(--color-text-muted); font-size: 12px; }
.strong { font-weight: 650; }
.muted-num { color: var(--color-text-secondary); }
.state-cells { text-align: right; white-space: nowrap; }
.state-cells .icon-button { width: 32px; height: 32px; }
.state-cells .icon-button:hover { color: var(--color-accent-text); background: var(--color-accent-soft); }
.coin-cards { display: none; margin: 0; padding: 0; list-style: none; }
.coin-card { border-bottom: 1px solid var(--color-border); }
.coin-card:last-child { border-bottom: 0; }
.coin-card-head { display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 14px; text-align: left; }
.coin-card-head .coin-names { flex: 1 1 auto; }
.coin-card-total { display: flex; flex-direction: column; align-items: flex-end; text-align: right; }
.coin-card-chevron { flex: 0 0 auto; color: var(--color-text-muted); transition: transform .2s ease; }
.coin-card.open .coin-card-chevron { transform: rotate(180deg); }
.coin-card-body { padding: 0 14px 14px 58px; }
.coin-card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; }
.coin-card-grid dt { color: var(--color-text-muted); font-size: 11px; }
.coin-card-grid dd { margin: 2px 0 0; font-size: 13px; word-break: break-all; }
.coin-card-actions { display: flex; gap: 8px; }
.coin-card-actions .btn { flex: 1 1 0; height: 34px; }
@media (max-width: 720px) {
  .summary-move { display: none; }
  .coin-cards { display: block; }
  .table-scroll { display: none; }
  /* Brand card: gold hairline, soft gold wash and a faint W watermark (owner 11-17). */
  .summary { align-items: stretch; padding: 20px 18px 18px; border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border)); border-radius: 18px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1594 987'%3E%3Cg fill='%23d9a85a' fill-opacity='.13'%3E%3Cpath d='M6 8H273L646 724 521 984Z'/%3E%3Cpath d='M797 40 1031 440 913 665 797 440 681 665 563 440Z'/%3E%3Cpath d='M1321 8H1588L1073 984 948 724Z'/%3E%3C/g%3E%3C/svg%3E") no-repeat right -14px bottom -12px / 150px auto,
      linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, var(--color-surface)), var(--color-surface) 62%);
    box-shadow: 0 10px 28px -18px color-mix(in srgb, var(--color-accent) 70%, transparent); }
  .summary-main { flex-basis: 100%; }
  .summary-actions { position: absolute; top: 14px; right: 14px; }
  .summary-actions .btn { background: color-mix(in srgb, var(--color-surface) 70%, transparent); }
  .summary-actions .btn { width: 30px; height: 30px; padding: 0; justify-content: center; border-radius: 50%; }
  .refresh-text { display: none; }
  /* Phones show the total only: no balance / PnL breakdown, update time or scope note (owner 11-17). */
  .summary :deep(.portfolio-details), .scope-note { display: none; }
  .overview-scope { margin-top: 4px; font-size: 10.5px; line-height: 1.45; }
  .wallet-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 12px; }
  .wallet-search { min-width: 0; padding: 0 10px; }
  .wallet-search svg { flex-shrink: 0; }
  .wallet-search input { width: 100%; min-width: 0; }
  .wallet-toggle { gap: 4px; font-size: 12px; white-space: nowrap; }
  .wallet-toggle input { flex-shrink: 0; }
}
/* Phones: the summary rises above the page's actions and tabs (views/AssetsView.vue orders the parts). */
@media (max-width: 720px) {
  .balances { display: contents; }
  .summary { order: 1; min-height: 168px; padding: 26px 20px 24px; align-content: center; }
  .holdings { order: 4; }
}
</style>
