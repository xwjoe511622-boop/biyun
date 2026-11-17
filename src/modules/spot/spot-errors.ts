import { translateForLocale } from '@/i18n/composer'
import { isApiError, type ApiError } from '@/core/errors'
import { describeGuardError, guardReasonText } from '@/modules/api/guard-errors'

/**
 * Plain words for `/api/v3` refusals (Binance codes, `{code, msg}`; fgw `spotv3.rs` `core_reject` / `map_order`).
 * Core business rejects arrive as `-2010 "Order rejected: <REASON>"` or `-1013 "Filter failure: <REASON>"`, where
 * REASON is the core's `validate.rs` / `mod.rs` reason (VOLUME_BELOW_MIN, PRICE_ABOVE_BAND …); those are translated
 * here. Rate limits (`-1003` / 429 / 418) and `-1015` fall through to the shared guard texts.
 */

type Texts = string

const TEXTS: Record<string, Texts> = {
  '-2010': 'spotRefusal.insufficientBalanceForThisOrder',
  '-1121': 'spotRefusal.thisPairIsNotTradable',
  '-2011': 'spotRefusal.theOrderIsAlreadyFilledOrCancelled',
  '-2013': 'spotRefusal.theOrderDoesNotExistOrIsAlreadyFilled',
  '-2015': 'spotRefusal.sessionExpiredPleaseLogInAgain',
  '-2014': 'spotRefusal.sessionExpiredPleaseLogInAgain',
  '-1001': 'spotRefusal.serviceTemporarilyUnavailableTheOrderWasNotExecutedYou',
  '-1000': 'spotRefusal.unknownServerErrorRefreshAndCheckYourOrdersBefore',
  '-1007': 'spotRefusal.orderResultUnconfirmedDoNotResubmitRefreshingYourOrders',
  '-1115': 'spotRefusal.thisTimeInForceIsNotSupported',
  '-1116': 'spotRefusal.thisOrderTypeIsNotSupported',
  '-1117': 'spotRefusal.invalidSide',
  '-1125': 'spotRefusal.theStreamKeyExpiredReconnecting',
}

/** Core reasons carried in the message (`Order rejected: X` / `Filter failure: X`). */
const REASON_TEXTS: Record<string, Texts> = {
  INSUFFICIENT_BALANCE: 'spotRefusal.insufficientBalanceForThisOrder',
  SYMBOL_NOT_OPEN: 'spotRefusal.thisPairIsNotOpenForTrading',
  UNKNOWN_SYMBOL: 'spotRefusal.thisPairIsNotTradable',
  TRADE_LOCKED: 'spotRefusal.tradingIsLockedOnThisAccountContactSupport',
  INVALID_ORDER_PARAM: 'spotRefusal.invalidOrderCheckThePriceAndAmount',
  PRICE_REQUIRED: 'spotRefusal.aLimitOrderNeedsAPrice',
  PRICE_ABOVE_BAND: 'spotRefusal.thePriceIsAboveTheAllowedRangeLowerIt',
  PRICE_BELOW_BAND: 'spotRefusal.thePriceIsBelowTheAllowedRangeRaiseIt',
  PRECISION: 'spotRefusal.tooManyDecimalsInThePriceOrAmountFor',
  VOLUME_BELOW_MIN: 'spotRefusal.theAmountIsBelowTheMinimumOrderSize',
  PRICE_BELOW_MIN: 'spotRefusal.thePriceIsBelowTheMinimum',
  AMOUNT_BELOW_MIN: 'spotRefusal.theOrderValueIsBelowTheMinimum',
  TIME_IN_FORCE: 'spotRefusal.thisTimeInForceIsNotSupported',
  SIDE: 'spotRefusal.invalidSide',
  ACCOUNT_TYPE_MISSING: 'spotRefusal.theAccountForThisCoinIsNotSetUp',
}

/**
 * Binance filter names (`-1013 "Filter failure: <FILTER>"`, fgw `filters.rs`): used when the refusal carries no
 * `data.reason` with bounds (建议-028: the page showed the bare 「PERCENT_PRICE_BY_SIDE」).
 */
