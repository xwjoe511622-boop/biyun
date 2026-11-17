/** Error taxonomy used by the UI so real server status is never replaced by a fake success. */

export type ApiErrorKind =
  | 'api' /* HTTP 200 with a non-zero business code */
  | 'http' /* non-2xx HTTP status */
  | 'network' /* fetch rejected: DNS, TLS, offline, CORS */
  | 'timeout'
  /* the caller cancelled the request (its AbortSignal): not a failure to show */
  | 'aborted'
  | 'parse'
  | 'unauthorized'

/**
 * Which backend answered (2026-10-01 error-code localisation): spot and futures reuse the same numbers for different
 * causes (futures 10001 = insufficient balance, spot 10001 = system error), so a code is only meaningful together with
 * its product. Decided by the API namespace the request went to (`futures` → futures, `otc` → otc, everything else —
 * `/fe-ex-api/`, the wallet gateway, uploads — spot).
 */
export type ApiProduct = 'spot' | 'futures' | 'otc'

export interface ApiErrorDetails {
  kind: ApiErrorKind
  /** Business code as returned by the server (`"0"` means success and is never an error). */
  code: string
  /** Server message when available; otherwise a transport-level description. */
  message: string
  status?: number
  path?: string
  /** Response `data` of the refusal (sub-reasons: `reason`, `param`, filter bounds, per-id results …). */
  data?: unknown
  /** Backend that answered; defaults to `spot`. */
  product?: ApiProduct
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly code: string
  readonly status?: number
  readonly path?: string
  readonly data?: unknown
  readonly product: ApiProduct

  constructor(details: ApiErrorDetails) {
    super(details.message)
    this.name = 'ApiError'
    this.kind = details.kind
    this.code = details.code
    this.status = details.status
    this.path = details.path
    this.data = details.data
    this.product = details.product ?? 'spot'
  }

  /** The business code as a number (`null` when there is none). Codes travel as JSON strings ("10018"). */
  get codeNumber(): number | null {
    return codeNumber(this.code)
  }

  /** True when the request most likely did not reach the exchange API. */
  get isTransportFailure(): boolean {
    return this.kind === 'network' || this.kind === 'timeout'
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** `Number(code)` for a business code string, `null` for '' or anything that is not an integer. */
export function codeNumber(code: string | number | null | undefined): number | null {
  if (code === null || code === undefined) return null
  const text = String(code).trim()
  if (!/^-?\d+$/.test(text)) return null
  return Number(text) // float-ok: integer error code
}

/** True when `error` is an `ApiError` whose code equals `code` numerically ("010018" / 10018 / "10018"). */
export function hasCode(error: unknown, code: number): boolean {
  return isApiError(error) && error.codeNumber === code
}
