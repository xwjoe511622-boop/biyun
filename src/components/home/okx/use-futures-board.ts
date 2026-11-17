import { computed, onBeforeUnmount, onMounted, shallowRef, type ComputedRef } from 'vue'
import { canonicalDecimal, groupDigits, isDecimalString, toDecString } from '@/modules/finance/decimal'
import { compactDecimal, percentView, type PercentView } from '@/modules/finance/display'
import { futuresTurnover } from '@/modules/futures/math'
import type { FuturesContract } from '@/modules/futures/contracts'
import { REVIEW_CHANNEL, buildReviewRequest, parseChannel, type TickerTick, type WsMessage } from '@/modules/ws/protocol'
import { sharedSockets, type SocketLease } from '@/modules/ws/shared-socket'
import { useFuturesMarketStore } from '@/stores/futures-market'

/** One USDT-margined perpetual as the home board shows it. Every figure is a server value or `--`. */
export interface BoardRow {
  contract: FuturesContract
  /** `BTC`, `XAUT`, `NVDA` … */
  base: string
  kind: 'crypto' | 'gold' | 'stock'
  last: string
  change: PercentView
  turnover: string
  maxLever: string
}

interface TickSnapshot {
  close: string
  rose: string
  amount: string
}

const GOLD = new Set(['XAUT', 'PAXG', 'XAU'])
const STOCKS = new Set(['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'COIN', 'MSTR'])

export function contractKind(base: string): BoardRow['kind'] {
  const upper = base.toUpperCase()
  if (GOLD.has(upper)) return 'gold'
  if (STOCKS.has(upper)) return 'stock'
  return 'crypto'
}

/**
 * Home-page view of the perpetual market: the contract list (`common/public_info`) plus the futures
 * `review` channel (all contracts' 24h tickers) on a lease of the tab-wide futures socket. Nothing
 * else is subscribed. Missing data renders as `--`; the lease is returned on unmount.
 */
export function useFuturesBoard(): { rows: ComputedRef<BoardRow[]>; live: ComputedRef<boolean> } {
  const futures = useFuturesMarketStore()
  const ticks = shallowRef<Record<string, TickSnapshot>>({})
  let lease: SocketLease | null = null
  let offs: (() => void)[] = []
  let disposed = false

  function read(value: unknown): string {
    return canonicalDecimal(toDecString(value))
  }

  function onMessage(message: WsMessage): void {
    if (parseChannel(message.channel ?? '').kind !== 'review') return
    const payload = message.data ?? message.tick
    if (payload === null || typeof payload !== 'object') return
    const next = { ...ticks.value }
    Object.entries(payload as Record<string, TickerTick>).forEach(([key, tick]) => {
      if (tick === null || typeof tick !== 'object') return
      next[key.toLowerCase()] = { close: read(tick.close), rose: read(tick.rose), amount: read(tick.amount) }
    })
    ticks.value = next
  }

  function connect(): void {
    if (disposed || lease !== null || !futures.wsConfigured) return
    const active = sharedSockets.acquire(futures.wsUrl)
    lease = active
    offs = [active.onMessage(onMessage)]
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('req').params, 'req')
    active.registerChannel(REVIEW_CHANNEL, buildReviewRequest('sub').params)
  }

  onMounted(async () => {
    try {
      await futures.loadPublicInfo()
    } catch {
      // No contract list: the board renders nothing rather than invented rows.
    }
    connect()
  })

  onBeforeUnmount(() => {
    disposed = true
    offs.forEach((off) => off())
    offs = []
    lease?.release()
    lease = null
  })

  const rows = computed<BoardRow[]>(() =>
    [...futures.contracts]
      .sort((left, right) => left.sort - right.sort)
      .map((contract) => {
        const tick = ticks.value[contract.wsSymbol]
        const close = tick?.close ?? ''
        const dp = Math.min(Math.max(contract.pricePrecision, 0), 8)
        const turnover = tick === undefined ? '' : futuresTurnover(tick.amount, contract.multiplier)
        return {
          contract,
          base: contract.base.toUpperCase(),
          kind: contractKind(contract.base),
          last: isDecimalString(close) ? groupDigits(close, dp) : '--',
          change: tick === undefined || tick.rose === '' ? { text: '--', direction: 'flat' } : percentView(tick.rose),
          turnover: turnover === '' ? '--' : compactDecimal(turnover),
          maxLever: contract.maxLever > 0 ? `${contract.maxLever}x` : '--',
        }
      }),
  )
  const live = computed(() => Object.keys(ticks.value).length > 0)
  return { rows, live }
}
