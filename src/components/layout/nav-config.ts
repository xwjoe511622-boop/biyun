import type { Component } from 'vue'
import { CloudSun,
  ArrowLeftRight,
  ChartColumn,
  ChartLine,
  Coins,
  Crown,
  Gift,
  HandCoins,
  Handshake,
  LifeBuoy,
  LockKeyhole,
  Megaphone,
  Percent,
  PiggyBank,
  Receipt,
  Rocket,
  Sprout,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  Zap,
} from '@lucide/vue'
import { SKIN, type SkinId } from '@/core/skin'
import type { FeatureFlagKey } from '@/core/feature-flags'

/**
 * Header navigation per skin (owner 10-22): each skin follows its reference site's top nav, and every route appears
 * in exactly ONE place across all groups (no top-level link that is repeated inside a menu, no product in two menus).
 * `tests/nav-config.spec.ts` asserts that for both skins and for the footer columns.
 *
 * Labels and descriptions are i18n keys. `flag` hides an entry while that feature flag is off. `layout` decides how a menu panel
 * renders its columns: `columns` side by side (Binance mega-menu) or `stack` (OKX: one column, section headings,
 * hairline between sections).
 */
export type Copy = string

export interface NavItemDef {
  to: string
  label: Copy
  desc: Copy
  icon: Component
  flag?: FeatureFlagKey
}

export interface NavColumnDef {
  /** Section heading key, empty for an unlabeled section. */
  title: Copy
  items: readonly NavItemDef[]
}

export interface NavGroupDef {
  key: string
  label: Copy
  /** A plain top-level link (no menu). */
  to?: string
  columns?: readonly NavColumnDef[]
  layout?: 'columns' | 'stack'
}

const NO_TITLE: Copy = ''

/* ------------------------------------------------------------------ shared entries (one definition each) */
const QUICK_BUY: NavItemDef = { to: '/quick-buy', label: 'navigation.quickBuy', desc: 'navigation.buyOrSellAtMarketPriceWithUsdt', icon: Zap }
const C2C: NavItemDef = { to: '/otc', label: 'navigation.c2cTrading', desc: 'navigation.tradeUsdtWithMerchantsManyPaymentMethods', icon: Wallet, flag: 'otc' }
const MARKETS: NavItemDef = { to: '/markets', label: 'navigation.markets', desc: 'navigation.livePricesAndMovesForEveryPair', icon: ChartLine }
const FUTURES_DATA: NavItemDef = { to: '/futures/data', label: 'navigation.futuresData', desc: 'navigation.fundingIndexAndMarkPrices', icon: ChartColumn }
const NOTICES: NavItemDef = { to: '/notices', label: 'navigation.announcements', desc: 'navigation.platformNewsAndListings', icon: Megaphone }
const SPOT: NavItemDef = { to: '/trade', label: 'navigation.spot', desc: 'navigation.limitAndMarketOrdersOnALiveBook', icon: Coins }
const MARGIN: NavItemDef = { to: '/margin', label: 'navigation.margin', desc: 'navigation.borrowToTradeWithIsolatedRisk', icon: Percent }
const FUTURES: NavItemDef = { to: '/futures', label: 'navigation.usdMFutures', desc: 'navigation.usdtMarginedPerpetualsInclGoldAndUsStocks', icon: TrendingUp }
const COPY: NavItemDef = { to: '/copy-trading', label: 'navigation.copyTrading', desc: 'navigation.followLeadTradersAutomatically', icon: Users }
const EARN: NavItemDef = { to: '/earn', label: 'navigation.earn', desc: 'navigation.flexibleAndFixedEarnPlans', icon: PiggyBank }
const LOANS: NavItemDef = { to: '/loans', label: 'navigation.loans', desc: 'navigation.collateralisedLoansAndRepayment', icon: HandCoins }
const LAUNCHPAD: NavItemDef = { to: '/launchpad', label: 'navigation.launchpad2', desc: 'navigation.subscribeToNewTokenSales', icon: Rocket }
const LAUNCHPOOL: NavItemDef = { to: '/launchpool', label: 'navigation.launchpool2', desc: 'navigation.stakeToFarmNewTokens', icon: Sprout }
const VESTING: NavItemDef = { to: '/vesting', label: 'navigation.vesting', desc: 'navigation.lockedPlansAndReleaseProgress', icon: LockKeyhole, flag: 'vesting' }
const VIP: NavItemDef = { to: '/vip', label: 'navigation.vip2', desc: 'navigation.tiersAndFeeBenefits', icon: Crown }
const AFFILIATE: NavItemDef = { to: '/affiliate', label: 'navigation.affiliate', desc: 'navigation.becomeAnAffiliateAndEarnRebates', icon: Handshake }
const INVITE: NavItemDef = { to: '/invite', label: 'navigation.referral', desc: 'navigation.inviteFriendsAndShareRebates', icon: UserPlus }
const RED_PACKET: NavItemDef = { to: '/redpacket/send', label: 'navigation.redPacket', desc: 'navigation.sendCryptoRedPackets', icon: Gift }
const HELP: NavItemDef = { to: '/help', label: 'navigation.helpCenter', desc: 'navigation.faqAndGuides', icon: LifeBuoy }
const FEES: NavItemDef = { to: '/fees', label: 'navigation.fees', desc: 'navigation.tradingAndWithdrawalFees', icon: Receipt }
const TRANSFER: NavItemDef = { to: '/transfer/internal', label: 'navigation.internalTransfer', desc: 'navigation.sendToAnotherUidOnThisPlatform', icon: ArrowLeftRight }

