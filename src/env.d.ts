/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Registrable domain of the public site (`ttexxx.xyz` test, `bitwinex.cc` production); WS host is `ws.<domain>`. */
  readonly VITE_SITE_DOMAIN?: string
  /** API prefix used by the browser. Defaults to `/fe-ex-api/`. */
  readonly VITE_API_BASE?: string
  /**
   * Same-origin gateway prefix for the CIAO wallet/signing service (the service that exposes
   * `/web/account/*`). **Empty by default and therefore closed**: wallet money/verification
   * requests throw "wallet gateway not configured" before any fetch until an operator sets this
   * to a root-relative prefix such as `/wallet-api/`. It must never be an absolute external URL.
   */
  readonly VITE_WALLET_API_BASE?: string
  /**
   * WebSocket endpoint override. Leave unset in production so the URL from
   * `/common/public_info_v4` (`market.wsUrl`) is used.
   */
  readonly VITE_WS_URL?: string
  /** futures-web-api prefix (default `/futures-api/`). */
  readonly VITE_FUTURES_API_BASE?: string
  /** Futures market WebSocket override; normally `wsUrl` from futures `common/public_info`. */
  readonly VITE_FUTURES_WS_URL?: string
  /** Futures user data stream socket base, e.g. `wss://ws.ttexxx.xyz/futures-user/ws`. */
  readonly VITE_FUTURES_USER_WS_URL?: string
  /** Binance-style order entry `/futures-api/fapi/v1/order`: '0' / 'false' / 'off' keeps the classic `order_create`. */
  readonly VITE_FUTURES_FAPI_ORDERS?: string
  /** Sequenced futures depth feed (`/fmd/v1`) for the futures book: '0' / 'false' / 'off' disables (default on). */
  readonly VITE_FUTURES_SEQ_DEPTH?: string
  /** Sequenced depth snapshot URL (default same-origin `/fmd/v1/depth`). */
  readonly VITE_FUTURES_SEQ_DEPTH_REST?: string
  /** Sequenced depth WebSocket URL (default `wss://ws.ttexxx.xyz/fmd/v1/ws`). */
  readonly VITE_FUTURES_SEQ_DEPTH_WS_URL?: string
  /** Sequenced spot depth feed (`/smd/v1`) for the spot book: '0' / 'false' / 'off' disables (default on). */
  readonly VITE_SPOT_SEQ_DEPTH?: string
  /** Spot sequenced depth snapshot URL (default same-origin `/smd/v1/depth`). */
  readonly VITE_SPOT_SEQ_DEPTH_REST?: string
  /** Spot sequenced depth WebSocket URL (default `wss://ws.ttexxx.xyz/smd/v1/ws`). */
  readonly VITE_SPOT_SEQ_DEPTH_WS_URL?: string
  /** Same-origin prefix of the Binance-style spot API `/api/v3/*` (default `/`). */
  readonly VITE_SPOT_V3_BASE?: string
  /** Spot user data stream socket base (default `wss://ws.ttexxx.xyz/spot/ws`). */
  readonly VITE_SPOT_USER_WS_URL?: string
  /** Spot order entry / user stream on `/api/v3`: '0' / 'false' / 'off' keeps the classic paths and polling. */
  readonly VITE_SPOT_V3_ORDERS?: string
  /** exchange-otc-api prefix (default `/otc-api/`). */
  readonly VITE_OTC_API_BASE?: string
  /** Display brand: `bitwinex` (AWS production) or `longbit` (Aliyun test, default). See `src/core/brand.ts`. */
  /** `1` = demo mode: the in-browser mock backend is injected (vite.config.ts `demoHtml`); empty otherwise. */
  readonly VITE_DEMO?: string
  readonly VITE_BRAND?: string
  /** Layout skin, build-time literal: 'binance' | 'okx' (vite.config.ts resolveSkin). */
  readonly VITE_SKIN?: string
  /** Latin brand name override (default from the brand). Owned by the client; the legacy `company_name` is ignored. */
  readonly VITE_BRAND_NAME?: string
  /** Chinese brand name override (default from the brand: `龙比特`, none for Bitwinex). */
  readonly VITE_BRAND_NAME_ZH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
