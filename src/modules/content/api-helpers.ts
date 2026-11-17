import { z } from 'zod'
import { ApiError, isApiError } from '@/core/errors'

/**
 * Shared zod helpers for the content / account-service API modules. Each module validates its own
 * response with `parseWith`, so a contract drift surfaces as an honest `parse` error listing the
 * mismatched field paths (never the values, which may be account data).
 */

/** Numeric or string id -> string. */
export const idText = z.union([z.string().min(1), z.number().int().safe()]).transform(String)

/** Optional text; numbers are stringified, null/undefined become ''. */
export const text = z
  .union([z.string(), z.number(), z.boolean()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? '' : String(value)))

/** Optional non-negative integer count (server sends number or numeric string). */
export const count = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .nullish()
  .transform((value) => (value === null || value === undefined ? 0 : Number(value))) // float-ok: integer count

/** Decimal-ish value kept as a display string (never used for maths here). */
export const decimalText = z
  .union([z.string(), z.number().finite()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? '' : String(value).trim()))

/** Array that the server may send as `null`. */
export function list<T extends z.ZodType>(item: T) {
  return z.array(item).nullish().transform((value) => value ?? [])
}

export function contractError(path: string, fields: string): ApiError {
  return new ApiError({ kind: 'parse', code: '', path, message: `API contract mismatch: ${path} [${fields}]` })
}

export function parseWith<S extends z.ZodType>(schema: S, path: string, data: unknown): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')
    throw contractError(path, fields)
  }
  return result.data
}

/** Human-readable error text from an unknown failure (server message preserved). */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.kind === 'unauthorized'
}

/**
 * Formats a server timestamp (epoch ms / s as number or numeric string, or an already formatted
 * string) for display. Unknown values render as `--`; formatted strings are returned untouched.
 */
export function formatDateTime(value: unknown, locale: string, withTime = true): string {
  if (value === null || value === undefined || value === '') return '--'
  let ms: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) ms = value
  else if (typeof value === 'string' && /^\d{10,13}$/.test(value.trim())) ms = Number(value.trim()) // float-ok: epoch timestamp
  if (ms === null) return typeof value === 'string' ? value : '--'
  if (ms < 1e12) ms *= 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '--'
  const options: Intl.DateTimeFormatOptions = withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }
  return new Intl.DateTimeFormat(locale, options).format(date)
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0 || total <= 0) return 1
  return Math.max(1, Math.ceil(total / pageSize)) // float-ok: pagination
}
