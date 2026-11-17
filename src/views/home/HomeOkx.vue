<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import CoinMark from '@/components/common/CoinMark.vue'
import OkxFaq from '@/components/home/okx/OkxFaq.vue'
import OkxHero from '@/components/home/okx/OkxHero.vue'
import OkxMarkets from '@/components/home/okx/OkxMarkets.vue'
import OkxNews from '@/components/home/okx/OkxNews.vue'
import OkxProducts from '@/components/home/okx/OkxProducts.vue'
import OkxTrust from '@/components/home/okx/OkxTrust.vue'
import { useFuturesBoard } from '@/components/home/okx/use-futures-board'
import { BRAND_ID, BRAND_NAME } from '@/core/brand'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import FxContracts, { type ContractItem } from '@/components/home/fx/FxContracts.vue'
import FxTicker, { type TickerItem } from '@/components/home/fx/FxTicker.vue'
import HomeSky from '@/components/home/fx/HomeSky.vue'
import { useReveal, vTick } from '@/components/home/fx/fx'
import { useFuturesMarketStore } from '@/stores/futures-market'
import '@/styles/home-fx.css'

/**
 * OKX-layout home (VITE_SKIN=okx), black-gold / white-gold, information first over one quiet sky (fx/HomeSky;
 * owner 10-22: 做过头了 — no pinning, no emblems behind content, no buttons that follow the pointer): hero with the
 * live perpetual board → price tape → spot markets → perpetuals board → products grid → security grid → app →
 * announcements + FAQ → a compact final call to action. Motion: a one-shot fade/rise per section, the tape and
 * price flashes. Shared styles live in styles/home-fx.css.
 * Data: spot `review` tickers + hourly trends (market store), futures contract list + futures
 * `review` (one lease, `use-futures-board`), public business endpoints, CMS notices, and the
 * account balance when signed in. Every figure is a server value or `--`.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      appTitle: '{brand} App 即将推出',
      appBody: '行情、现货、合约与资产管理将来到手机上。上线后会在公告中通知，在此之前可在手机浏览器直接访问本站，页面已为小屏适配。',
      appSoon: '敬请期待',
      appBoard: '永续合约',
      ctaTitle: '现在开始交易',
      ctaBody: '几分钟完成注册，一个账户交易加密货币、黄金和美股永续合约。',
      ctaSignup: '注册账户',
      ctaTrade: '去交易',
      ctaMarkets: '浏览行情',
      tape: '永续合约实时价格',
      orbitTrade: '交易合约', orbitData: '资金费率',
    },
    'en-US': {
      appTitle: 'The {brand} app is coming',
      appBody: 'Markets, spot, futures and assets are coming to your phone. We will announce the launch; until then, this site works in your mobile browser and is built for small screens.',
      appSoon: 'Coming soon',
      appBoard: 'Perpetuals',
      ctaTitle: 'Start trading today',
      ctaBody: 'Sign up in minutes and trade crypto, gold and US-stock perpetuals from one account.',
      ctaSignup: 'Create account',
      ctaTrade: 'Trade now',
      ctaMarkets: 'Browse markets',
      tape: 'Live perpetual prices',
      orbitTrade: 'Trade futures', orbitData: 'Funding rates',
    },
  },
})

const market = useMarketStore()
const session = useSessionStore()
const board = useFuturesBoard()
const router = useRouter()
const futures = useFuturesMarketStore()

/** "WIN THE FUTURE" belongs to the BITWINEX brand only (owner 10-22 poster). */
const emblem = BRAND_ID === 'bitwinex'
const root = ref<HTMLElement | null>(null)
useReveal(root)

/** Perpetuals board: the hero board rows (BTC/ETH/XAUT/NVDA/TSLA/SOL first). */
const contractItems = computed<ContractItem[]>(() =>
  board.rows.value.map((row) => ({
    key: row.contract.contractName, base: row.base, label: `${row.base}USDT`, kind: row.kind, last: row.last, change: row.change,
    lever: row.contract.maxLever > 0 ? String(row.contract.maxLever) : '',
  })),
)
/** Highest leverage cap across the listed contracts (a config integer), `--` until the list arrives. */
const maxLever = computed(() => {
  const best = board.rows.value.reduce((top, row) => Math.max(top, row.contract.maxLever), 0)
  return best > 0 ? `${best}x` : '--'
})

/** Price tape: the same live perpetual rows as the hero board (rows still at `--` are left out). */
const tapeItems = computed<TickerItem[]>(() =>
  board.rows.value.map((row) => ({ key: row.contract.contractName, label: `${row.base}USDT`, last: row.last, change: row.change })),
)
function pickTape(key: string): void {
  futures.selectContract(key)
  void router.push('/futures')
}

let stopStream: (() => void) | null = null

async function bootstrap(): Promise<void> {
  try {
    await market.loadPublicInfo()
  } catch {
    // `publicInfoError` drives the markets block's empty state.
  }
}

onMounted(() => {
  // Overview only: the spot `review` channel (all pairs). No book, trades or live K-line.
  stopStream = market.start('overview')
  void bootstrap()
})

onBeforeUnmount(() => {
  stopStream?.()
  stopStream = null
})
</script>

