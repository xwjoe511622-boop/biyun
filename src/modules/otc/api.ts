import { i18n } from '@/i18n/composer'
import { request, requestWithRetry, type RequestOptions } from '@/modules/api/http'
import { toDecString } from '@/modules/finance/decimal'
import { safeWebUrl } from '@/core/urls'
import { parseJsonLossless } from '@/core/lossless-json'
import { stripCurrencySuffix } from './amounts'
import { parseMillis } from './countdown'
import { parseStatus, type OtcOrderStatus, type OrderTabQuery } from './order-state'

/**
 * C2C / OTC API client.
 *
 * Two services are involved (verified against the Java source, paths relative to
 * clean-source/backend/filox-maven/back-exchange):
 *
 * `api: 'otc'` → `/otc-api/` → exchange-otc-api (`otc-parent/exchange-otc-api/.../action/api/*`), served at
 * the servlet root (the `/exchange-otc-api/*` mapping is an extra alias). Auth = `exchange-token` looked up
 * as Redis `user_<token>` (BaseAct.java:64-101), i.e. the same session as the spot web-api.
 *
 * default namespace → `/fe-ex-api/` → exchange-web-api: OTC account/transfer, my-order lists, appeal
 * tickets, nickname and fund password.
 *
 * Every response is normalised here into plain decimal strings; missing values become `''`.
 */

const OTC: Pick<RequestOptions, 'api'> = { api: 'otc' }

export const OTC_PATHS = {
  // exchange-otc-api
  publicInfo: 'otc/public_info', // HomePageAct.java:122
  rates: 'otc/rates', // HomePageAct.java:218
  search: 'otc/search', // SearchAdvertAct.java:66
  advertDetail: 'otc/v4/wanted_detail', // AdvertAct.java:856
  buyOrder: 'v4/otc/buy_order_save', // OrderActV4.java:400
  sellOrder: 'v4/otc/sell_order_save', // OrderActV4.java:587
  orderDetail: 'v4/otc/order_detail', // OrderActV4.java:133
  orderPaid: 'v4/otc/order_payed', // OrderActV4.java:881
  orderCancel: 'otc/order_cancel', // OrderAct.java:1767
  orderRelease: 'otc/confirm_order', // OrderAct.java:1946
  complain: 'otc/complain_order', // OrderAct.java:2074
  complainCancel: 'otc/complain_cancel', // OrderAct.java:2188
  chatHistory: 'chatMsg/message', // ChatMsgController.java:60
  publishAdvert: 'otc/wanted_save', // AdvertAct.java:119
  closeAdvert: 'otc/close_wanted', // AdvertAct.java:583
  personAds: 'otc/v4/person_ads', // PersonalPageAct.java:530
  personHome: 'otc/person_home_page', // PersonalPageAct.java:225
  paymentFind: 'otc/payment/find', // PersonalPageAct.java:1465
  paymentAdd: 'otc/payment/add', // PersonalPageAct.java:976
  paymentUpdate: 'otc/payment/update', // PersonalPageAct.java:1154
  paymentDelete: 'otc/v4/payment/delete', // PersonalPageAct.java:1387
  paymentOpen: 'otc/payment/open', // PersonalPageAct.java:1562
  relationship: 'otc/person_relationship', // PersonalPageAct.java:738
  relationshipRemove: 'otc/user_contacts_remove', // PersonalPageAct.java:906
  // exchange-web-api (default namespace)
  accountList: 'finance/v4/otc_account_list', // AccountAct.java:1141
  transfer: 'finance/otc_transfer', // AccountAct.java:1188
  ordersByStatus: 'order/otc/bystatus', // OrderAct.java:1516
  ordersComplete: 'order/otc/complete', // OrderAct.java:1473
  createProblem: 'question/create_problem', // RqInfoAct.java:118
  nickname: 'user/nickname_update', // UserCenterAct.java:404
  capitalPassword: 'v4/capital_password/reset', // UserAct.java:593
  smsCode: 'v4/common/smsValidCode',
} as const

/* ----------------------------------------------------------------------------------------------
 * Normalisation helpers
 * -------------------------------------------------------------------------------------------- */

type Raw = Record<string, unknown>

