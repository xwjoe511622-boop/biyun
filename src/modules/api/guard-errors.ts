import { translateForLocale } from '@/i18n/composer'
import { isApiError } from '@/core/errors'
import { Decimal } from '@/modules/finance/decimal'

/**
 * Rate-limit and order-rule refusals introduced 2026-09-29 (docs/03-reference/api/rate-limits.md), shared by the spot
 * and futures order panels:
 *   -1003 (HTTP 429)  request weight / per-IP request limit
 *   -1015 (HTTP 429)  too many new orders (10 s / day window; cancels and closes are never limited)
 *   -1013 (HTTP 200)  Binance-style order filter (price band, tick, lot size, minimum value, market price protection …)
 *   -2010 (HTTP 200)  self-trade prevention: the new order would match the same account's resting order
 * The server already answers in the request language (`exchange-language`); nginx's per-IP answer gets
 * "中文 / English", so only the half matching the UI is shown. Since 2026-10-01 the guard answers English when there
 * is no language header and every refusal carries `data.reason` plus the numeric bounds (`minQty`, `tickSize`,
 * `retryAfter` …): the text is then built here in the UI language (`guardReasonText`), the server text is the fallback.
 */
export const GUARD_CODES = ['-1003', '-1015', '-1013', '-2010'] as const

export type GuardKind = 'rate' | 'orders' | 'filter' | 'stp'

export function guardKind(code: string, status?: number): GuardKind | null {
  const n = /^\s*-?\d+\s*$/.test(code) ? Number(code) : NaN // float-ok: integer error code
  if (n === -1015) return 'orders'
  if (n === -1013) return 'filter'
  if (n === -2010) return 'stp'
  if (n === -1003 || status === 429 || status === 418) return 'rate'
  return null
}

const TITLES: Record<GuardKind, string> = {
  rate: 'guardError.tooManyRequests',
  orders: 'guardError.tooManyNewOrders',
  filter: 'guardError.orderRejectedByTradingRules',
  stp: 'guardError.orderRejectedSelfTradePrevention',
}

/** Picks the Chinese or English half of a "中文 / English" message; other messages are returned unchanged. */
export function pickLanguage(message: string, locale: string): string {
  const cut = message.indexOf(' / ')
  if (cut <= 0) return message
  const zh = message.slice(0, cut).trim()
  const en = message.slice(cut + 3).trim()
  if (!/[一-鿿]/.test(zh)) return message
  return locale.toLowerCase().startsWith('zh') ? zh : en
}

type Fields = Record<string, unknown>

/** Plain decimal text of a numeric field (`1E-8` → `0.00000001`), `null` when missing / not a number. */
function num(data: Fields, key: string): string | null {
  const value = data[key]
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  try {
    const decimal = new Decimal(value)
    return decimal.isFinite() ? decimal.toFixed() : null
  } catch {
    return null
  }
}

