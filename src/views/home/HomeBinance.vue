<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import CoinMark from '@/components/common/CoinMark.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import AssetValuation from '@/components/wallet/AssetValuation.vue'
import PortfolioValuationDetails from '@/components/wallet/PortfolioValuationDetails.vue'
import AppSection from '@/components/home/binance/AppSection.vue'
import FaqSection from '@/components/home/binance/FaqSection.vue'
import HeroMarketCard from '@/components/home/binance/HeroMarketCard.vue'
import HeroNewsCard from '@/components/home/binance/HeroNewsCard.vue'
import MarketOverview from '@/components/home/binance/MarketOverview.vue'
import ProductShowcase from '@/components/home/binance/ProductShowcase.vue'
import WhySection from '@/components/home/binance/WhySection.vue'
import FxContracts, { type ContractItem } from '@/components/home/fx/FxContracts.vue'
import FxCount from '@/components/home/fx/FxCount.vue'
import FxTicker, { type TickerItem } from '@/components/home/fx/FxTicker.vue'
import HomeSky from '@/components/home/fx/HomeSky.vue'
import { useReveal } from '@/components/home/fx/fx'
import { useHomeMarkets, useOpenMarket } from '@/components/home/binance/use-home-markets'
import '@/styles/home-fx.css'
import { BRAND_ID, BRAND_NAME } from '@/core/brand'
import { isFeatureEnabled } from '@/core/feature-flags'
import { cmp, isDecimalString, isZero } from '@/modules/finance/decimal'
import { compactDecimal } from '@/modules/finance/display'
import { coinMeta } from '@/modules/wallet/coins'
import { useValuationPrefs } from '@/modules/wallet/use-valuation'
import { HIDDEN_MASK, coinUsdValue, formatCoinAmount, usdLine } from '@/modules/wallet/valuation'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { PORTFOLIO_MESSAGES, usePortfolioOverview } from '@/modules/wallet/use-portfolio-overview'

/**
 * Binance-skin home, information first over one quiet sky (fx/HomeSky; owner 10-22: 做过头了 — no pinning, no
 * emblems behind content, no buttons that follow the pointer): hero (headline, live platform figures, sign-up;
 * live market + announcement cards) → price tape → live markets → perpetuals board → products grid → security
 * grid → app → FAQ → a compact final call to action. Motion: a one-shot fade/rise per section, the tape, price
 * flashes. Styles shared with the OKX skin live in styles/home-fx.css.
 * Every number is real: market counts and leverage caps from the pair / contract config, prices and turnover
 * from the spot and futures `review` streams, balances from the account API. Missing data renders as `--`.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      ...PORTFOLIO_MESSAGES['zh-CN'],
      titleA: '一个账户，',
      titleB: '交易加密货币、黄金与美股',
      lead: '现货、U 本位永续合约、跟单、理财与新币发行，统一在 {brand}。',
      spotPairs: '现货交易对',
      perps: 'U 本位永续合约',
      lever: '合约最高杠杆',
      turnover: '24h 成交额（USDT）',
      placeholder: '邮箱 / 手机号',
      signup: '注册',
      haveAccount: '已有账户？',
      login: '登录',
      welcome: '欢迎回来',
      totalValue: '总资产估值',
      deposit: '资产',
      goTrade: '交易',
      goFutures: '合约',
      noBalance: '暂无现货持仓',
      loadingAccount: '正在加载账户…',
      ctaTitle: '现在开始在 {brand} 交易',
      ctaSub: '注册只需几分钟，同一个账户即可使用现货、合约与理财。',
      ctaBtn: '立即注册',
      ctaTrade: '前往交易',
      tape: '实时行情',
    },
    'en-US': {
      ...PORTFOLIO_MESSAGES['en-US'],
      titleA: 'One account.',
      titleB: 'Crypto, gold & US stocks.',
      lead: 'Spot, USDT-margined perpetuals, copy trading, Earn and token launches — all on {brand}.',
      spotPairs: 'Spot pairs',
      perps: 'USDⓈ-M perpetuals',
      lever: 'Max futures leverage',
      turnover: '24h turnover (USDT)',
      placeholder: 'Email / phone number',
      signup: 'Register',
      haveAccount: 'Already have an account?',
      login: 'Sign in',
      welcome: 'Welcome back',
      totalValue: 'Estimated balance',
      deposit: 'Assets',
      goTrade: 'Trade',
      goFutures: 'Futures',
      noBalance: 'No spot holdings',
      loadingAccount: 'Loading account…',
      ctaTitle: 'Start trading on {brand} today',
      ctaSub: 'Sign up in minutes and use spot, futures and Earn from one account.',
      ctaBtn: 'Register now',
      ctaTrade: 'Go to trade',
      tape: 'Live prices',
    },
  },
})

const router = useRouter()
const market = useMarketStore()
const account = useAccountStore()
const sessionStore = useSessionStore()
const { spotRows, futuresRows, totalTurnover, maxLever } = useHomeMarkets()

const showAssets = computed(() => isFeatureEnabled('assetsPage'))
/** "WIN THE FUTURE" belongs to the BITWINEX brand only (owner 10-22 poster). */
const emblem = BRAND_ID === 'bitwinex'