/** Announcements entry for pages that list the service links outside the header (phone 个人中心). */
export const NOTICES_ENTRY: NavItemDef = NOTICES
/** 云预测 (prediction market, owner 2026-11-17): announced on the phone 探索 page only, not open yet. */
export const PREDICT_ENTRY: NavItemDef = { to: '/predict', label: 'navigation.cloudPredict', desc: 'navigation.predictEventOutcomes', icon: CloudSun }

const BUY_GROUP: NavGroupDef = { key: 'buy', label: 'navigation.buyCrypto', layout: 'stack', columns: [{ title: NO_TITLE, items: [QUICK_BUY, C2C] }] }

/**
 * Binance (www): 买币▾ · 行情 · 交易▾ · 合约▾ · 理财▾ · 更多▾ — binance.com keeps futures in its own 合约 menu
 * (with the futures data) and spot / margin / copy trading under 交易.
 */
export const BINANCE_NAV: readonly NavGroupDef[] = [
  BUY_GROUP,
  { key: 'markets', label: 'navigation.markets', to: MARKETS.to },
  { key: 'trade', label: 'navigation.trade', columns: [{ title: NO_TITLE, items: [SPOT, MARGIN, COPY] }] },
  { key: 'futures', label: 'navigation.futures', columns: [{ title: NO_TITLE, items: [FUTURES, FUTURES_DATA] }] },
  {
    key: 'earn',
    label: 'navigation.earn',
    columns: [
      { title: 'navigation.earnLoans', items: [EARN, LOANS] },
      { title: 'navigation.tokenLaunches', items: [LAUNCHPAD, LAUNCHPOOL, VESTING] },
    ],
  },
  {
    key: 'more',
    label: 'navigation.more',
    columns: [
      { title: 'navigation.benefitsPartners', items: [VIP, AFFILIATE, INVITE, RED_PACKET] },
      { title: 'navigation.serviceSupport', items: [NOTICES, HELP, FEES, TRANSFER] },
    ],
  },
]

/**
 * OKX (pro.): 买币▾ · 市场▾ · 交易▾ · 金融▾ · 更多▾, mirroring okx.com (10-22): no standalone 合约 item — futures
 * sit inside 交易 next to spot; each panel is one column of icon + title + one-line description with section headings.
 */
