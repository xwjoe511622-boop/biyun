import { i18n } from '@/i18n/composer'
import type { App } from 'vue'
import { isApiError } from './errors'
import { toastError } from './toast'
import { describeApiError } from '@/modules/api/error-codes'

/**
 * Global "no dead end" safety net (owner 2026-10-01: 「用户的操作千奇百怪，前端务必做好优化，防止类似卡壳情况」).
 *
 * Callers still own their errors: an action that catches its failure shows its own toast / inline text. What reaches
 * here is what nobody handled — a rejected promise without a catch, or an exception thrown while rendering or in an
 * event handler. Before, those vanished into the console and the user saw a button that "did nothing". Now:
 * - an unhandled `ApiError` (non-zero code, HTTP, timeout, network) is toasted with `describeApiError` (the localised
 *   text for its product + code, else the server / transport message);
 * - any other unhandled error is logged and toasted as a generic "the page hit an error" line with its message;
 * - a request the page cancelled itself (`kind: 'aborted'`), and an expired session (`unauthorized`, which the session
 *   layer already turns into the login prompt), are not toasted;
 * - the same text within `REPEAT_WINDOW_MS` is shown once (a failing poll must not flood the screen).
 */

export const REPEAT_WINDOW_MS = 10_000
const lastShown = new Map<string, number>()

function isZh(): boolean {
  if (typeof document === 'undefined') return true
  return (document.documentElement.lang || 'zh').toLowerCase().startsWith('zh')
}

/** The text to show for an error nobody handled, or null when it must stay silent. */
export function unhandledMessage(reason: unknown): string | null {
  if (isApiError(reason)) {
    if (reason.kind === 'aborted' || reason.kind === 'unauthorized') return null
    // Localised by (product, code) with sub-reasons, else the server / transport message (2026-10-01).
    const text = describeApiError(reason, i18n.global.t('siteError.enUs')).trim()
    if (text !== '') return text
    return i18n.global.t('siteError.requestFailed', { kind: reason.code || reason.kind })
  }
  if (reason instanceof DOMException && reason.name === 'AbortError') return null
  const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  // Chunk load after a deploy: the old bundle's lazy files are gone; a reload fixes it.
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(detail)) {
    return i18n.global.t('siteError.theSiteWasUpdatedReloadThePageAndTry')
  }
  const prefix = i18n.global.t('siteError.somethingWentWrongRetryOrReloadThePage')
  return detail === '' ? prefix : `${prefix}（${detail.slice(0, 160)}）`
}

/** Log + toast an unhandled error (deduplicated). Returns the text shown, or null. */
export function reportUnhandled(reason: unknown, source: string, now: number = Date.now()): string | null {
  // Always keep the full error in the console for support.
  console.error(`[unhandled:${source}]`, reason)
  const text = unhandledMessage(reason)
  if (text === null) return null
  const last = lastShown.get(text)
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return null
  lastShown.set(text, now)
  toastError(text, `unhandled:${text}`)
  return text
}

/** Tests: forget the dedupe window. */
export function resetSafetyNet(): void {
  lastShown.clear()
}

export function installSafetyNet(app: App): void {
  app.config.errorHandler = (error, _instance, info) => {
    reportUnhandled(error, `vue:${info}`)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (event) => {
      if (reportUnhandled(event.reason, 'promise') !== null || unhandledMessage(event.reason) === null) event.preventDefault()
    })
    window.addEventListener('error', (event) => {
      // Resource load errors (img/script) have no `error`; only report script exceptions.
      if (event.error !== undefined && event.error !== null) reportUnhandled(event.error, 'window')
    })
  }
}
