import { SPOT_V3_PREFIX } from './spot-api'

/**
 * Spot pair trading status from the public `GET /api/v3/exchangeInfo` (fgw; `status` = TRADING / BREAK from
 * `config_symbol_matching.is_open`, no cache beyond 30 s server-side). The vendor `public_info_v4` keeps a closed pair
 * listed until its own cache refreshes (10-02: AVAX/USDT still listed a few minutes after the close), and it carries no
 * open flag, so the markets list / pickers hide every pair this answer marks non-TRADING (Binance: delisted pairs are
 * not offered). One cached public GET (60 s); a failure keeps the previous answer (nothing hidden on first failure).
 */

export const STATUS_TTL_MS = 60_000

let cache: { at: number; closed: ReadonlySet<string> } | null = null
let inflight: Promise<ReadonlySet<string>> | null = null

/** Upper-case symbols (`AVAXUSDT`) whose status is not TRADING. */
export function closedFromExchangeInfo(body: unknown): Set<string> {
  const out = new Set<string>()
  const symbols = body !== null && typeof body === 'object' ? (body as { symbols?: unknown }).symbols : undefined
  if (!Array.isArray(symbols)) return out
  for (const row of symbols as Array<Record<string, unknown>>) {
    const symbol = String(row?.symbol ?? '').toUpperCase()
    const status = String(row?.status ?? '').toUpperCase()
    if (symbol !== '' && status !== '' && status !== 'TRADING') out.add(symbol)
  }
  return out
}

export async function fetchClosedSpotSymbols(now = Date.now()): Promise<ReadonlySet<string>> {
  if (cache !== null && now - cache.at < STATUS_TTL_MS) return cache.closed
  if (inflight !== null) return inflight
  inflight = (async () => {
    try {
      const response = await fetch(`${SPOT_V3_PREFIX}api/v3/exchangeInfo`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const closed = closedFromExchangeInfo(await response.json())
      cache = { at: Date.now(), closed }
      return closed
    } catch {
      return cache?.closed ?? new Set<string>()
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Tests. */
export function resetExchangeStatusCache(): void {
  cache = null
  inflight = null
}
