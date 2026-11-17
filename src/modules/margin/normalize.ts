import { canonicalDecimal, isDecimalString, toDecString } from '@/modules/finance/decimal'
import type {
  BorrowRecord,
  BorrowRecordPage,
  BorrowRule,
  MarginAccountsOverview,
  MarginSymbolAccount,
  MarginTransferPage,
  MarginTransferRecord,
  RepaymentRecord,
} from './types'

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Non-negative decimal string or `''`. Server BigDecimals arrive as JSON numbers or strings. */
export function decimalField(value: unknown): string {
  const text = canonicalDecimal(toDecString(value))
  return isDecimalString(text) ? text : ''
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }
  return fallback
}

/** Epoch milliseconds from a serialized `Date` (number or numeric string); `null` otherwise. */
export function timestampField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && /^\d{9,}$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim().replace(' ', 'T'))
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function normalizeSymbolAccount(raw: unknown): MarginSymbolAccount | null {
  if (!isRecord(raw)) return null
  const symbol = text(raw.symbol).toLowerCase()
  const baseCoin = text(raw.baseCoin).toUpperCase()
  const quoteCoin = text(raw.quoteCoin).toUpperCase()
  const name = text(raw.name) !== '' ? text(raw.name).toUpperCase() : (baseCoin !== '' && quoteCoin !== '' ? `${baseCoin}/${quoteCoin}` : '')
  if (symbol === '' && name === '') return null
  return {
    symbol: symbol !== '' ? symbol : name.replace('/', '').toLowerCase(),
    name,
    baseCoin,
    quoteCoin,
    baseNormalBalance: decimalField(raw.baseNormalBalance),
    baseLockBalance: decimalField(raw.baseLockBalance),
    baseTotalBalance: decimalField(raw.baseTotalBalance),
    baseBorrowBalance: decimalField(raw.baseBorrowBalance),
    baseCanBorrow: decimalField(raw.baseCanBorrow),
    baseTotalBorrow: decimalField(raw.baseTotalBorrow),
    baseCanTransfer: decimalField(raw.baseCanTransfer),
    baseMinBorrow: decimalField(raw.baseMinBorrow),
    baseMinPayment: decimalField(raw.baseMinPayment),
    quoteNormalBalance: decimalField(raw.quoteNormalBalance),
    quoteLockBalance: decimalField(raw.quoteLockBalance),
    quoteTotalBalance: decimalField(raw.quoteTotalBalance),
    quoteBorrowBalance: decimalField(raw.quoteBorrowBalance),
    quoteCanBorrow: decimalField(raw.quoteCanBorrow),
    quoteTotalBorrow: decimalField(raw.quoteTotalBorrow),
    quoteCanTransfer: decimalField(raw.quoteCanTransfer),
    quoteMinBorrow: decimalField(raw.quoteMinBorrow),
    quoteMinPayment: decimalField(raw.quoteMinPayment),
    baseExNormalBalance: decimalField(raw.baseExNormalBalance),
    // Server key really is `quoteEXNormalBalance` (capital EX) — LeverAccountServiceImpl.java:151/262.
    quoteExNormalBalance: decimalField(raw.quoteEXNormalBalance ?? raw.quoteExNormalBalance),
    riskRate: decimalField(raw.riskRate),
    burstPrice: decimalField(raw.burstPrice),
    rate: decimalField(raw.rate),
    multiple: decimalField(raw.multiple),
    symbolBalance: decimalField(raw.symbolBalance),
    baseReturnPrecision: integer(raw.baseReturnPrecision, 8),
    quoteReturnPrecision: integer(raw.quoteReturnPrecision, 8),
  }
}

export function normalizeAccountsOverview(raw: unknown): MarginAccountsOverview {
  const data = isRecord(raw) ? raw : {}
  const leverMap = isRecord(data.leverMap) ? data.leverMap : {}
  const accounts = Object.values(leverMap)
    .map(normalizeSymbolAccount)
    .filter((entry): entry is MarginSymbolAccount => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    totalBalance: decimalField(data.totalBalance),
    totalBalanceSymbol: text(data.totalBalanceSymbol),
    accounts,
  }
}

function normalizeBorrowRecord(raw: unknown): BorrowRecord | null {
  if (!isRecord(raw)) return null
  const id = text(raw.id)
  if (id === '') return null
  return {
    id,
    ctime: timestampField(raw.ctime),
    symbol: text(raw.symbol).toUpperCase(),
    showName: text(raw.showName),
    coin: text(raw.coin).toUpperCase(),
    borrowMoney: decimalField(raw.borrowMoney),
    status: integer(raw.status),
    interestRate: decimalField(raw.interestRate),
    oweInterest: decimalField(raw.oweInterest),
    oweAmount: decimalField(raw.oweAmount),
    interest: decimalField(raw.interest),
  }
}

function listOf(raw: unknown, key: string): unknown[] {
  if (!isRecord(raw)) return []
  const list = raw[key]
  return Array.isArray(list) ? list : []
}

function countOf(raw: unknown): number {
  return isRecord(raw) ? Math.max(0, integer(raw.count)) : 0
}

/**
 * Total of a borrow page as shown on the tab / pager. The server counts and lists in two separate queries; a repayment
 * landing between them returned the list without the repaid loan but the old count (「当前借贷(2)」 with one row,
 * QA-054). A first page that is not full holds every row, so its length is the total.
 */
export function borrowTotal(page: BorrowRecordPage, pageNo: number, pageSize: number): number {
  return pageNo === 1 && page.list.length < pageSize ? page.list.length : page.count
}

export function normalizeBorrowPage(raw: unknown): BorrowRecordPage {
  return {
    count: countOf(raw),
    list: listOf(raw, 'financeList').map(normalizeBorrowRecord).filter((entry): entry is BorrowRecord => entry !== null),
  }
}

export function normalizeRepayments(raw: unknown): RepaymentRecord[] {
  return listOf(raw, 'financeList').filter(isRecord).map(entry => ({
    repaymentTime: timestampField(entry.repaymentTime),
    coin: text(entry.coin).toUpperCase(),
    returnMoney: decimalField(entry.returnMoney),
    type: integer(entry.type),
  }))
}

export function normalizeTransferPage(raw: unknown): MarginTransferPage {
  const list: MarginTransferRecord[] = listOf(raw, 'financeList').filter(isRecord).map(entry => ({
    createTime: timestampField(entry.createTime),
    amount: decimalField(entry.amount),
    symbol: text(entry.symbol).toUpperCase(),
    showName: text(entry.showName),
    coinSymbol: text(entry.coinSymbol).toUpperCase(),
    transferType: integer(entry.transferType),
  }))
  return { count: countOf(raw), list }
}

export function normalizeBorrowRules(raw: unknown): BorrowRule[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map(entry => ({
    symbol: text(entry.symbol).toUpperCase(),
    base: text(entry.base).toUpperCase(),
    quote: text(entry.quote).toUpperCase(),
    baseMinBorrow: decimalField(entry.base_min_borrow),
    baseMinPayment: decimalField(entry.base_min_payment),
    quoteMinBorrow: decimalField(entry.quote_min_borrow),
    quoteMinPayment: decimalField(entry.quote_min_payment),
    ratePercent: decimalField(entry.rate),
    multiple: decimalField(entry.multiple),
  }))
}