const root = ref<HTMLElement | null>(null)
useReveal(root)

/** Perpetuals board: every contract row (the board puts BTC/ETH/XAUT/NVDA/TSLA/SOL first). */
const contractItems = computed<ContractItem[]>(() =>
  futuresRows.value.map((row) => ({
    key: row.key, base: row.base, label: row.label, kind: row.assetClass, last: row.last, change: row.change,
    lever: row.maxLever > 0 ? String(row.maxLever) : '',
  })),
)
function pickContract(key: string): void {
  const row = futuresRows.value.find((item) => item.key === key)
  if (row !== undefined) openMarket(row)
}

/** Price tape: every spot pair and perpetual with a live price (FxTicker drops rows still at `--`). */
const openMarket = useOpenMarket()
const tapeRows = computed(() => [...spotRows.value, ...futuresRows.value])
const tapeItems = computed<TickerItem[]>(() =>
  tapeRows.value.map((row) => ({ key: row.key, label: row.label, last: row.last, change: row.change })),
)
function pickTape(key: string): void {
  const row = tapeRows.value.find((item) => item.key === key)
  if (row !== undefined) openMarket(row)
}

const leverText = computed(() => (maxLever.value > 0 ? `${maxLever.value}x` : '--'))

/** Platform figures (counts are config facts; turnover is the live sum, `--` until a ticker arrives). */
const stats = computed(() => [
  { key: 'spotPairs', value: market.symbols.length > 0 ? String(market.symbols.length) : '--' },
  { key: 'perps', value: futuresRows.value.length > 0 ? String(futuresRows.value.length) : '--' },
  { key: 'lever', value: leverText.value },
  { key: 'turnover', value: totalTurnover.value === '' ? '--' : compactDecimal(totalTurnover.value) },
])

/** Sign-up box: an e-mail goes to the e-mail tab, digits (with an optional +) to the phone tab, both prefilled. */
const contact = ref('')
function startSignup(): void {
  const value = contact.value.trim()
  if (value === '') {
    void router.push('/register')
  } else if (value.includes('@')) {
    void router.push({ path: '/register', query: { email: value } })
  } else if (/^\+?[\d\s-]{5,}$/.test(value)) {
    void router.push({ path: '/register', query: { phone: value.replace(/[\s-]/g, ''), nowType: 'phone' } })
  } else {
    void router.push('/register')
  }
}

const valuation = useValuationPrefs()
const { total: overviewTotal, balance: overviewBalance, unrealized: overviewPnl, readAtMs: overviewReadAt, loading: overviewLoading, unavailable: overviewFailed, reload: reloadOverview, spotReady } = usePortfolioOverview()

/** The four largest holdings by BTC valuation, each at the coin's display precision with its USD value. */
const accountRows = computed(() =>
  (spotReady.value ? account.coinRows : [])
    .filter((row) => isDecimalString(row.total) && !isZero(row.total))
    .sort((left, right) => {
      const a = isDecimalString(left.btcValuation) ? left.btcValuation : '0'
      const b = isDecimalString(right.btcValuation) ? right.btcValuation : '0'
      return cmp(b, a) || left.coin.localeCompare(right.coin)
    })
    .slice(0, 4)
    .map((row) => ({
      coin: row.coin,
      amount: valuation.hidden.value ? HIDDEN_MASK : formatCoinAmount(row.total, coinMeta(market.publicInfo, row.coin).showPrecision),
      usd: valuation.hidden.value ? `≈ $${HIDDEN_MASK}` : usdLine(coinUsdValue(row.coin, row.total, row.btcValuation, market.tickers)),
    })),
)

