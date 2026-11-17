import { i18n } from '@/i18n/composer'
/**
 * C2C 红包（原订单双方单人红包）用户接口。
 *
 * 统一走 `@/modules/api/http` 的 `request`：自动携带 `exchange-token` 与 TLS，**明文 JSON**、**不使用 signed 信封**；
 * 成功返回已 unwrap 的 `data`，非零业务码与 HTTP/网络错误抛 `@/core/errors` 的 `ApiError`。
 *
 * 金额精度：所有金额字段**只接受字符串**并逐字透传，绝不用 `Number()`/`parseFloat()` 解析金额；数量、时间戳是
 * 计数/时间（非金额），允许 `Number.isSafeInteger` 并注释。任一金额字段不是字符串或不匹配 `^\d+(\.\d+)?$` 即抛
 * `ApiError(kind:'parse')`，**拒绝**数字、指数、null，不补零。
 *
 * 后端由主代理实现（含持久 `requestId` 幂等），本模块只描述调用契约。
 */
import { ApiError } from '@/core/errors'
import { request } from '@/modules/api/http'

/** 红包服务路径（OTC 命名空间 `/otc-api/`）。 */
export const RP_PATHS = {
  config: 'lb/red_packet/config',
  send: 'lb/red_packet/send',
  detail: 'lb/red_packet/detail',
  claim: 'lb/red_packet/claim',
} as const

const OTC = { api: 'otc' } as const
/** 严格非负十进制字符串：金额字段必须是字符串，不接受数字/指数/null。 */
const MONEY_RE = /^\d+(\.\d+)?$/

function parseError(message: string, path: string): ApiError {
  return new ApiError({ kind: 'parse', code: '', message, path })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 金额：必须是非负十进制**字符串**，原样返回。 */
export function readMoney(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MONEY_RE.test(value)) {
    throw parseError(i18n.global.t('serviceMessage.invalidAmountStringInRedPacketField', { field }), 'lb/red_packet')
  }
  return value
}

/** 整数计数/时间（非金额）：必须是安全整数。 */
export function readInt(value: unknown, field: string): number {
  // float-ok: not money (count / epoch ms)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw parseError(i18n.global.t('serviceMessage.redPacketFieldIsNotASafeInteger', { field }), 'lb/red_packet')
  }
  return value
}

/** epoch 毫秒或 null（时间非金额）。 */
export function readMsOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return readInt(value, field)
}

/** uid：字符串或安全整数（大整数以字符串返回时原样保留）。 */
export function readId(value: unknown, field: string): number | string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  // float-ok: not money (account id, integer when the server sends a number)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw parseError(i18n.global.t('serviceMessage.invalidAccountIdInRedPacketField', { field }), 'lb/red_packet')
}

function readBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw parseError(i18n.global.t('serviceMessage.redPacketFieldMustBeABoolean', { field }), 'lb/red_packet')
  return value
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw parseError(i18n.global.t('serviceMessage.redPacketFieldMustBeAString', { field }), 'lb/red_packet')
  return value
}

export interface RedPacketCoinRule {
  coin: string
  enabled: boolean
  /** 单份最小金额（字符串）。 */
  min_share: string
  /** 红包总额上限（字符串）。 */
  max_total: string
  /** 份数上限（计数）。 */
  max_count: number
  /** 每日可发次数（计数）。 */
  daily_count: number
  /** 每日等值上限（USDT 字符串）。 */
  daily_usdt: string
  /** 有效期小时（计数）。 */
  expire_hours: number
}

/** 安全要求：主代理尚在补齐；字段缺失表示“未知”，UI 须展示可选验证项并按账户安全设置填写。 */
export interface RedPacketSecurity {
  capitalPasswordRequired?: boolean
  googleRequired?: boolean
}

export interface RedPacketConfig {
  open: boolean
  coins: RedPacketCoinRule[]
  security?: RedPacketSecurity
}

export function normalizeRedPacketConfig(raw: unknown): RedPacketConfig {
  const data = asRecord(raw)
  const coinsRaw = data.coins
  if (!Array.isArray(coinsRaw)) throw parseError(i18n.global.t('serviceMessage.missingRedPacketCoinsArray'), 'lb/red_packet/config')
  const coins: RedPacketCoinRule[] = coinsRaw.map((entry) => {
    const c = asRecord(entry)
    return {
      coin: readString(c.coin, 'coins[].coin').toUpperCase(),
      enabled: readBool(c.enabled, 'coins[].enabled'),
      min_share: readMoney(c.min_share, 'coins[].min_share'),
      max_total: readMoney(c.max_total, 'coins[].max_total'),
      max_count: readInt(c.max_count, 'coins[].max_count'),
      daily_count: readInt(c.daily_count, 'coins[].daily_count'),
      daily_usdt: readMoney(c.daily_usdt, 'coins[].daily_usdt'),
      expire_hours: readInt(c.expire_hours, 'coins[].expire_hours'),
    }
  })
  const security = data.security === undefined || data.security === null
    ? undefined
    : (() => {
        const s = asRecord(data.security)
        const out: RedPacketSecurity = {}
        if (typeof s.capitalPasswordRequired === 'boolean') out.capitalPasswordRequired = s.capitalPasswordRequired
        if (typeof s.googleRequired === 'boolean') out.googleRequired = s.googleRequired
        return out
      })()
  return { open: readBool(data.open, 'open'), coins, ...(security === undefined ? {} : { security }) }
}

