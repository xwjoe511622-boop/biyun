/**
 * Response/request types for the current spot web-api.
 * Field names were taken from the controllers and service implementations in
 * clean-source/backend/filox-maven/back-exchange/ex-parent (PublicAct, AccountAct, OrderAct, LoginAct,
 * AccountServiceImpl) and cross-checked against api-contracts/openapi/pc-exchange-web-api.openapi.yaml.
 */

export interface CommonResult<T> {
  code: string | number
  msg: string
  data: T
  message?: string
}

export interface CoinListItem {
  name?: string
  showPrecision?: number
  icon?: string
  showName?: string
  isFiat?: number
  sort?: number
  otcOpen?: string | number
  mainChainType?: number
  mainChainSymbol?: string
  mainChainName?: string
  coinTag?: unknown
  [key: string]: unknown
}

export interface SymbolInfo {
  /** Lowercase, no separator, e.g. `btcusdt`. */
  symbol: string
  /** Price decimal places (`ConfigSymbol.pricePre`). */
  price: number
  /** Amount decimal places (`ConfigSymbol.volumePre`). */
  volume: number
  /** `BTC/USDT` */
  name: string
  /** Allowed depth steps, comma separated, e.g. `0.00000001,0.000001,0.0001`. */
  depth: string
  limitPriceMin?: string | number
  limitVolumeMin?: string | number
  marketBuyMin?: string | number
  marketSellMin?: string | number
  showName?: string
  sort?: number
  isShow?: string | number
  newcoinFlag?: string | number
  IsST?: string | number
  multiple?: string | number
  borrowRuleConfigured?: boolean
  tradingStartTime?: number | string
  [key: string]: unknown
}

export interface MarketPublicInfo {
  /** Coin symbol -> coin meta. Key is uppercase, e.g. `BTC`. */
  coinList?: Record<string, CoinListItem>
  followCoinList?: Record<string, CoinListItem>
  /** Admin coin tags (KV `coin_tag_categorys`): `lang_key` (`zh_CN`) -> tag index (`coinList[BASE].coinTag`) -> label. */
  coinTagLangs?: Record<string, Record<string, string> | undefined>
  /** Market WebSocket endpoint configured on the server. */
  wsUrl?: string
  /** Allowed K-line scales; the server returns `""` when unconfigured. */
  klineScale?: string[] | string
  /** Quote coin -> `BASE/QUOTE` -> symbol info. */
  market?: Record<string, Record<string, SymbolInfo>>
  marketSort?: string[]
  maket_index?: string
  rate?: Record<string, unknown>
  [key: string]: unknown
}

export interface PublicInfoMsg {
  company_name?: string
  company_hash?: string
  contact_email?: string
  contact_number?: string
  logoUrl?: string
  iconUrl?: string
  footer_logo_path?: string
  [key: string]: unknown
}

export interface PublicInfoNc {
  nc_prefix?: string
  nc_lang?: string
  nc_appkey?: string
}

export interface PublicInfoV4 {
  /** Slider captcha configuration (Aliyun NC by default). */
  nc?: PublicInfoNc
  url?: Record<string, string>
  msg?: PublicInfoMsg
  /** Feature switches; all values are strings like `"0"` / `"1"`. */
  switch?: Record<string, string | number>
  market?: MarketPublicInfo
  /** Platform coin symbol. */
  HIT?: string
  [key: string]: unknown
}

export interface AccountBalanceData {
  totalBalance?: string
  totalBalanceSymbol?: string
  platformCoin?: string
  /** Coin symbol -> balance entry. Key casing is not guaranteed; use `findCoinBalance`. */
  allCoinMap?: Record<string, CoinBalanceEntry>
  [key: string]: unknown
}

export interface CoinBalanceEntry {
  /** Raw 201/202 from the same authoritative core read as nonTradingBalance, before overcharge allocation. */
  normalBalanceExact?: string
  lockBalanceExact?: string
  /** Exact non-trading 207+221 quantity in the classic v2 contract; never infer from rounded totals. */
  nonTradingBalance?: string
  /** Same configured overcharge rule/whitelist as the backend; a zero amount cannot determine it. */
  overchargeRestricted?: boolean
  normal_balance?: string
  lock_balance?: string
  nc_lock_balance?: string
  lock_position_balance?: string
  lock_position_v2_amount?: string
  total_balance?: string
  allBalance?: string
  overcharge_balance?: string
  coinName?: string
  btcValuatin?: string
  allBtcValuatin?: string
  depositOpen?: string | number
  withdrawOpen?: string | number
  sort?: number
  [key: string]: unknown
}

export interface OrderItem {
  /** Order id as a string. */
  id: string
  side: string
  side_text?: string
  /** 0 INIT, 1 NEW, 2 FILLED, 3 PART_FILLED, 4 CANCELED, 5 PENDING_CANCEL, 6 EXPIRED. */
  status: number
  status_text?: string
  /** 1 limit, 2 market. */
  type: number
  source?: string
  time_long?: number
  created_at?: string
  price?: string
  volume?: string
  total_price?: string
  remain_volume?: string
  deal_volume?: string
  deal_money?: string
  avg_price?: string
  baseCoin?: string
  countCoin?: string
  isCloseCancelOrder?: boolean | number | string
}

export interface OrderListData {
  count?: number | null
  /** Server returns `null` instead of an empty array when nothing matches. */
  orderList?: OrderItem[] | null
}

export interface TradeItem {
  id: number | string
  ctime?: string
  time_long?: number
  side?: string
  side_text?: string
  price: string
  volume: string
  deal_price?: string
  fee?: string
  feeCoin?: string
}

export interface TradeListData {
  count?: number | null
  trade_list?: TradeItem[] | null
}

export interface CoinIntroItem {
  id: number
  shortName?: string
  longName?: string
  coinSymbol?: string
  langKey?: string
  publishTimeStr?: string
  publishAmount?: string | number
  currencyAmount?: string | number
  officialUrl?: string
  blockchainUrl?: string
  introduction?: string
}

export interface UserInfoData {
  id?: number
  nickName?: string
  email?: string
  mobileNumber?: string
  userAccount?: string
  countryCode?: string
  avatar?: string
  accountStatus?: string
  /** 1 means real-name verified. */
  authLevel?: number | string
  [key: string]: unknown
}

export interface LoginStepOneData {
  /** Temporary token (older servers only); cookie mode keeps it in the HttpOnly `__Host-lb_pending`. */
  token?: string
  /** `cookie` = the challenge is the HttpOnly cookie (10-17). */
  session?: 'cookie'
  /** `1` Google, `2` SMS, `3` email. */
  type: string
}

export interface LoginStepTwoData {
  userEntity?: Record<string, unknown>
}

export interface OrderCreateRequest {
  symbol: string
  side: 'BUY' | 'SELL'
  /** `"1"` limit, `"2"` market. */
  type: string
  /** Decimal string. Base amount, or quote amount for a market buy. */
  volume: string
  /** Decimal string, required for limit orders. */
  price?: string
}

export interface OrderListRequest {
  /** Lowercase pair, e.g. `btcusdt`. Required by the server. */
  symbol: string
  page: number
  pageSize: number
  /** `BUY` / `SELL`; empty string means all. */
  side?: string
}

export interface HistoryOrderListRequest extends OrderListRequest {
  /** `1` show cancelled orders (server default), `0` hide them. */
  isShowCanceled?: number
}

export interface CancelOrderRequest {
  orderId: string
  symbol: string
}