let stopStream: (() => void) | null = null

async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    // `publicInfoError` drives the retry state on the markets page; the home keeps its `--`.
  }
}

onMounted(() => {
  // Overview only: the spot review channel (all pairs, no book/trades/K-line).
  stopStream = market.start('overview')
  void bootstrap()
})

onBeforeUnmount(() => {
  stopStream?.()
  stopStream = null
})
</script>

<template>
  <div ref="root" class="bn-home fx-home">
    <HomeSky />
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-copy">
          <h1 class="hero-title"><span>{{ t('titleA') }}</span><span>{{ t('titleB') }}</span></h1>
          <p class="hero-lead">{{ t('lead', { brand: BRAND_NAME }) }}</p>

          <dl class="hero-stats">
            <div v-for="stat in stats" :key="stat.key" class="stat">
              <dt>{{ t(stat.key) }}</dt>
              <dd class="num"><FxCount :value="stat.value" /></dd>
            </div>
          </dl>

          <form v-if="!sessionStore.isAuthenticated" class="signup" @submit.prevent="startSignup">
            <input v-model="contact" class="signup-input" type="text" inputmode="email" autocomplete="email" :placeholder="t('placeholder')" :aria-label="t('placeholder')" />
            <button class="btn btn-primary signup-btn" type="submit">{{ t('signup') }}</button>
          </form>
          <p v-if="!sessionStore.isAuthenticated" class="signin-hint">{{ t('haveAccount') }} <RouterLink to="/login">{{ t('login') }}</RouterLink></p>

          <div v-else class="account-card bn-card glass">
            <div class="account-top">
              <AssetValuation class="account-valuation" :label="t('portfolioTotal')" :total="overviewTotal" symbol="USDT" :max-font="30" />
              <div class="account-actions">
                <RouterLink v-if="showAssets" class="btn btn-primary" to="/assets">{{ t('deposit') }}</RouterLink>
                <RouterLink class="btn btn-quiet" to="/trade">{{ t('goTrade') }}</RouterLink>
                <RouterLink class="btn btn-quiet" to="/futures">{{ t('goFutures') }}</RouterLink>
              </div>
            </div>
            <PortfolioValuationDetails :balance="overviewBalance" :unrealized="overviewPnl" :read-at-ms="overviewReadAt" />
            <p class="account-hint">{{ t('portfolioScope') }}</p>
            <StateBlock v-if="overviewFailed" variant="error" :message="t('portfolioFailed')" retryable @retry="reloadOverview" />
            <p v-else-if="overviewLoading" class="account-hint" role="status">{{ t(overviewTotal === '' ? 'portfolioLoading' : 'portfolioRefreshing') }}</p>
            <p v-else-if="accountRows.length === 0" class="account-hint">{{ t('noBalance') }}</p>
            <ul v-else class="account-coins">
              <li v-for="row in accountRows" :key="row.coin">
                <CoinMark :symbol="row.coin" :size="22" />
                <span class="coin-name">{{ row.coin }}</span>
                <span class="coin-amounts">
                  <span class="num" data-testid="home-coin-amount">{{ row.amount }}</span>
                  <small v-if="row.usd !== ''" class="num coin-usd">{{ row.usd }}</small>
                </span>
              </li>
            </ul>
          </div>
        </div>

        <div class="hero-side">
          <HeroMarketCard class="glass" :spot="spotRows" :futures="futuresRows" />
          <HeroNewsCard class="glass" />
        </div>
      </div>
    </section>

    <FxTicker :items="tapeItems" :label="t('tape')" @pick="pickTape" />
    <MarketOverview :spot="spotRows" :futures="futuresRows" />
    <FxContracts data-fx :items="contractItems" :max-lever="leverText" @pick="pickContract" />
    <ProductShowcase />
    <WhySection />
    <AppSection :rows="spotRows" />
    <FaqSection />

    <section class="fx-final" data-fx>
      <div class="bn-section-inner">
        <div class="fx-final-inner glass">
          <div class="fx-final-copy">
            <p v-if="emblem" class="fx-tagline" lang="en"><b>WIN</b> THE FUTURE</p>
            <h2>{{ t('ctaTitle', { brand: BRAND_NAME }) }}</h2>
            <p>{{ t('ctaSub') }}</p>
          </div>
          <RouterLink v-if="!sessionStore.isAuthenticated" class="btn btn-primary cta-btn" to="/register">{{ t('ctaBtn') }}</RouterLink>
          <RouterLink v-else class="btn btn-primary cta-btn" to="/trade">{{ t('ctaTrade') }}</RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.bn-home { overflow-x: clip; }

