import { i18n } from '@/i18n/composer'
import { session } from '@/core/session'
import { parseJsonLossless } from '@/core/lossless-json'
import { buildHeaders } from '@/modules/api/http'

export type BusinessRow = Record<string, unknown>
export type BusinessParams = Record<string, string>

/** Preserve every JSON numeric lexeme before parsing: decimal amounts and 64-bit IDs never pass through Number. */
export function parseBusinessJson(text: string): unknown {
  let output = ''
  let quoted = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    if (quoted) {
      output += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') { quoted = true; output += c; continue }
    if (c === '-' || /\d/.test(c)) {
      const match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      if (match) { output += JSON.stringify(match[0]); i += match[0].length - 1; continue }
    }
    output += c
  }
  return parseJsonLossless(output) as unknown
}

export function rowOf(value: unknown): BusinessRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as BusinessRow : {}
}
export function valueAt(row: BusinessRow, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => rowOf(value)[key], row)
}
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // Objects are for inspection only. The parser above has already preserved decimal/ID strings.
  return JSON.stringify(value)
}
export function rowsOf(value: unknown, path = 'rows', singleton = false): BusinessRow[] {
  const source = path === '' ? value : valueAt(rowOf(value), path)
  if (Array.isArray(source)) return source.map(rowOf)
  if (singleton && source !== null && source !== undefined && Object.keys(rowOf(source)).length > 0) return [rowOf(source)]
  return []
}

export class BusinessApiError extends Error {
  constructor(message: string, readonly unconfirmed = false, readonly code = '') { super(message); this.name = 'BusinessApiError' }
}

/** Business APIs and the one futures fee preference use direct JSON. POST is never retried. */
export async function businessRequest(path: string, params: BusinessParams = {}, write = false, signal?: AbortSignal): Promise<unknown> {
  if (!/^\/sapi\/v[12]\/[a-zA-Z0-9/_-]+$/.test(path) && path !== '/fapi/v1/feeBurn') throw new BusinessApiError('Invalid business API path')
  const token = session.getToken()
  if (write && !token) throw new BusinessApiError(i18n.global.t('businessRequest.pleaseSignIn'))
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = window.setTimeout(abort, 20_000)
  const fields = new URLSearchParams(params)
  try {
    const response = await fetch(path + (!write && fields.size ? `?${fields.toString()}` : ''), {
      method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: buildHeaders({ headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } }),
      body: write ? fields.toString() : undefined, signal: controller.signal,
    })
    const raw = await response.text()
    let data: unknown
    try { data = parseBusinessJson(raw) }
    catch { throw new BusinessApiError(i18n.global.t('businessRequest.responseUnconfirmedCheckRecords'), write) }
    if (session.getToken() !== token) throw new BusinessApiError(i18n.global.t('businessRequest.signedInAccountChanged'), write)
    const body = rowOf(data)
    const code = textOf(body.code)
    if (!response.ok || /^-\d+$/.test(code)) {
      const message = code === '-6004' ? i18n.global.t('businessRequest.thisProductIsNotAcceptingSubscriptionsRefreshItsStatus')
        : code === '-6008' ? i18n.global.t('businessRequest.thisPositionIsNotRedeemableNowOrDoesNot')
        : code === '-6007' ? i18n.global.t('businessRequest.settlementOrAClosedTransactionWindowIsInProgress')
        : code === '-9001' ? i18n.global.t('businessRequest.thisModuleIsUnavailableOrNotConfigured')
        : code === '-2015' || code === '-2014' ? i18n.global.t('businessRequest.identityOrPermissionCheckFailedSignInAgainOr')
        : textOf(body.msg) || `HTTP ${response.status}`
      throw new BusinessApiError(message, write && response.status >= 500, code)
    }
    if (write && (data === null || typeof data !== 'object' || Array.isArray(data))) throw new BusinessApiError(i18n.global.t('businessRequest.emptySubmissionResponseCheckRecords'), true)
    if (token) session.noteServerContact(token)
    return data
  } catch (error) {
    if (error instanceof BusinessApiError) throw error
    throw new BusinessApiError(write
      ? i18n.global.t('businessRequest.resultUnconfirmedCheckRecordsBeforeResubmitting')
      : i18n.global.t('businessRequest.unableToReadRefreshToRetry'), write)
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export interface PendingBusinessAction { label: string; path: string; fields: BusinessParams; result: BusinessRow; time: string }
/** Token fingerprint scopes the receipt to a session without persisting the token itself. Only a receipt is stored. */
async function receiptKey(feature: string): Promise<string | null> {
  const token = session.getToken()
  if (!token) return null
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return `lb-business-receipt:${feature}:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`
}
export async function pendingReceipt(feature: string): Promise<PendingBusinessAction | null> {
  const key = await receiptKey(feature)
  if (!key) return null
  const text = sessionStorage.getItem(key)
  if (!text) return null
  const receipt = parseJsonLossless(text) as PendingBusinessAction
  if (!receipt || typeof receipt.path !== 'string' || typeof receipt.label !== 'string' || typeof receipt.fields !== 'object' || receipt.fields === null) throw new BusinessApiError(i18n.global.t('businessRequest.submissionReceiptIsUnreadable'))
  return receipt
}
export async function saveReceipt(feature: string, receipt: PendingBusinessAction | null): Promise<void> {
  const key = await receiptKey(feature)
  if (!key) return
  if (receipt) sessionStorage.setItem(key, JSON.stringify(receipt))
  else sessionStorage.removeItem(key)
}
