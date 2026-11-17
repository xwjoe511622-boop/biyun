<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Globe2, Mail, Moon, Sun } from '@lucide/vue'
import BrandMark from '@/components/common/BrandMark.vue'
import { BRAND_FULL, BRAND_NAME, BRAND_NAME_ZH } from '@/core/brand'
import { isFeatureEnabled } from '@/core/feature-flags'
import { LOCALES, setLocale } from '@/i18n'
import { theme, toggleTheme } from '@/core/theme'
import { useMarketStore } from '@/stores/market'
import { fetchFooterArticles, type CmsLink } from '@/modules/content/content.api'
import { runWhenIdle } from '@/core/idle'
import { readCache, writeCache } from '@/core/session-cache'
import { FOOTER_COLUMNS } from './nav-config'

/**
 * Site footer for non-terminal pages, Binance arrangement: brand + community/contact + preferences on the left,
 * five link columns (about, products, service, support, learn), then the risk warning and copyright. Every link
 * is a real route or an admin-configured CMS page; contact details render only when public info returns them.
 *
 * Stable class names for skins: .site-footer, .footer-inner, .footer-side, .footer-cols, .footer-col, .footer-legal.
 */
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      tagline: '一个账户交易现货、U 本位永续合约（含黄金与美股合约），并使用跟单、理财与新币发行。',
      community: '社区与联系',
      noContact: '官方社区与客服渠道公布后将在此列出。',
      preference: '偏好设置',
      language: '语言',
      themeDark: '深色模式',
      themeLight: '浅色模式',
      about: '关于',
      products: '产品',
      service: '服务',
      support: '支持',
      learn: '学习',
      notices: '公告中心',
      fees: '费率标准',
      spot: '现货交易',
      margin: '杠杆交易',
      futures: 'U 本位合约',
      copy: '跟单交易',
      earn: '理财',
      launchpad: 'Launchpad',
      launchpool: 'Launchpool',
      vesting: '锁仓释放',
      loans: '借币',
      quickBuy: '快捷买币',
      otc: 'C2C 交易',
      vip: 'VIP 会员',
      affiliate: '代理商',
      invite: '邀请返佣',
      redpacket: '红包',
      transfer: '站内转账',
      assets: '资产管理',
      help: '帮助中心',
      messages: '消息中心',
      kyc: '身份认证',
      security: '账户安全与 API',
      recover: '找回密码',
      apiDocs: 'API 文档',
      earnTerms: '理财服务协议',
      loanTerms: '借币服务协议',
      markets: '行情中心',
      futuresData: '合约数据',
      register: '注册账户',
      risk: '风险提示：数字资产及合约价格波动剧烈，杠杆交易可能放大亏损，甚至损失全部保证金。请在充分了解产品与风险后谨慎决策，您须自行承担投资决定的后果。',
      env: import.meta.env.VITE_BRAND === 'bitwinex' ? '' : '当前为测试环境，不对公众开放真实资产服务。',
    },
    'en-US': {
      tagline: 'One account for spot, USDT-margined perpetuals (including gold and US-stock contracts), copy trading, Earn and token launches.',
      community: 'Community & contact',
      noContact: 'Official community and support channels will be listed here once published.',
      preference: 'Preferences',
      language: 'Language',
      themeDark: 'Dark mode',
      themeLight: 'Light mode',
      about: 'About',
      products: 'Products',
      service: 'Service',
      support: 'Support',
      learn: 'Learn',
      notices: 'Announcements',
      fees: 'Fees',
      spot: 'Spot',
      margin: 'Margin',
      futures: 'USDⓈ-M futures',
      copy: 'Copy trading',
      earn: 'Earn',
      launchpad: 'Launchpad',
      launchpool: 'Launchpool',
      vesting: 'Vesting',
      loans: 'Loans',
      quickBuy: 'Quick buy',
      otc: 'C2C trading',
      vip: 'VIP',
      affiliate: 'Affiliate',
      invite: 'Referral',
      redpacket: 'Red packet',
      transfer: 'Internal transfer',
      assets: 'Assets',
      help: 'Help center',
      messages: 'Messages',
      kyc: 'Identity verification',
      security: 'Security & API',
      recover: 'Reset password',
      apiDocs: 'API docs',
      earnTerms: 'Simple Earn Agreement',
      loanTerms: 'Crypto Loan Agreement',
      markets: 'Markets',
      futuresData: 'Futures data',
      register: 'Create account',
      risk: 'Risk warning: digital asset and derivative prices are highly volatile, and leverage can magnify losses up to your entire margin. Trade only after you understand the product and its risks; you are responsible for your investment decisions.',
      env: import.meta.env.VITE_BRAND === 'bitwinex' ? '' : 'This is a test environment and does not provide public real-asset services.',
    },
  },
})
const market = useMarketStore()
const email = computed(() => {
  const value = market.publicInfo?.msg?.contact_email
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim() : ''
})
const year = new Date().getUTCFullYear()