function obj(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return ''
}

function dec(value: unknown): string {
  const out = toDecString(value)
  return /^\d+(\.\d+)?$/.test(out) ? out : ''
}

function int(value: unknown): number | null {
  const out = text(value)
  return /^-?\d+$/.test(out) ? Number.parseInt(out, 10) : null
}

function flag(value: unknown): boolean {
  const out = text(value)
  return out === '1' || out === 'true'
}

/* ----------------------------------------------------------------------------------------------
 * Public info
 * -------------------------------------------------------------------------------------------- */

export interface PaymentMethodMeta {
  key: string
  title: string
  icon: string
}

export interface OtcPublicInfo {
  payments: PaymentMethodMeta[]
  paycoins: { key: string; title: string }[]
  defaultCoin: string
  defaultSide: 'BUY' | 'SELL'
  defaultPayCoin: string
  /** `sys_conf_otc.chat_ws_url`; `''` when not configured or not a ws(s) URL. */
  chatWsUrl: string
  /** Advert fee rate per coin (`feeOtcList`), used to show the SELL-advert lock. */
  feeRates: Record<string, string>
}

export function safeWsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return ''
    if (url.username !== '' || url.password !== '') return ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function normalizePublicInfo(raw: unknown): OtcPublicInfo {
  const data = obj(raw)
  const payments = list(data.payments)
    .map(obj)
    .filter(item => text(item.key) !== '' && item.used !== false)
    .map(item => ({ key: text(item.key), title: text(item.title) || text(item.key), icon: safeWebUrl(item.icon) }))
  const paycoins = list(data.paycoins)
    .map(obj)
    .filter(item => text(item.key) !== '' && item.used !== false)
    .map(item => ({ key: text(item.key), title: text(item.title) || text(item.key) }))
  const feeRates: Record<string, string> = {}
  list(data.feeOtcList).map(obj).forEach((item) => {
    const symbol = text(item.symbol).toUpperCase()
    const rate = dec(item.rate)
    if (symbol !== '' && rate !== '') feeRates[symbol] = rate
  })
  const side = text(data.defaultSeach).toUpperCase()
  return {
    payments,
    paycoins,
    defaultCoin: text(data.defaultCoin).toUpperCase(),
    defaultSide: side === 'SELL' ? 'SELL' : 'BUY',
    defaultPayCoin: text(data.otcDefaultPaycoin).toUpperCase(),
    chatWsUrl: safeWsUrl(data.otcChatWS),
    feeRates,
  }
}

/** Idempotent public read: transient 502–504 / network errors are retried (seen live 2026-09-27). */
export async function fetchPublicInfo(): Promise<OtcPublicInfo> {
  return normalizePublicInfo(await requestWithRetry<unknown>(OTC_PATHS.publicInfo, { ...OTC, body: {} }))
}

/** Reference prices of one coin in every fiat (`{ CNY: "7.1", USD: "1", ... }`). */
export async function fetchRates(symbol: string): Promise<Record<string, string>> {
  const data = obj(await request<unknown>(OTC_PATHS.rates, { ...OTC, body: { symbol } }))
  const out: Record<string, string> = {}
  Object.entries(data).forEach(([key, value]) => {
    if (/^[A-Z]{3,5}$/.test(key)) {
      const price = dec(value)
      if (price !== '') out[key] = price
    }
  })
  return out
}

/* ----------------------------------------------------------------------------------------------
 * Advert search / detail
 * -------------------------------------------------------------------------------------------- */

export interface AdvertPayment {
  key: string
  title: string
  icon: string
}

export interface OtcAdvert {
  advertId: string
  userId: string
  nickname: string
  online: boolean
  avatar: string
  completeOrders: string
  /** Completion/credit ratio 0..1 as a decimal string (`creditGrade`), `''` when absent. */
  creditGrade: string
  side: 'BUY' | 'SELL' | ''
  price: string
  payCoin: string
  volume: string
  volumeBalance: string
  minTrade: string
  maxTrade: string
  payments: AdvertPayment[]
}

