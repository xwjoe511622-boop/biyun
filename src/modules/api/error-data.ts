/**
 * Refusal `data` as the error tables read it (2026-10-01). Classic futures errors come through web-api's Feign map
 * (`Map<String, List<String>>`), so `data.reason` / `data.param` arrive either as a string or as a ONE-ELEMENT LIST
 * (`{"reason":["VOLUME_NOT_INTEGER"]}`). Both become the plain string (a longer list: its first string); the same for
 * the per-id rows in `data.results`. Everything else is passed through unchanged.
 */
const SUB_REASON_KEYS = ['reason', 'param'] as const

function unwrap(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const first = value.find((entry) => typeof entry === 'string')
  return first ?? value
}

function unwrapRecord(record: Record<string, unknown>): Record<string, unknown> {
  let out = record
  for (const key of SUB_REASON_KEYS) {
    if (!(key in record)) continue
    const next = unwrap(record[key])
    if (next !== record[key]) {
      if (out === record) out = { ...record }
      out[key] = next
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeErrorData(data: unknown): unknown {
  if (!isRecord(data)) return data
  let out = unwrapRecord(data)
  if (Array.isArray(out.results)) {
    const rows = out.results.map((row) => (isRecord(row) ? unwrapRecord(row) : row))
    if (rows.some((row, index) => row !== (out.results as unknown[])[index])) out = { ...out, results: rows }
  }
  return out
}