export const OKX_NAV: readonly NavGroupDef[] = [
  BUY_GROUP,
  { key: 'markets', label: 'navigation.markets2', layout: 'stack', columns: [{ title: NO_TITLE, items: [MARKETS, FUTURES_DATA, NOTICES] }] },
  {
    key: 'trade',
    label: 'navigation.trade',
    layout: 'stack',
    columns: [
      { title: 'navigation.trading', items: [SPOT, MARGIN, { ...FUTURES, label: 'navigation.futures' }] },
      { title: 'navigation.tools', items: [COPY] },
    ],
  },
  {
    key: 'finance',
    label: 'navigation.finance',
    layout: 'stack',
    columns: [
      { title: 'navigation.earn2', items: [EARN, LOANS] },
      { title: 'navigation.newTokens', items: [LAUNCHPAD, LAUNCHPOOL, VESTING] },
    ],
  },
  {
    key: 'more',
    label: 'navigation.more',
    layout: 'stack',
    columns: [
      { title: 'navigation.benefitsPartners', items: [VIP, AFFILIATE, INVITE, RED_PACKET] },
      { title: 'navigation.serviceSupport', items: [HELP, FEES, TRANSFER] },
    ],
  },
]

export const NAV_BY_SKIN: Readonly<Record<SkinId, readonly NavGroupDef[]>> = { binance: BINANCE_NAV, okx: OKX_NAV }

/** This build's nav (SKIN is a build-time literal, so only one config ends up in the bundle). */
export const NAV_CONFIG: readonly NavGroupDef[] = SKIN === 'okx' ? OKX_NAV : BINANCE_NAV

/** Every route a nav config links to, in order, with repeats (the uniqueness test counts them). */
export function navRoutes(groups: readonly NavGroupDef[]): string[] {
  return groups.flatMap((group) => [
    ...(group.to !== undefined ? [group.to] : []),
    ...(group.columns ?? []).flatMap((column) => column.items.map((item) => item.to)),
  ])
}

/* ------------------------------------------------------------------ footer */
/** `external`: a plain page served by nginx outside the SPA (e.g. /api-docs/), rendered as <a href>. */
export interface FooterLinkDef { to: string; key: string; flag?: FeatureFlagKey; external?: boolean }
export interface FooterColumnDef { key: string; links: readonly FooterLinkDef[] }

/** Footer columns (both skins). Key products may repeat the header, but a link never appears twice in one column. */
export const FOOTER_COLUMNS: readonly FooterColumnDef[] = [
  { key: 'about', links: [{ to: '/notices', key: 'notices' }, { to: '/fees', key: 'fees' }] },
  {
    key: 'products',
    links: [
      { to: '/quick-buy', key: 'quickBuy' }, { to: '/otc', key: 'otc', flag: 'otc' },
      { to: '/trade', key: 'spot' }, { to: '/margin', key: 'margin' }, { to: '/futures', key: 'futures' },
      { to: '/copy-trading', key: 'copy' }, { to: '/earn', key: 'earn' }, { to: '/launchpad', key: 'launchpad' },
      { to: '/launchpool', key: 'launchpool' }, { to: '/vesting', key: 'vesting', flag: 'vesting' }, { to: '/loans', key: 'loans' },
    ],
  },
  {
    key: 'service',
    links: [
      { to: '/vip', key: 'vip' }, { to: '/affiliate', key: 'affiliate' }, { to: '/invite', key: 'invite' },
      { to: '/redpacket/send', key: 'redpacket' }, { to: '/transfer/internal', key: 'transfer' },
      { to: '/assets', key: 'assets', flag: 'assetsPage' },
    ],
  },
  {
    key: 'support',
    links: [
      { to: '/help', key: 'help' }, { to: '/messages', key: 'messages' }, { to: '/kyc', key: 'kyc' },
      { to: '/security', key: 'security' }, { to: '/recover-password', key: 'recover' },
      { to: '/api-docs/', key: 'apiDocs', external: true },
      { to: '/terms/earn', key: 'earnTerms' }, { to: '/terms/loan', key: 'loanTerms' },
    ],
  },
  { key: 'learn', links: [{ to: '/markets', key: 'markets' }, { to: '/futures/data', key: 'futuresData' }, { to: '/register', key: 'register' }] },
]