<template>
  <div ref="root" class="okx-home fx-home">
    <HomeSky />
    <OkxHero :rows="board.rows.value" :live="board.live.value" />
    <FxTicker :items="tapeItems" :label="t('tape')" @pick="pickTape" />
    <OkxMarkets data-fx />
    <FxContracts data-fx :items="contractItems" :max-lever="maxLever" @pick="pickTape">
      <template #actions>
        <RouterLink class="okx-pill okx-pill-gold" to="/futures">{{ t('orbitTrade') }}</RouterLink>
        <RouterLink class="okx-pill okx-pill-line" to="/futures/data">{{ t('orbitData') }}</RouterLink>
      </template>
    </FxContracts>
    <OkxProducts data-fx />
    <OkxTrust data-fx />

    <section class="okx-sec" data-fx>
      <div class="okx-wrap">
        <div class="okx-app glass">
          <div class="okx-app-copy">
            <span class="okx-app-soon">{{ t('appSoon') }}</span>
            <h2 class="okx-h2">{{ t('appTitle', { brand: BRAND_NAME }) }}</h2>
            <p>{{ t('appBody') }}</p>
          </div>
          <!-- Phone frame showing the same live perpetual rows as the hero (real data, not a screenshot). -->
          <div class="okx-phone" aria-hidden="true">
            <div class="okx-phone-screen">
              <span class="okx-phone-notch"></span>
              <strong class="okx-phone-title">{{ t('appBoard') }}</strong>
              <ul>
                <li v-for="row in board.rows.value.slice(0, 4)" :key="row.contract.contractName">
                  <CoinMark :symbol="row.base" :size="22" />
                  <span class="okx-phone-name">{{ row.base }}</span>
                  <span v-tick="row.last" class="num okx-phone-px">{{ row.last }}</span>
                  <span class="num okx-phone-chg" :class="row.change.direction">{{ row.change.text }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div data-fx>
      <OkxNews />
      <OkxFaq />
    </div>

    <section class="fx-final" data-fx>
      <div class="okx-wrap">
        <div class="fx-final-inner glass">
          <div class="fx-final-copy">
            <p v-if="emblem" class="fx-tagline" lang="en"><b>WIN</b> THE FUTURE</p>
            <h2>{{ t('ctaTitle') }}</h2>
            <p>{{ t('ctaBody') }}</p>
          </div>
          <div class="okx-final-actions">
            <template v-if="!session.isAuthenticated">
              <RouterLink class="okx-pill okx-pill-gold okx-pill-lg" to="/register">{{ t('ctaSignup') }}</RouterLink>
              <RouterLink class="okx-pill okx-pill-line okx-pill-lg" to="/markets">{{ t('ctaMarkets') }}</RouterLink>
            </template>
            <template v-else>
              <RouterLink class="okx-pill okx-pill-gold okx-pill-lg" to="/trade">{{ t('ctaTrade') }}</RouterLink>
              <RouterLink class="okx-pill okx-pill-line okx-pill-lg" to="/markets">{{ t('ctaMarkets') }}</RouterLink>
            </template>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.okx-home { overflow-x: clip; }

.okx-app {
  display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 56px; align-items: end;
  padding: 40px 56px 0; border-radius: 24px; overflow: hidden;
}
.okx-app-copy { align-self: center; padding-bottom: 40px; }
.okx-app-copy p { max-width: 560px; margin: 14px 0 0; color: var(--color-text-secondary); font-size: 16px; line-height: 1.7; }
.okx-app-soon { display: inline-block; margin-bottom: 14px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--okx-gold-line); color: var(--okx-gold-ink); font-size: 13px; font-weight: 650; }
.okx-phone { position: relative; align-self: end; padding: 10px 10px 0; border-radius: 36px 36px 0 0; background: var(--okx-phone-frame); }
.okx-phone-screen { position: relative; min-height: 270px; padding: 40px 16px 0; border-radius: 28px 28px 0 0; background: var(--okx-canvas); }
.okx-phone-notch { position: absolute; top: 10px; left: 50%; width: 80px; height: 20px; margin-left: -40px; border-radius: 999px; background: var(--okx-phone-frame); }
.okx-phone-title { display: block; margin-bottom: 6px; font-family: var(--okx-font); font-size: 16px; font-weight: 750; }
.okx-phone ul { margin: 0; padding: 0; list-style: none; }
.okx-phone li { display: grid; grid-template-columns: 22px 1fr auto; grid-template-rows: auto auto; column-gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--color-border); }
.okx-phone li > :first-child { grid-row: span 2; }
.okx-phone-name { font-weight: 700; font-size: 14px; }
.okx-phone-px { font-size: 14px; font-weight: 600; text-align: right; }
.okx-phone-chg { grid-column: 3; font-size: 12px; text-align: right; }
.okx-phone-chg.flat { color: var(--color-text-muted); }

.okx-final-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 12px; }

@media (max-width: 1080px) {
  .okx-app { grid-template-columns: minmax(0, 1fr) 260px; gap: 32px; padding: 32px 32px 0; }
}
@media (max-width: 720px) {
  .okx-app { grid-template-columns: minmax(0, 1fr); padding: 24px 20px 0; border-radius: 20px; gap: 4px; }
  .okx-app-copy { padding-bottom: 20px; }
  .okx-app-copy p { font-size: 15px; }
  .okx-phone { justify-self: center; width: 260px; }
  .okx-phone-screen { min-height: 240px; }
  .okx-final-actions { width: 100%; }
  .okx-final-actions .okx-pill { flex: 1 1 100%; }
}
</style>
