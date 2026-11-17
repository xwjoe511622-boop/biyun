import { translateForLocale } from '@/i18n/composer'
/**
 * Consumer-facing formatting for the "产品与权益" pages (Earn, Launchpad, Launchpool, Vesting, Vouchers, VIP,
 * Platform coin, Affiliate, Loans). Money stays a decimal string end to end (IRON RULE, docs/00-meta/money-precision-rule.md):
 * every helper takes the lossless string from `parseBusinessJson` and only rounds for display, always ROUND_DOWN for
 * balances/amounts (never overstate what a user has) and ROUND_HALF_UP for rates.
 */
import { Decimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { textOf, valueAt, type BusinessRow } from './client'

export type Lang = 'zh' | 'en'

const DASH = '—'

/** Read a field as text (dotted paths allowed). */
export function field(row: BusinessRow, path: string): string {
  return textOf(valueAt(row, path))
}

/** Amount: grouped digits, trailing zeros trimmed, at most `dp` decimals (ROUND_DOWN). */
export function amount(value: unknown, dp = 8): string {
  const text = textOf(value)
  if (!isDecimalString(text)) return text === '' ? DASH : text
  const fixed = new Decimal(text).toDecimalPlaces(dp, Decimal.ROUND_DOWN).toFixed()
  return groupDigits(fixed)
}

/** Ratio (0.05) → "5%" / "5.25%"; `dp` decimals max (ROUND_HALF_UP), trailing zeros trimmed. */
export function percent(value: unknown, dp = 2): string {
  const text = textOf(value)
  if (!isDecimalString(text)) return DASH
  const pct = new Decimal(text).times(100).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed()
  return `${pct}%`
}

/** Fee ratio (0.001) → "0.1000%" — exchange fee tables keep four places like Binance. */
export function feeRate(value: unknown): string {
  const text = textOf(value)
  if (!isDecimalString(text)) return DASH
  return `${new Decimal(text).times(100).toFixed(4, Decimal.ROUND_HALF_UP)}%`
}

function toDate(value: unknown): Date | null {
  const text = textOf(value)
  if (text === '' || text === 'null') return null
  if (/^\d{10,13}$/.test(text)) {
    const ms = text.length === 13 ? Number(text) : Number(text) * 1000 // float-ok: epoch timestamp, not money
    return new Date(ms)
  }
  const iso = text.replace(' ', 'T')
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(iso) ? `${iso.includes('T') ? iso : iso + 'T00:00:00'}Z` : iso)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-10-16 08:30" */
export function dateTime(value: unknown): string {
  const d = toDate(value)
  if (d === null) return DASH
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
/** "2026-10-16" */
export function dateOnly(value: unknown): string {
  const d = toDate(value)
  if (d === null) return DASH
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
/** Epoch ms of a value, or null. */
export function epochMs(value: unknown): number | null {
  const d = toDate(value)
  return d === null ? null : d.getTime()
}

/** "2天 03:12:09" countdown to `target` from `now` (both epoch ms); empty when passed. */
export function countdown(target: number | null, now: number, lang: Lang): string {
  if (target === null || target <= now) return ''
  let s = Math.floor((target - now) / 1000)
  const days = Math.floor(s / 86400); s -= days * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`
  return days > 0 ? `${days}${translateForLocale(lang, 'businessTime.d')} ${clock}` : clock
}

/** Progress 0..100 of `part / whole` for bars (display only). */
export function progress(part: unknown, whole: unknown): number {
  const a = textOf(part)
  const b = textOf(whole)
  if (!isDecimalString(a) || !isDecimalString(b) || new Decimal(b).lte(0)) return 0
  const ratio = new Decimal(a).div(b).times(100)
  return Math.max(0, Math.min(100, ratio.toDecimalPlaces(1, Decimal.ROUND_DOWN).toNumber())) // float-ok: bar width only
}

export type Tone = 'up' | 'down' | 'warn' | 'muted' | 'accent' | 'info'
const STATUS: Record<string, [string, Tone]> = {
  PURCHASING: ['businessStatus.open', 'up'], END: ['businessStatus.ended', 'muted'], SOLD_OUT: ['businessStatus.soldOut', 'muted'],
  HOLDING: ['businessStatus.holding', 'up'], holding: ['businessStatus.holding', 'up'], REDEEMING: ['businessStatus.redeeming', 'warn'],
  redeeming: ['businessStatus.redeeming', 'warn'], REDEEMED: ['businessStatus.redeemed', 'muted'], redeemed: ['businessStatus.redeemed', 'muted'],
  maturing: ['businessStatus.maturing', 'warn'], matured: ['businessStatus.matured', 'muted'],
  SUCCESS: ['businessStatus.success', 'up'], success: ['businessStatus.success', 'up'], done: ['businessStatus.done', 'up'], DONE: ['businessStatus.done', 'up'],
  PENDING: ['businessStatus.processing', 'warn'], pending: ['businessStatus.processing', 'warn'], FAILED: ['businessStatus.failed', 'down'], failed: ['businessStatus.failed', 'down'],
  draft: ['businessStatus.draft', 'muted'], preview: ['businessStatus.upcoming', 'info'], snapshot: ['businessStatus.snapshot', 'info'],
  subscribing: ['businessStatus.subscribing', 'up'], calculated: ['businessStatus.calculated', 'info'], distributing: ['businessStatus.distributing', 'warn'],
  completed: ['businessStatus.completed', 'muted'], cancelling: ['businessStatus.cancelling', 'warn'], cancelled: ['businessStatus.cancelled', 'muted'],
  online: ['businessStatus.live', 'up'], ended: ['businessStatus.ended', 'muted'], closed: ['businessStatus.closed', 'muted'], stopped: ['businessStatus.paused', 'warn'],
  active: ['businessStatus.active', 'up'], ACTIVE: ['businessStatus.active2', 'up'], repaid: ['businessStatus.repaid', 'muted'], liquidated: ['businessStatus.liquidated', 'down'],
  ISSUED: ['businessStatus.readyToRedeem', 'accent'], REDEEMED_VOUCHER: ['businessStatus.redeemed2', 'up'], USED: ['businessStatus.used', 'muted'],
  EXPIRED: ['businessStatus.expired', 'muted'], expired: ['businessStatus.expired', 'muted'], ABANDONED: ['businessStatus.abandoned', 'muted'], RECLAIMED: ['businessStatus.reclaimed', 'muted'],
  more_info: ['businessStatus.moreInformationRequired', 'warn'],
  approved: ['businessStatus.approved', 'up'], rejected: ['businessStatus.rejected', 'down'], reviewing: ['businessStatus.underReview', 'warn'],
  locked: ['businessStatus.locked', 'info'], releasing: ['businessStatus.releasing', 'up'], released: ['businessStatus.fullyReleased', 'muted'], revoked: ['businessStatus.revoked', 'down'],
}
/** Status code → localized label and tone. Unknown codes are shown as-is (never hidden). */
export function status(code: unknown, lang: Lang): { label: string; tone: Tone } {
  const key = textOf(code)
  const hit = STATUS[key] ?? STATUS[key.toUpperCase()] ?? STATUS[key.toLowerCase()]
  if (hit === undefined) return { label: key === '' ? DASH : key, tone: 'muted' }
  return { label: translateForLocale(lang, hit[0]), tone: hit[1] }
}

/** True when a decimal string is > 0. */
export function positive(value: unknown): boolean {
  const text = textOf(value)
  return isDecimalString(text) && new Decimal(text).gt(0)
}
