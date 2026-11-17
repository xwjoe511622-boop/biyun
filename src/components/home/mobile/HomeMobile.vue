<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ChevronRight, Megaphone } from '@lucide/vue'
import biyunLogo from '@/assets/biyun-logo.png?inline'
import BrandMark from '@/components/common/BrandMark.vue'
import Sparkline from '@/components/market/Sparkline.vue'
import ProductArt from '@/components/common/ProductArt.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import HomeBannerArt from '@/components/home/mobile/HomeBannerArt.vue'
import HomeOrbit from '@/components/home/mobile/HomeOrbit.vue'
import { useFuturesBoard } from '@/components/home/okx/use-futures-board'
import { vTick } from '@/components/home/fx/fx'
import { byDecimalDesc } from '@/components/home/binance/use-home-markets'
import { BRAND_NAME } from '@/core/brand'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { percentView, type PercentView } from '@/modules/finance/display'
import { fetchNotices, type NoticeSummary } from '@/modules/content/content.api'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { ROW_TREND_POINTS, useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

/**
 * Phone home (≤720px, owner 2026-11-17), the layout the large exchanges use on phones — two to three screens
 * instead of the desktop marketing page: search → total / sign-up card → banner carousel → quick entries →
 * one-line announcements → market lists (热门 / 涨幅榜 / 新币 / 成交额 / 合约). The desktop home is untouched.
 *
 * BANNERS are fixed sample slides for now: the backend has no banner endpoint yet. Replace `banners` with the
 * CMS response (image, title, link) once it exists.
 */
const board = useFuturesBoard()

const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      search: '搜索币种', support: '帮助与客服', welcome: '欢迎来到 {brand}', welcomeSub: '一个账户交易加密货币、黄金与美股', signup: '注册', login: '登录',
      banners: '活动横幅', go: '立即查看',
      b1Tag: '热门', b1Title: 'WIN/USDT 现货交易', b1Sub: '现货交易已开放',
      b2Tag: '合约行情', b2Title: '黄金与美股永续合约', b2Sub: '行情已上线 · 交易暂未开放',
      b3Tag: '热门板块', b3Title: 'AI · RWA · 美股 · 黄金', b3Sub: '按板块发现市场机会',
      quick: '快捷入口', quickBuy: '快捷买币', c2c: 'C2C 交易', futuresData: '合约数据', sectors: '热门板块', futuresQuotes: '合约行情', help: '帮助中心', earn: '理财', copy: '跟单', launchpad: 'Launchpad', launchpool: 'Launchpool', loans: '借币', invite: '邀请返佣', vip: 'VIP',
      notices: '公告', hot: '热门', gainers: '涨幅榜', fresh: '新币', volume: '成交额', futures: '合约',
      name: '名称', last: '最新价', change: '24h 涨跌', all: '查看全部行情', none: '暂无数据', perp: '永续',
      fees: '费率标准', risk: '风险提示：数字资产及合约价格波动剧烈，杠杆交易可能放大亏损。请在充分了解风险后谨慎决策。',
    },
    'en-US': {
      search: 'Search coins', support: 'Help and support', welcome: 'Welcome to {brand}', welcomeSub: 'Crypto, gold and US stocks in one account', signup: 'Sign up', login: 'Log in',
      banners: 'Promotions', go: 'View',
      b1Tag: 'Hot', b1Title: 'WIN/USDT spot', b1Sub: 'Spot trading is open',
      b2Tag: 'Futures quotes', b2Title: 'Gold and US-stock perpetuals', b2Sub: 'Quotes are live · trading opens soon',
      b3Tag: 'Sectors', b3Title: 'AI · RWA · US stocks · Gold', b3Sub: 'Discover the market by sector',
      quick: 'Shortcuts', quickBuy: 'Buy crypto', c2c: 'C2C', futuresData: 'Futures data', sectors: 'Sectors', futuresQuotes: 'Futures', help: 'Help', earn: 'Earn', copy: 'Copy', launchpad: 'Launchpad', launchpool: 'Launchpool', loans: 'Loans', invite: 'Referral', vip: 'VIP',
      notices: 'Announcements', hot: 'Popular', gainers: 'Gainers', fresh: 'New', volume: 'Volume', futures: 'Futures',
      name: 'Name', last: 'Last price', change: '24h change', all: 'View all markets', none: 'No data yet', perp: 'Perp',
      fees: 'Fees', risk: 'Risk warning: digital asset and derivative prices are highly volatile and leverage can magnify losses. Trade only after you understand the risks.',
    },
  },
})

