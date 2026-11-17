import { translateForLocale } from '@/i18n/composer'
/**
 * Stable numeric codes, localised by the frontend (owner 2026-10-01, Binance style). The server sends
 * `{code, msg (English default or the request language), data}`; the UI shows ITS OWN zh/en text chosen by
 * (product, code) — spot and futures reuse numbers for different causes — plus the sub-reasons in `data.param` /
 * `data.reason`. Falls back to the server `msg`, then to a generic 「错误码 N」.
 *
 *   describeApiError(error, locale)   one line for any thrown error (used by the stores, panels and the global toast)
 *   isOrderResultUnknown(error)       200011 / a timed-out order request: refresh, never resubmit
 *   tpslCancelOutcome(error | data)   per-id results of `order/order_tpsl_cancel`
 */
import { codeNumber, isApiError, type ApiError, type ApiProduct } from '@/core/errors'
import { isPlaceholderMessage } from '@/modules/transfer/errors'
import { describeGuardError, guardKind } from '../guard-errors'
import { FUTURES_CODES, FUTURES_PREFER_SERVER } from './futures'
import { SPOT_CODES, SPOT_PREFER_SERVER } from './spot'
import type { CodeTable, CodeText } from './types'

export { FUTURES_CODES } from './futures'
export { SPOT_CODES } from './spot'
export type { CodeTable, CodeText } from './types'

/** OTC (exchange-otc-api `OtcMessage`): only codes seen with an empty server message are tabled. */
const OTC_CODES: CodeTable = {
  2029: 'apiError.orderNotFoundOrNotAccessible',
}

const TABLES: Record<ApiProduct, CodeTable> = { spot: SPOT_CODES, futures: FUTURES_CODES, otc: OTC_CODES }
const PREFER_SERVER: Record<ApiProduct, ReadonlySet<number>> = { spot: SPOT_PREFER_SERVER, futures: FUTURES_PREFER_SERVER, otc: new Set() }

/** Futures codes with special client behaviour. */
export const CODE = {
  NOT_LOGGED_IN: 10002,
  CANCEL_FAILED: 10021,
  SERVICE_UNAVAILABLE: 200010,
  ORDER_RESULT_UNKNOWN: 200011,
  AUTH_UNAVAILABLE: 200013,
} as const

function isZh(locale: string): boolean {
  return !locale.toLowerCase().startsWith('en')
}

function pick(text: CodeText, zh: boolean): string {
  return translateForLocale(zh ? 'zh' : 'en', text)
}

/** Text for (product, code) from the tables, or `null`. */
export function codeText(product: ApiProduct, code: number | string, locale: string): string | null {
  const n = typeof code === 'number' ? code : codeNumber(code)
  if (n === null) return null
  const entry = TABLES[product][n]
  return entry === undefined ? null : pick(entry, isZh(locale))
}

/* ------------------------------------------------------------------ sub-reasons */

/** Request field → what the user calls it (`data.param`). Unknown fields are shown as sent. */
const FIELD_NAMES: Record<string, CodeText> = {
  volume: 'apiError.quantity',
  price: 'apiError.price',
  triggerPrice: 'apiError.triggerPrice',
  contractId: 'apiError.contract',
  symbol: 'apiError.symbol',
  side: 'apiError.side',
  open: 'apiError.openClose',
  type: 'apiError.orderType',
  positionType: 'apiError.marginMode',
  leverageLevel: 'apiError.leverage',
  isConditionOrder: 'apiError.conditionalFlag',
  orderId: 'apiError.orderId',
  orderIds: 'apiError.orderIds',
  positionId: 'apiError.position',
  amount: 'apiError.amount',
  takerProfitTrigger: 'apiError.takeProfitTriggerPrice',
  takerProfitPrice: 'apiError.takeProfitPrice',
  stopLossTrigger: 'apiError.stopLossTriggerPrice',
  stopLossPrice: 'apiError.stopLossPrice',
  expireTime: 'apiError.expiry',
  timeInForce: 'apiError.timeInForce',
  body: 'apiError.requestBody',
}

/** `data.reason` → plain words. Reasons not listed here are not shown (they are for support, not users). */
const REASON_NAMES: Record<string, CodeText> = {
  MISSING: 'apiError.missing',
  NOT_NUMBER: 'apiError.notANumber',
  NOT_POSITIVE: 'apiError.mustBeAbove0',
  INVALID_VALUE: 'apiError.invalidValue',
  BUILD_FAILED: 'apiError.couldNotBuildTheOrder',
  BAD_JSON: 'apiError.malformedRequest',
  UNSUPPORTED_MEDIA_TYPE: 'apiError.unsupportedContentType',
  BAD_REQUEST: 'apiError.badRequest',
  CONNECT_FAILED: 'apiError.couldNotReachTheService',
  NO_INSTANCE: 'apiError.serviceNotReady',
  KYC_CHECK_UNAVAILABLE: 'apiError.kycCheckUnavailable',
  TIMEOUT: 'apiError.timedOut',
  RPC_ERROR: 'apiError.internalCallFailed',
  EMPTY_RESPONSE: 'apiError.noResponseFromTheService',
}

