import { isApiError } from '@/core/errors'
import { newRequestId } from './internal-transfer.api'

/**
 * Client `requestId` for money writes whose server derives the core idempotency key from it (user-api 2026-10-16:
 * margin borrow / repay / transfer, OTC transfer; optional body field `^[A-Za-z0-9_-]{8,64}$`, an older server
 * ignores it). Same requestId + same parameters = the same operation: a retry after a lost answer moves nothing twice.
 *
 * One id per user submission of a draft:
 * - re-submitting the same draft (same fingerprint) after an uncertain outcome reuses the id;
 * - editing the draft (amount / coin / pair / direction → a different fingerprint) gets a new id;
 * - a definite outcome (success, or a refusal the server answered) settles it, so the next submission is new.
 * Same pattern as `WithdrawPanel.vue` / `isDefinitiveCreateRejection`.
 */
export class DraftRequestId {
  private id = ''
  private fingerprint = ''

  /** The id for this draft (`fingerprint` = the operation's parameters). */
  forDraft(fingerprint: string): string {
    if (this.id === '' || this.fingerprint !== fingerprint) {
      this.id = newRequestId()
      this.fingerprint = fingerprint
    }
    return this.id
  }

  /** After a definite outcome: the next submission gets a fresh id. */
  settle(): void {
    this.id = ''
    this.fingerprint = ''
  }

  /** Applies the rule to a finished attempt: `error` undefined = success. */
  finish(error?: unknown): void {
    if (error === undefined || !isUncertainOutcome(error)) this.settle()
  }
}

/**
 * True when the server may have executed the request although no definite answer arrived (transport failure,
 * timeout, 5xx, unreadable answer, unknown error): the same id must be reused for a retry. A business refusal
 * (`api`), an expired session or a 4xx is definite.
 */
export function isUncertainOutcome(error: unknown): boolean {
  if (!isApiError(error)) return true
  if (error.kind === 'api' || error.kind === 'unauthorized') return false
  if (error.kind === 'http') return error.status === undefined || error.status >= 500
  return true
}
