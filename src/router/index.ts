import { translateForLocale } from '@/i18n/composer'
import { createRouter, createWebHistory, type RouteMeta, type RouteRecordRaw } from 'vue-router'
import { isFeatureEnabled } from '@/core/feature-flags'
import { currentLocale } from '@/i18n'
import { BRAND_FULL } from '@/core/brand'
import { prefetchRouteData } from './prefetch'
import { installChunkRecovery } from './chunk-recovery'
import { PRODUCT_TERMS_ROUTES } from './product-terms'

/**
 * Only implemented routes exist here. Optional modules (short video / live / chat / future work)
 * are contributed through the typed extension registry and stay absent while their feature flag is
 * `false` — they are never rendered as dead links.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { titleKey: 'nav.home' } },
  {
    path: '/markets',
    name: 'markets',
    component: () => import('@/views/MarketsView.vue'),
    meta: { titleKey: 'nav.markets' },
  },
  {
    path: '/trade',
    name: 'trade',
    component: () => import('@/views/TradeView.vue'),
    meta: { titleKey: 'nav.trade' },
  },
  {
    path: '/assets',
    name: 'assets',
    component: () => import('@/views/AssetsView.vue'),
    meta: { titleKey: 'nav.assets' },
  },
  {
    path: '/security',
    name: 'security',
    component: () => import('@/views/SecurityView.vue'),
    meta: { titleKey: 'nav.security' },
  },
  // Derivatives / margin (owned by the futures and margin modules).
  { path: '/futures', name: 'futures', component: () => import('@/views/futures/FuturesTradeView.vue'), meta: { titleKey: 'nav.futures' } },
  { path: '/futures/data', name: 'futures-data', component: () => import('@/views/futures/FuturesDataView.vue'), meta: { titleKey: 'nav.futuresData' } },
  { path: '/copy-trading', name: 'copy-trading', component: () => (isFeatureEnabled('copyTrading') ? import('@/views/futures/CopyTradingView.vue') : import('@/views/ComingSoonView.vue')), meta: { soon: 'copyTrading', titleKey: 'nav.copyTrading' } },
  { path: '/margin', name: 'margin', component: () => import('@/views/margin/MarginTradeView.vue'), meta: { titleKey: 'nav.margin' } },
  { path: '/orders', name: 'orders', component: () => import('@/views/orders/OrdersCenterView.vue'), meta: { titleKey: 'nav.orders' } },
  // 快捷买币: a spot market order sized in USDT (owner 10-22).
  { path: '/quick-buy', name: 'quick-buy', component: () => import('@/views/QuickBuyView.vue'), meta: { titleKey: 'navigation.quickBuy' } },
  // C2C / OTC.
  { path: '/otc', name: 'otc', component: () => import('@/views/otc/OtcMarketView.vue'), meta: { titleKey: 'nav.otc' } },
  { path: '/otc/orders', name: 'otc-orders', component: () => import('@/views/otc/OtcOrdersView.vue'), meta: { titleKey: 'nav.otcOrders' } },
  { path: '/otc/orders/:id', name: 'otc-order', component: () => import('@/views/otc/OtcOrderDetailView.vue'), meta: { titleKey: 'nav.otcOrders' } },
  { path: '/otc/adverts', name: 'otc-adverts', component: () => import('@/views/otc/OtcAdvertsView.vue'), meta: { titleKey: 'nav.otcAdverts' } },
  // Content and account services.
  ...PRODUCT_TERMS_ROUTES,
  { path: '/notices', name: 'notices', component: () => import('@/views/content/NoticeListView.vue'), meta: { titleKey: 'nav.notices' } },
  { path: '/notices/:id', name: 'notice', component: () => import('@/views/content/NoticeDetailView.vue'), meta: { titleKey: 'nav.notices' } },
  { path: '/help/:id?', name: 'help', component: () => import('@/views/content/HelpCenterView.vue'), meta: { titleKey: 'nav.help' } },
  { path: '/fees', name: 'fees', component: () => import('@/views/content/FeesView.vue'), meta: { titleKey: 'nav.fees' } },
  { path: '/messages', name: 'messages', component: () => import('@/views/account/MessagesView.vue'), meta: { titleKey: 'nav.messages' } },
  { path: '/kyc', name: 'kyc', component: () => import('@/views/account/KycView.vue'), meta: { titleKey: 'nav.kyc' } },
  { path: '/invite', name: 'invite', component: () => import('@/views/account/InviteView.vue'), meta: { titleKey: 'nav.invite' } },
  {
    path: '/coin-intro',
    name: 'coin-intro',
    redirect: '/trade',
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { titleKey: 'nav.login' },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { titleKey: 'nav.register' },
  },
  {
    path: '/recover-password',
    name: 'recover-password',
    component: () => import('@/views/RecoverPasswordView.vue'),
    meta: { titleKey: 'nav.recoverPassword' },
  },
  // Business and account pages.
  // 探索: the 金融 menu as a page, the phone bottom navigation's fourth tab (owner 11-17).
  // 个人中心: opened from the avatar in the phone header (owner 11-17).
  { path: '/me', name: 'me', component: () => import('@/views/UserCenterView.vue'), meta: { titleKey: 'nav.userCenter' } },
  { path: '/explore', name: 'explore', component: () => import('@/views/ExploreView.vue'), meta: { titleKey: 'nav.explore' } },
  { path: '/earn', name: 'earn', component: () => (isFeatureEnabled('earn') ? import('@/views/business/EarnView.vue') : import('@/views/ComingSoonView.vue')), meta: { soon: 'earn', titleKey: 'navigation.earn' } },
  { path: '/launchpad', name: 'launchpad', component: () => (isFeatureEnabled('launchpad') ? import('@/views/business/LaunchpadView.vue') : import('@/views/ComingSoonView.vue')), meta: { soon: 'launchpad', titleKey: 'navigation.launchpad' } },
  { path: '/launchpool', name: 'launchpool', component: () => (isFeatureEnabled('launchpool') ? import('@/views/business/LaunchpoolView.vue') : import('@/views/ComingSoonView.vue')), meta: { soon: 'launchpool', titleKey: 'navigation.launchpool' } },
  { path: '/vesting', name: 'vesting', component: () => (isFeatureEnabled('vesting') ? import('@/views/business/VestingView.vue') : import('@/views/ComingSoonView.vue')), meta: { soon: 'vesting', titleKey: 'navigation.vesting' } },
  { path: '/predict', name: 'predict', component: () => import('@/views/ComingSoonView.vue'), meta: { soon: 'predict', titleKey: 'navigation.cloudPredict' } },
  { path: '/vouchers', name: 'vouchers', component: () => import('@/views/business/VouchersView.vue'), meta: { titleKey: 'navigation.vouchers' } },
  { path: '/vip', name: 'vip', component: () => import('@/views/business/VipView.vue'), meta: { titleKey: 'navigation.vip' } },
  { path: '/affiliate', name: 'affiliate', component: () => import('@/views/business/AffiliateView.vue'), meta: { titleKey: 'navigation.affiliate' } },
  { path: '/platform-coin', name: 'platform-coin', component: () => import('@/views/business/PlatformCoinView.vue'), meta: { titleKey: 'navigation.platformCoin' } },
  { path: '/loans', name: 'loans', component: () => (isFeatureEnabled('loans') ? import('@/views/business/LoansView.vue') : import('@/views/ComingSoonView.vue')), meta: { soon: 'loans', titleKey: 'navigation.loans' } },
  // Red packet: the explicit send page must precede the `:sn` detail route.
  { path: '/redpacket/send', name: 'redpacket-send', component: () => import('@/views/RedPacketSendView.vue'), meta: { titleKey: 'navigation.sendRedPacket' } },
  { path: '/redpacket/:sn', name: 'redpacket-detail', component: () => import('@/views/RedPacketDetailView.vue'), meta: { titleKey: 'navigation.redPacket' } },
  // Internal ledger transfer panel (own guest gate + history; no balance is created here).
  { path: '/transfer/internal', name: 'internal-transfer', component: () => import('@/components/wallet/InternalTransferPanel.vue'), meta: { titleKey: 'navigation.internalTransfer' } },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

installChunkRecovery(router)

// Start the page's critical data before its chunk has finished loading.
router.beforeEach((to) => {
  prefetchRouteData(to.name)
})

export function routeTitle(meta: RouteMeta, locale: string): string {
  const key = meta.titleKey
  return typeof key === 'string' && key !== '' ? translateForLocale(locale, key) : ''
}

router.afterEach((to) => {
  const title = routeTitle(to.meta, currentLocale())
  document.title = title === '' ? BRAND_FULL : `${title} · ${BRAND_FULL}`
})