function normalizeAdvertPayments(value: unknown): AdvertPayment[] {
  return list(value)
    .map(obj)
    .map(item => ({
      key: text(item.key) || text(item.payment),
      title: text(item.title),
      icon: safeWebUrl(item.icon),
    }))
    .filter(item => item.key !== '')
}

function normalizeSide(value: unknown): 'BUY' | 'SELL' | '' {
  const side = text(value).toUpperCase()
  return side === 'BUY' || side === 'SELL' ? side : ''
}

export function normalizeAdvert(raw: unknown): OtcAdvert {
  const item = obj(raw)
  return {
    advertId: text(item.advertId),
    userId: text(item.userId),
    nickname: text(item.otcNickName),
    online: text(item.loginStatus) === '1',
    avatar: safeWebUrl(item.imageUrl),
    completeOrders: text(item.completeOrders),
    creditGrade: dec(item.creditGrade),
    side: normalizeSide(item.side),
    price: dec(item.price),
    payCoin: text(item.payCoin).toUpperCase(),
    volume: dec(item.volume),
    volumeBalance: dec(item.volumeBalance),
    minTrade: dec(item.minTrade),
    maxTrade: dec(item.maxTrade),
    payments: normalizeAdvertPayments(item.payments),
  }
}

export interface AdvertSearchQuery {
  /** Advert side: users who want to BUY browse SELL adverts. */
  side: 'BUY' | 'SELL'
  symbol: string
  payCoin: string
  payment: string
  page: number
  pageSize: number
}

export interface Page<T> {
  count: number
  items: T[]
}

export async function searchAdverts(query: AdvertSearchQuery, signal?: AbortSignal): Promise<Page<OtcAdvert>> {
  const body: Record<string, unknown> = {
    side: query.side,
    symbol: query.symbol,
    payCoin: query.payCoin,
    page: String(query.page),
    pageSize: String(query.pageSize),
    isBlockTrade: '0',
  }
  if (query.payment !== '') body.payments = query.payment
  const data = obj(await request<unknown>(OTC_PATHS.search, { ...OTC, body, signal }))
  return {
    count: int(data.count) ?? 0,
    items: list(data.advertList).map(normalizeAdvert).filter(item => item.advertId !== ''),
  }
}

export interface OtcAdvertDetail extends OtcAdvert {
  coin: string
  limitTime: string
  description: string
  /** Server message when the viewer cannot trade this advert (own advert / not tradable). */
  tip: string
  status: string
}

export async function fetchAdvertDetail(advertId: string): Promise<OtcAdvertDetail> {
  const data = obj(await request<unknown>(OTC_PATHS.advertDetail, { ...OTC, body: { advertId } }))
  return {
    ...normalizeAdvert({ ...data, advertId: data.advertId ?? advertId }),
    coin: text(data.coin).toUpperCase(),
    limitTime: text(data.limitTime),
    description: text(data.description),
    tip: text(data.tip),
    status: text(data.status),
  }
}

/* ----------------------------------------------------------------------------------------------
 * Orders
 * -------------------------------------------------------------------------------------------- */

export interface CreateOrderInput {
  /** Side of the ADVERT: SELL advert → the user buys (`buy_order_save`). */
  advertSide: 'BUY' | 'SELL'
  advertId: string
  price: string
  totalPrice: string
  volume: string
  /** `price` when the user typed a fiat amount, `volume` when a coin amount. */
  type: 'price' | 'volume'
  /** Required by `sell_order_save` only. */
  capitalPword?: string
}

export async function createOrder(input: CreateOrderInput): Promise<string> {
  const body: Record<string, unknown> = {
    advertId: input.advertId,
    price: input.price,
    totalPrice: input.totalPrice,
    volume: input.volume,
    type: input.type,
  }
  let path: string = OTC_PATHS.buyOrder
  if (input.advertSide === 'BUY') {
    path = OTC_PATHS.sellOrder
    body.capitalPword = input.capitalPword ?? ''
  }
  const data = obj(await request<unknown>(path, { ...OTC, body }))
  const sequence = text(data.sequence)
  if (sequence === '') throw new Error(i18n.global.t('clientFailure.otcOrderCreatedWithoutASequence'))
  return sequence
}

export interface OrderParty {
  uid: string
  nickname: string
  realName: string
  mobile: string
  email: string
  online: boolean
  completeOrders: string
  avatar: string
}

