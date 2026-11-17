import { i18n } from '@/i18n/composer'
import { ApiError } from '@/core/errors'
import { isDecimalString, toDecString } from '@/modules/finance/decimal'
import type {
  DepositAddress,
  HistoryEntry,
  HistoryKind,
  HistoryPage,
  UserSecurity,
  WalletAddress,
  WithdrawConfig,
} from './types'

/**
 * Defensive readers for wallet payloads.
 *
 * Wallet responses use these runtime guards alongside `wallet-security.openapi.yaml` instead of
 * `validateData` in `modules/api/validation.ts`. These helpers narrow unknown JSON to
 * the source-confirmed shapes. A payload that is missing the envelope the server contract always
 * returns (`addressStr`, `addressList`, `userWithdrawAddrList`, `financeList`, `count`, an entry
 * `id`) throws `ApiError(kind: 'parse')` so the UI shows a real failure instead of an empty page
 * that looks like a legitimate "no data" success.
 */

/** A response that does not match the endpoint contract at all. */
function malformed(path: string, detail: string): ApiError {
  return new ApiError({ kind: 'parse', code: '', path, message: i18n.global.t('serviceMessage.invalidWalletResponse', { detail }) })
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** `null`/`undefined` -> `''`; JSON numbers are stringified without float parsing. */
export function text(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? toDecString(value) : ''
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0'
  }
  return ''
}

/** Keeps a decimal field only when the server actually sent a decimal. */
export function decimal(value: unknown): string {
  const raw = toDecString(value)
  return isDecimalString(raw) ? raw : ''
}

export function flag(value: unknown): boolean {
  const raw = text(value).trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/** Legacy `isHavePage`: the coin carries a memo/tag, so `address_tag` is one string. */
export function hasTag(raw: string): boolean {
  return raw.includes('_')
}

/** Splits on the first `_`, exactly like the legacy mixins (`address.split('_')`). */
export function splitAddressTag(raw: string): { address: string; tag: string } {
  const index = raw.indexOf('_')
  if (index === -1) {
    return { address: raw, tag: '' }
  }
  return { address: raw.slice(0, index), tag: raw.slice(index + 1) }
}

export function joinAddressTag(address: string, tag: string): string {
  return tag === '' ? address : `${address}_${tag}`
}

export function normalizeDepositAddress(data: unknown): DepositAddress {
  const record = asRecord(data)
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw malformed('account/getRechargeAddress', i18n.global.t('serviceMessage.missingChargeaddressvoObject'))
  }
  if (record.addressStr === undefined || record.addressStr === null) {
    throw malformed('account/getRechargeAddress', i18n.global.t('serviceMessage.missingAddressstr'))
  }
  const raw = text(record.addressStr)
  const split = splitAddressTag(raw)
  return {
    address: split.address,
    tag: split.tag,
    hasTag: split.tag !== '',
    qrCode: text(record.addressQRCode),
  }
}