const router = useRouter()
const market = useMarketStore()
const futures = useFuturesMarketStore()
const session = useSessionStore()

/* ------------------------------------------------------------------ banners */
const banners = computed(() => [
  // Sample slides until the banner endpoint exists; each one only points at something that is live today.
  { key: 'b1', to: '/trade' },
  { key: 'b2', to: '/futures' },
  { key: 'b3', to: '/explore' },
])
const track = ref<HTMLElement | null>(null)
const slide = ref(0)
let autoplay: ReturnType<typeof setInterval> | null = null
function onScroll(): void {
  const el = track.value
  if (el === null || el.clientWidth === 0) return
  slide.value = Math.round(el.scrollLeft / el.clientWidth)
}
function goTo(index: number): void {
  const el = track.value
  if (el === null) return
  el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' })
}

/** Shown in the footer so the owner can tell which build a phone is showing (bump with each delivery). */
const BUILD = 'v41'

/* ------------------------------------------------------------------ quick entries */
const entries = computed(() => [
  // Everything the old drawer offered stays one tap away: C2C and futures data have no other phone entry.
  { key: 'quickBuy', to: '/quick-buy', art: 'buy' },
  { key: 'c2c', to: '/otc', art: 'c2c' },
  { key: 'sectors', to: '/explore', art: 'sectors' },
  { key: 'notices', to: '/notices', art: 'notice' },
  { key: 'futuresData', to: '/futures/data', art: 'data' },
  { key: 'help', to: '/help', art: 'help' },
  { key: 'invite', to: '/invite', art: 'gift' },
  { key: 'vip', to: '/vip', art: 'vip' },
])

/* ------------------------------------------------------------------ announcements (one line, rotating) */
const notices = ref<NoticeSummary[]>([])
const noticeIndex = ref(0)
let noticeTimer: ReturnType<typeof setInterval> | null = null
let controller: AbortController | null = null
async function loadNotices(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    const result = await fetchNotices({ page: 1, pageSize: 4 }, current.signal)
    if (controller === current) notices.value = result.items
  } catch {
    if (controller === current) notices.value = []
  }
}
const notice = computed(() => notices.value[noticeIndex.value % Math.max(notices.value.length, 1)])

/* ------------------------------------------------------------------ markets */
type TabKey = 'hot' | 'gainers' | 'fresh' | 'volume' | 'futures'
const tabs: TabKey[] = ['hot', 'gainers', 'fresh', 'volume', 'futures']
const tab = ref<TabKey>('hot')
const LIMIT = 20

interface Row { key: string; base: string; quote: string; tag: string; last: string; rose: string; amount: string; change: PercentView; isNew: boolean; symbol: string; open: () => void }

const spotRows = computed<Row[]>(() => {
  const groups = market.publicInfo?.market?.market ?? {}
  const fresh = new Set<string>()
  Object.values(groups).forEach((group) => Object.entries(group).forEach(([pair, info]) => { if (String(info?.newcoinFlag ?? '0') === '1') fresh.add(pair.toUpperCase()) }))
  return market.symbols.map((entry) => {
    const tick = market.tickers[entry.symbol.toLowerCase()]
    const rose = tick?.rose ?? ''
    return {
      key: entry.symbol, base: entry.base, quote: entry.quote, tag: '',
      last: tick !== undefined && isDecimalString(tick.close) ? groupDigits(tick.close, Math.min(entry.pricePrecision, 8)) : '--',
      rose, amount: tick?.amount ?? '',
      change: rose === '' ? { text: '--', direction: 'flat' } : percentView(rose),
      isNew: fresh.has(entry.pair.toUpperCase()), symbol: entry.symbol,
      open: () => { market.selectPair(entry.pair); void router.push('/trade') },
    }
  })
})
const futuresRows = computed<Row[]>(() => board.rows.value.map((row) => ({
  key: row.contract.contractName, base: row.base, quote: 'USDT', tag: t('perp'), last: row.last, rose: '', amount: '', change: row.change, isNew: false, symbol: '',
  open: () => { futures.selectContract(row.contract.contractName); void router.push('/futures') },
})))
/** Market config still on its way: show skeleton rows, not “no data”. */
const loading = computed(() => market.publicInfo === null && market.publicInfoError === null)
const shown = computed<Row[]>(() => {
  if (tab.value === 'futures') return futuresRows.value.slice(0, LIMIT)
  const list = [...spotRows.value]
  if (tab.value === 'gainers') list.sort(byDecimalDesc((row: Row) => row.rose))
  else if (tab.value === 'volume') list.sort(byDecimalDesc((row: Row) => row.amount))
  else if (tab.value === 'fresh') {
    const flagged = list.filter((row) => row.isNew)
    return (flagged.length > 0 ? flagged : list).slice(0, LIMIT)
  }
  return list.slice(0, LIMIT)
})