export interface OrderPaymentAccount {
  payment: string
  userName: string
  account: string
  qrcodeImg: string
  bankName: string
  bankOfDeposit: string
  ifscCode: string
}

export interface OtcOrderDetail {
  sequence: string
  coin: string
  payCoin: string
  price: string
  volume: string
  totalPrice: string
  status: OtcOrderStatus | null
  /** Remaining ms while status = 1 (server-side countdown), `null` otherwise. */
  limitTime: number | null
  payTime: number | null
  createdAt: number | null
  buyer: OrderParty
  seller: OrderParty
  paymentAccounts: OrderPaymentAccount[]
  /** Payment key the buyer used (`payKey`). */
  payKey: string
  complainId: string
  isComplainUser: boolean
  description: string
}

function normalizeParty(raw: unknown): OrderParty {
  const item = obj(raw)
  return {
    uid: text(item.uid),
    nickname: text(item.otcNickName),
    realName: text(item.realName),
    mobile: text(item.mobileNumber),
    email: text(item.email),
    online: text(item.isOnline) === '1',
    completeOrders: text(item.completeOrders),
    avatar: safeWebUrl(item.imageUrl),
  }
}

export function normalizeOrderDetail(raw: unknown): OtcOrderDetail {
  const data = obj(raw)
  const paymentRaw = Array.isArray(data.payment) ? data.payment : data.payment === undefined ? [] : [data.payment]
  return {
    sequence: text(data.sequence),
    coin: text(data.coin).toUpperCase(),
    payCoin: text(data.paycoin).toUpperCase(),
    price: stripCurrencySuffix(data.price),
    volume: dec(data.volume),
    totalPrice: stripCurrencySuffix(data.totalPrice),
    status: parseStatus(data.status),
    limitTime: parseMillis(data.limitTime),
    payTime: parseMillis(data.payTime),
    createdAt: parseMillis(data.ctime),
    buyer: normalizeParty(data.buyer),
    seller: normalizeParty(data.seller),
    paymentAccounts: paymentRaw.map(obj).map(item => ({
      payment: text(item.payment),
      userName: text(item.userName),
      account: text(item.account),
      qrcodeImg: safeWebUrl(item.qrcodeImg),
      bankName: text(item.bankName),
      bankOfDeposit: text(item.bankOfDeposit),
      ifscCode: text(item.ifscCode),
    })).filter(item => item.payment !== ''),
    payKey: text(data.payKey),
    complainId: text(data.complainId),
    isComplainUser: flag(data.isComplainUser),
    description: text(data.description),
  }
}

/** `auto` sends `exchange-auto: 1` so background polling does not extend the session TTL (BaseAct.java:84-95). */
export async function fetchOrderDetail(sequence: string, auto = false): Promise<OtcOrderDetail> {
  const headers = auto ? { 'exchange-auto': '1' } : undefined
  return normalizeOrderDetail(await request<unknown>(OTC_PATHS.orderDetail, { ...OTC, body: { sequence }, headers }))
}

export function markOrderPaid(sequence: string, payment: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.orderPaid, { ...OTC, body: { sequence, payment } })
}

export function cancelOrder(sequence: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.orderCancel, { ...OTC, body: { sequence } })
}

/** Seller releases the coin. The server requires the fund password (`capitalPword`), no 2FA code. */
export function releaseOrder(sequence: string, capitalPword: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.orderRelease, { ...OTC, body: { sequence, capitalPword } })
}

/**
 * Appeal = a support ticket on the web-api (`rqType` 8 for the buyer, 9 for the seller — legacy
 * `otcDetailOrder/index.js#appealConfirm`) followed by `complain_order` with the returned `complainId`.
 */
export async function appealOrder(sequence: string, role: 'buyer' | 'seller', reason: string): Promise<void> {
  const ticket = obj(await request<unknown>(OTC_PATHS.createProblem, {
    body: { rqType: role === 'buyer' ? 8 : 9, rqDescribe: reason },
  }))
  const complainId = text(ticket.complainId)
  if (complainId === '') throw new Error(i18n.global.t('clientFailure.appealTicketWasNotCreated'))
  await request<unknown>(OTC_PATHS.complain, { ...OTC, body: { sequence, complainId } })
}

