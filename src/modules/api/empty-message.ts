import { translateForLocale } from '@/i18n/composer'
/**
 * Fallback text for business errors the server returns with an empty `msg`. The live backend is
 * missing several language-config rows (seen 2026-09-27: `otc.order.error`, `rtCmsArticleNotFind`,
 * the generic system error), so the user would otherwise see only a bare code. Wording follows the
 * server enums (`OtcMessage`, `WebApiResultType`); unknown codes keep the generic "error code N".
 */
type Namespace = 'default' | 'wallet' | 'futures' | 'otc'

const KNOWN: Record<string, string> = {
  'otc:2029': 'emptyError.orderNotFoundOrNotAccessible',
  'default:10044': 'emptyError.articleNotFound',
  'default:10001': 'emptyError.serviceTemporarilyUnavailablePleaseRetryLater',
}

export function emptyMessageFallback(api: Namespace | undefined, code: string, language: string): string {
  const message = (key: string, values?: Record<string, unknown>) => translateForLocale(language, key, values)
  const hit = KNOWN[`${api ?? 'default'}:${code}`]
  if (hit !== undefined) return translateForLocale(language, hit)
  // -1 is the vendor "exception without a code" (ExchangeException.getCode() maps 0 → -1): never show it bare
  // (2026-09-29 transfer incident). Callers with more context (the transfer dialogs) map it more precisely.
  if (code === '-1') return message('emptyError.theRequestWasNotExecutedNoReasonGivenPlease')
  return message('emptyError.requestFailedCode', { code })
}