const FILTER_TEXTS: Record<string, Texts> = {
  PRICE_FILTER: 'spotRefusal.thePriceBreaksThePriceRuleMinMaxPrice',
  PERCENT_PRICE_BY_SIDE: 'spotRefusal.thePriceIsTooFarFromTheLastPrice',
  PERCENT_PRICE: 'spotRefusal.thePriceIsTooFarFromTheMarkPrice',
  LOT_SIZE: 'spotRefusal.theQuantityBreaksTheQuantityRuleMinMaxOr',
  MARKET_LOT_SIZE: 'spotRefusal.theMarketOrderQuantityIsOutOfRange',
  NOTIONAL: 'spotRefusal.theOrderValueIsBelowTheMinimumOrAbove',
  MIN_NOTIONAL: 'spotRefusal.theOrderValueIsBelowTheMinimum2',
  MAX_NUM_ORDERS: 'spotRefusal.tooManyOpenOrdersOnThisPairCancelSome',
}

const PARAMETER_CODES = new Set(['-1100', '-1101', '-1102', '-1106'])

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh')
}

export function isSpotV3Error(error: unknown): error is ApiError {
  return isApiError(error) && typeof error.path === 'string' && error.path.startsWith('api/v3/')
}

/** `Order rejected: X` / `Filter failure: X` → X (upper snake), or null. */
export function rejectReason(message: string): string | null {
  const match = /^(?:Order rejected|Filter failure):\s*([A-Z][A-Z0-9_]*)\b/.exec(message.trim())
  return match === null ? null : (match[1] as string)
}

/**
 * One line for an `/api/v3` refusal in the UI language, or null when it is not an `/api/v3` error or has no text here
 * (the caller's `describeApiError` then applies: rate-limit and transport texts).
 */
export function describeSpotV3Error(error: unknown, locale: string): string | null {
  if (!isSpotV3Error(error)) return null
  if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'aborted' || error.kind === 'parse') return null
  const zh = isZh(locale)
  // Filter / STP refusals carry `data.reason` + bounds: rebuilt with the range and unit in the UI language (建议-028).
  if (error.code === '-1013' || error.code === '-2010') {
    const detail = guardReasonText(error.data, zh)
    const data = error.data !== null && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
    if (detail !== null) return data.reason === 'SELF_TRADE' ? describeGuardError(error, locale) : `${translateForLocale(zh ? 'zh' : 'en', 'spotRefusal.orderRejectedByTradingRules')}${detail}`
  }
  const reason = rejectReason(error.message)
  if (reason !== null) {
    const filter = FILTER_TEXTS[reason]
    if (filter !== undefined) return `${translateForLocale(zh ? 'zh' : 'en', 'spotRefusal.orderRejectedByTradingRules')}${translateForLocale(zh ? 'zh' : 'en', filter)}`
    const entry = REASON_TEXTS[reason]
    if (entry !== undefined) return translateForLocale(zh ? 'zh' : 'en', entry)
    return translateForLocale(zh ? 'zh' : 'en', 'spotRefusal.orderRejected', { reason })
  }
  if (error.code === '-1013') return translateForLocale(zh ? 'zh' : 'en', 'spotRefusal.orderRejectedByTradingRules2', { message: error.message })
  const entry = TEXTS[error.code]
  if (entry !== undefined) return translateForLocale(zh ? 'zh' : 'en', entry)
  if (PARAMETER_CODES.has(error.code)) return translateForLocale(zh ? 'zh' : 'en', 'spotRefusal.invalidRequest', { message: error.message })
  return null
}

/** The `/api/v3` answer that means "this deployment has no session-mode spot API": use the classic path. */
export function isSpotV3Unavailable(error: unknown): boolean {
  if (!isApiError(error)) return false
  if (error.kind === 'parse') return true
  if (error.status === 404 || error.status === 405 || error.status === 501) return true
  // API-key only gateway (session mode not deployed): the request carried no X-MBX-APIKEY.
  return error.code === '-2014'
}

/** `-1007` / timeout: the order may exist, never retry. */
export function isSpotV3ResultUnknown(error: unknown): boolean {
  return isSpotV3Error(error) && (error.kind === 'timeout' || error.code === '-1007')
}
