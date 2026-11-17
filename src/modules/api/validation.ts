import { z } from 'zod'
import { ENDPOINTS } from '@/config/endpoints'
import { ApiError } from '@/core/errors'
import { toDecString } from '@/modules/finance/decimal'

const optionalText = z.string().nullish().transform(value => value ?? undefined)
const decimal = z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().finite().nonnegative()]).transform(toDecString)
const optionalDecimal = decimal.optional()
const object = z.record(z.string(), z.unknown())
const symbol = z.object({
  symbol: z.string().min(1), name: z.string().min(1),
  price: z.number().int().min(0).max(30), volume: z.number().int().min(0).max(30), depth: z.string(),
}).passthrough()
const balance = z.object({
  normal_balance: optionalDecimal, lock_balance: optionalDecimal,
  total_balance: optionalDecimal,
  overcharge_balance: z.preprocess(value => value === '' ? undefined : value, optionalDecimal),
}).passthrough()
const order = z.object({
  id: z.union([z.string().min(1), z.number().int().safe()]).transform(String),
  side: z.string(), status: z.number().int(), type: z.number().int(),
  price: optionalDecimal, volume: optionalDecimal, deal_volume: optionalDecimal,
  remain_volume: optionalDecimal, total_price: optionalDecimal,
}).passthrough()
const orders = z.object({ count: z.number().int().nullable().optional(), orderList: z.array(order).nullable().optional() })
const trades = z.object({ count: z.number().int().nullable().optional(), trade_list: z.array(z.object({
  id: z.union([z.string(), z.number().int().safe()]), price: decimal, volume: decimal,
}).passthrough()).nullable().optional() })
const balances = z.object({ totalBalance: optionalDecimal, allCoinMap: z.record(z.string(), balance) }).passthrough()

export const envelopeSchema = z.object({
  code: z.union([z.string(), z.number().int()]), msg: z.string().nullish(), data: z.unknown().optional(),
}).passthrough()

const schemas: Record<string, z.ZodType> = {
  [ENDPOINTS.publicInfo]: z.object({
    msg: z.object({ company_name: optionalText, logoUrl: optionalText, iconUrl: optionalText, contact_email: optionalText }).passthrough(),
    nc: z.object({ nc_appkey: optionalText, nc_prefix: optionalText, nc_lang: optionalText }).optional(),
    market: z.object({
      market: z.record(z.string(), z.record(z.string(), symbol)),
      coinList: z.record(z.string(), object), wsUrl: optionalText,
    }).passthrough(),
  }).passthrough(),
  [ENDPOINTS.accountBalance]: balances,
  [ENDPOINTS.accountBalanceV5]: balances,
  [ENDPOINTS.openOrders]: orders,
  [ENDPOINTS.historyOrders]: orders,
  [ENDPOINTS.myTrades]: trades,
  [ENDPOINTS.tradesByOrder]: trades,
  // cookie mode (10-17): `{ type, session: "cookie" }`, the challenge is the HttpOnly cookie; older servers answer `token`
  [ENDPOINTS.login]: z.object({
    token: z.string().min(1).optional(),
    session: z.literal('cookie').optional(),
    type: z.union([z.string(), z.number()]).transform(String),
  }).refine((d) => d.session === 'cookie' || d.token !== undefined, { message: 'login challenge missing' }),
  [ENDPOINTS.confirmLogin]: object.nullable(),
  [ENDPOINTS.userInfo]: object,
  [ENDPOINTS.coinIntro]: z.array(z.object({
    id: z.number().int(), coinSymbol: optionalText, introduction: optionalText,
    officialUrl: optionalText, blockchainUrl: optionalText,
  }).passthrough()),
}

export function validateData<T>(path: string, data: unknown): T {
  const schema = schemas[path]
  if (schema === undefined) return data as T
  const result = schema.safeParse(data)
  if (!result.success) {
    // Field paths are useful for diagnosis; never include returned account values or tokens.
    const fields = result.error.issues.map(issue => issue.path.join('.')).join(', ')
    throw new ApiError({ kind: 'parse', code: '', path, message: `API contract mismatch: ${path} [${fields}]` })
  }
  return result.data as T
}