/** Codes whose own text already says everything; their `data.reason` is diagnostic only. */
const NO_SUFFIX: ReadonlySet<number> = new Set([CODE.ORDER_RESULT_UNKNOWN, 200014, 200015])

function field(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 「数量：不是有效数字」 / "quantity: not a number" from `data.param` + `data.reason` (`''` when neither applies). */
export function subReasonText(data: unknown, locale: string): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ''
  const zh = isZh(locale)
  const record = data as Record<string, unknown>
  const param = field(record, 'param')
  const reason = field(record, 'reason')
  const parts: string[] = []
  if (param !== null) parts.push(FIELD_NAMES[param] !== undefined ? pick(FIELD_NAMES[param], zh) : param)
  if (reason !== null && REASON_NAMES[reason] !== undefined) parts.push(pick(REASON_NAMES[reason], zh))
  return parts.join(zh ? '：' : ': ')
}

function withSubReason(text: string, sub: string, zh: boolean): string {
  if (sub === '') return text
  return zh ? `${text}（${sub}）` : `${text} (${sub})`
}

/** True when the text is in the UI language (Chinese characters ⇔ zh). */
function inLanguage(text: string, zh: boolean): boolean {
  return /[一-鿿]/.test(text) === zh
}

/* ------------------------------------------------------------------ main entry */

function genericCode(code: number, zh: boolean): string {
  return translateForLocale(zh ? 'zh' : 'en', 'apiError.error', { code })
}

/** Localised text for (product, code, data, server msg), the core of `describeApiError`. */
export function describeCode(product: ApiProduct, code: number, data: unknown, serverMessage: string, locale: string): string {
  const zh = isZh(locale)
  const entry = TABLES[product][code]
  const server = serverMessage.trim()
  const usableServer = server !== '' && !isPlaceholderMessage(server)
  if (entry === undefined) return usableServer ? server : genericCode(code, zh)
  if (PREFER_SERVER[product].has(code) && usableServer && inLanguage(server, zh)) return server
  return withSubReason(pick(entry, zh), NO_SUFFIX.has(code) ? '' : subReasonText(data, locale), zh)
}

/**
 * One line for any error, in the UI language (`locale`: `zh_CN` / `en_US` / `zh-CN` …).
 * Order: guard refusal (-1003/-1013/-1015/-2010, sub-reason aware) → (product, code) table with `data.param` /
 * `data.reason` → server `msg` → 「错误码 N」. Transport errors keep their own (already localised) text.
 */
export function describeApiError(error: unknown, locale: string): string {
  if (!isApiError(error)) {
    if (error instanceof Error) return error.message
    return typeof error === 'string' ? error : String(error)
  }
  const zh = isZh(locale)
  if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'aborted' || error.kind === 'parse') return error.message
  const guard = describeGuardError(error, locale)
  if (guard !== null) return guard
  const code = errorCode(error)
  if (code === null) {
    if (error.kind === 'http' && (error.status ?? 0) >= 500) {
      return translateForLocale(zh ? 'zh' : 'en', 'apiError.serviceTemporarilyUnavailableHttpPleaseRetryLater', { status: error.status })
    }
    return error.message
  }
  return describeCode(error.product, code, error.data, error.message, locale)
}

/** The business code of an error, `null` when there is none (transport errors, an HTTP status standing in for a code). */
export function errorCode(error: ApiError): number | null {
  const n = error.codeNumber
  if (n === null) return null
  // http.ts uses the HTTP status as the code when the body had none (502 HTML page …): that is not a business code.
  if (error.kind === 'http' && error.status !== undefined && n === error.status) return null
  return n
}

/* ------------------------------------------------------------------ special cases */

/**
 * The order may or may not exist: futures 200011 ORDER_RESULT_UNKNOWN, or our own request timed out after it was sent.
 * Never retry; refresh open orders and positions instead.
 */
export function isOrderResultUnknown(error: unknown): boolean {
  if (!isApiError(error)) return false
  if (error.kind === 'timeout') return true
  return error.product === 'futures' && errorCode(error) === CODE.ORDER_RESULT_UNKNOWN
}