/** 读取红包配置；主开关关闭时也应能读到（用于提示），故调用方自行判断 `open`。 */
export function fetchRedPacketConfig(signal?: AbortSignal): Promise<RedPacketConfig> {
  return request<unknown>(RP_PATHS.config, { ...OTC, body: {}, signal }).then(normalizeRedPacketConfig)
}

export interface SendRedPacketInput {
  sequence: string
  coin: string
  /** 收到金额（总额），字符串。 */
  total: string
  count: 1
  type: 1
  greeting: string
  capitalPword?: string
  googleCode?: string
  /** 客户端幂等键：生成一次，发送前保存，失败/超时都保留复用。 */
  requestId: string
}

export interface SendRedPacketResult {
  /** 红包 ID（整数，非金额）。 */
  packetId: number | string
  sn: string
  status: string
  /** 过期时间（epoch 毫秒）或 null。 */
  expireAt: number | null
}

export function normalizeSendResult(raw: unknown): SendRedPacketResult {
  const data = asRecord(raw)
  return {
    packetId: readId(data.packetId, 'packetId') ?? (() => { throw parseError(i18n.global.t('serviceMessage.missingRedPacketId'), RP_PATHS.send) })(),
    sn: readString(data.sn, 'sn'),
    status: readString(data.status, 'status'),
    expireAt: readMsOrNull(data.expireAt, 'expireAt'),
  }
}

/** 发送红包（金融操作：**绝不自动重试**，调用方处理超时/未知结果与 requestId 复用）。 */
export function sendRedPacket(input: SendRedPacketInput, signal?: AbortSignal): Promise<SendRedPacketResult> {
  return request<unknown>(RP_PATHS.send, { ...OTC, body: input, signal }).then(normalizeSendResult)
}

export interface DetailShare {
  idx: number
  amount: string
  status: string
  uid: number | string | null
  claimedAt: number | null
}

export interface RedPacketDetail {
  packetId: number | string
  sn: string
  coin: string
  total: string
  count: number
  type: number
  remainingCount: number
  status: string
  greeting: string
  expireAt: number | null
  senderUid: number | string
  shares: DetailShare[]
}

export function normalizeDetail(raw: unknown): RedPacketDetail {
  const data = asRecord(raw)
  const sharesRaw = data.shares
  if (!Array.isArray(sharesRaw)) throw parseError(i18n.global.t('serviceMessage.missingRedPacketSharesArray'), 'lb/red_packet/detail')
  const shares: DetailShare[] = sharesRaw.map((entry) => {
    const s = asRecord(entry)
    return {
      idx: readInt(s.idx, 'shares[].idx'),
      amount: readMoney(s.amount, 'shares[].amount'),
      status: readString(s.status, 'shares[].status'),
      uid: readId(s.uid, 'shares[].uid'),
      claimedAt: readMsOrNull(s.claimedAt, 'shares[].claimedAt'),
    }
  })
  return {
    packetId: readId(data.packetId, 'packetId') ?? (() => { throw parseError(i18n.global.t('serviceMessage.missingRedPacketId'), RP_PATHS.detail) })(),
    sn: readString(data.sn, 'sn'),
    coin: readString(data.coin, 'coin').toUpperCase(),
    total: readMoney(data.total, 'total'),
    count: readInt(data.count, 'count'),
    type: readInt(data.type, 'type'),
    remainingCount: readInt(data.remainingCount, 'remainingCount'),
    status: readString(data.status, 'status'),
    greeting: readString(data.greeting, 'greeting'),
    expireAt: readMsOrNull(data.expireAt, 'expireAt'),
    senderUid: readId(data.senderUid, 'senderUid') ?? (() => { throw parseError(i18n.global.t('serviceMessage.missingSenderUid'), RP_PATHS.detail) })(),
    shares,
  }
}

/** 明细查询：优先 `{sn}`；原单查询用 `{requestId}`（返回与 SN 查询相同的明细）。 */
export function fetchRedPacketDetail(
  query: { sn?: string; requestId?: string },
  signal?: AbortSignal,
): Promise<RedPacketDetail> {
  const body: Record<string, string> = {}
  if (query.sn !== undefined && query.sn !== '') body.sn = query.sn
  if (query.requestId !== undefined && query.requestId !== '') body.requestId = query.requestId
  return request<unknown>(RP_PATHS.detail, { ...OTC, body, signal }).then(normalizeDetail)
}

export interface ClaimRedPacketResult {
  packetId: number | string
  amount: string
  coin: string
  status: 'claimed' | 'claiming'
}

export function normalizeClaimResult(raw: unknown): ClaimRedPacketResult {
  const data = asRecord(raw)
  const status = readString(data.status, 'status')
  if (status !== 'claimed' && status !== 'claiming') {
    throw parseError(i18n.global.t('serviceMessage.invalidRedPacketClaimStatus'), 'lb/red_packet/claim')
  }
  return {
    packetId: readId(data.packetId, 'packetId') ?? (() => { throw parseError(i18n.global.t('serviceMessage.missingRedPacketId'), RP_PATHS.claim) })(),
    amount: readMoney(data.amount, 'amount'),
    coin: readString(data.coin, 'coin').toUpperCase(),
    status,
  }
}

/** 领取红包（`claiming` 不代表到账，须刷新原红包确认）。 */
export function claimRedPacket(sn: string, signal?: AbortSignal): Promise<ClaimRedPacketResult> {
  return request<unknown>(RP_PATHS.claim, { ...OTC, body: { sn }, signal }).then(normalizeClaimResult)
}
