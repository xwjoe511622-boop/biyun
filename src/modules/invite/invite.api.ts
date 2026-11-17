import { z } from 'zod'
import { request } from '@/modules/api/http'
import { add, isDecimalString, toDecString } from '@/modules/finance/decimal'
import { count, decimalText, parseWith, text } from '@/modules/content/api-helpers'

/**
 * Referral dashboard.
 *
 * - `ReturnAndDividendAct.java:318-393` `return/invite_info_list` body `{page, pageSize}` (login required) ->
 *   `{coin, id, inviteCode, inviteUrl, inviteQECode, invite_number, invite_list:[{invitee, register_time}],
 *   invite_return_number}`. `invite_list` is the empty string `""` (not `[]`) when nobody was invited.
 *   `invite_return_number` sums settled invite rebates (`stats_dividend_hour` type 3) in `coin`.
 * - Invite link: the server builds `base_url + "/register?inviteCode=" + code` (`PublicAct.java:2300-2303`),
 *   where `base_url` is the legacy site. This client builds the same query against its own origin, and
 *   its register page reads `inviteCode` and submits it as `invitedCode` (`RegisterView.vue:464-466`).
 * - `invite_return_number` above is the legacy platform-coin mining total and stays 0 on Longbit. Referral rebates
 *   are paid by the longbit-referral-rebate job (hourly) and listed by `UserInviteCodeAct.bonusList`
 *   (`GET invite_code/bonusList`, login required): `exchange.transaction_branch_bonus` rows with `pid` = me —
 *   `{id, uid (invitee), pid, roleId (0 spot incl. margin, 1 USDT-M futures), symbol (rebate coin = fee coin),
 *   feeSymbol, fee, scale (rate %), amount, ctime (epoch ms), email/phoneNumber (masked invitee)}`. The server
 *   ignores the paging parameters (legacy bug: only `limitEnd` is set, so no LIMIT) and returns every row
 *   unsorted, so this client sorts, totals per coin and pages locally.
 */
export const INVITE_ENDPOINTS = {
  info: 'return/invite_info_list',
  rebates: 'invite_code/bonusList',
} as const

export interface Invitee {
  account: string
  /** Epoch ms or null. */
  registeredAt: number | null
}

export interface InviteInfo {
  inviteCode: string
  coin: string
  invitedCount: number
  rebateTotal: string
  invitees: Invitee[]
}

const epoch = z
  .union([z.number().finite(), z.string().regex(/^\d+$/)])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : Number(value))) // float-ok: epoch timestamp
const invitee = z.object({ invitee: text, register_time: epoch }).passthrough()
const infoSchema = z
  .object({
    coin: text,
    inviteCode: text,
    invite_number: count,
    invite_return_number: decimalText,
    invite_list: z
      .union([z.array(invitee), z.literal(''), z.null(), z.undefined()])
      .transform((value) => (Array.isArray(value) ? value : [])),
  })
  .passthrough()

export async function fetchInviteInfo(page: number, pageSize: number, signal?: AbortSignal): Promise<InviteInfo> {
  const data = await request<unknown>(INVITE_ENDPOINTS.info, { body: { page, pageSize }, signal })
  const parsed = parseWith(infoSchema, INVITE_ENDPOINTS.info, data)
  return {
    inviteCode: parsed.inviteCode.trim(),
    coin: parsed.coin,
    invitedCount: parsed.invite_number,
    rebateTotal: toDecString(parsed.invite_return_number),
    invitees: parsed.invite_list.map((row) => ({ account: row.invitee, registeredAt: row.register_time })),
  }
}

export type RebateMarket = 'spot' | 'futures'

export interface RebateRecord {
  id: string
  market: RebateMarket
  /** Masked invitee (e-mail / phone as masked by the server job), never the plain address. */
  invitee: string
  coin: string
  fee: string
  /** Rebate rate in percent, e.g. "20". */
  ratePct: string
  amount: string
  /** Epoch ms or null. */
  time: number | null
}

export interface RebateSummary {
  records: RebateRecord[]
  /** Per-coin totals, coins sorted alphabetically, amounts as plain decimal strings. */
  totals: Array<{ coin: string; amount: string }>
}

const amount = z.union([z.string(), z.number().finite()]).nullish().transform((value) => toDecString(value))
const rebateRow = z
  .object({
    id: z.union([z.string().min(1), z.number().int().safe()]).transform(String),
    uid: z.union([z.string(), z.number()]).nullish(),
    roleId: z.union([z.number().int(), z.string()]).nullish(),
    symbol: text,
    fee: amount,
    scale: amount,
    amount,
    ctime: epoch,
    email: text,
    phoneNumber: text,
  })
  .passthrough()
const rebatesSchema = z.array(rebateRow).nullish().transform((value) => value ?? [])

function maskedInvitee(row: z.output<typeof rebateRow>): string {
  const email = row.email.trim()
  if (email !== '' && (email.includes('*') || email.startsWith('uid '))) return email
  const phone = row.phoneNumber.trim()
  if (phone !== '' && phone.includes('*')) return phone
  // Never show an unmasked address even if a row was back-filled by the admin page.
  return row.uid === null || row.uid === undefined ? '--' : `UID ${String(row.uid)}`
}

export function summarizeRebates(rows: z.output<typeof rebatesSchema>): RebateSummary {
  const records: RebateRecord[] = rows.map((row) => ({
    id: row.id,
    market: String(row.roleId ?? '0') === '1' ? 'futures' : 'spot',
    invitee: maskedInvitee(row),
    coin: row.symbol.trim().toUpperCase(),
    fee: row.fee,
    ratePct: row.scale,
    amount: row.amount,
    time: row.ctime,
  }))
  records.sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || Number(b.id) - Number(a.id)) // float-ok: timestamp / id ordering
  const byCoin = new Map<string, string>()
  for (const record of records) {
    if (record.coin === '' || !isDecimalString(record.amount)) continue
    byCoin.set(record.coin, add(byCoin.get(record.coin) ?? '0', record.amount))
  }
  const totals = [...byCoin.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([coin, total]) => ({ coin, amount: total }))
  return { records, totals }
}

export async function fetchRebates(signal?: AbortSignal): Promise<RebateSummary> {
  const data = await request<unknown>(`${INVITE_ENDPOINTS.rebates}?pages=1&pageSize=1000`, { method: 'GET', signal })
  return summarizeRebates(parseWith(rebatesSchema, INVITE_ENDPOINTS.rebates, data))
}

/** Invite codes are server-generated alphanumerics; anything else is refused rather than encoded. */
export function isValidInviteCode(code: string): boolean {
  return /^[A-Za-z0-9]{1,32}$/.test(code)
}

/**
 * `${origin}${base}register?inviteCode=CODE`. Returns '' for an invalid code or a non-http(s) origin so a
 * malformed value can never produce a link or QR code.
 */
export function buildInviteLink(origin: string, code: string, basePath = '/'): string {
  const trimmed = code.trim()
  if (!isValidInviteCode(trimmed)) return ''
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return ''
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
  const base = basePath.startsWith('/') ? basePath : `/${basePath}`
  const prefix = base.endsWith('/') ? base : `${base}/`
  const link = new URL(`${prefix}register`, url.origin)
  link.searchParams.set('inviteCode', trimmed)
  return link.href
}