.hero { position: relative; }
.hero-inner {
  position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 500px); gap: 56px; align-items: start;
  max-width: 1200px; margin: 0 auto; padding: 64px 24px 56px;
}
.hero-copy { min-width: 0; padding-top: 24px; }
.hero-title {
  display: flex; flex-direction: column; max-width: 640px; margin: 0; color: var(--color-text); font-size: 48px; font-weight: 700; line-height: 1.18; letter-spacing: -0.02em;
}
.hero-lead { max-width: 540px; margin: 20px 0 0; color: var(--color-text-secondary); font-size: 18px; line-height: 1.6; }

.hero-stats { display: grid; grid-template-columns: repeat(4, minmax(0, auto)); justify-content: start; gap: 0 36px; margin: 40px 0 0; }
.stat { display: flex; flex-direction: column-reverse; gap: 6px; min-width: 0; }
.stat dt { color: var(--color-text-secondary); font-size: 13px; white-space: nowrap; }
.stat dd { margin: 0; color: var(--color-accent-text); font-size: 32px; font-weight: 700; line-height: 1.1; letter-spacing: -0.01em; }

.signup { display: flex; gap: 12px; max-width: 480px; margin-top: 44px; }
.signup-input {
  flex: 1 1 auto; min-width: 0; height: 48px; padding: 0 16px; border: 1px solid var(--color-border-strong); border-radius: 8px;
  background: var(--bn-input, var(--color-surface)); color: var(--color-text); font-size: 15px; transition: border-color 0.15s;
}
.signup-input::placeholder { color: var(--color-text-muted); }
.signup-input:hover, .signup-input:focus { border-color: var(--color-accent); outline: none; }
.signup-btn { flex: 0 0 auto; height: 48px; min-width: 160px; padding: 0 24px; border-radius: 8px; font-size: 16px; font-weight: 600; }
.signin-hint { margin: 16px 0 0; color: var(--color-text-secondary); font-size: 14px; }
.signin-hint a { color: var(--color-accent-text); font-weight: 500; }
.signin-hint a:hover { text-decoration: underline; }

.hero-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

.account-card { max-width: 560px; margin-top: 40px; padding: 24px; }
.account-top { display: flex; flex-direction: column; gap: 18px; }
.account-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.account-actions .btn { height: 40px; padding: 0 20px; font-size: 14px; }
.account-hint { margin: 16px 0 0; color: var(--color-text-secondary); font-size: 13px; }
.account-coins { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 24px; margin: 18px 0 0; padding: 16px 0 0; border-top: 1px solid var(--color-border); list-style: none; }
.account-coins li { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; }
.coin-name { color: var(--color-text); font-weight: 600; }
.coin-amounts { display: flex; flex-direction: column; align-items: flex-end; margin-left: auto; min-width: 0; line-height: 1.3; }
.coin-amounts .num { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.coin-usd { color: var(--color-text-muted); font-size: 12px; }

.cta-btn { flex: 0 0 auto; height: 48px; min-width: 180px; padding: 0 28px; border-radius: 8px; font-size: 16px; font-weight: 600; }

@media (max-width: 1100px) {
  .hero-inner { grid-template-columns: minmax(0, 1fr); gap: 36px; padding: 48px 24px 48px; }
  .hero-copy { padding-top: 0; }
  .hero-side { max-width: 640px; }
}
@media (max-width: 720px) {
  .hero-inner { padding: 28px 16px 40px; }
  .hero-title { font-size: 30px; }
  .hero-lead { font-size: 15px; margin-top: 14px; }
  .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 16px; margin-top: 28px; }
  .stat dd { font-size: 24px; }
  .signup { flex-direction: column; margin-top: 28px; }
  .signup-btn { width: 100%; }
  .account-coins { grid-template-columns: minmax(0, 1fr); }
  .cta-btn { width: 100%; }
}
</style>
