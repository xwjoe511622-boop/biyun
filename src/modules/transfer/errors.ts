import { translateForLocale } from '@/i18n/composer'
import { isApiError } from '@/core/errors'
import { describeGuardError } from '@/modules/api/guard-errors'

/**
 * User-facing text for spot ⇄ futures transfer failures and for the futures-account gate the transfer dialogs wait on.
 *
 * Incident 2026-09-29: a 现货→合约 10,000 USDT transfer showed the raw「接口返回错误码 -1」. The spot server answered
 * every pre-debit refusal of `contract/co_transfer` (spot balance too low, futures out-limits) as `{"code":"-1",
 * "msg":""}`; since the `cotransfer-msg-20260929` web-api they are coded (10034 / 105002–105004) with a message. Both
 * dialogs map the codes here, so an older server, a missing language row or an unknown code never shows a bare number.
 *
 * Stores and components resolve these keys in the caller’s language.
 */
export type TransferErrorKind =
  | 'session' /* signed out / token expired: offer 重新登录 */
  | 'pending' /* 105000: not finished, reconciled automatically — do not resubmit */
  | 'refused' /* refused before any money moved */
  | 'rate' /* rate limit */
  | 'unknownResult' /* transport failure after sending: the result is unknown */
  | 'unavailable' /* 5xx / gateway / not JSON */
  | 'other'

export interface TransferErrorView {
  kind: TransferErrorKind
  text: string
  code: string
}

type Text = string

const SESSION: Text = 'transferError.yourSessionHasExpiredPleaseLogInAgainTo'

const BY_CODE: Record<string, { kind: TransferErrorKind; text: Text }> = {
  '10002': { kind: 'session', text: SESSION },
  '110009': { kind: 'session', text: SESSION },
  '100102': { kind: 'refused', text: 'transferError.tradingIsFrozenForThisAccountNothingWasTransferred' },
  '10034': { kind: 'refused', text: 'transferError.insufficientAvailableBalanceNothingWasTransferred' },
  '105000': { kind: 'pending', text: 'transferError.transferProcessingItWillCompleteOrBeRefundedAutomatically' },
  '105001': { kind: 'refused', text: 'transferError.yourFuturesAccountIsNotReadyYetNothingWas' },
  '105002': { kind: 'refused', text: 'transferError.theTransferWasNotExecutedAndNothingMovedPlease' },
  '105003': { kind: 'refused', text: 'transferError.theAmountExceedsWhatCanCurrentlyBeMovedOut' },
  '105005': { kind: 'refused', text: 'transferError.theAmountExceedsTheFuturesTransferableAmountNothingWas' },
  '10071': { kind: 'refused', text: 'transferError.theAmountExceedsTheTransferableAmountUnrealizedProfitCannot' },
  '105004': { kind: 'refused', text: 'transferError.futuresSpotTransfersAreLimitedByTheAmountYou' },
  // Servers before cotransfer-msg-20260929: every code-less pre-debit refusal (balance too low / out-limit).
  '-1': { kind: 'refused', text: 'transferError.theTransferWasNotExecutedAndNothingMovedInsufficient' },
}

/** Per-code transfer wording, reused by the spot code table (`api/error-codes/spot.ts`) for 105000–105005. */
export const TRANSFER_CODE_TEXTS: Readonly<Record<string, Text>> = Object.fromEntries(
  Object.entries(BY_CODE).map(([code, entry]) => [code, entry.text]),
)

const UNKNOWN_RESULT: Text = 'transferError.networkProblemTheResultIsUnknownRefreshYourBalances'
const UNAVAILABLE: Text = 'transferError.theTransferServiceIsTemporarilyUnavailablePleaseTryAgain'

function pick(text: Text, locale: string): string {
  return translateForLocale(locale, text)
}

/** The http layer's placeholder for an empty server message (`empty-message.ts`); never shown as such. */
export function isPlaceholderMessage(message: string): boolean {
  const text = message.trim()
  return text === '' || /^接口返回错误码\s*-?\d*$/.test(text) || /^Request failed \(code -?\d*\)$/.test(text)
}

