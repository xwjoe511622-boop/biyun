import { translateForLocale } from '@/i18n/composer'
import { isApiError, type ApiError } from '@/core/errors'
import { Decimal, isDecimalString, isPositive, toDecString } from '@/modules/finance/decimal'
import { guardReasonText } from '@/modules/api/guard-errors'

/**
 * Plain words for `/futures-api/fapi/*` refusals (Binance codes, `{code, msg, data}`; fgw 0.4.0 order entry, 2026-10-01).
 * The shared error tables (`modules/api/error-codes`) cover the classic futures codes; until the Binance codes are
 * folded into them this module answers for errors whose path starts with `fapi/`.
 *
 * Filter refusals carry `data.filter` + bounds; they are rewritten to the guard's `data.reason` shape so the guard's
 * texts (same rules, same wording as the classic path) are reused.
 */

type Texts = string

const TEXTS: Record<string, Texts> = {
  '-2019': 'futuresRefusal.marginIsInsufficientReduceTheSizeOrLeverageOr',
  '-2021': 'futuresRefusal.theOrderWouldTriggerImmediatelyPutTheTriggerPrice',
  '-4044': 'futuresRefusal.invalidTriggerPriceType',
  '-4136': 'futuresRefusal.anEntirePositionTpSlCannotAlsoCarryA',
  '-4137': 'futuresRefusal.entirePositionCloseOnlyWorksOnAClosingMarket',
  '-2022': 'futuresRefusal.closeRejectedNoPositionToCloseOrTheSize',
  '-2027': 'futuresRefusal.exceedsTheMaximumPositionValueAtTheCurrentLeverage',
  '-4045': 'futuresRefusal.tooManyOpenOrdersCancelSomeFirst',
  '-1111': 'futuresRefusal.quantityMustBeAWholeNumberOfContracts',
  '-4003': 'futuresRefusal.quantityMustBeGreaterThan0',
  '-4001': 'futuresRefusal.priceMustBeGreaterThan0',
  '-4061': 'futuresRefusal.thePositionSideDoesNotMatchTheAccountS',
  '-1121': 'futuresRefusal.thisContractIsNotTradable',
  '-2011': 'futuresRefusal.theOrderDoesNotExistOrIsAlreadyFilled',
  '-2015': 'futuresRefusal.sessionExpiredPleaseLogInAgain',
  '-4131': 'futuresRefusal.theBestOppositePriceIsOutsideTheMarketPrice',
  '-4015': 'futuresRefusal.invalidClientOrderId',
  '-1001': 'futuresRefusal.serviceTemporarilyUnavailableTheOrderWasNotExecutedYou',
  '-1000': 'futuresRefusal.unknownServerErrorRefreshAndCheckYourOrdersBefore',
  '-1007': 'futuresRefusal.orderResultUnconfirmedDoNotResubmitRefreshingYourOrders',
}

/** Core sub-reasons (`data.reason`, docs/03-reference/error-codes.md §3a) that say more than the code. */
const REASON_TEXTS: Record<string, Texts> = {
  NO_POSITION: 'futuresRefusal.closeRejectedThereIsNoPositionOnThisSide',
  CLOSE_EXCEEDS_POSITION: 'futuresRefusal.closeRejectedTheSizeExceedsWhatIsClosableOpen',
  INSUFFICIENT_BALANCE: 'futuresRefusal.insufficientBalanceToFreezeTheMarginForThisOrder',
}

/** Binance parameter errors: a programming error on our side, shown with the server text. */
const PARAMETER_CODES = new Set(['-1100', '-1101', '-1102', '-1106', '-1115', '-1116', '-1117'])

const FILTER_TITLE: Texts = 'futuresRefusal.orderRejectedByTradingRules'

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh')
}

export function isFapiError(error: unknown): error is ApiError {
  return isApiError(error) && typeof error.path === 'string' && error.path.startsWith('fapi/')
}

/** `/fapi` filter data → the guard's `{reason, …}` shape (`guard-errors.ts`), or null. */
export function guardShape(code: string, data: unknown): Record<string, unknown> | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const filter = typeof d.filter === 'string' ? d.filter : ''
  switch (filter) {
    case 'PRICE_FILTER': {
      // Exact decimal remainder (money-precision rule): a float price / tick ratio misjudges large prices / tiny ticks.
      const price = toDecString(d.price); const tick = toDecString(d.tickSize)
      if (isDecimalString(price) && isPositive(tick) && !new Decimal(price).mod(tick).isZero()) return { ...d, reason: 'TICK_SIZE' }
      return { ...d, reason: 'PRICE_OUT_OF_BAND' }
    }
    case 'PERCENT_PRICE':
      return { ...d, reason: d.maxPrice !== undefined ? 'PRICE_TOO_HIGH' : 'PRICE_TOO_LOW' }
    case 'LOT_SIZE':
      return { ...d, reason: d.minQty !== undefined ? 'QTY_TOO_SMALL' : 'QTY_TOO_LARGE' }
    case 'MARKET_LOT_SIZE':
      return { ...d, reason: 'QTY_TOO_LARGE' }
    case 'MIN_NOTIONAL':
      return { ...d, reason: 'NOTIONAL_TOO_SMALL' }
    case 'STP':
      return { ...d, reason: 'SELF_TRADE' }
    default:
      return code === '-2010' ? { ...d, reason: 'SELF_TRADE' } : null
  }
}

/**
 * One line for a `/fapi` refusal in the UI language, or null when it is not a `/fapi` error or has no text here (the
 * caller's usual path then applies: rate limits `-1003` / 418 are described by the guard texts).
 */
export function describeFapiError(error: unknown, locale: string): string | null {
  if (!isFapiError(error)) return null
  if (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'aborted' || error.kind === 'parse') return null
  const zh = isZh(locale)
  const code = error.code
  const shaped = guardShape(code, error.data)
  if (shaped !== null) {
    const detail = guardReasonText(shaped, zh)
    if (detail !== null) return `${translateForLocale(zh ? 'zh' : 'en', FILTER_TITLE)}${zh ? '：' : ': '}${detail}`
  }
  const data = error.data !== null && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
  const reason = typeof data.reason === 'string' ? REASON_TEXTS[data.reason] : undefined
  if (reason !== undefined) return translateForLocale(zh ? 'zh' : 'en', reason)
  const entry = TEXTS[code]
  if (entry !== undefined) return translateForLocale(zh ? 'zh' : 'en', entry)
  if (PARAMETER_CODES.has(code)) return translateForLocale(zh ? 'zh' : 'en', 'futuresRefusal.invalidRequest', { message: error.message })
  return null
}
