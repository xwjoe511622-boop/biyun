import { i18n } from '@/i18n/composer'
/**
 * 历史记录导出（生成报表，参照币安「导出交易记录」；hexport 10-19）：`/fe-ex-api/history/export/*`。
 *
 * 热窗口（测试环境 14 天）之前的委托、成交和资金流水已移入归档，页面不再能直接查询；用户在这里申请报表，
 * 服务端异步生成压缩的 CSV（7 天内可下载），下载链接为 5 分钟的预签名地址，只给报表所属用户。
 *
 * 时间一律是 epoch 毫秒 UTC（UTC 铁律）；`tzOffsetMin` 只决定 CSV 里的时间显示，取自浏览器时区。
 * 报表内容（含金额）只在 CSV 文件里，本模块不处理金额。数字字段（时间、条数、字节数）都按安全整数校验。
 */
import { ApiError } from '@/core/errors'
import { request } from '@/modules/api/http'

export const HISTORY_EXPORT_PATHS = {
  info: 'history/export/info',
  create: 'history/export/create',
  list: 'history/export/list',
  download: 'history/export/download',
} as const

export const EXPORT_KINDS = ['spot_orders', 'spot_trades', 'spot_funds', 'futures_orders', 'futures_trades', 'futures_funds'] as const
export type ExportKind = (typeof EXPORT_KINDS)[number]

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired'
const STATUSES: readonly ExportStatus[] = ['queued', 'running', 'ready', 'failed', 'expired']

export interface ExportInfo {
  /** 仍在数据库（页面可查）的最早时间，epoch 毫秒 UTC；`null` = 尚无归档。 */
  hotFromMs: number | null
  /** 归档里最早的一天，epoch 毫秒 UTC；`null` = 尚无归档。 */
  earliestMs: number | null
  maxRangeDays: number
  per30Days: number
  used30Days: number
  waiting: number
  maxWaiting: number
  retentionDays: number
}

export interface ExportRecord {
  id: string
  kind: ExportKind
  startTime: number
  endTime: number
  tzOffsetMin: number
  status: ExportStatus
  rows: number | null
  fileBytes: number | null
  fileName: string | null
  error: string | null
  createdAt: number
  expiresAt: number | null
}

export interface ExportLink {
  url: string
  fileName: string
  expiresIn: number
}

export interface CreateExportInput {
  kind: ExportKind
  /** epoch 毫秒 UTC，含。 */
  startTime: number
  /** epoch 毫秒 UTC，不含。 */
  endTime: number
  /** 东区为正的分钟数（UTC+8 = 480）。 */
  tzOffsetMin: number
}

function malformed(detail: string, path: string): ApiError {
  return new ApiError({ kind: 'parse', code: '', message: i18n.global.t('serviceMessage.invalidExportResponse', { detail }), path })
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw malformed(i18n.global.t('serviceMessage.missingObject'), path)
  return value as Record<string, unknown>
}

/** 时间、条数、字节数：安全整数（非金额）。 */
function asInt(value: unknown, name: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw malformed(i18n.global.t('serviceMessage.isNotAnInteger', { name }), path)
  return value
}

function asIntOrNull(value: unknown, name: string, path: string): number | null {
  return value === null || value === undefined ? null : asInt(value, name, path)
}

function asTextOrNull(value: unknown, name: string, path: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw malformed(i18n.global.t('serviceMessage.isNotAString', { name }), path)
  return value
}

export function isExportKind(value: unknown): value is ExportKind {
  return typeof value === 'string' && (EXPORT_KINDS as readonly string[]).includes(value)
}

export function parseInfo(data: unknown): ExportInfo {
  const path = HISTORY_EXPORT_PATHS.info
  const r = asRecord(data, path)
  return {
    hotFromMs: asIntOrNull(r.hotFromMs, 'hotFromMs', path),
    earliestMs: asIntOrNull(r.earliestMs, 'earliestMs', path),
    maxRangeDays: asInt(r.maxRangeDays, 'maxRangeDays', path),
    per30Days: asInt(r.per30Days, 'per30Days', path),
    used30Days: asInt(r.used30Days, 'used30Days', path),
    waiting: asInt(r.waiting, 'waiting', path),
    maxWaiting: asInt(r.maxWaiting, 'maxWaiting', path),
    retentionDays: asInt(r.retentionDays, 'retentionDays', path),
  }
}