/** Epoch milliseconds (as sent by fastjson for `Date`) rendered as UTC `YYYY-MM-DD HH:mm:ss`. */
export function displayTime(value: unknown): string {
  const raw = text(value).trim()
  if (!/^\d{12,13}$/.test(raw)) {
    return raw
  }
  const date = new Date(Number.parseInt(raw, 10))
  if (Number.isNaN(date.getTime())) {
    return raw
  }
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

export function normalizeWalletAddress(value: unknown): WalletAddress {
  const record = asRecord(value)
  const raw = text(record.address)
  const split = splitAddressTag(raw)
  const entry: WalletAddress = {
    id: text(record.id),
    // Historical rows carry `symbol`; some legacy payloads use `coinSymbol`.
    coin: text(record.symbol !== undefined && record.symbol !== null ? record.symbol : record.coinSymbol).toUpperCase(),
    address: split.address,
    tag: split.tag,
    label: text(record.label),
    raw,
  }
  // Contract v2 fields are only attached when the server actually sent them.
  const network = text(record.network).trim().toUpperCase()
  if (network !== '') {
    entry.network = network
  }
  const created = displayTime(record.ctime)
  if (created !== '') {
    entry.createdAt = created
  }
  const lastUsed = displayTime(record.lastUsedTime)
  if (lastUsed !== '') {
    entry.lastUsedAt = lastUsed
  }
  return entry
}

/**
 * Compatibility probe: the contract v2 address book returns `network` on every row. A list without
 * any `network` field is the historical per-coin book (an empty list proves nothing either way).
 */
export function addressListHasNetworks(list: WalletAddress[]): boolean {
  return list.some(entry => entry.network !== undefined && entry.network !== '')
}

export function normalizeAddressList(data: unknown): WalletAddress[] {
  const record = asRecord(data)
  if (!Array.isArray(record.addressList)) {
    throw malformed('addr/address_list', i18n.global.t('serviceMessage.missingAddresslistArray'))
  }
  return record.addressList.map(normalizeWalletAddress).filter(entry => entry.id !== '')
}

export function normalizeWithdrawConfig(data: unknown, coin: string): WithdrawConfig {
  const record = asRecord(data)
  if (!Array.isArray(record.userWithdrawAddrList)) {
    throw malformed('cost/Getcost', i18n.global.t('serviceMessage.missingUserwithdrawaddrlistArray'))
  }
  const addresses = record.userWithdrawAddrList
    .map(normalizeWalletAddress)
    .filter(entry => entry.id !== '')
  return {
    coin,
    feeMin: decimal(record.feeMin),
    feeMax: decimal(record.feeMax),
    withdrawMin: decimal(record.withdraw_min),
    withdrawMax: decimal(record.withdraw_max),
    defaultFee: decimal(record.defaultFee),
    chainTip: text(record.mainChainNameTip),
    addresses,
    ...contractConfigFields(record),
  }
}

function optionalOpen(value: unknown): boolean | null {
  const raw = text(value).trim().toLowerCase()
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return null
}

/** Contract v2 optional fields; each one is only present when the server reported it. */
function contractConfigFields(record: Record<string, unknown>): Partial<WithdrawConfig> {
  const extra: Partial<WithdrawConfig> = {}
  const network = text(record.network).trim().toUpperCase()
  if (network !== '') extra.network = network
  const daily = decimal(record.dailyRemaining)
  if (daily !== '') extra.dailyRemaining = daily
  const threshold = decimal(record.autoApprovalThreshold)
  if (threshold !== '') extra.autoApprovalThreshold = threshold
  const open = optionalOpen(record.withdrawOpen)
  if (open !== null) extra.withdrawOpen = open
  const precision = text(record.precision).trim()
  if (/^\d{1,2}$/.test(precision)) extra.precision = Number.parseInt(precision, 10)
  const confirmations = text(record.confirmations).trim()
  if (/^\d+$/.test(confirmations)) extra.confirmations = Number.parseInt(confirmations, 10)
  const dailyLimit = decimal(record.dailyLimit)
  if (dailyLimit !== '') extra.dailyLimit = dailyLimit
  return extra
}

/** True when a `withdraw_config` payload carries at least one contract v2 limit field. */
export function isContractWithdrawConfig(data: unknown): boolean {
  const record = asRecord(data)
  return ['withdrawMin', 'withdrawMax', 'fee', 'withdrawOpen', 'dailyRemaining'].some(
    key => record[key] !== undefined && record[key] !== null && record[key] !== '',
  )
}

/**
 * Contract v2 `withdraw_config` (§6.4): `{ coinSymbol, network, fee, feeMin, feeMax, withdrawMin,
 * withdrawMax, dailyLimit, dailyUsed, dailyRemaining, autoApprovalThreshold|null, withdrawOpen,
 * precision, confirmations }`. `fee` is the current fee the server requires the request to repeat.
 */
export function normalizeContractWithdrawConfig(data: unknown, coin: string): WithdrawConfig {
  const record = asRecord(data)
  if (!isContractWithdrawConfig(data)) {
    throw malformed('account/withdraw_config', i18n.global.t('serviceMessage.missingLimitFields'))
  }
  const fee = decimal(record.fee)
  const feeMin = decimal(record.feeMin)
  const feeMax = decimal(record.feeMax)
  return {
    coin,
    feeMin: feeMin !== '' ? feeMin : fee,
    feeMax: feeMax !== '' ? feeMax : fee,
    withdrawMin: decimal(record.withdrawMin),
    withdrawMax: decimal(record.withdrawMax),
    defaultFee: fee,
    chainTip: '',
    addresses: [],
    ...contractConfigFields(record),
  }
}

function normalizeHistoryEntry(value: unknown, kind: HistoryKind): HistoryEntry {
  const record = asRecord(value)
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(kind === 'withdraw' ? 'account/withdrawList' : 'record/deposit_list', i18n.global.t('serviceMessage.recordMustBeAnObject'))
  }
  // `record/deposit_list` sends `addressTo`/`symbol`; the CIAO-compatible `withdrawList` sends
  // `address`/`coinSymbol`. Both shapes are read, neither is invented.
  const addressRaw = record.addressTo !== undefined && record.addressTo !== null ? record.addressTo : record.address
  const addressSplit = splitAddressTag(text(addressRaw))
  const createdAt = displayTime(record.createdAt)
  const id = text(record.id !== undefined && record.id !== null ? record.id : record.withdrawId)
  if (kind === 'withdraw' && id === '') {
    throw malformed('account/withdrawList', i18n.global.t('serviceMessage.withdrawalRecordIsMissingTheIdNeededForCancellation'))
  }
  return {
    id: id === '' ? createdAt : id,
    coin: text(record.symbol !== undefined && record.symbol !== null ? record.symbol : record.coinSymbol).toUpperCase(),
    amount: decimal(record.amount),
    fee: decimal(record.fee),
    address: addressSplit.address,
    tag: addressSplit.tag,
    txid: text(record.txid),
    // The explorer URL comes from the server and is untrusted: only `http(s)` survives.
    txidUrl: safeExplorerUrl(text(record.txidAddr)),
    label: text(record.label),
    // Deposits have no cancellation state; only the withdrawal status drives actions.
    status: kind === 'withdraw' ? text(record.status).trim() : '',
    canCancel: record.canCancel === undefined ? undefined : flag(record.canCancel),
    statusText: text(record.status_text),
    confirmDesc: text(record.confirmDesc),
    createdAt,
    walletTime: displayTime(record.walletTime),
    ...historyExtras(record),
  }
}