export function cancelAppeal(sequence: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.complainCancel, { ...OTC, body: { sequence } })
}

export interface OtcOrderRow {
  sequence: string
  side: 'BUY' | 'SELL' | ''
  coin: string
  payCoin: string
  price: string
  volume: string
  totalPrice: string
  status: OtcOrderStatus | null
  statusText: string
  counterparty: string
  createdAt: number | null
}

export function normalizeOrderRow(raw: unknown): OtcOrderRow {
  const item = obj(raw)
  const price = text(item.price)
  const suffix = /[A-Za-z]+$/.exec(price)
  return {
    sequence: text(item.sequence),
    side: normalizeSide(item.side),
    coin: text(item.coinSymbol).toUpperCase(),
    payCoin: (text(item.payCoin) || (suffix === null ? '' : suffix[0])).toUpperCase(),
    price: stripCurrencySuffix(item.price),
    volume: dec(item.volume),
    totalPrice: stripCurrencySuffix(item.totalPrice),
    status: parseStatus(item.status),
    statusText: text(item.status_text),
    counterparty: text(item.nickName) || text(item.realName),
    createdAt: parseMillis(item.ctime),
  }
}

export async function fetchMyOrders(query: OrderTabQuery, page: number, pageSize: number): Promise<Page<OtcOrderRow>> {
  const body: Record<string, unknown> = { page: String(page), pageSize: String(pageSize) }
  let path: string = OTC_PATHS.ordersComplete
  if (query.endpoint === 'bystatus') {
    path = OTC_PATHS.ordersByStatus
    body.status = String(query.status)
  } else {
    body.isShowCanceled = String(query.isShowCanceled ?? 1)
  }
  const data = obj(await request<unknown>(path, { body }))
  return {
    count: int(data.count) ?? 0,
    items: list(data.orderList).map(normalizeOrderRow).filter(item => item.sequence !== ''),
  }
}

/* ----------------------------------------------------------------------------------------------
 * Chat (history over HTTP; live over the otc-chat WebSocket)
 * -------------------------------------------------------------------------------------------- */

export interface ChatMessage {
  id: string
  fromId: string
  content: string
  time: number | null
  /** Server message type (camelCase); ordinary rows default to `text`. */
  msgType?: string
  /** Red-packet SN, only when `msgType === 'red_packet'` and the ext SN is well-formed. */
  redPacketSn?: string
}

/** `ext` may be an object or a JSON string; arrays/null are rejected. */
function parseExtRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = parseJsonLossless(value)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Red-packet SN shape; kept as a string end-to-end (never parsed as a number). */
const RED_PACKET_SN_RE = /^[A-Za-z0-9_-]{1,128}$/

function redPacketSnOf(msgType: string, extRaw: unknown): string | undefined {
  if (msgType !== 'red_packet') return undefined
  const ext = parseExtRecord(extRaw)
  const sn = ext?.sn
  return typeof sn === 'string' && RED_PACKET_SN_RE.test(sn) ? sn : undefined
}

export async function fetchChatHistory(sequence: string, fromId: string, toId: string): Promise<ChatMessage[]> {
  const data = await request<unknown>(OTC_PATHS.chatHistory, { ...OTC, body: { orderId: sequence, fromId, toId } })
  return list(data).map(obj).map((item) => {
    const msgType = text(item.msgType)
    const redPacketSn = redPacketSnOf(msgType, item.ext)
    return {
      id: text(item.id),
      fromId: text(item.fromId),
      content: text(item.content),
      time: parseMillis(item.ctime),
      msgType: msgType === '' ? 'text' : msgType,
      ...(redPacketSn === undefined ? {} : { redPacketSn }),
    }
  }).filter(item => item.content !== '')
}

/* ----------------------------------------------------------------------------------------------
 * Adverts (mine)
 * -------------------------------------------------------------------------------------------- */

