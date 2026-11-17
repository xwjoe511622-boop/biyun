/**
 * Typed feature flags. Everything that is not implemented in this client defaults to `false`
 * and is therefore never rendered: no short-video, live-stream or chat entry points appear in
 * the navigation or on the trade page.
 */

export interface FeatureFlags {
  /** Short video module. Not implemented in this client. */
  shortVideo: boolean
  /** Live streaming module. Not implemented in this client. */
  liveStream: boolean
  /** IM chat module. Not implemented in this client. */
  chat: boolean
  /** Retired standalone coin profile route; metadata is maintained in the admin. */
  coinIntroPage: boolean
  /** Assets page (`/finance/v5/account_balance`). Implemented; on by default. */
  assetsPage: boolean
  /**
   * Official provider SDKs for login, registration and password recovery.
   * Server policy and a valid provider challenge remain authoritative.
   */
  loginCaptchaProvider: boolean
  /** Depth chart tab next to the K-line (shipped 2026-09-26). */
  depthChart: boolean
  /**
   * Products that are announced but not open yet (owner 2026-11-17). While a flag is `false` its page is the
   * “coming soon” preview (views/ComingSoonView.vue) and no product figure is shown anywhere; turn it on when the
   * backend is live and the real page returns. Futures quotes stay visible either way — only order entry closes.
   */
  futuresTrading: boolean
  copyTrading: boolean
  earn: boolean
  loans: boolean
  launchpad: boolean
  launchpool: boolean
  vesting: boolean
}

export type FeatureFlagKey = keyof FeatureFlags

/** A product opens when its build variable is `1` (e.g. `VITE_OPEN_EARN=1` in `.env.local`); unset = coming soon. */
function productOpen(name: string): boolean {
  return String((import.meta.env as Record<string, unknown>)[name] ?? '') === '1'
}

export const defaultFeatureFlags: FeatureFlags = {
  shortVideo: false,
  liveStream: false,
  chat: false,
  coinIntroPage: false,
  assetsPage: true,
  loginCaptchaProvider: true,
  depthChart: true,
  futuresTrading: productOpen('VITE_OPEN_FUTURES_TRADING'),
  copyTrading: productOpen('VITE_OPEN_COPY_TRADING'),
  earn: productOpen('VITE_OPEN_EARN'),
  loans: productOpen('VITE_OPEN_LOANS'),
  launchpad: productOpen('VITE_OPEN_LAUNCHPAD'),
  launchpool: productOpen('VITE_OPEN_LAUNCHPOOL'),
  vesting: productOpen('VITE_OPEN_VESTING'),
}

/** Mutable runtime copy. Overrides may only come from local build config, never from the API. */
const flags: FeatureFlags = { ...defaultFeatureFlags }

export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  return flags[key] === true
}

export function setFeatureFlag(key: FeatureFlagKey, enabled: boolean): void {
  flags[key] = enabled
}

export function featureFlags(): Readonly<FeatureFlags> {
  return flags
}