function text(data: Fields, key: string): string | null {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The refusal detail rebuilt from `data.reason` and its numeric fields, in the UI language; `null` when the reason is
 * unknown or a field it needs is missing (the caller then shows the server text).
 */
export function guardReasonText(data: unknown, zh: boolean): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Fields
  const reason = text(d, 'reason')
  if (reason === null) return null
  const t = (key: string, values?: Record<string, unknown>) => translateForLocale(zh ? 'zh' : 'en', key, values)
  const retry = num(d, 'retryAfter')
  const retryHint = retry !== null && Number(retry) > 0 // float-ok: retry-after seconds
    ? t('guardError.retryInS', { retry })
    : t('guardError.pleaseRetryShortly')
  switch (reason) {
    case 'PRICE_OUT_OF_BAND': {
      const lo = num(d, 'minPrice'); const hi = num(d, 'maxPrice'); const ref = num(d, 'referencePrice')
      if (lo === null || hi === null) return null
      // 建议-028: the band in percent of the reference, and what to do (QA saw only 「PERCENT_PRICE_BY_SIDE」).
      const down = num(d, 'multiplierDown'); const up = num(d, 'multiplierUp')
      const pct = (m: string): string => `${new Decimal(m).times(100).toFixed()}%`
      const band = ref !== null && down !== null && up !== null ? t('guardError.ofTheLastPrice', { ref, pctdown: pct(down), pctup: pct(up) })
        : ref !== null ? t('guardError.referencePrice', { ref }) : ''
      return t('guardError.priceMustBeWithinAdjustThePrice', { lo, hi, band })
    }
    case 'PRICE_TOO_HIGH': {
      const hi = num(d, 'maxPrice'); const mark = num(d, 'markPrice')
      if (hi === null) return null
      return mark !== null
        ? t('guardError.priceTooHighAtMostMarkPrice', { hi, mark })
        : t('guardError.priceTooHighAtMost', { hi })
    }
    case 'PRICE_TOO_LOW': {
      const lo = num(d, 'minPrice'); const mark = num(d, 'markPrice')
      if (lo === null) return null
      return mark !== null
        ? t('guardError.priceTooLowAtLeastMarkPrice', { lo, mark })
        : t('guardError.priceTooLowAtLeast', { lo })
    }
    case 'TICK_SIZE': {
      const tick = num(d, 'tickSize')
      if (tick === null) return null
      return t('guardError.priceMustBeAMultipleOf', { tick })
    }
    case 'QTY_TOO_SMALL': {
      const min = num(d, 'minQty'); const contracts = num(d, 'minContracts')
      if (min === null) return null
      return contracts !== null
        ? t('guardError.quantityTooSmallAtLeastContracts', { min, contracts })
        : t('guardError.quantityTooSmallAtLeast', { min })
    }
    case 'QTY_TOO_LARGE': {
      const max = num(d, 'maxQty'); const contracts = num(d, 'maxContracts'); const notional = num(d, 'maxNotional')
      if (max === null) return null
      const extra = contracts !== null ? t('guardError.contracts', { contracts })
        : notional !== null ? t('guardError.aboutUsdt', { notional }) : ''
      return t('guardError.quantityTooLargeAtMost', { max, extra })
    }
    case 'STEP_SIZE': {
      const step = num(d, 'stepSize')
      if (step === null) return null
      return t('guardError.quantityMustBeAMultipleOf', { step })
    }
    case 'NOTIONAL_TOO_SMALL': {
      const min = num(d, 'minNotional'); const now = num(d, 'notional')
      if (min === null) return null
      return now !== null
        ? t('guardError.orderValueTooSmallAtLeastUsdtThisOrder', { min, now })
        : t('guardError.orderValueTooSmallAtLeastUsdt', { min })
    }
    case 'NOTIONAL_TOO_LARGE': {
      const max = num(d, 'maxNotional'); const now = num(d, 'notional')
      if (max === null) return null
      return now !== null
        ? t('guardError.orderValueTooLargeAtMostUsdtThisOrder', { max, now })
        : t('guardError.orderValueTooLargeAtMostUsdt', { max })
    }
    case 'MARKET_PRICE_PROTECTION': {
      const cap = num(d, 'maxWithinRange'); const edge = num(d, 'limitPrice'); const unit = text(d, 'unit') ?? ''
      if (cap === null) return null
      return (edge !== null
        ? t('guardError.marketPriceProtectionAtMostCanTradeWithinReduce', { edge, cap, unit })
        : t('guardError.marketPriceProtectionAtMostCanTradeReduceThe', { cap, unit })).replace(/ ，/g, '，').replace(/ {2}/g, ' ')
    }
    case 'SELF_TRADE': {
      const own = num(d, 'ownOrderPrice')
      return own !== null
        ? t('guardError.theNewOrderWouldMatchYourOwnRestingOrder', { own })
        : t('guardError.theNewOrderWouldMatchYourOwnRestingOrder2')
    }
    case 'TOO_MANY_OPEN_ORDERS': {
      const max = num(d, 'maxNumOrders')
      return max !== null
        ? t('guardError.tooManyOpenOrdersOnThisSymbolMaxCancel', { max })
        : t('guardError.tooManyOpenOrdersOnThisSymbolCancelSome')
    }
    case 'BANNED':
      return retry !== null
        ? t('guardError.temporarilyBannedAfterRepeatedRateLimitHitsForS', { retry })
        : t('guardError.temporarilyBannedAfterRepeatedRateLimitHitsCancelsAnd')
    case 'REQUEST_WEIGHT': {
      const limit = num(d, 'limit')
      return limit !== null
        ? t('guardError.requestWeightLimitPerMinute', { limit, retryHint })
        : t('guardError.requestWeightLimitReached', { retryHint })
    }
    case 'ORDERS_10S': {
      const limit = num(d, 'limit')
      return limit !== null
        ? t('guardError.atMostNewOrdersPer10SecondsCancelsAnd', { limit, retryHint })
        : t('guardError.tooManyNewOrdersIn10SecondsCancelsAnd', { retryHint })
    }
    case 'ORDERS_1D': {
      const limit = num(d, 'limit')
      return limit !== null
        ? t('guardError.atMostNewOrdersPerDayCancelsAndCloses', { limit, retryHint })
        : t('guardError.dailyNewOrderLimitReachedCancelsAndClosesAre', { retryHint })
    }
    default:
      return null
  }
}

/**
 * A clear one-line text for a guard refusal, or null when the error is something else (callers keep their own text).
 * Example (zh): "下单过于频繁：每 10 秒最多 20 笔新订单，请 1 秒后再试（撤单、平仓不受限）".
 */
export function describeGuardError(error: unknown, locale: string): string | null {
  if (!isApiError(error)) return null
  const kind = guardKind(error.code, error.status)
  if (kind === null) return null
  const zh = locale.toLowerCase().startsWith('zh')
  const title = translateForLocale(locale, TITLES[kind])
  const rebuilt = guardReasonText(error.data, zh)
  if (rebuilt !== null) return `${title}${zh ? '：' : ': '}${rebuilt}`
  let text = pickLanguage(error.message ?? '', locale)
    .replace(/^Filter failure: [A-Z_]+\.\s*/, '')
    .replace(/^Order rejected \(self-trade prevention\)\.\s*/, '')
  if (text === '' || /^HTTP 429/.test(text)) {
    text = translateForLocale(locale, 'guardError.pleaseRetryInAMoment')
  }
  if (text.startsWith(title)) return text
  return `${title}${zh ? '：' : ': '}${text}`
}