/** Hourly closes of the spot rows on screen (the store requests them once, a few at a time); futures rows have none. */
const shownSymbols = computed(() => shown.value.map((row) => row.symbol).filter((symbol) => symbol !== '').join(','))
watch(shownSymbols, (list) => market.loadTrends(list === '' ? [] : list.split(',')), { immediate: true })
function trendOf(symbol: string): number[] {
  const values = symbol === '' ? undefined : market.trends[symbol]
  return values === undefined || values.length < 2 ? [] : values.slice(-ROW_TREND_POINTS)
}

/* The market tabs and column header pin to the top of the screen while the list is in view. Done by script with
   `position: fixed` (works the same on every phone browser), with a spacer so nothing jumps. */
const pinSentinel = ref<HTMLElement | null>(null)
const pinBar = ref<HTMLElement | null>(null)
const marketsBox = ref<HTMLElement | null>(null)
const pinned = ref(false)
const pinHeight = ref(0)
function updatePin(): void {
  const sentinel = pinSentinel.value
  const bar = pinBar.value
  const box = marketsBox.value
  if (sentinel === null || bar === null || box === null) return
  if (!pinned.value) pinHeight.value = bar.offsetHeight
  // Pinned from the moment the bar's natural place reaches the top until the list's end passes under it.
  pinned.value = sentinel.getBoundingClientRect().top <= 0 && box.getBoundingClientRect().bottom > pinHeight.value + 56
}

let stopStream: (() => void) | null = null
onMounted(() => {
  window.addEventListener('scroll', updatePin, { passive: true })
  window.addEventListener('resize', updatePin)
  updatePin()
  // Same data as the desktop home: the all-pair `review` stream and the public market config.
  stopStream = market.start('overview')
  void market.loadPublicInfo().catch(() => { /* the lists show their empty state */ })
  void loadNotices()
  autoplay = setInterval(() => { if (document.visibilityState === 'visible') goTo((slide.value + 1) % banners.value.length) }, 5000)
  noticeTimer = setInterval(() => { noticeIndex.value += 1 }, 4000)
})
watch(locale, () => void loadNotices())
onBeforeUnmount(() => {
  window.removeEventListener('scroll', updatePin)
  window.removeEventListener('resize', updatePin)
  stopStream?.()
  stopStream = null
  controller?.abort()
  if (autoplay !== null) clearInterval(autoplay)
  if (noticeTimer !== null) clearInterval(noticeTimer)
})
</script>

