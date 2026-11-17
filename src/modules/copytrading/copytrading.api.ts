import { i18n } from '@/i18n/composer'
import { z } from 'zod'
import { request } from '@/modules/api/http'
import { Decimal, toDecString } from '@/modules/finance/decimal'
import { count, list, parseWith, text } from '@/modules/content/api-helpers'

/**
 * Copy trading.
 *
 * exchange-web-api `TraderUserAct.java` (`/traderUser`). Every method binds `@RequestParam`, so
 * parameters travel in the **query string** (a JSON body is not bound), and every method — even the
 * ranking — requires login (`10002` otherwise):
 * - `:139` `POST list?page&pageSize&orderBy` -> `TraderUserVo[]` (bare array, no total). orderBy:
 *   all | profitRatio | winRatio | profitUSDT | totalRatio | orderCount | followerCount (desc).
 * - `:102` `POST query?uid` -> `TraderUserVo` (empty data when the uid is not a trader).
 * - `:42`  `POST create?traderUid&type&amount|rate&deposit&profitRatio&lossRatio` (upsert: follow or update).
 *   type 0 = fixed ratio (`rate` > 0), 1 = fixed amount (`amount` > 0); `deposit` > 0; `lossRatio` < 100;
 *   -1 means "not set". `109111` NOT_TRADER.
 * - `:85`  `POST cancel?traderUid` (unfollow).
 * - `:213` `POST myTraders` -> `FollowUserVo[]`.
 * - `:306` `GET myStatistics` -> `{followTotalAmount, profit, rate}`. `rate` is NOT a return: it is a percentile
 *   rank among all followers by summed `profit_usdt` ((max+1 - mine) / (max - min + 3) x 100, lower = better;
 *   `TraderUserServiceImpl.myStatistics:134`), so the page shows it as "top X%" and only when the user follows someone.
 * `TraderUserVo` (`TraderUser` + vo): uid, nickname, profitRatio (2-week ROI, ALREADY percent: -12.27 = -12.27 %), winRatio
 * (2-week win rate, already ×100), profitUSDT, totalRatio (cumulative ROI, percent), totalUSDT, orderCount,
 * followerCount (all-time), currentFollowCount, entryDay, follow (-1 not following, 0 self is trader, 1 following).
 * Ratios are computed by `FollowUserServiceImpl.winRate` (futures-trader) — new traders are all zero.
 *
 * futures-web-api `TraderController.java:163` `POST trader/trader_position_list?traderUid&status`
 * (status 1 = current positions -> `{positionList: PositionResultVo[]}`), login required.
 *
 * Trader onboarding (same controller):
 * - `:262` `POST applyBecomeTrader` -> data `"ok"` (or `"已经是交易员"` when `trader_user_flag` already has the uid).
 *   Inserts `apply_become_trader(status 0)` unless a pending row exists, and pre-creates the zeroed `trader_user`
 *   row. No KYC/balance precondition on the server; an operator approves it in the admin console.
 * - `:278` `GET currentStatus` -> `{uid, status}`: -1 not applied, 0 pending, 1 trader (`trader_user_flag` row),
 *   2 rejected (re-applying inserts a new pending row).
 *
 * Mirroring of trader orders additionally needs futures kv `follow_order_open_flag = "true"`
 * (`SendMessageServiceImpl.java:115-118`); the API cannot report it, so the UI says so.
 */
export const COPY_ENDPOINTS = {
  list: 'traderUser/list',
  detail: 'traderUser/query',
  follow: 'traderUser/create',
  unfollow: 'traderUser/cancel',
  myTraders: 'traderUser/myTraders',
  myStatistics: 'traderUser/myStatistics',
  positions: 'trader/trader_position_list',
  apply: 'traderUser/applyBecomeTrader',
  applyStatus: 'traderUser/currentStatus',
  /** `:190` `traderUser/follower?traderUid` -> FollowUserVo[] (nickname, followAmount = margin in use). */
  followers: 'traderUser/follower',
  /** `:316/:330` `POST description?description` sets / `GET description` reads the caller's own bio (Redis). */
  description: 'traderUser/description',
  /** futures `TraderController:344` `POST trader/traderBonusRate` -> integer percent (KV `trader_bonus_rate`, default 10). */
  bonusRate: 'trader/traderBonusRate',
  /** futures `:119` `POST trader/trader_total_profit` -> the caller's total profit-share income. */
  totalIncome: 'trader/trader_total_profit',
  /** futures `:86` `POST trader/traderTransaction?page&pageSize` -> paged profit-share records (the caller's). */
  incomeRecords: 'trader/traderTransaction',
} as const

export const TRADER_SORTS = ['all', 'profitRatio', 'winRatio', 'profitUSDT', 'totalRatio', 'orderCount', 'followerCount'] as const
export type TraderSort = (typeof TRADER_SORTS)[number]