/** Columns live in `nav-config.ts` (shared uniqueness test with the header); flagged links hide while their flag is off. */
const columns = computed(() => FOOTER_COLUMNS.map((column) => ({
  key: column.key,
  links: column.links.filter((link) => link.flag === undefined || isFeatureEnabled(link.flag)),
})))

/** Phones fold the link columns into an accordion (Binance mobile footer); the open one is remembered here. */
const openColumn = ref<string | null>(null)
function toggleColumn(key: string): void {
  openColumn.value = openColumn.value === key ? null : key
}

function changeLocale(event: Event): void {
  setLocale((event.target as HTMLSelectElement).value)
  void market.loadPublicInfo({ force: true }).catch(() => { /* Market error state is rendered by the view. */ })
}

/**
 * Admin-configured footer CMS pages (terms, privacy, …) from `cms/footer/list`, shown under "About"; hidden when none.
 * The footer is below the fold, so the request waits for an idle moment instead of competing with
 * the page's market data, and the list is cached per language for the browser session.
 */
const FOOTER_CACHE_MAX_AGE_MS = 30 * 60_000
const FOOTER_DELAY_MS = 3_000
const legalLinks = ref<CmsLink[]>([])
let controller: AbortController | null = null
let cancelIdle: () => void = () => undefined

function footerCacheName(): string {
  return `footer.${locale.value}`
}

function sanitizeLinks(data: unknown): CmsLink[] | null {
  if (!Array.isArray(data)) return null
  const links = data.filter((item): item is CmsLink => item !== null && typeof item === 'object'
    && typeof (item as CmsLink).id === 'string' && typeof (item as CmsLink).title === 'string'
    && typeof (item as CmsLink).fileName === 'string' && (item as CmsLink).fileName !== '')
  return links.length === data.length ? links : null
}

async function loadLegal(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  const cacheName = footerCacheName()
  try {
    const links = (await fetchFooterArticles(current.signal)).slice(0, 8)
    if (controller === current) legalLinks.value = links
    writeCache(cacheName, links)
  } catch {
    if (controller === current && readCache(cacheName, FOOTER_CACHE_MAX_AGE_MS, sanitizeLinks) === null) legalLinks.value = []
  }
}

function scheduleLegal(): void {
  cancelIdle()
  const cached = readCache(footerCacheName(), FOOTER_CACHE_MAX_AGE_MS, sanitizeLinks)
  if (cached !== null) {
    legalLinks.value = cached.data
    return
  }
  // A delay first: right after boot the browser is "idle" while it waits for the page's data.
  cancelIdle = runWhenIdle(() => void loadLegal(), { delayMs: FOOTER_DELAY_MS, timeoutMs: 4_000 })
}

onMounted(scheduleLegal)
watch(locale, scheduleLegal)
onBeforeUnmount(() => {
  cancelIdle()
  controller?.abort()
})
</script>

<template>
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-side">
        <RouterLink class="brand" to="/"><BrandMark :size="28" /><span>{{ BRAND_NAME }}</span><small v-if="BRAND_NAME_ZH !== ''">{{ BRAND_NAME_ZH }}</small></RouterLink>
        <p class="tagline">{{ t('tagline') }}</p>

        <h4>{{ t('community') }}</h4>
        <a v-if="email !== ''" class="pref-row" :href="`mailto:${email}`"><Mail :size="18" :stroke-width="1.6" />{{ email }}</a>
        <p v-else class="muted-line">{{ t('noContact') }}</p>

        <h4>{{ t('preference') }}</h4>
        <label class="pref-row pref-select">
          <Globe2 :size="18" :stroke-width="1.6" aria-hidden="true" />
          <span>{{ LOCALES.find((option) => option.code === locale)?.label ?? locale }}</span>
          <select :aria-label="t('language')" :value="locale" @change="changeLocale">
            <option v-for="option in LOCALES" :key="option.code" :value="option.code">{{ option.label }}</option>
          </select>
        </label>
        <button class="pref-row" type="button" @click="toggleTheme">
          <Moon v-if="theme === 'dark'" :size="18" :stroke-width="1.6" /><Sun v-else :size="18" :stroke-width="1.6" />
          {{ theme === 'dark' ? t('themeDark') : t('themeLight') }}
        </button>
      </div>

      <div class="footer-cols">
        <nav v-for="column in columns" :key="column.key" class="footer-col" :class="{ 'is-open': openColumn === column.key }" :aria-label="t(column.key)">
          <h4>
            <span class="col-title">{{ t(column.key) }}</span>
            <button class="col-toggle" type="button" :aria-expanded="openColumn === column.key" @click="toggleColumn(column.key)">
              {{ t(column.key) }}<ChevronDown :size="18" aria-hidden="true" />
            </button>
          </h4>
          <template v-for="link in column.links" :key="link.to">
            <a v-if="link.external === true" :href="link.to">{{ t(link.key) }}</a>
            <RouterLink v-else :to="link.to">{{ t(link.key) }}</RouterLink>
          </template>
          <template v-if="column.key === 'about'">
            <RouterLink v-for="link in legalLinks" :key="link.id" :to="{ name: 'help', params: { id: link.fileName } }">{{ link.title }}</RouterLink>
          </template>
        </nav>
      </div>
    </div>
    <div class="footer-legal">
      <p class="risk">{{ t('risk') }}<template v-if="t('env') !== ''"> {{ t('env') }}</template></p>
      <p class="copy">{{ BRAND_FULL }} © {{ year }}</p>
    </div>
  </footer>
