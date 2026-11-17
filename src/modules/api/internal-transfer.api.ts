import { i18n } from '@/i18n/composer'
/**
 * 内账转账（现货可用余额 → 同一平台的另一个 UID）：`/fe-ex-api/finance/inner_transfer/*`。
 *
 * 普通 JSON、**不签名**（`signed` 不设）、`exchange-token` 由统一 http 层带上。成功时 http 层已 `unwrap data`；
 * 非 0 业务码 / HTTP / 传输错误一律抛 `@/core/errors` 的 `ApiError`。**create 绝不自动重试**；读取仅手动刷新。
 *
 * 金额精度：接口金额只能是**精确十进制字符串**（`/^\d+(\.\d+)?$/`，非负、无指数），本模块严格校验、不补 0、不舍入；
 * `precision`/`expireAt`/`page` 等是整数或时间（非金额），用 `Number.isSafeInteger` 校验并注释。
 */
import { request } from '@/modules/api/http'
import { ApiError } from '@/core/errors'
import { isDecimalString } from '@/modules/finance/decimal'

export const INNER_TRANSFER_PATHS = {
  config: 'finance/inner_transfer/config',
  preview: 'finance/inner_transfer/preview',
  create: 'finance/inner_transfer/create',
  history: 'finance/inner_transfer/history',
} as const

export interface TransferCoin {
  coin: string
  /** 小数位数（计数，非金额）。 */
  precision: number
  /** 固定手续费，精确十进制字符串。 */
  fee: string
  /** 免审核金额阈值（**不是免手续费**）；超过需后台审核。 */
  freeAmount: string
}

export interface TransferSecurity {
  googleRequired: boolean
  emailRequired: boolean
  smsRequired: boolean
}

export interface TransferConfig {
  coins: TransferCoin[]
  security: TransferSecurity
}

export interface TransferPreview {
  previewToken: string
  /** epoch 毫秒（时间非金额）。 */
  expireAt: number
  toUid: string
  /** 收款人脱敏标签（UID 尾号），不含实名/邮箱。 */
  recipientLabel: string
  coin: string
  amount: string
  fee: string
  totalDebit: string
  receiveAmount: string
  available: string
  precision: number
  requiresApproval: boolean
  security: TransferSecurity
}

export type TransferStatus = 'pending' | 'review' | 'done' | 'failed' | 'rejected'

export interface TransferRecord {
  id: string
  requestId: string
  fromUid: string
  toUid: string
  coin: string
  amount: string
  fee: string
  status: TransferStatus
  reason: string
  ctime: string
}

export interface TransferHistory {
  list: TransferRecord[]
  page: number
  pageSize: number
}

export interface PreviewInput {
  toUid: string
  coin: string
  amount: string
}

export interface CreateInput extends PreviewInput {
  previewToken: string
  requestId: string
  googleCode: string
  emailValidCode?: string
  smsAuthCode?: string
}

export interface HistoryQuery {
  requestId?: string
  page?: number
  /** 服务端上限 50。 */
  pageSize?: number
}

const STATUSES: readonly TransferStatus[] = ['pending', 'review', 'done', 'failed', 'rejected']

function malformed(detail: string, path: string): ApiError {
  return new ApiError({ kind: 'parse', code: '', message: i18n.global.t('serviceMessage.invalidInternalTransferResponse', { detail }), path })
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw malformed(i18n.global.t('serviceMessage.missingObject'), path)
  return value as Record<string, unknown>
}

function asText(value: unknown, name: string, path: string): string {
  if (typeof value !== 'string') throw malformed(i18n.global.t('serviceMessage.isNotAString', { name }), path)
  return value
}

/** 只接受精确十进制字符串；数字/指数/空/NaN 一律拒绝。 */
function asMoney(value: unknown, name: string, path: string): string {
  if (typeof value !== 'string' || !isDecimalString(value)) throw malformed(i18n.global.t('serviceMessage.isNotAnExactDecimalString', { name }), path)
  return value
}

/** 小数位数（计数，非金额）；0..=16。 */
function asPrecision(value: unknown, name: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 16) throw malformed(i18n.global.t('serviceMessage.mustBeAnIntegerFrom0To16', { name }), path)
  return value
}