export const NOT_TRADER = '109111'

const num = z.union([z.number().finite(), z.string()]).nullish().transform((value) => toDecString(value))
const intText = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).nullish().transform((value) => (value === null || value === undefined ? null : Number(value))) // float-ok: integer ids / enums (contractId, type, status, leverage)

const traderSchema = z
  .object({
    uid: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String),
    nickname: text,
    profitRatio: num,
    winRatio: num,
    profitUSDT: num,
    totalRatio: num,
    totalUSDT: num,
    orderCount: count,
    followerCount: count,
    currentFollowCount: count,
    entryDay: count,
    follow: intText,
    /** Bio (`TraderUserVo.description`, Redis `trader_description{uid}`, sanitised, <= 200 chars; filled since 2026-10-01). */
    description: z.string().nullish().transform((value) => value ?? ''),
  })
  .passthrough()

const followSchema = z
  .object({
    uid: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String),
    nickname: text,
    type: intText,
    amount: num,
    rate: num,
    deposit: num,
    profitRatio: num,
    lossRatio: num,
    profitUSDT: num,
    status: intText,
    followAmount: num,
    currentFollowCount: count,
    ctime: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough()

const statsSchema = z.object({ followTotalAmount: num, profit: num, rate: num }).passthrough()
const positionSchema = z
  .object({
    contractName: text,
    symbol: text,
    orderSide: text,
    positionVolume: num,
    openAvgPrice: num,
    leverageLevel: text,
    unRealizedAmount: num,
    returnRate: num,
  })
  .passthrough()
const positionsSchema = z.object({ positionList: list(positionSchema) }).passthrough()

export type Trader = z.output<typeof traderSchema>
export type FollowRecord = z.output<typeof followSchema>
export type FollowStats = z.output<typeof statsSchema>
export type TraderPosition = z.output<typeof positionSchema>

function withQuery(path: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) query.set(key, String(value))
  const encoded = query.toString()
  return encoded === '' ? path : `${path}?${encoded}`
}

function assertUid(uid: string): string {
  if (!/^[1-9]\d{0,9}$/.test(uid)) throw new Error(i18n.global.t('clientFailure.invalidTraderUid'))
  return uid
}

export async function fetchTraders(page: number, pageSize: number, orderBy: TraderSort, signal?: AbortSignal): Promise<Trader[]> {
  const data = await request<unknown>(withQuery(COPY_ENDPOINTS.list, { page, pageSize, orderBy }), { body: {}, signal })
  return parseWith(list(traderSchema), COPY_ENDPOINTS.list, data)
}

export async function fetchTrader(uid: string, signal?: AbortSignal): Promise<Trader | null> {
  const data = await request<unknown>(withQuery(COPY_ENDPOINTS.detail, { uid: assertUid(uid) }), { body: {}, signal })
  if (data === null || data === undefined) return null
  return parseWith(traderSchema, COPY_ENDPOINTS.detail, data)
}

export async function fetchMyTraders(signal?: AbortSignal): Promise<FollowRecord[]> {
  const data = await request<unknown>(COPY_ENDPOINTS.myTraders, { body: {}, signal })
  return parseWith(list(followSchema), COPY_ENDPOINTS.myTraders, data)
}

export async function fetchMyStatistics(signal?: AbortSignal): Promise<FollowStats> {
  const data = await request<unknown>(COPY_ENDPOINTS.myStatistics, { method: 'GET', signal })
  return parseWith(statsSchema, COPY_ENDPOINTS.myStatistics, data ?? {})
}

export async function fetchTraderPositions(uid: string, signal?: AbortSignal): Promise<TraderPosition[]> {
  const data = await request<unknown>(withQuery(COPY_ENDPOINTS.positions, { traderUid: assertUid(uid), status: 1 }), {
    api: 'futures',
    body: {},
    signal,
  })
  return parseWith(positionsSchema, COPY_ENDPOINTS.positions, data ?? {}).positionList
}

/** -1 not applied, 0 pending review, 1 approved (is a trader), 2 rejected. */
export type ApplyStatus = -1 | 0 | 1 | 2

const applySchema = z
  .object({
    uid: z.union([z.number().int(), z.string().regex(/^\d+$/)]).nullish().transform((value) => (value === null || value === undefined ? '' : String(value))),
    status: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform(Number),
  })
  .passthrough()

export interface ApplyState { uid: string; status: ApplyStatus }

export function normalizeApplyStatus(value: number): ApplyStatus {
  return value === 0 || value === 1 || value === 2 ? value : -1
}

