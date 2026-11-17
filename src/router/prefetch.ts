import type { RouteRecordNameGeneric } from 'vue-router'
import { useMarketStore } from '@/stores/market'

/**
 * Route-level data prefetch. Runs in `beforeEach`, i.e. while the page chunk is still downloading
 * (1–2 s through a high-latency link), so the critical request and the market socket handshake
 * overlap the chunk instead of starting after it. Everything here is deduped by the stores, so the
 * page's own bootstrap simply picks up the same promise / socket.
 */
const SPOT_MARKET_ROUTES = new Set(['home', 'markets', 'trade', 'margin', 'quick-buy'])
const FUTURES_MARKET_ROUTES = new Set(['futures'])
const FUTURES_INFO_ROUTES = new Set(['futures', 'futures-data'])

export function prefetchRouteData(name: RouteRecordNameGeneric | null | undefined): void {
  const key = typeof name === 'string' ? name : ''
  if (SPOT_MARKET_ROUTES.has(key)) {
    const market = useMarketStore()
    void market.loadPublicInfo().catch(() => undefined)
    market.warmUp()
    return
  }
  if (FUTURES_INFO_ROUTES.has(key)) {
    // Futures modules stay out of the entry chunk: the store is loaded next to the page chunk.
    void import('@/stores/futures-market').then(({ useFuturesMarketStore }) => {
      const futures = useFuturesMarketStore()
      void futures.loadPublicInfo().catch(() => undefined)
      if (FUTURES_MARKET_ROUTES.has(key)) futures.warmUp()
    }).catch(() => undefined)
  }
}