/** Maps a `contract/co_transfer` failure (or any error thrown around it) to one clear line. */
export function describeTransferError(error: unknown, locale: string): TransferErrorView {
  if (!isApiError(error)) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'other', code: '', text: message.trim() !== '' ? message : pick(UNAVAILABLE, locale) }
  }
  if (error.kind === 'unauthorized') return { kind: 'session', code: error.code, text: pick(SESSION, locale) }
  const known = BY_CODE[error.code]
  if (known !== undefined) return { kind: known.kind, code: error.code, text: pick(known.text, locale) }
  const guard = describeGuardError(error, locale)
  if (guard !== null) return { kind: 'rate', code: error.code, text: guard }
  if (error.kind === 'network' || error.kind === 'timeout') return { kind: 'unknownResult', code: '', text: pick(UNKNOWN_RESULT, locale) }
  if (error.kind === 'http' || error.kind === 'parse') return { kind: 'unavailable', code: error.code, text: pick(UNAVAILABLE, locale) }
  if (!isPlaceholderMessage(error.message)) return { kind: 'other', code: error.code, text: error.message }
  return { kind: 'other', code: error.code, text: translateForLocale(locale, 'transferFailure.transferFailedCodePleaseTryAgainLater', { code: error.code }) }
}

/**
 * Futures-account gate failures (`user/get_user_config`, `user/create_co_id`, `position/get_assets_list`):
 * - `session`: the spot session is gone too → 重新登录;
 * - `futuresAuth`: futures answered 10002 while the spot session is still valid (e.g. the 2026-09-29 10:15–10:18 JWT
 *   rotation window, futures checks tokens through spot `/rpc/login_info`) → retry, not a sign-out;
 * - `unavailable`: futures unreachable / restarting (5xx, 502 HTML, timeout, offline);
 * - `other`: server text, or a generic line with the code (never a bare "-1").
 */
export type GateErrorKind = 'session' | 'futuresAuth' | 'unavailable' | 'rate' | 'other'

export interface GateErrorView {
  kind: GateErrorKind
  text: string
}

const GATE: Record<Exclude<GateErrorKind, 'other' | 'rate'>, Text> = {
  session: SESSION,
  futuresAuth: 'transferError.theFuturesServiceCouldNotConfirmYourLoginPlease',
  unavailable: 'transferError.theFuturesServiceIsTemporarilyUnavailableMaintenancePleaseRetry',
}

const AUTH_UNAVAILABLE: Text = 'transferError.loginServiceTemporarilyUnavailablePleaseRetryYouAreStill'

export function describeFuturesGateError(error: unknown, locale: string, spotSignedIn: boolean): GateErrorView {
  // Not an API answer (e.g. the contract list failed to load): the service is not usable right now.
  if (!isApiError(error)) return { kind: 'unavailable', text: pick(GATE.unavailable, locale) }
  // 2026-10-01: 200013 = the futures login check itself is down (never a sign-out); 200010 = not executed, retry.
  if (error.codeNumber === 200013) return { kind: 'futuresAuth', text: pick(AUTH_UNAVAILABLE, locale) }
  if (error.codeNumber === 200010) return { kind: 'unavailable', text: pick(GATE.unavailable, locale) }
  if (error.kind === 'unauthorized' || error.code === '10002' || error.code === '110009') {
    return spotSignedIn ? { kind: 'futuresAuth', text: pick(GATE.futuresAuth, locale) } : { kind: 'session', text: pick(GATE.session, locale) }
  }
  const guard = describeGuardError(error, locale)
  if (guard !== null) return { kind: 'rate', text: guard }
  if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'http' || error.kind === 'parse') {
    return { kind: 'unavailable', text: pick(GATE.unavailable, locale) }
  }
  if (!isPlaceholderMessage(error.message)) return { kind: 'other', text: error.message }
  return { kind: 'other', text: translateForLocale(locale, 'transferFailure.theFuturesServiceReturnedAnErrorCodePleaseRetry', { code: error.code }) }
}