export interface MyAdvert {
  advertId: string
  /** Advert status (OtcAdvertStatus): 1 published, 2 trading, 3 expired, 4 closed, 5 abnormal. */
  status: string
  side: 'BUY' | 'SELL' | ''
  coin: string
  price: string
  payCoin: string
  volume: string
  /** Sold / bought so far (`sell`). */
  dealt: string
  minTrade: string
  maxTrade: string
  createdAt: number | null
  payments: AdvertPayment[]
}

export async function fetchMyAdverts(uid: string, side: 'BUY' | 'SELL', page: number, pageSize: number): Promise<Page<MyAdvert>> {
  const data = obj(await request<unknown>(OTC_PATHS.personAds, {
    ...OTC,
    body: { uid, adType: side, closeHide: '0', page: String(page), pageSize: String(pageSize) },
  }))
  return {
    count: int(data.count) ?? 0,
    items: list(data.adList).map(obj).map(item => ({
      advertId: text(item.advertId),
      status: text(item.status),
      side: normalizeSide(item.side),
      coin: text(item.coin).toUpperCase(),
      price: dec(item.price),
      payCoin: text(item.payCoin).toUpperCase(),
      volume: dec(item.volume),
      dealt: dec(item.sell),
      minTrade: dec(item.minTrade),
      maxTrade: dec(item.maxTrade),
      createdAt: parseMillis(item.createTime),
      payments: normalizeAdvertPayments(item.payments),
    })).filter(item => item.advertId !== ''),
  }
}

export function publishAdvert(payload: Record<string, unknown>): Promise<unknown> {
  return request<unknown>(OTC_PATHS.publishAdvert, { ...OTC, body: payload })
}

export function closeAdvert(advertId: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.closeAdvert, { ...OTC, body: { advertId } })
}

/* ----------------------------------------------------------------------------------------------
 * Payment methods, profile, blacklist
 * -------------------------------------------------------------------------------------------- */

export interface UserPaymentMethod {
  id: string
  payment: string
  title: string
  icon: string
  userName: string
  account: string
  qrcodeImg: string
  bankName: string
  bankOfDeposit: string
  ifscCode: string
  open: boolean
}

export async function fetchPaymentMethods(onlyOpen = false): Promise<UserPaymentMethod[]> {
  const body = onlyOpen ? { isOpen: '1' } : {}
  const data = await request<unknown>(OTC_PATHS.paymentFind, { ...OTC, body })
  return list(data).map(obj).map(item => ({
    id: text(item.id),
    payment: text(item.payment),
    title: text(item.title),
    icon: safeWebUrl(item.icon),
    userName: text(item.userName),
    account: text(item.account),
    qrcodeImg: safeWebUrl(item.qrcodeImg),
    bankName: text(item.bankName),
    bankOfDeposit: text(item.bankOfDeposit),
    ifscCode: text(item.ifscCode),
    open: text(item.isOpen) === '1',
  })).filter(item => item.id !== '')
}

export interface PaymentMethodInput {
  id?: string
  payment: string
  userName: string
  account: string
  bankName?: string
  bankOfDeposit?: string
  ifscCode?: string
  smsAuthCode?: string
  googleCode?: string
}

export function savePaymentMethod(input: PaymentMethodInput): Promise<unknown> {
  const body: Record<string, unknown> = { payment: input.payment, userName: input.userName, account: input.account }
  if (input.bankName) body.bankName = input.bankName
  if (input.bankOfDeposit) body.bankOfDeposit = input.bankOfDeposit
  if (input.ifscCode) body.ifscCode = input.ifscCode
  if (input.smsAuthCode) body.smsAuthCode = input.smsAuthCode
  if (input.googleCode) body.googleCode = input.googleCode
  if (input.id !== undefined && input.id !== '') {
    body.id = input.id
    return request<unknown>(OTC_PATHS.paymentUpdate, { ...OTC, body })
  }
  return request<unknown>(OTC_PATHS.paymentAdd, { ...OTC, body })
}

export function deletePaymentMethod(id: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.paymentDelete, { ...OTC, body: { id } })
}

export function togglePaymentMethod(id: string, open: boolean): Promise<unknown> {
  return request<unknown>(OTC_PATHS.paymentOpen, { ...OTC, body: { id, isOpen: open ? 1 : 0 } })
}