</template>

<style scoped>
.site-footer {
  border-top: 1px solid var(--color-border);
  background: var(--bn-footer, var(--color-surface));
  color: var(--color-text-secondary);
  font-size: 14px;
}
.footer-inner {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 48px;
  max-width: 1200px;
  margin: 0 auto;
  padding: 56px 24px 40px;
}
.footer-side { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; min-width: 0; }
.brand { display: inline-flex; align-items: center; min-height: 40px; gap: 10px; color: var(--color-text); font-family: var(--font-display); font-size: 20px; font-weight: 700; }
.brand small { color: var(--color-text-secondary); font-family: var(--font-sans); font-size: 13px; font-weight: 600; }
.tagline { margin: 0 0 12px; line-height: 1.6; font-size: 13px; }
.footer-side h4, .footer-col h4 { margin: 12px 0 4px; color: var(--color-text); font-size: 16px; font-weight: 600; }
.footer-col h4 { margin-top: 0; margin-bottom: 8px; }
.pref-row {
  position: relative; display: inline-flex; align-items: center; gap: 10px; padding: 4px 0;
  color: var(--color-text-secondary); font-size: 14px; cursor: pointer; transition: color 0.15s;
}
.pref-row:hover { color: var(--color-text); }
.pref-select select { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.pref-select:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.muted-line { margin: 0; color: var(--color-text-muted); font-size: 13px; line-height: 1.55; }

.footer-cols { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 24px; min-width: 0; }
.footer-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.footer-col a { width: fit-content; max-width: 100%; transition: color 0.15s; }
.footer-col a:hover { color: var(--color-text); }
.col-toggle { display: none; }

.footer-legal {
  width: calc(100% - 48px);
  max-width: 1152px;
  margin: 0 auto;
  padding: 20px 0 32px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.65;
}
.footer-legal p { margin: 0; }
.risk { font-weight: 500; }
.copy { margin-top: 14px !important; color: var(--color-text-muted); }

@media (max-width: 1000px) {
  .footer-inner { grid-template-columns: minmax(0, 1fr); gap: 32px; }
  .footer-cols { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 32px; }
}
@media (max-width: 600px) {
  .footer-inner { gap: 20px; padding: 32px 16px 12px; }
  .pref-row { min-height: 44px; }
  /* Link columns become an accordion: one 52 px row per section, links open below with 44 px rows. */
  .footer-cols { grid-template-columns: minmax(0, 1fr); gap: 0; row-gap: 0; border-top: 1px solid var(--color-border); }
  .footer-col { gap: 0; border-bottom: 1px solid var(--color-border); }
  :global(:root[data-skin='binance'] .site-footer .footer-col:last-child) { border-bottom: 0; }
  .footer-col h4 { margin: 0; }
  .col-title { display: none; }
  .col-toggle {
    display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 52px;
    color: var(--color-text); font: inherit; font-size: 15px; font-weight: 600; text-align: left;
  }
  .col-toggle svg { color: var(--color-text-secondary); transition: transform 0.2s var(--ease-out); }
  .footer-col.is-open .col-toggle svg { transform: rotate(180deg); }
  .footer-col a { display: none; }
  .footer-col.is-open a { display: flex; align-items: center; min-height: 44px; width: 100%; }
  .footer-col.is-open { padding-bottom: 8px; }
  .footer-legal { width: calc(100% - 32px); padding: 16px 0 calc(28px + env(safe-area-inset-bottom)); }
}
</style>
