import { i18n } from '@/i18n/composer'
import { siteWsUrl } from './site'

/**
 * HTTP paths are relative to the API prefix (`/fe-ex-api/`).
 * Every path below exists in the current web-api controllers:
 *   exchange-web-api/src/main/java/com/chainup/exchange/api/{PublicAct,AccountAct,OrderAct,LoginAct}.java
 */

export const API_PREFIX = import.meta.env.VITE_API_BASE ?? '/fe-ex-api/'

/**
 * Same-origin gateway prefix for the CIAO wallet service.
 *
 * Source of truth: the legacy PC assets page called the CIAO service on the historical host
 * `https://exchange.filoxex.com/web/account/*` with a signed/encrypted envelope
 * (`PC/.../assets/withdraw/withdraw.js:742-765`, `.../assets/recharge/recharge.js:242`). The modern
 * client must not hard-code that host. Instead an operator points `VITE_WALLET_API_BASE` at a
 * same-origin reverse proxy. The current integration preserves `/wallet-api/account/*` and
 * forwards it to port 8208's WalletCompatibilityAct, which reuses the spot JWT and ledger.
 * Port 8222 is an internal address/vault service and must not receive browser wallet routes.
 *
 * The prefix is **empty by default**, which means the wallet gateway and its signing keypair are
 * not configured for this build: every wallet-namespace request then throws before `fetch`. Nothing
 * here silently falls back to the old H5 endpoints or to the legacy external domain.
 */
export function walletApiBase(): string {
  const raw = import.meta.env.VITE_WALLET_API_BASE
  return typeof raw === 'string' ? raw.trim() : ''
}

export function isWalletGatewayConfigured(): boolean {
  return walletApiBase() !== ''
}

const WALLET_PREFIX_PATTERN = /^\/[A-Za-z0-9._~%/-]+$/

/** A rooted, same-origin path prefix: no scheme, no `//`, no `?`/`#`, no backslash or `..`. */
function isValidWalletPrefix(base: string): boolean {
  if (!base.startsWith('/') || base.startsWith('//') || base.includes('//')) {
    return false
  }
  if (/[?#\\\s]/.test(base) || base.includes('://')) {
    return false
  }
  if (!WALLET_PREFIX_PATTERN.test(base)) {
    return false
  }
  return !base.split('/').some(segment => segment === '..' || segment === '.')
}

/**
 * Resolved, validated wallet prefix (always ends with `/`).
 * Throws a localized error **before any fetch** when the gateway is unset or not a rooted path.
 */
export function walletApiPrefix(): string {
  const base = walletApiBase()
  if (base === '') {
    throw new Error(i18n.global.t('serviceMessage.walletGatewayIsNotConfiguredTheServiceIsTemporarily'))
  }
  if (!isValidWalletPrefix(base)) {
    throw new Error(i18n.global.t('serviceMessage.invalidWalletGatewayAddressTheServiceIsTemporarilyUnavailable'))
  }
  return base.endsWith('/') ? base : `${base}/`
}

export const ENDPOINTS = {
  publicInfo: 'common/public_info_v4',
  userInfo: 'common/user_info',
  coinIntro: 'common/coinSymbol_introduce',
  rate: 'common/rate',
  login: 'user/login_in',
  confirmLogin: 'user/confirm_login',
  logout: 'user/login_out',
  /** Trade page balances: includes `overcharge_balance` / `lock_position_v2_amount`. */
  accountBalance: 'finance/account_balance',
  /** Assets page balances (v5: no withdraw address map). */
  accountBalanceV5: 'finance/v5/account_balance',
  createOrder: 'order/create',
  cancelOrder: 'order/cancel',
  openOrders: 'order/list/new',
  historyOrders: 'order/entrust_history',
  myTrades: 'trade/list',
  tradesByOrder: 'trade/list_by_order',
} as const

/** Existing public market WebSocket, used when public info does not return `market.wsUrl`. */
export const FALLBACK_WS_URL = siteWsUrl('/kline-api/ws')

/**
 * Sequenced spot depth feed (spot-md `/smd/v1`, same protocol as futures-md `/fmd/v1`, see
 * `modules/ws/seq-depth.ts`): snapshot same-origin (nginx proxies `/smd/v1/depth` on the web host), socket on the
 * ws host. Both overridable at build time.
 */
export const SPOT_SEQ_DEPTH_SNAPSHOT_URL: string = (() => {
  const raw = import.meta.env.VITE_SPOT_SEQ_DEPTH_REST
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '/smd/v1/depth'
})()

export const SPOT_SEQ_DEPTH_WS_URL: string = (() => {
  const raw = import.meta.env.VITE_SPOT_SEQ_DEPTH_WS_URL
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : siteWsUrl('/smd/v1/ws')
})()

/** Dev-only override, e.g. `/fe-kline-ws/ws` to route the socket through the Vite proxy. */
export const WS_URL_OVERRIDE = import.meta.env.VITE_WS_URL ?? null