<template>
  <div class="mhome">

    <HomeOrbit />
    <section v-if="!session.isAuthenticated" class="mh-guest" data-testid="mhome-guest">
      <span><strong>{{ t('welcome', { brand: BRAND_NAME }) }}</strong><small>{{ t('welcomeSub') }}</small></span>
      <RouterLink class="mh-btn gold" to="/register">{{ t('signup') }}</RouterLink>
      <RouterLink class="mh-btn" to="/login">{{ t('login') }}</RouterLink>
    </section>

    <section class="mh-banners" :aria-label="t('banners')">
      <div ref="track" class="mh-track" @scroll.passive="onScroll">
        <RouterLink v-for="(banner, index) in banners" :key="banner.key" class="mh-banner" :class="`tone-${index + 1}`" :to="banner.to" :data-testid="`mhome-banner-${index + 1}`">
          <span class="mh-banner-copy">
            <em>{{ t(`${banner.key}Tag`) }}</em>
            <strong>{{ t(`${banner.key}Title`, { brand: BRAND_NAME }) }}</strong>
            <small>{{ t(`${banner.key}Sub`) }}</small>
            <span class="mh-banner-go">{{ t('go') }}<ChevronRight :size="13" aria-hidden="true" /></span>
          </span>
          <HomeBannerArt :kind="((index % 3) + 1) as 1 | 2 | 3" />
        </RouterLink>
      </div>
      <div class="mh-dots">
        <button v-for="(banner, index) in banners" :key="banner.key" type="button" :class="{ active: slide === index }" :aria-label="`${index + 1} / ${banners.length}`" @click="goTo(index)"></button>
      </div>
    </section>

    <nav class="mh-quick" :aria-label="t('quick')">
      <RouterLink v-for="entry in entries" :key="entry.key" class="mh-entry" :to="entry.to">
        <span class="mh-entry-icon"><ProductArt :kind="entry.art" :size="32" /></span>
        <span class="mh-entry-label">{{ t(entry.key) }}</span>
      </RouterLink>
    </nav>

    <RouterLink v-if="notice !== undefined" class="mh-notice" :to="{ name: 'notice', params: { id: notice.id } }" :aria-label="t('notices')">
      <Megaphone :size="15" aria-hidden="true" />
      <span class="mh-notice-view"><Transition name="nt" mode="out-in"><span :key="notice.id" class="mh-notice-text">{{ notice.title }}</span></Transition></span>
      <ChevronRight :size="14" aria-hidden="true" />
    </RouterLink>

    <section ref="marketsBox" class="mh-markets">
      <div ref="pinSentinel" class="mh-pin-sentinel" :style="{ height: pinned ? `${pinHeight}px` : '0px' }"></div>
      <div ref="pinBar" class="mh-sticky" :class="{ pinned }">
        <div class="mh-tabs" role="tablist">
        <button v-for="key in tabs" :key="key" type="button" role="tab" class="mh-tab" :class="{ active: tab === key }" :aria-selected="tab === key" :data-testid="`mhome-tab-${key}`" @click="tab = key">{{ t(key) }}</button>
        </div>
        <div class="mh-list-head"><span>{{ t('name') }}</span><span></span><span>{{ t('last') }}</span><span>{{ t('change') }}</span></div>
      </div>
      <ul v-if="shown.length === 0 && loading" class="mh-list" aria-hidden="true">
        <li v-for="n in 6" :key="n" class="mh-row mh-sk-row"><span class="mh-row-name"><i class="sk sk-dot"></i><i class="sk sk-name"></i></span><i></i><i class="sk sk-num"></i><i class="sk sk-pill"></i></li>
      </ul>
      <p v-else-if="shown.length === 0" class="mh-empty">{{ t('none') }}</p>
      <ul v-else class="mh-list">
        <li v-for="row in shown" :key="row.key">
          <button type="button" class="mh-row" @click="row.open()">
            <span class="mh-row-name">
              <CoinMark :symbol="row.base" :size="28" />
              <span><strong>{{ row.base }}</strong><small>/{{ row.quote }}</small><i v-if="row.tag !== ''">{{ row.tag }}</i></span>
            </span>
            <span class="mh-row-spark"><Sparkline v-if="trendOf(row.symbol).length > 1" :values="trendOf(row.symbol)" :width="56" :height="26" :direction="row.change.direction" /></span>
            <span v-tick="row.last" class="mh-row-last num">{{ row.last }}</span>
            <span class="mh-row-chg num" :class="row.change.direction">{{ row.change.text }}</span>
          </button>
        </li>
      </ul>
      <RouterLink class="mh-all" :to="tab === 'futures' ? '/futures' : '/markets'">{{ t('all') }}<ChevronRight :size="14" aria-hidden="true" /></RouterLink>
    </section>

    <footer class="mh-foot">
      <div class="mh-sign"><img v-if="BRAND_NAME === 'BIYUN'" class="mh-sign-logo" :src="biyunLogo" alt="BIYUN" width="344" height="108" /><template v-else><BrandMark :size="30" /><strong>{{ BRAND_NAME }}</strong></template></div>
      <nav class="mh-links">
        <RouterLink to="/help">{{ t('help') }}</RouterLink><i></i><RouterLink :to="{ name: 'notices' }">{{ t('notices') }}</RouterLink><i></i><RouterLink to="/fees">{{ t('fees') }}</RouterLink>
      </nav>
      <p>{{ t('risk') }}</p>
      <small>{{ BRAND_NAME }} © {{ new Date().getFullYear() }} · {{ BUILD }}</small>
    </footer>
  </div>
