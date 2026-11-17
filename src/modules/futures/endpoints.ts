import { siteWsUrl } from '@/config/site'

/**
 * futures-web-api paths, relative to the `futures` namespace prefix (`/futures-api/`, see
 * `modules/api/http.ts`). Every path was checked against the controllers in
 * `back-futures/futures-api/futures-web-api/src/main/java/com/chainup/futures/web/controller/`:
 *
 *   PublicController      @RequestMapping("/common")   public_info:117 public_market_info:188 get_ladder_info:468
 *                                                      funding_rate_list:559 getMakerAndTaker:839 (GET)
 *   UserController        @RequestMapping("/user")     get_user_config:75 edit_user_page_config:116
 *                                                      margin_model_edit:151 level_edit:193 create_co_id:255
 *   PositionController    @RequestMapping("/position") get_assets_list:75 change_position_margin:123
 *                                                      history_position_list:160
 *   OrderCreateController @RequestMapping("/order")    order_create:74 order_tpsl_create:213 order_cancel:288
 *                                                      order_tpsl_cancel:540 light_close:595
 *   OrderController       @RequestMapping("/order")    current_order_list:97 trigger_order_list:153
 *                                                      history_trigger_order_list:203 history_order_list:346
 *                                                      his_trade_list:623 get_trade_info:1133
 *                                                      take_profit_stop_loss:1175
 *   RecordController      @RequestMapping("/record")   get_transaction_list:77
 */
export const FUTURES_ENDPOINTS = {
  publicInfo: 'common/public_info',
  publicMarketInfo: 'common/public_market_info',
  fundingRateList: 'common/funding_rate_list',
  /** GET; returns fee rows without a contract id (see `modules/futures/api.ts`). */
  makerTaker: 'common/getMakerAndTaker',
  /** Maintenance-margin ladder + leverage tiers of one contract (pre-order liquidation estimate). */
  ladderInfo: 'common/get_ladder_info',

  createCoId: 'user/create_co_id',
  userConfig: 'user/get_user_config',
  editPageConfig: 'user/edit_user_page_config',
  levelEdit: 'user/level_edit',
  marginModelEdit: 'user/margin_model_edit',

  assetsList: 'position/get_assets_list',
  changePositionMargin: 'position/change_position_margin',
  historyPositionList: 'position/history_position_list',

  orderCreate: 'order/order_create',
  orderCancel: 'order/order_cancel',
  tpslCreate: 'order/order_tpsl_create',
  tpslCancel: 'order/order_tpsl_cancel',
  takeProfitStopLoss: 'order/take_profit_stop_loss',
  lightClose: 'order/light_close',

  currentOrderList: 'order/current_order_list',
  triggerOrderList: 'order/trigger_order_list',
  historyOrderList: 'order/history_order_list',
  historyTriggerOrderList: 'order/history_trigger_order_list',
  hisTradeList: 'order/his_trade_list',
  tradeInfo: 'order/get_trade_info',

  transactionList: 'record/get_transaction_list',
} as const

/**
 * Spot <-> futures transfer lives on the spot web-api (default `/fe-ex-api/` namespace):
 * `exchange-web-api/.../api/ContractAct.java` `@RequestMapping("/contract")`:
 *   co_transfer:102 (POST {transferType, amount, coinSymbol})
 */
export const SPOT_CONTRACT_ENDPOINTS = {
  coTransfer: 'contract/co_transfer',
} as const

/** Futures business code "user has not opened futures trading" (`ApiResultCode.USER_NOT_OPEN_CONTRACT`). */
export const CODE_NOT_OPENED = '100501'
/** Spot `contract/co_transfer` (patched 2026-09-27): futures account not opened, nothing was debited. */
export const CODE_TRANSFER_NOT_OPENED = '105001'

/**
 * Planned public futures market socket (being wired by ops). Used only when neither the env override
 * nor the server `wsUrl` is set; while it is unreachable the UI shows "market not connected".
 */
export const FUTURES_FALLBACK_WS_URL = siteWsUrl('/futures-ws')

/** Build-time override, e.g. `wss://ws.ttexxx.xyz/futures-ws`. */
export const FUTURES_WS_URL_OVERRIDE: string | null = (() => {
  const raw = import.meta.env.VITE_FUTURES_WS_URL
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
})()

/**
 * Sequenced futures depth feed (futures-md `/fmd/v1`, see `modules/ws/seq-depth.ts`): the snapshot is
 * same-origin (nginx proxies `/fmd/` on the web host; the service sends no CORS headers), the socket
 * lives on the ws host. Both overridable at build time.
 */
export const FUTURES_SEQ_DEPTH_SNAPSHOT_URL: string = (() => {
  const raw = import.meta.env.VITE_FUTURES_SEQ_DEPTH_REST
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '/fmd/v1/depth'
})()

export const FUTURES_SEQ_DEPTH_WS_URL: string = (() => {
  const raw = import.meta.env.VITE_FUTURES_SEQ_DEPTH_WS_URL
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : siteWsUrl('/fmd/v1/ws')
})()

/** Futures user data stream socket base (`<base>/<listenKey>`); build-time override `VITE_FUTURES_USER_WS_URL`. */
export const FUTURES_USER_WS_URL: string = (() => {
  const raw = import.meta.env.VITE_FUTURES_USER_WS_URL
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : siteWsUrl('/futures-user/ws')
})()