export interface OtcProfile {
  nickname: string
  completeOrders: string
  complainNum: string
  sucComplainNum: string
  registerTime: number | null
}

export async function fetchOtcProfile(uid: string): Promise<OtcProfile> {
  const data = obj(await request<unknown>(OTC_PATHS.personHome, { ...OTC, body: { uid } }))
  return {
    nickname: text(data.otcNickName),
    completeOrders: text(data.completeOrders),
    complainNum: text(data.complainNum),
    sucComplainNum: text(data.sucComplainNum),
    registerTime: parseMillis(data.registerTime),
  }
}

export interface BlacklistEntry {
  userId: string
  nickname: string
  completeOrders: string
}

export async function fetchBlacklist(page: number, pageSize: number): Promise<Page<BlacklistEntry>> {
  const data = obj(await request<unknown>(OTC_PATHS.relationship, {
    ...OTC,
    body: { relationType: 'BLACKLIST', page: String(page), pageSize: String(pageSize) },
  }))
  return {
    count: int(data.count) ?? 0,
    items: list(data.relationshipList).map(obj).map(item => ({
      userId: text(item.userId),
      nickname: text(item.otcNickName),
      completeOrders: text(item.completeOrders),
    })).filter(item => item.userId !== ''),
  }
}

export function removeFromBlacklist(userId: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.relationshipRemove, { ...OTC, body: { friendId: userId } })
}

export function updateNickname(nickname: string): Promise<unknown> {
  return request<unknown>(OTC_PATHS.nickname, { body: { nickname } })
}

/** Legacy `modifySettings.js`: SMS operation type 6 = first-time fund password, 7 = reset. */
export function requestFundPasswordSms(alreadySet: boolean): Promise<unknown> {
  return request<unknown>(OTC_PATHS.smsCode, { body: { operationType: alreadySet ? 7 : 6 } })
}

/** Legacy `SetUp.js#getCodeClick`: SMS operation type 28 for payment-method changes. */
export function requestPaymentSms(): Promise<unknown> {
  return request<unknown>(OTC_PATHS.smsCode, { body: { operationType: 28 } })
}

export function setFundPassword(input: { newCapitalPwd: string; smsAuthCode?: string; googleCode?: string }): Promise<unknown> {
  const body: Record<string, unknown> = { newCapitalPwd: input.newCapitalPwd }
  if (input.smsAuthCode) body.smsAuthCode = input.smsAuthCode
  if (input.googleCode) body.googleCode = input.googleCode
  return request<unknown>(OTC_PATHS.capitalPassword, { body })
}

/* ----------------------------------------------------------------------------------------------
 * OTC account + transfer
 * -------------------------------------------------------------------------------------------- */

export interface OtcBalance {
  coin: string
  normal: string
  lock: string
  total: string
  /** Spot available balance of the same coin (`exchangeNormal`). */
  spotNormal: string
}

export async function fetchOtcAccounts(): Promise<OtcBalance[]> {
  const data = obj(await request<unknown>(OTC_PATHS.accountList, { body: {} }))
  const map = data.allCoinMap
  const rows = Array.isArray(map) ? map : Object.values(obj(map))
  return rows.map(obj).map(item => ({
    coin: text(item.coinSymbol).toUpperCase(),
    normal: dec(item.normal),
    lock: dec(item.lock),
    total: dec(item.total_balance),
    spotNormal: dec(item.exchangeNormal),
  })).filter(item => item.coin !== '')
}

export type AccountKind = 'spot' | 'otc'

/** `fromAccount` / `toAccount`: "1" = spot, "2" = OTC (AccountAct.java:1188). No 2FA is required. */
export function transferOtc(input: { from: AccountKind; to: AccountKind; amount: string; coin: string; requestId?: string }): Promise<unknown> {
  const code = (kind: AccountKind): string => (kind === 'spot' ? '1' : '2')
  const body: Record<string, string> = { fromAccount: code(input.from), toAccount: code(input.to), amount: input.amount, coinSymbol: input.coin }
  // client idempotency id (modules/api/draft-request-id.ts); an older server ignores it
  if (input.requestId !== undefined && input.requestId !== '') body.requestId = input.requestId
  return request<unknown>(OTC_PATHS.transfer, { body })
}
