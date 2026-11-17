import { z } from 'zod'
import { parseChannel, type WsMessage } from './protocol'

const numeric = z.union([z.string().regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/), z.number().finite()])
const nonnegative = z.union([z.string().regex(/^\d+(\.\d+)?([eE][+-]?\d+)?$/), z.number().finite().nonnegative()])
const ticker = z.object({ close: numeric.optional(), open: numeric.optional(), high: numeric.optional(), low: numeric.optional(), vol: numeric.optional(), amount: numeric.optional(), rose: numeric.optional() }).passthrough()
const trade = z.object({ price: numeric, vol: numeric, ts: numeric, side: z.string().optional() }).passthrough()
const bar = z.object({ id: numeric, open: numeric, high: numeric, low: numeric, close: numeric, vol: numeric }).passthrough()
const rows = z.array(z.tuple([nonnegative, nonnegative]).rest(z.unknown())).nullable().optional()
const depth = z.union([
  z.object({ side: z.enum(['asks', 'buys']), price: nonnegative, volume: nonnegative }),
  z.object({ asks: rows, buys: rows }).passthrough().refine(value => !('side' in value) && ('asks' in value || 'buys' in value)),
])
const envelope = z.object({ channel: z.string().optional(), event_rep: z.string().optional(), ts: z.number().optional(), ping: numeric.optional(), tick: z.unknown().optional(), data: z.unknown().optional() }).passthrough()

export function validateWsMessage(input: unknown): WsMessage | null {
  const parsed = envelope.safeParse(input)
  if (!parsed.success) return null
  const message = parsed.data
  const kind = parseChannel(message.channel ?? '').kind
  let schema: z.ZodType | undefined
  let field: 'tick' | 'data' = 'tick'
  if (kind === 'ticker') schema = ticker
  if (kind === 'depth') schema = depth
  if (kind === 'trade') {
    if (message.event_rep === 'rep') { field = 'data'; schema = z.array(trade) }
    else schema = z.object({ data: z.array(trade) })
  }
  if (kind === 'kline') {
    if (message.event_rep === 'rep') { field = 'data'; schema = z.array(bar) }
    else schema = bar
  }
  if (kind === 'review') { field = 'data'; schema = z.record(z.string(), ticker) }
  if (schema !== undefined && message[field] !== undefined) {
    const payload = schema.safeParse(message[field])
    if (!payload.success) return null
    message[field] = payload.data
  }
  return message
}