/** 非负安全整数（计数/时间，非金额）。 */
function asSafeInt(value: unknown, name: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed(i18n.global.t('serviceMessage.mustBeANonnegativeSafeInteger', { name }), path)
  return value
}

function asBool(value: unknown, name: string, path: string): boolean {
  if (typeof value !== 'boolean') throw malformed(i18n.global.t('serviceMessage.mustBeABoolean', { name }), path)
  return value
}

function asSecurity(value: unknown, path: string): TransferSecurity {
  const rec = asRecord(value, path)
  return {
    googleRequired: asBool(rec.googleRequired, 'security.googleRequired', path),
    emailRequired: asBool(rec.emailRequired, 'security.emailRequired', path),
    smsRequired: asBool(rec.smsRequired, 'security.smsRequired', path),
  }
}

function asStatus(value: unknown, path: string): TransferStatus {
  if (typeof value !== 'string' || !(STATUSES as readonly string[]).includes(value)) throw malformed(i18n.global.t('serviceMessage.unknownTransferStatus'), path)
  return value as TransferStatus
}

function asRecordItem(value: unknown, path: string): TransferRecord {
  const rec = asRecord(value, path)
  return {
    id: asText(rec.id, 'id', path),
    requestId: asText(rec.requestId, 'requestId', path),
    fromUid: asText(rec.fromUid, 'fromUid', path),
    toUid: asText(rec.toUid, 'toUid', path),
    coin: asText(rec.coin, 'coin', path),
    amount: asMoney(rec.amount, 'amount', path),
    fee: asMoney(rec.fee, 'fee', path),
    status: asStatus(rec.status, path),
    reason: asText(rec.reason, 'reason', path),
    ctime: asText(rec.ctime, 'ctime', path),
  }
}

/** 只读配置：仅有实际开启配置的币种；无配置/失败时不返回任何默认币种。 */
export async function loadTransferConfig(): Promise<TransferConfig> {
  const data = await request<unknown>(INNER_TRANSFER_PATHS.config, { method: 'POST', body: {} })
  const rec = asRecord(data, INNER_TRANSFER_PATHS.config)
  if (!Array.isArray(rec.coins)) throw malformed(i18n.global.t('serviceMessage.missingCoinsArray'), INNER_TRANSFER_PATHS.config)
  const coins: TransferCoin[] = rec.coins.map((entry) => {
    const c = asRecord(entry, INNER_TRANSFER_PATHS.config)
    return {
      coin: asText(c.coin, 'coin', INNER_TRANSFER_PATHS.config),
      precision: asPrecision(c.precision, 'precision', INNER_TRANSFER_PATHS.config),
      fee: asMoney(c.fee, 'fee', INNER_TRANSFER_PATHS.config),
      freeAmount: asMoney(c.freeAmount, 'freeAmount', INNER_TRANSFER_PATHS.config),
    }
  })
  return { coins, security: asSecurity(rec.security, INNER_TRANSFER_PATHS.config) }
}

/** 预览：以服务端结果为准（fee/限额都由服务端计算，本地不猜算法）。 */
export async function previewTransfer(input: PreviewInput): Promise<TransferPreview> {
  const data = await request<unknown>(INNER_TRANSFER_PATHS.preview, {
    method: 'POST',
    body: { toUid: input.toUid, coin: input.coin, amount: input.amount },
  })
  const rec = asRecord(data, INNER_TRANSFER_PATHS.preview)
  return {
    previewToken: asText(rec.previewToken, 'previewToken', INNER_TRANSFER_PATHS.preview),
    expireAt: asSafeInt(rec.expireAt, 'expireAt', INNER_TRANSFER_PATHS.preview),
    toUid: asText(rec.toUid, 'toUid', INNER_TRANSFER_PATHS.preview),
    recipientLabel: asText(rec.recipientLabel, 'recipientLabel', INNER_TRANSFER_PATHS.preview),
    coin: asText(rec.coin, 'coin', INNER_TRANSFER_PATHS.preview),
    amount: asMoney(rec.amount, 'amount', INNER_TRANSFER_PATHS.preview),
    fee: asMoney(rec.fee, 'fee', INNER_TRANSFER_PATHS.preview),
    totalDebit: asMoney(rec.totalDebit, 'totalDebit', INNER_TRANSFER_PATHS.preview),
    receiveAmount: asMoney(rec.receiveAmount, 'receiveAmount', INNER_TRANSFER_PATHS.preview),
    available: asMoney(rec.available, 'available', INNER_TRANSFER_PATHS.preview),
    precision: asPrecision(rec.precision, 'precision', INNER_TRANSFER_PATHS.preview),
    requiresApproval: asBool(rec.requiresApproval, 'requiresApproval', INNER_TRANSFER_PATHS.preview),
    security: asSecurity(rec.security, INNER_TRANSFER_PATHS.preview),
  }
}