export async function fetchApplyStatus(signal?: AbortSignal): Promise<ApplyState> {
  const data = await request<unknown>(COPY_ENDPOINTS.applyStatus, { method: 'GET', signal })
  if (data === null || data === undefined) return { uid: '', status: -1 }
  const parsed = parseWith(applySchema, COPY_ENDPOINTS.applyStatus, data)
  return { uid: parsed.uid, status: normalizeApplyStatus(parsed.status) }
}

export async function applyBecomeTrader(): Promise<void> {
  await request<unknown>(COPY_ENDPOINTS.apply, { body: {} })
}

export type FollowMode = 'ratio' | 'amount'

export interface FollowSettings {
  traderUid: string
  mode: FollowMode
  /** Fixed ratio (mode `ratio`) or fixed amount per order (mode `amount`). */
  value: string
  deposit: string
  /** Optional take-profit / stop-loss percentages; '' = not set. */
  takeProfit: string
  stopLoss: string
}

export type FollowErrorKey = 'valueRequired' | 'depositRequired' | 'stopLossRange' | 'takeProfitRange' | 'invalidNumber'

const POSITIVE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/

function positive(value: string): boolean {
  return POSITIVE.test(value) && new Decimal(value).gt(0)
}

/** Mirrors the server checks in `TraderUserAct.create` (`:59-67`) before any request is sent. */
export function validateFollow(settings: FollowSettings): Partial<Record<'value' | 'deposit' | 'takeProfit' | 'stopLoss', FollowErrorKey>> {
  const errors: Partial<Record<'value' | 'deposit' | 'takeProfit' | 'stopLoss', FollowErrorKey>> = {}
  if (!positive(settings.value.trim())) errors.value = 'valueRequired'
  if (!positive(settings.deposit.trim())) errors.deposit = 'depositRequired'
  const tp = settings.takeProfit.trim()
  if (tp !== '' && !positive(tp)) errors.takeProfit = 'takeProfitRange'
  const sl = settings.stopLoss.trim()
  if (sl !== '' && (!positive(sl) || new Decimal(sl).gte(100))) errors.stopLoss = 'stopLossRange'
  return errors
}

export function buildFollowQuery(settings: FollowSettings): Record<string, string> {
  const query: Record<string, string> = {
    traderUid: assertUid(settings.traderUid),
    type: settings.mode === 'ratio' ? '0' : '1',
    deposit: settings.deposit.trim(),
    profitRatio: settings.takeProfit.trim() === '' ? '-1' : settings.takeProfit.trim(),
    lossRatio: settings.stopLoss.trim() === '' ? '-1' : settings.stopLoss.trim(),
  }
  if (settings.mode === 'ratio') query.rate = settings.value.trim()
  else query.amount = settings.value.trim()
  return query
}

export async function followTrader(settings: FollowSettings): Promise<void> {
  if (Object.keys(validateFollow(settings)).length > 0) throw new Error(i18n.global.t('clientFailure.invalidFollowSettings'))
  await request<unknown>(withQuery(COPY_ENDPOINTS.follow, buildFollowQuery(settings)), { body: {} })
}

export async function unfollowTrader(uid: string): Promise<void> {
  await request<unknown>(withQuery(COPY_ENDPOINTS.unfollow, { traderUid: assertUid(uid) }), { body: {} })
}

/** Fraction -> percent string (`0.1234` -> `12.34`); '' when missing. */
export function fractionPercent(value: string, dp = 2): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return ''
  return new Decimal(value).times(100).toFixed(dp, Decimal.ROUND_HALF_UP)
}

/* ------------------------------------------------------------------ 2026-09-30 detail / follower / trader views */

/**
 * Closed lead positions (`trader/trader_position_list?traderUid&status=0`, all contracts, newest first): the rows of
 * `history_position_list` (openPrice, closePrice, volume, historyRealizedAmount, ctime / mtime).
 */
const closedSchema = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    contractId: intText,
    side: text,
    positionType: intText,
    leverageLevel: intText,
    volume: num,
    openPrice: num,
    closePrice: num,
    historyRealizedAmount: num,
    ctime: z.union([z.number(), z.string()]).nullish().transform((value) => (value === null || value === undefined ? null : Number(value))), // float-ok: epoch timestamp
    mtime: z.union([z.number(), z.string()]).nullish().transform((value) => (value === null || value === undefined ? null : Number(value))), // float-ok: epoch timestamp
  })
  .passthrough()
export type TraderClosedPosition = z.output<typeof closedSchema>

export async function fetchTraderHistory(uid: string, signal?: AbortSignal): Promise<TraderClosedPosition[]> {
  const data = await request<unknown>(withQuery(COPY_ENDPOINTS.positions, { traderUid: assertUid(uid), status: 0 }), { api: 'futures', body: {}, signal })
  return parseWith(z.object({ positionList: list(closedSchema) }).passthrough(), COPY_ENDPOINTS.positions, data ?? {}).positionList
}