</template>

<style scoped>
.mhome { position: relative; display: flex; flex-direction: column; gap: 14px; padding: 12px 14px 20px; isolation: isolate; }
/* The orbit's glow runs down behind the banner and the shortcuts, so the first screen reads as one piece. */
.mhome::before { content: ''; position: absolute; top: 0; left: 0; right: 0; z-index: -1; height: 640px; pointer-events: none;
  background: radial-gradient(78% 46% at 50% 22%, color-mix(in srgb, var(--color-accent) 20%, transparent), transparent 72%), radial-gradient(120% 34% at 50% 62%, color-mix(in srgb, var(--color-accent) 8%, transparent), transparent 70%); }

.mh-top { display: flex; align-items: center; gap: 10px; }
.mh-support { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 38px; width: 38px; height: 38px; border-radius: 50%; background: var(--color-surface-alt); color: var(--color-text-secondary); }
.mh-search { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text-muted); font-size: 13px; text-decoration: none; }

.mh-card {
  position: relative; padding: 20px 18px 18px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border)); border-radius: 18px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1594 987'%3E%3Cg fill='%23d9a85a' fill-opacity='.13'%3E%3Cpath d='M6 8H273L646 724 521 984Z'/%3E%3Cpath d='M797 40 1031 440 913 665 797 440 681 665 563 440Z'/%3E%3Cpath d='M1321 8H1588L1073 984 948 724Z'/%3E%3C/g%3E%3C/svg%3E") no-repeat right -14px bottom -12px / 150px auto,
    linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, var(--color-surface)), var(--color-surface) 62%);
  box-shadow: 0 10px 28px -18px color-mix(in srgb, var(--color-accent) 70%, transparent);
}
.mh-guest { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 14px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-surface); }
.mh-guest > span { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.mh-guest strong { font-size: 13.5px; font-weight: 700; }
.mh-guest small { overflow: hidden; color: var(--color-text-muted); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.mh-btn { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; height: 32px; padding: 0 14px; border: 1px solid var(--color-border-strong); border-radius: 999px; color: var(--color-text); font-size: 13px; font-weight: 700; text-decoration: none; }
.mh-btn.gold { border-color: transparent; background: var(--color-accent); color: #1a1408; }

.mh-banners { position: relative; }
.mh-track { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; border-radius: 16px; scrollbar-width: none; }
.mh-track::-webkit-scrollbar { display: none; }
.mh-banner {
  --bn-fg: #2a1f08; --bn-sub: rgba(42, 31, 8, .66); --bn-tag-bg: rgba(176, 122, 24, .16); --bn-tag: #8c5e12;
  position: relative; display: flex; align-items: center; flex: 0 0 100%; min-height: 132px; padding: 16px 18px 24px;
  overflow: hidden; scroll-snap-align: start; color: var(--bn-fg); text-decoration: none;
  background: linear-gradient(115deg, #fffaf0 0%, #fbeecb 55%, #f1d99a 100%);
}
:root[data-theme='dark'] .mh-banner {
  --bn-fg: #fff; --bn-sub: rgba(255, 255, 255, .68); --bn-tag-bg: rgba(217, 168, 90, .2); --bn-tag: #f2c64e;
  background: linear-gradient(115deg, #1a140a 0%, #0c0c0e 58%, #17110a 100%);
}
.mh-banner-copy { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-width: 58%; min-width: 0; }
.mh-banner-copy em { padding: 2px 8px; border-radius: 999px; background: var(--bn-tag-bg); color: var(--bn-tag); font-size: 10.5px; font-style: normal; font-weight: 700; letter-spacing: .02em; }
.mh-banner-copy strong { font-family: var(--font-display); font-size: 17px; font-weight: 750; line-height: 1.25; }
.mh-banner-copy small { color: var(--bn-sub); font-size: 12px; }
.mh-banner-go { display: inline-flex; align-items: center; gap: 2px; margin-top: 4px; color: var(--bn-tag); font-size: 12px; font-weight: 700; }
.mh-track { border: 1px solid color-mix(in srgb, var(--color-accent) 30%, var(--color-border)); }
.mh-dots { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; justify-content: center; gap: 5px; }
.mh-dots button { width: 5px; height: 5px; padding: 0; border-radius: 999px; background: color-mix(in srgb, var(--color-text) 30%, transparent); transition: width .2s ease, background-color .2s ease; }
.mh-dots button.active { width: 14px; background: #f2c64e; }

.mh-quick { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px 4px; }
.mh-entry { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; color: var(--color-text-secondary); text-decoration: none; }
.mh-entry-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 17px; color: var(--color-accent-text); transition: transform .12s ease;
  border: 1px solid color-mix(in srgb, var(--color-accent) 26%, var(--color-border));
  background: radial-gradient(120% 90% at 22% 12%, color-mix(in srgb, var(--color-accent) 30%, transparent), transparent 62%), linear-gradient(160deg, var(--color-surface-alt), var(--color-surface));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 6px 14px -10px color-mix(in srgb, var(--color-accent) 80%, transparent);
}
.mh-entry:active .mh-entry-icon { transform: scale(.94); }
.mh-entry-label { max-width: 100%; overflow: hidden; font-size: 11.5px; white-space: nowrap; text-overflow: ellipsis; }

.mh-notice { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 2px; color: var(--color-text-secondary); font-size: 12.5px; text-decoration: none; }
.mh-notice-view { flex: 1 1 auto; min-width: 0; height: 24px; overflow: hidden; line-height: 24px; }
.nt-enter-active, .nt-leave-active { transition: transform .32s ease, opacity .32s ease; }
.nt-enter-from { transform: translateY(100%); opacity: 0; } .nt-leave-to { transform: translateY(-100%); opacity: 0; }
.mh-notice > svg:first-child { flex: 0 0 auto; color: var(--color-accent-text); }
.mh-notice > svg:last-child { flex: 0 0 auto; color: var(--color-text-muted); }
.mh-notice-text { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* Edge to edge, no card: the list sits on the page like the markets tab's. */
.mh-markets { margin: 2px -14px 0; }
/* The tabs and the column header stay at the top of the screen while the list scrolls under them. */
.mh-sticky { position: relative; z-index: 5; background: var(--color-bg); }
.mh-sticky.pinned { position: fixed; top: 0; left: 0; right: 0; z-index: 40; padding-top: env(safe-area-inset-top, 0px); box-shadow: 0 10px 14px -12px rgba(0, 0, 0, .55); }
.mh-pin-sentinel { width: 100%; }
/* Fixed in place (owner 2026-11-17): the five tabs share the width evenly and the row cannot be dragged sideways. */
.mh-tabs { display: flex; justify-content: space-between; gap: 0; padding: 0 16px; overflow: hidden; border-bottom: 1px solid var(--color-border); touch-action: pan-y; overscroll-behavior: none; }
.mh-tab { position: relative; flex: 0 1 auto; min-width: 0; height: 42px; white-space: nowrap; color: var(--color-text-muted); font-family: var(--font-display); font-size: 15.5px; font-weight: 700; transition: color .15s ease; }
.mh-tab.active { color: var(--color-text); }
.mh-tab.active::after { content: ''; position: absolute; left: 18%; right: 18%; bottom: -1px; height: 2.5px; border-radius: 2px; background: var(--color-accent); box-shadow: 0 0 10px var(--color-accent); }
.mh-list-head, .mh-row { display: grid; grid-template-columns: minmax(0, 1.25fr) 56px minmax(0, 1fr) 80px; align-items: center; gap: 8px; }
.mh-row-spark { display: flex; align-items: center; height: 26px; opacity: .9; }
.mh-list-head { padding: 10px 16px 4px; color: var(--color-text-muted); font-size: 11px; }
.mh-list-head span:nth-child(n + 3), .mh-row-last { text-align: right; }
.mh-list { margin: 0; padding: 0; list-style: none; }
.mh-row { width: 100%; height: 56px; padding: 0 16px; text-align: left; }
.mh-row:active { background: var(--color-hover); }
.mh-row-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mh-row-name > span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mh-row-name strong { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
.mh-row-name small { color: var(--color-text-muted); font-size: 11px; }
.mh-row-name i { display: inline-block; margin-left: 5px; padding: 1px 5px; border-radius: 4px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 10px; font-style: normal; }
.mh-row-last { font-size: 14.5px; font-weight: 650; }
.mh-row-chg { display: inline-flex; align-items: center; justify-content: center; justify-self: end; width: 80px; height: 32px; border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13px; font-weight: 700; }
.mh-row-chg.up { background: var(--color-up); color: #fff; }
.mh-row-chg.down { background: var(--color-down); color: #fff; }
.mh-empty { margin: 0; padding: 28px 0; color: var(--color-text-muted); font-size: 13px; text-align: center; }
.mh-all { display: flex; align-items: center; justify-content: center; gap: 2px; height: 40px; margin: 8px 16px 0; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-secondary); font-size: 13px; font-weight: 600; text-decoration: none; }

.mh-foot { display: flex; flex-direction: column; align-items: center; padding: 18px 6px 0; color: var(--color-text-muted); text-align: center; }
.mh-sign { display: flex; align-items: center; gap: 9px; color: var(--color-text); }
.mh-sign-logo { width: auto; height: 44px; }
.mh-sign strong { font-family: var(--font-display); font-size: 18px; font-weight: 800; letter-spacing: .06em; }
.mh-links { display: flex; align-items: center; gap: 14px; margin: 12px 0 14px; }
.mh-links a { color: var(--color-text-secondary); font-size: 12.5px; text-decoration: none; }
.mh-links i { width: 1px; height: 10px; background: var(--color-border-strong); }
.mh-foot p { margin: 0 0 6px; font-size: 11px; line-height: 1.6; }
.mh-foot small { font-size: 11px; }
.mh-row-last.fx-tk-up1, .mh-row-last.fx-tk-up2 { animation: tick-up-a .9s ease-out; }
.mh-row-last.fx-tk-up2 { animation-name: tick-up-b; }
.mh-row-last.fx-tk-dn1, .mh-row-last.fx-tk-dn2 { animation: tick-dn-a .9s ease-out; }
.mh-row-last.fx-tk-dn2 { animation-name: tick-dn-b; }
@keyframes tick-up-a { from { color: var(--color-up); } }
@keyframes tick-up-b { from { color: var(--color-up); } }
@keyframes tick-dn-a { from { color: var(--color-down); } }
@keyframes tick-dn-b { from { color: var(--color-down); } }
@media (prefers-reduced-motion: reduce) { .mh-row-last { animation: none !important; } }
.sk { display: block; border-radius: 8px; background: linear-gradient(90deg, var(--color-surface-alt) 25%, color-mix(in srgb, var(--color-text) 9%, var(--color-surface-alt)) 50%, var(--color-surface-alt) 75%); background-size: 200% 100%; animation: sk-move 1.3s linear infinite; }
@keyframes sk-move { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .sk { animation: none; } }
.mh-sk-row .sk-dot { width: 28px; height: 28px; border-radius: 50%; }
.mh-sk-row .sk-name { width: 78px; height: 14px; }
.mh-sk-row .sk-num { justify-self: end; width: 64px; height: 14px; }
.mh-sk-row .sk-pill { justify-self: end; width: 78px; height: 30px; }
.mh-row-name i.sk { margin: 0; padding: 0; }
/* Only the colour flash here: the desktop home's flash bar (styles/home-fx.css) is not part of the phone home. */
.mh-row-last::after { content: none !important; }
@media (max-width: 360px) { .mh-tabs { padding: 0 12px; } .mh-tab { font-size: 14px; } }
</style>
