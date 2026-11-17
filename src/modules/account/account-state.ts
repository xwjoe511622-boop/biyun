/**
 * Pure helpers for account bindings (email / phone) and API keys.
 *
 * Every rule below is copied from the legacy PC client and cross-checked against the current
 * `exchange-web-api` controllers so the rebuilt panels do not invent validation, permissions or
 * factor requirements:
 * - IPv4 rule: `vuex/regExp.js` `ip` (`^((25[0-5]|2[0-4]\d|[01]?\d\d?)($|(?!\.$)\.)){4}$`)
 * - comma-separated allowlist: `common-mixin/personal/APImanagement` `dealIp` (max 5 entries)
 * - email presence rule: `vuex/regExp.js` `email` (`/@+/`, the exact legacy test)
 * - 6-digit code rule: `vuex/regExp.js` `verification` (`^[0-9]{6}$`)
 */

/** Legacy `regExp.ip` — a single dotted-quad IPv4 address with no trailing dot. */
export const LEGACY_IPV4_PATTERN = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)($|(?!\.$)\.)){4}$/

/** `dealIp` rejects more than five allowlist entries. */
export const MAX_API_IPS = 5

/** Legacy `regExp.email` (`/@+/`): the binding screens only require an `@`. */
export function isLegacyEmail(value: string): boolean {
  return /@+/.test(value.trim())
}

export function isValidIpv4(value: string): boolean {
  return LEGACY_IPV4_PATTERN.test(value.trim())
}

export type IpAllowlistResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'invalid' | 'tooMany' }

/**
 * Normalises the `believeIps` field exactly like the legacy `dealIp`/`inputChanges` pair:
 * blank means "no restriction", a trailing comma is tolerated, every remaining entry must be a
 * valid IPv4 and at most five addresses are allowed.
 */
export function normalizeIpAllowlist(raw: string): IpAllowlistResult {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { ok: true, value: '' }
  }
  const withoutTrailingComma = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed
  const entries = withoutTrailingComma.split(',')
  if (entries.length > MAX_API_IPS) {
    return { ok: false, reason: 'tooMany' }
  }
  const normalized: string[] = []
  for (const entry of entries) {
    const address = entry.trim()
    if (!isValidIpv4(address)) {
      return { ok: false, reason: 'invalid' }
    }
    normalized.push(address)
  }
  return { ok: true, value: normalized.join(',') }
}

/** Dial-code field (`countryCode`). The legacy screen picked one from a country list. */
export const DIAL_CODE_PATTERN = /^\+\d{1,4}$/

export function isValidDialCode(value: string): boolean {
  return DIAL_CODE_PATTERN.test(value.trim())
}

/** Legacy `regExp.phone` (`^[0-9]{7,}$`). */
export function isValidMobile(value: string): boolean {
  return /^[0-9]{7,}$/.test(value.trim())
}

const MASK_CHAR = '•'

function maskMiddle(value: string, keepHead: number, keepTail: number): string {
  const head = value.slice(0, keepHead)
  const tail = keepTail === 0 ? '' : value.slice(-keepTail)
  const hidden = Math.max(4, value.length - head.length - tail.length)
  return `${head}${MASK_CHAR.repeat(hidden)}${tail}`
}

/**
 * Masks a bound email for display next to a rebind action. A value the server already masked
 * (`t***@example.com`) is preserved verbatim so it is never double-masked.
 */
export function maskEmail(value: string): string {
  const raw = value.trim()
  if (raw === '') {
    return ''
  }
  if (raw.includes('*') || raw.includes(MASK_CHAR)) {
    return raw
  }
  const at = raw.indexOf('@')
  if (at <= 0) {
    return maskMiddle(raw, 1, 0)
  }
  const local = raw.slice(0, at)
  const domain = raw.slice(at)
  const head = local.slice(0, 1)
  const hidden = Math.max(3, Math.min(local.length - 1, 6))
  return `${head}${MASK_CHAR.repeat(hidden)}${domain}`
}

/** Masks a bound phone number for display; a server-masked value is preserved verbatim. */
export function maskMobile(value: string): string {
  const raw = value.trim()
  if (raw === '') {
    return ''
  }
  if (raw.includes('*') || raw.includes(MASK_CHAR)) {
    return raw
  }
  const digits = raw.replace(/\D/g, '')
  if (digits.length <= 4) {
    return MASK_CHAR.repeat(Math.max(1, digits.length))
  }
  return maskMiddle(raw, 3, 4)
}

/** Fixed-width mask for a newly issued API secret; never derived from the real value. */
export function maskApiSecret(): string {
  return '•••• •••• •••• ••••'
}