/** 「下单结果未确认：请勿重复提交，正在刷新委托列表…」 */
export function orderUnconfirmedText(locale: string): string {
  return pick(FUTURES_CODES[CODE.ORDER_RESULT_UNKNOWN], isZh(locale))
}

/** Futures 200010: the request was NOT executed, a retry is safe. */
export function isServiceUnavailable(error: unknown): boolean {
  return isApiError(error) && error.product === 'futures' && errorCode(error) === CODE.SERVICE_UNAVAILABLE
}

/** Futures 200013: the login check itself is down — not a sign-out. */
export function isAuthUnavailable(error: unknown): boolean {
  return isApiError(error) && error.product === 'futures' && errorCode(error) === CODE.AUTH_UNAVAILABLE
}

/** True for a guard refusal (rate limit / order filter / STP). */
export function isGuardRefusal(error: unknown): boolean {
  return isApiError(error) && guardKind(error.code, error.status) !== null
}

/* ------------------------------------------------------------------ order_tpsl_cancel per-id results */

export interface TpslCancelFailure {
  orderId: string
  code: number | null
  text: string
}

export interface TpslCancelOutcome {
  succeeded: number
  failed: number
  failures: TpslCancelFailure[]
}

/**
 * Per-id results of `order/order_tpsl_cancel` (2026-10-01): `data = {results:[{orderId, code, msg, reason?}],
 * succeeded, failed}`, top-level code 0 only when every id succeeded, otherwise 10021 with the same data. Accepts the
 * thrown error or the success data; `null` when the answer has no per-id results (older server, other failure).
 */
export function tpslCancelOutcome(source: unknown, locale: string): TpslCancelOutcome | null {
  const data = isApiError(source) ? source.data : source
  if (data === null || typeof data !== 'object') return null
  const results = (data as { results?: unknown }).results
  if (!Array.isArray(results)) return null
  const failures: TpslCancelFailure[] = []
  let ok = 0
  for (const raw of results) {
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const code = codeNumber(typeof row.code === 'number' || typeof row.code === 'string' ? row.code : null)
    if (code === 0) {
      ok += 1
      continue
    }
    const orderId = row.orderId === undefined || row.orderId === null ? '' : String(row.orderId)
    const msg = typeof row.msg === 'string' ? row.msg : ''
    const reason = typeof row.reason === 'string' ? row.reason : undefined
    const text = code === null
      ? (msg.trim() !== '' ? msg : pick(FUTURES_CODES[CODE.CANCEL_FAILED], isZh(locale)))
      : describeCode('futures', code, reason === undefined ? undefined : { reason }, msg, locale)
    failures.push({ orderId, code, text })
  }
  const succeeded = typeof (data as { succeeded?: unknown }).succeeded === 'number' ? (data as { succeeded: number }).succeeded : ok
  const failed = typeof (data as { failed?: unknown }).failed === 'number' ? (data as { failed: number }).failed : failures.length
  return { succeeded, failed, failures }
}

/** 「已撤销 1 个，2 个未撤销：#11 订单已成交或已撤销；#12 撤单失败」 */
export function describeTpslCancel(outcome: TpslCancelOutcome, locale: string): string {
  const zh = isZh(locale)
  const list = outcome.failures.map((entry) => `#${entry.orderId} ${entry.text}`).join(zh ? '；' : '; ')
  if (outcome.failed === 0) return translateForLocale(zh ? 'zh' : 'en', 'apiError.cancelled', { succeeded: outcome.succeeded })
  const head = outcome.succeeded > 0
    ? translateForLocale(locale, 'cancelSummary.cancelledNotCancelled', { succeeded: outcome.succeeded, failed: outcome.failed })
    : translateForLocale(locale, 'cancelSummary.notCancelled', { failed: outcome.failed })
  return list === '' ? head : `${head}${zh ? '：' : ': '}${list}`
}

/* ------------------------------------------------------------------ unknown-result refresh guard */

/** The submit button stays blocked at least this long after an unconfirmed order, even if the refresh is faster. */
export const UNKNOWN_RESULT_GUARD_MS = 1_000

/**
 * Runs the open-orders / positions refresh after an unconfirmed order (never a retry) and resolves no sooner than
 * `minMs`, so the caller can keep its submit button disabled across a double click. A failed refresh is swallowed:
 * the unconfirmed message is already shown and the regular polling reconciles.
 */
export async function guardedRefresh(refresh: () => Promise<unknown>, minMs: number = UNKNOWN_RESULT_GUARD_MS): Promise<void> {
  const floor = minMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, minMs)) : Promise.resolve()
  await Promise.all([refresh().catch(() => undefined), floor])
}