function historyExtras(record: Record<string, unknown>): Partial<HistoryEntry> {
  const extra: Partial<HistoryEntry> = {}
  const network = text(record.network).trim().toUpperCase()
  if (network !== '') extra.network = network
  const rawStatus = text(record.status).trim()
  if (rawStatus !== '') extra.rawStatus = rawStatus
  const desc = /^(\d+)\s*\/\s*(\d+)$/.exec(text(record.confirmDesc).trim())
  const confirmations = text(record.confirmations).trim()
  if (/^\d+$/.test(confirmations)) {
    extra.confirmations = Number.parseInt(confirmations, 10)
  } else if (desc !== null) {
    extra.confirmations = Number.parseInt(desc[1], 10)
  }
  if (desc !== null) extra.requiredConfirmations = Number.parseInt(desc[2], 10)
  // Dust remainder is read as a raw string only (never parsed / coerced from a number): it is a
  // smallest-unit integer of the user's funds below the core's 16-decimal scale, not a fee.
  const dustRaw = record.dustRaw
  if (typeof dustRaw === 'string' && dustRaw.trim() !== '') {
    extra.dustRaw = dustRaw.trim()
  }
  return extra
}

export function normalizeHistoryPage(data: unknown, kind: HistoryKind): HistoryPage {
  const record = asRecord(data)
  const path = kind === 'withdraw' ? 'account/withdrawList' : 'record/deposit_list'
  if (!Array.isArray(record.financeList)) {
    throw malformed(path, i18n.global.t('serviceMessage.missingFinancelistArray'))
  }
  if (record.count === undefined || record.count === null || record.count === '') {
    throw malformed(path, i18n.global.t('serviceMessage.missingCount'))
  }
  const rawCount = text(record.count)
  if (!/^\d+$/.test(rawCount)) {
    throw malformed(path, i18n.global.t('serviceMessage.countMustBeANonnegativeInteger'))
  }
  const count = Number.parseInt(rawCount, 10)
  if (!Number.isSafeInteger(count)) throw malformed(path, i18n.global.t('serviceMessage.countExceedsTheSafeIntegerRange'))
  return {
    count,
    list: record.financeList.map(entry => normalizeHistoryEntry(entry, kind)),
  }
}

export function normalizeUserSecurity(userInfo: unknown): UserSecurity {
  const record = asRecord(userInfo)
  const authLevelText = text(record.authLevel)
  const googleRaw = record.googleStatus
  const mobileRaw = record.isOpenMobileCheck
  const googleKnown = ['0', '1'].includes(text(googleRaw).trim())
  const mobileKnown = ['0', '1'].includes(text(mobileRaw).trim())
  return {
    googleEnabled: text(googleRaw).trim() === '1',
    googleKnown,
    mobileCheckEnabled: text(mobileRaw).trim() === '1',
    email: text(record.email),
    authLevel: /^\d+$/.test(authLevelText) ? Number.parseInt(authLevelText, 10) : 0,
    // Unknown security flags must never behave as "off": callers block submission when this is false.
    known: googleKnown && mobileKnown,
  }
}

/**
 * The server returns either an absolute explorer URL (`txidAddr`) or nothing. Only `http(s)`
 * values are adopted so a hostile payload cannot inject a `javascript:` link.
 */
export function safeExplorerUrl(value: string): string {
  const raw = value.trim()
  if (raw === '') {
    return ''
  }
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}