export function parseRecord(value: unknown): ExportRecord {
  const path = HISTORY_EXPORT_PATHS.list
  const r = asRecord(value, path)
  if (typeof r.id !== 'string' || !/^\d+$/.test(r.id)) throw malformed(i18n.global.t('serviceMessage.invalidId'), path)
  if (!isExportKind(r.kind)) throw malformed(i18n.global.t('serviceMessage.invalidKind'), path)
  if (typeof r.status !== 'string' || !(STATUSES as readonly string[]).includes(r.status)) throw malformed(i18n.global.t('serviceMessage.invalidStatus'), path)
  return {
    id: r.id,
    kind: r.kind,
    startTime: asInt(r.startTime, 'startTime', path),
    endTime: asInt(r.endTime, 'endTime', path),
    tzOffsetMin: asInt(r.tzOffsetMin, 'tzOffsetMin', path),
    status: r.status as ExportStatus,
    rows: asIntOrNull(r.rows, 'rows', path),
    fileBytes: asIntOrNull(r.fileBytes, 'fileBytes', path),
    fileName: asTextOrNull(r.fileName, 'fileName', path),
    error: asTextOrNull(r.error, 'error', path),
    createdAt: asInt(r.createdAt, 'createdAt', path),
    expiresAt: asIntOrNull(r.expiresAt, 'expiresAt', path),
  }
}

export function parseLink(data: unknown): ExportLink {
  const path = HISTORY_EXPORT_PATHS.download
  const r = asRecord(data, path)
  if (typeof r.url !== 'string' || !/^https:\/\//.test(r.url)) throw malformed(i18n.global.t('serviceMessage.invalidUrl'), path)
  return { url: r.url, fileName: asTextOrNull(r.fileName, 'fileName', path) ?? 'statement.zip', expiresIn: asInt(r.expiresIn, 'expiresIn', path) }
}

export async function fetchExportInfo(): Promise<ExportInfo> {
  return parseInfo(await request<unknown>(HISTORY_EXPORT_PATHS.info, { body: {} }))
}

export async function fetchExports(): Promise<ExportRecord[]> {
  const r = asRecord(await request<unknown>(HISTORY_EXPORT_PATHS.list, { body: {} }), HISTORY_EXPORT_PATHS.list)
  if (!Array.isArray(r.list)) throw malformed(i18n.global.t('serviceMessage.expectedAListArray'), HISTORY_EXPORT_PATHS.list)
  return r.list.map(parseRecord)
}

/** 申请报表（不自动重试：重复点击由服务端的频率与排队上限拦住）。 */
export async function createExport(input: CreateExportInput): Promise<string> {
  const r = asRecord(await request<unknown>(HISTORY_EXPORT_PATHS.create, { body: { ...input } }), HISTORY_EXPORT_PATHS.create)
  if (typeof r.id !== 'string') throw malformed(i18n.global.t('serviceMessage.invalidId'), HISTORY_EXPORT_PATHS.create)
  return r.id
}

export async function fetchDownloadLink(id: string): Promise<ExportLink> {
  return parseLink(await request<unknown>(HISTORY_EXPORT_PATHS.download, { body: { id } }))
}

/** 浏览器所在时区（东区为正的分钟数；`getTimezoneOffset` 西区为正，所以取反）。 */
export function browserOffsetMin(at: Date = new Date()): number {
  return -at.getTimezoneOffset()
}

const DAY_MS = 86_400_000

/**
 * 本地日期 `YYYY-MM-DD` 的 00:00（在 `offsetMin` 时区）→ epoch 毫秒 UTC。展示层输入转内部时间的唯一入口。
 */
export function localDayStartMs(day: string, offsetMin: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return null
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) // float-ok: not money (calendar date parts)
  if (Number.isNaN(utc)) return null
  return utc - offsetMin * 60_000
}

/** 预设区间（含今天）：最近 `days` 天，按用户时区的自然日对齐，结束为明天 00:00（不含）。 */
export function presetRange(days: number, nowMs: number, offsetMin: number): { startTime: number; endTime: number } {
  const localMidnight = Math.floor((nowMs + offsetMin * 60_000) / DAY_MS) * DAY_MS - offsetMin * 60_000
  const endTime = localMidnight + DAY_MS
  return { startTime: endTime - days * DAY_MS, endTime }
}

/** 区间早于热窗口（页面查不到、需要导出）吗？ */
export function reachesArchive(startTime: number | null, info: Pick<ExportInfo, 'hotFromMs'> | null): boolean {
  return startTime !== null && info !== null && info.hotFromMs !== null && startTime < info.hotFromMs
}