/** 提交一笔转账：同一 `requestId` 由服务端查/恢复，不重复消耗验证码。 */
export async function createTransfer(input: CreateInput): Promise<TransferRecord> {
  const body: Record<string, string> = {
    toUid: input.toUid,
    coin: input.coin,
    amount: input.amount,
    previewToken: input.previewToken,
    requestId: input.requestId,
    googleCode: input.googleCode,
  }
  if (input.emailValidCode !== undefined && input.emailValidCode !== '') body.emailValidCode = input.emailValidCode
  if (input.smsAuthCode !== undefined && input.smsAuthCode !== '') body.smsAuthCode = input.smsAuthCode
  const data = await request<unknown>(INNER_TRANSFER_PATHS.create, { method: 'POST', body })
  return asRecordItem(data, INNER_TRANSFER_PATHS.create)
}

/** 历史（不含 total）：服务端按当前登录用户过滤。 */
export async function listTransferHistory(query: HistoryQuery = {}): Promise<TransferHistory> {
  const body: Record<string, unknown> = {}
  if (query.requestId !== undefined && query.requestId !== '') body.requestId = query.requestId
  if (query.page !== undefined) body.page = query.page
  if (query.pageSize !== undefined) body.pageSize = query.pageSize
  const data = await request<unknown>(INNER_TRANSFER_PATHS.history, { method: 'POST', body })
  const rec = asRecord(data, INNER_TRANSFER_PATHS.history)
  if (!Array.isArray(rec.list)) throw malformed(i18n.global.t('serviceMessage.missingListArray'), INNER_TRANSFER_PATHS.history)
  return {
    list: rec.list.map((entry) => asRecordItem(entry, INNER_TRANSFER_PATHS.history)),
    page: asSafeInt(rec.page, 'page', INNER_TRANSFER_PATHS.history),
    pageSize: asSafeInt(rec.pageSize, 'pageSize', INNER_TRANSFER_PATHS.history),
  }
}

/** `requestId` 约定：16..64 位 ASCII 字母数字/`_`/`-`。 */
export function isValidRequestId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value)
}

/** 生成一次幂等键（确认意图时生成一次）。 */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID()
  throw new Error(i18n.global.t('serviceMessage.cannotGenerateASecureRequestIdBecauseCryptoRandomuuid'))
}

/**
 * create 结果分类：只有**服务端明确拒绝**（业务码 / 4xx）算 definitive；network/timeout/5xx/parse/未识别一律 unknown。
 * unknown 时必须保留原 requestId，禁止换新 requestId 重发。
 */
export function isDefinitiveCreateRejection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.kind === 'unauthorized') return true
  // Only documented, pre-acceptance validation/auth errors may release the intent. A generic system code may
  // follow an accepted core request, so it must never mint a fresh requestId.
  return error.kind === 'api' && ['INNER_TRANSFER_ERROR', 'WALLET_ERROR', '10002', '110009', '10010', '10009',
    '110008', '10080', '110007'].includes(error.code)
}

/** preview 可回编辑：`INNER_TRANSFER_ERROR`（过期/参数/security 拒绝）由用户修改后重试。 */
export function isPreviewRecoverable(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'api' && error.code === 'INNER_TRANSFER_ERROR'
}