/**
 * Realized PnL of closed lead positions, oldest close first, as a running total (the trader page's curve). This is the
 * only per-trade PnL series the server exposes; a daily PnL / ROI curve needs a new endpoint.
 */
export function cumulativeRealized(rows: readonly TraderClosedPosition[]): { at: number; total: string }[] {
  const sorted = rows.filter((row) => row.mtime !== null && /^-?\d+(\.\d+)?$/.test(row.historyRealizedAmount)).sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0))
  let total = new Decimal(0)
  return sorted.map((row) => {
    total = total.plus(row.historyRealizedAmount)
    return { at: row.mtime ?? 0, total: total.toFixed() }
  })
}

const followerSchema = z.object({ nickname: text, followAmount: num }).passthrough()
export type TraderFollower = z.output<typeof followerSchema>

export async function fetchFollowers(uid: string, signal?: AbortSignal): Promise<TraderFollower[]> {
  const data = await request<unknown>(withQuery(COPY_ENDPOINTS.followers, { traderUid: assertUid(uid) }), { body: {}, signal })
  return parseWith(list(followerSchema), COPY_ENDPOINTS.followers, data ?? [])
}

/** AUM shown on the trader page: the margin followers currently have in this trader's copies (Σ followAmount). */
export function followersAum(rows: readonly TraderFollower[]): string {
  return rows.reduce((sum, row) => (/^-?\d+(\.\d+)?$/.test(row.followAmount) ? sum.plus(row.followAmount) : sum), new Decimal(0)).toFixed()
}

export async function fetchBonusRate(signal?: AbortSignal): Promise<number> {
  const data = await request<unknown>(COPY_ENDPOINTS.bonusRate, { api: 'futures', body: {}, signal })
  const value = Number(data) // float-ok: profit-share percent (0-100) for the rule text; profitShare() does the decimal maths
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 10
}

/**
 * Profit share of one profitable full close (vendor `CoOrderServiceImpl:957-960`, verified live 09-30: 0.40267 × 10% →
 * 0.04; 0.1069 × 10% = 0.0106 → 0.01 → skipped): realized profit × rate, truncated DOWN to 0.01 USDT, and paid only
 * when that is MORE than 0.01 — so at 10% a profit under 0.2 USDT pays nothing. Losses pay nothing.
 */
export function profitShare(profit: string, ratePercent: number): string {
  if (!/^-?\d+(\.\d+)?$/.test(profit) || new Decimal(profit).lte(0)) return '0.00'
  const share = new Decimal(profit).times(ratePercent).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_DOWN)
  return share.gt('0.01') ? share.toFixed(2) : '0.00'
}

export async function fetchMyDescription(signal?: AbortSignal): Promise<string> {
  const data = await request<unknown>(COPY_ENDPOINTS.description, { method: 'GET', signal })
  return typeof data === 'string' ? data : ''
}

export const DESCRIPTION_MAX = 200

export async function saveMyDescription(description: string): Promise<void> {
  const trimmed = description.trim().slice(0, DESCRIPTION_MAX)
  await request<unknown>(withQuery(COPY_ENDPOINTS.description, { description: trimmed }), { body: {} })
}

export async function fetchTotalIncome(signal?: AbortSignal): Promise<string> {
  const data = await request<unknown>(COPY_ENDPOINTS.totalIncome, { api: 'futures', body: {}, signal })
  return toDecString(typeof data === 'object' && data !== null ? (data as Record<string, unknown>).amount ?? (data as Record<string, unknown>).totalAmount ?? '' : data)
}

/**
 * The follower's copied positions: futures `position/get_assets_list` rows that carry `traderName` (the vendor tags
 * mirror positions with the masked trader nickname). There is no per-copy order list endpoint for followers yet.
 */
const copiedSchema = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    contractId: intText,
    contractName: text,
    orderSide: text,
    positionVolume: num,
    openAvgPrice: num,
    indexPrice: num,
    leverageLevel: intText,
    holdAmount: num,
    unRealizedAmount: num,
    openRealizedAmount: num,
    traderName: z.string().nullish().transform((value) => value ?? ''),
  })
  .passthrough()
export type CopiedPosition = z.output<typeof copiedSchema>

export async function fetchCopiedPositions(signal?: AbortSignal): Promise<CopiedPosition[]> {
  const data = await request<unknown>('position/get_assets_list', { api: 'futures', body: {}, signal })
  const rows = parseWith(z.object({ positionList: list(copiedSchema) }).passthrough(), 'position/get_assets_list', data ?? {}).positionList
  return rows.filter((row) => row.traderName.trim() !== '')
}
