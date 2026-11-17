<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import CoinMark from '@/components/common/CoinMark.vue'
import AssetValuation from '@/components/wallet/AssetValuation.vue'
import PortfolioValuationDetails from '@/components/wallet/PortfolioValuationDetails.vue'
import { isFeatureEnabled } from '@/core/feature-flags'
import { PORTFOLIO_MESSAGES, usePortfolioOverview } from '@/modules/wallet/use-portfolio-overview'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useSessionStore } from '@/stores/session'
import type { BoardRow } from './use-futures-board'
import { vTick } from '@/components/home/fx/fx'

/**
 * OKX-rhythm hero: one very large headline about the whole platform, a sign-up field, and the
 * "perpetual board" — every listed USDT-margined perpetual (crypto, gold, US stocks) with its live
 * last price, 24h change and maximum leverage from the server. No figure on this block is invented.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      ...PORTFOLIO_MESSAGES['zh-CN'],
      titleA: '加密、黄金与美股',
      titleB: '一个账户全部交易',
      lead: '现货、U 本位永续合约（含黄金 XAUT 与英伟达、特斯拉股票永续）、理财、跟单与借币，同一个账户、同一份资产。',
      placeholder: '邮箱或手机号',
      signup: '注册',
      signupHint: '注册后绑定验证器即可开始交易',
      welcome: '欢迎回来',
      total: '总资产估值',
      trade: '去交易',
      assets: '资产',
      deposit: '充值',
      boardTitle: 'U 本位永续合约',
      boardLive: '实时',
      boardWait: '等待行情',
      crypto: '加密',
      gold: '黄金',
      stock: '美股',
      lever: '最高 {lever}',
      empty: '合约列表暂不可用',
      boardMore: '全部合约',
      tradeContract: '交易 {name} 永续',
    },
    'en-US': {
      ...PORTFOLIO_MESSAGES['en-US'],
      titleA: 'Crypto, gold and US stocks.',
      titleB: 'One account for all of it.',
      lead: 'Spot, USDT-margined perpetuals (including gold XAUT and NVIDIA and Tesla stock perps), Earn, copy trading and loans — one account, one balance.',
      placeholder: 'Email or mobile number',
      signup: 'Sign up',
      signupHint: 'Bind an authenticator after sign-up and start trading',
      welcome: 'Welcome back',
      total: 'Estimated balance',
      trade: 'Trade',
      assets: 'Assets',
      deposit: 'Deposit',
      boardTitle: 'USDT-margined perpetuals',
      boardLive: 'Live',
      boardWait: 'Awaiting data',
      crypto: 'Crypto',
      gold: 'Gold',
      stock: 'US stock',
      lever: 'Up to {lever}',
      empty: 'Contract list unavailable',
      boardMore: 'All contracts',
      tradeContract: 'Trade {name} perpetual',
    },
  },
})

const router = useRouter()
const session = useSessionStore()
const { total: overviewTotal, balance: overviewBalance, unrealized: overviewPnl, readAtMs: overviewReadAt, loading: overviewLoading, unavailable: overviewFailed, reload: reloadOverview } = usePortfolioOverview()
const futures = useFuturesMarketStore()
defineProps<{ rows: BoardRow[]; live: boolean }>()
const showAssets = computed(() => isFeatureEnabled('assetsPage'))

const identity = ref('')

function signUp(): void {
  const value = identity.value.trim()
  const query: Record<string, string> = {}
  if (value.includes('@')) query.email = value
  else if (/^\+?[\d\s-]{5,20}$/.test(value)) {
    query.phone = value.replace(/[\s-]/g, '')
    query.nowType = 'phone'
  }
  void router.push({ path: '/register', query })
}

function openContract(row: BoardRow): void {
  futures.selectContract(row.contract.contractName)
  void router.push('/futures')
}
</script>

<template>
  <section class="okx-hero">
    <div class="okx-hero-inner">
      <div class="okx-hero-copy">
        <h1 class="okx-hero-title">
          <span>{{ t('titleA') }}</span>
          <span>{{ t('titleB') }}</span>
        </h1>
        <p class="okx-hero-lead">{{ t('lead') }}</p>

        <form v-if="!session.isAuthenticated" class="okx-signup" @submit.prevent="signUp">
          <label class="okx-signup-field">
            <span class="okx-sr">{{ t('placeholder') }}</span>
            <input v-model="identity" type="text" inputmode="email" autocomplete="email" :placeholder="t('placeholder')" />
          </label>
          <button class="okx-pill okx-pill-gold" type="submit">{{ t('signup') }}</button>
        </form>
        <p v-if="!session.isAuthenticated" class="okx-signup-hint">{{ t('signupHint') }}</p>

        <div v-else class="okx-balance">
          <AssetValuation :label="t('portfolioTotal')" :total="overviewTotal" symbol="USDT" :max-font="40" />
          <PortfolioValuationDetails :balance="overviewBalance" :unrealized="overviewPnl" :read-at-ms="overviewReadAt" />
          <small class="scope-note">{{ t('portfolioScope') }}</small>
          <p v-if="overviewLoading" role="status">{{ t(overviewTotal === '' ? 'portfolioLoading' : 'portfolioRefreshing') }}</p>
          <p v-else-if="overviewFailed" role="status">{{ t('portfolioFailed') }} <button type="button" @click="reloadOverview">{{ t('common.refresh') }}</button></p>
          <div class="okx-balance-actions">
            <RouterLink class="okx-pill okx-pill-gold" to="/trade">{{ t('trade') }}</RouterLink>
            <RouterLink v-if="showAssets" class="okx-pill okx-pill-line" to="/assets">{{ t('assets') }}</RouterLink>
          </div>
        </div>
      </div>

      <aside class="okx-board glass" :aria-label="t('boardTitle')">
        <header class="okx-board-head">
          <strong>{{ t('boardTitle') }}</strong>
          <span class="okx-board-state" :class="{ on: live }"><i></i>{{ live ? t('boardLive') : t('boardWait') }}</span>
        </header>
        <p v-if="rows.length === 0" class="okx-board-empty">{{ t('empty') }}</p>
        <ul v-else class="okx-board-list">
          <li v-for="row in rows" :key="row.contract.contractName">
            <button type="button" class="okx-board-row" :aria-label="t('tradeContract', { name: row.base })" @click="openContract(row)">
              <CoinMark :symbol="row.base" :size="30" />
              <span class="okx-board-name">
                <strong>{{ row.base }}<small>USDT</small></strong>
                <span class="okx-board-tags">
                  <em :class="row.kind">{{ t(row.kind) }}</em>
                  <span>{{ t('lever', { lever: row.maxLever }) }}</span>
                </span>
              </span>
              <span class="okx-board-price">
                <span v-tick="row.last" class="num">{{ row.last }}</span>
                <span class="num okx-board-change" :class="row.change.direction">{{ row.change.text }}</span>
              </span>
            </button>
          </li>
        </ul>
        <RouterLink class="okx-board-more" to="/futures">{{ t('boardMore') }}</RouterLink>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.okx-hero { position: relative; isolation: isolate; }
/* One quiet gold light behind the board, over the page's cosmos backdrop (fx/StoryStage). */
.okx-hero::before {
  content: ''; position: absolute; z-index: 0; right: -10%; top: -30%; width: 70%; height: 140%; pointer-events: none;
  background: radial-gradient(closest-side, rgba(var(--okx-gold-rgb), 0.07), transparent 70%);
}
.okx-hero-inner {
  position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 480px); gap: 72px; align-items: center;
  max-width: 1280px; margin: 0 auto; padding: 72px 32px 64px;
}
.okx-hero-title {
  display: flex; flex-direction: column; margin: 0;
  font-family: var(--okx-font); font-size: clamp(38px, 4.6vw, 64px); font-weight: 800; line-height: 1.08; letter-spacing: -0.045em;
  color: var(--color-text);
}
.okx-hero-title span:last-child { color: var(--okx-gold-ink); }
.okx-hero-lead { max-width: 560px; margin: 28px 0 0; color: var(--color-text-secondary); font-size: 18px; line-height: 1.65; }

