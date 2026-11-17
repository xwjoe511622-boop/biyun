/**
 * 反手 (Binance "Reverse" on a position): close the whole position at market, then open the opposite side with the same
 * size at market. The server has no atomic reverse, so the browser sends two orders (a MARKET CLOSE of the whole position, then a market
 * `order/order_create` OPEN sized by `market-open.ts` so it fills the same contracts); see `futures-account.ts`.
 */
export type ReverseStep = 1 | 2
/** `visible`: the new opposite position showed up in 持仓 before the settle window (`REVERSE_SETTLE_MS`) ran out. */
export type ReverseResult = { ok: true; visible: boolean } | { ok: false; step: ReverseStep; message: string }

/** After step 2 the positions are re-read every `REVERSE_POLL_MS` until the new position shows, for at most this long. */
export const REVERSE_SETTLE_MS = 5000
export const REVERSE_POLL_MS = 400