.okx-signup { display: flex; gap: 12px; max-width: 520px; margin-top: 44px; }
.okx-signup-field { flex: 1 1 auto; min-width: 0; }
.okx-signup-field input {
  width: 100%; height: 56px; padding: 0 24px; border: 1px solid var(--color-border-strong); border-radius: 999px;
  background: var(--okx-panel); color: var(--color-text); font-size: 16px; outline: none; transition: border-color .15s;
}
.okx-signup-field input::placeholder { color: var(--color-text-muted); }
.okx-signup-field input:focus { border-color: var(--color-accent); }
.okx-signup .okx-pill { height: 56px; padding: 0 36px; font-size: 16px; }
.okx-signup-hint { margin: 14px 0 0 24px; color: var(--color-text-muted); font-size: 13px; }

.okx-balance { max-width: 520px; margin-top: 44px; padding: 24px 28px; border: 1px solid var(--color-border); border-radius: 24px; background: var(--okx-panel); }
.okx-balance-actions { display: flex; gap: 12px; margin-top: 20px; }

/* ---- board */
.okx-board {
  position: relative; display: flex; flex-direction: column; padding: 28px 28px 20px; min-width: 0;
  border-color: var(--okx-gold-line); border-radius: 20px;
}
.okx-board-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; }
.okx-board-head strong { font-family: var(--okx-font); font-size: 17px; font-weight: 700; }
.okx-board-state { display: inline-flex; align-items: center; gap: 7px; color: var(--color-text-muted); font-size: 12.5px; font-weight: 600; }
.okx-board-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--color-text-muted); }
.okx-board-state.on { color: var(--color-up); }
.okx-board-state.on i { background: var(--color-up); }
.okx-board-empty { margin: 32px 0; color: var(--color-text-muted); text-align: center; }
.okx-board-list { margin: 0; padding: 0; list-style: none; }
.okx-board-list li + li { border-top: 1px solid var(--color-border); }
.okx-board-row {
  display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 14px;
  padding: 15px 8px; margin: 0 -8px; width: calc(100% + 16px); border-radius: 14px; text-align: left; transition: background-color .15s;
}
.okx-board-row:hover { background: var(--color-hover); }
.okx-board-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.okx-board-name strong { font-family: var(--okx-font); font-size: 17px; font-weight: 750; letter-spacing: -0.01em; }
.okx-board-name small { margin-left: 4px; color: var(--color-text-muted); font-size: 12px; font-weight: 500; }
.okx-board-tags { display: flex; align-items: center; gap: 8px; color: var(--color-text-muted); font-size: 12px; }
.okx-board-tags em { padding: 1px 7px; border-radius: 6px; font-style: normal; font-weight: 650; font-size: 11px; background: var(--color-hover); color: var(--color-text-secondary); }
.okx-board-tags em.gold { background: var(--color-accent-soft); color: var(--okx-gold-ink); }
.okx-board-tags em.stock { background: var(--color-surface-alt); color: var(--color-text); }
.okx-board-price { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.okx-board-price > .num:first-child { font-size: 18px; font-weight: 650; }
.okx-board-change { font-size: 13px; font-weight: 600; }
.okx-board-change.flat { color: var(--color-text-muted); }
.okx-board-more { align-self: center; margin-top: 14px; color: var(--color-text-secondary); font-size: 14px; font-weight: 600; }
.okx-board-more:hover { color: var(--okx-gold-ink); }

@media (max-width: 1080px) {
  .okx-hero-inner { grid-template-columns: minmax(0, 1fr); gap: 40px; padding: 56px 24px 56px; }
  .okx-board { max-width: 560px; }
}
@media (max-width: 720px) {
  /* Phones show the total only (owner 11-17). */
  .okx-balance :deep(.portfolio-details), .okx-balance .scope-note { display: none; }
  /* The bottom navigation already offers 交易 / 资产; the card is the brand total card (owner 11-17). */
  .okx-balance-actions { display: none; }
  .okx-balance { padding: 20px 18px 18px; border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border)); border-radius: 18px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1594 987'%3E%3Cg fill='%23d9a85a' fill-opacity='.13'%3E%3Cpath d='M6 8H273L646 724 521 984Z'/%3E%3Cpath d='M797 40 1031 440 913 665 797 440 681 665 563 440Z'/%3E%3Cpath d='M1321 8H1588L1073 984 948 724Z'/%3E%3C/g%3E%3C/svg%3E") no-repeat right -14px bottom -12px / 150px auto,
      linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, var(--color-surface)), var(--color-surface) 62%);
    box-shadow: 0 10px 28px -18px color-mix(in srgb, var(--color-accent) 70%, transparent); }
  .okx-hero-inner { padding: 32px 16px 40px; gap: 32px; }
  .okx-hero-lead { font-size: 15.5px; margin-top: 20px; }
  .okx-signup { flex-direction: column; margin-top: 32px; }
  .okx-signup .okx-pill { width: 100%; height: 52px; }
  .okx-signup-field input { height: 52px; }
  .okx-signup-hint { margin-left: 0; text-align: center; }
  .okx-board { padding: 20px 18px 14px; border-radius: 16px; }

}
</style>
