import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { Decimal, isPositive, toDecString } from '@/modules/finance/decimal'
import { sharedSockets, type SocketLease } from '@/modules/ws/shared-socket'
import { buildTickerRequest, tickerChannel } from '@/modules/ws/protocol'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { fetchPublicMarketInfo } from './api'
import type { FuturesContract } from './contracts'
import { FUTURES_SEQ_DEPTH_SNAPSHOT_URL } from './endpoints'
import type { BookTop } from './order-entry'

/**
 * Market data of ONE contract for a per-position action (close / 最优价 / TP-SL / reverse), whatever contract the page
 * shows. The futures page only streams its selected contract, so a BTC position acted on from the ETH page used to read
 * the ETH book, ticker and precision (09-30 owner bug: 最优价 close of BTC from ETH → 「最多一位小数」 then 「卖出平仓价不能
 * 低于 … 标记价格下限」). For the selected contract this returns the live store data; for any other contract it polls the
 * depth snapshot (`/fmd/v1/depth`, same source as the page book) and `public_market_info` (mark) every `pollMs`, and
 * subscribes that contract's ticker on the shared futures socket for the last price. `read()` fetches a fresh snapshot
 * right before an order is priced from the book.
 */
export interface ContractLevels {
  asks: { price: string; amount: string }[]
  bids: { price: string; amount: string }[]
}

const TOP_LEVELS = 5
const SNAPSHOT_LIMIT = 50

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** Book mid (best ask + best bid) / 2 as an exact decimal string (no float artifacts / exponent form); `''` unless both > 0. */
export function bookMid(ask: unknown, bid: unknown): string {
  const a = toDecString(ask)
  const b = toDecString(bid)
  return isPositive(a) && isPositive(b) ? new Decimal(a).plus(b).dividedBy(2).toFixed() : ''
}

function pairs(value: unknown): { price: string; amount: string }[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((row): row is [unknown, unknown] => Array.isArray(row) && row.length >= 2)
    .map(([price, amount]) => ({ price: String(price), amount: String(amount) }))
    .filter((row) => Number(row.price) > 0 && Number(row.amount) > 0) // float-ok: "> 0" check on a validated decimal string, boolean only (drops empty book rows)
}

/** `GET /fmd/v1/depth?symbol=e_btcusdt&limit=N` → levels best first (asks ascending, bids descending). */
export async function fetchContractLevels(wsSymbol: string, fetcher: Fetch = (url, init) => fetch(url, init)): Promise<ContractLevels> {
  const separator = FUTURES_SEQ_DEPTH_SNAPSHOT_URL.includes('?') ? '&' : '?'
  const response = await fetcher(`${FUTURES_SEQ_DEPTH_SNAPSHOT_URL}${separator}symbol=${encodeURIComponent(wsSymbol)}&limit=${SNAPSHOT_LIMIT}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`depth ${response.status}`)
  const body = JSON.parse(await response.text()) as { symbol?: unknown; asks?: unknown; bids?: unknown }
  if (typeof body.symbol === 'string' && body.symbol.toLowerCase() !== wsSymbol.toLowerCase()) throw new Error('depth symbol mismatch')
  const asks = pairs(body.asks).sort((a, b) => Number(a.price) - Number(b.price)) // float-ok: book level ordering only; the price strings are kept
  const bids = pairs(body.bids).sort((a, b) => Number(b.price) - Number(a.price)) // float-ok: book level ordering only; the price strings are kept
  return { asks, bids }
}

export function levelsTop(levels: ContractLevels): BookTop {
  return { asks: levels.asks.slice(0, TOP_LEVELS).map((row) => row.price), bids: levels.bids.slice(0, TOP_LEVELS).map((row) => row.price) }
}

export function useContractQuote(contract: () => FuturesContract | undefined, options: { pollMs?: number; fetcher?: Fetch } = {}) {
  const market = useFuturesMarketStore()
  const pollMs = options.pollMs ?? 2_000
  const isCurrent = computed(() => {
    const own = contract()
    return own !== undefined && market.currentContract?.id === own.id
  })
  const levels = shallowRef<ContractLevels>({ asks: [], bids: [] })
  const remoteMark = shallowRef('')
  const remoteLast = shallowRef('')
  let timer: ReturnType<typeof setInterval> | null = null
  let lease: SocketLease | null = null
  let leaseOff: (() => void) | null = null
  let leaseChannel = ''
  let generation = 0

  async function refresh(): Promise<ContractLevels> {
    const own = contract()
    if (own === undefined) return levels.value
    const current = ++generation
    const [book, info] = await Promise.all([
      fetchContractLevels(own.wsSymbol, options.fetcher).catch(() => null),
      fetchPublicMarketInfo(own.id).catch(() => null),
    ])
    if (current !== generation) return levels.value
    if (book !== null) levels.value = book
    if (info !== null && info.tagPrice !== '') remoteMark.value = info.tagPrice
    return levels.value
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    generation += 1
    leaseOff?.()
    leaseOff = null
    if (lease !== null && leaseChannel !== '') lease.unsubscribe(leaseChannel)
    lease?.release()
    lease = null
    leaseChannel = ''
  }

  function start(own: FuturesContract): void {
    stop()
    levels.value = { asks: [], bids: [] }
    remoteMark.value = ''
    remoteLast.value = ''
    void refresh()
    timer = setInterval(() => { void refresh() }, pollMs)
    if (market.wsConfigured && market.wsUrl !== '') {
      lease = sharedSockets.acquire(market.wsUrl)
      leaseChannel = tickerChannel(own.wsSymbol)
      const request = buildTickerRequest('sub', own.wsSymbol)
      lease.registerChannel(leaseChannel, request.params)
      leaseOff = lease.onMessage((message) => {
        const frame = message as { channel?: unknown; tick?: { close?: unknown } }
        if (frame.channel !== leaseChannel || frame.tick === undefined) return
        const close = Number(frame.tick.close) // float-ok: "> 0" presence check, the original string is stored
        if (Number.isFinite(close) && close > 0) remoteLast.value = String(frame.tick.close)
      })
    }
  }

  watch([() => contract()?.id, isCurrent], () => {
    const own = contract()
    if (own === undefined || isCurrent.value) stop()
    else start(own)
  }, { immediate: true })
  onScopeDispose(stop)

  const mark = computed(() => (isCurrent.value ? market.markPrice : remoteMark.value))
  /** Last trade price; for another contract the ticker, else the book mid until the first tick arrives. */
  const last = computed(() => {
    if (isCurrent.value) return Number(market.ticker.close) > 0 ? market.ticker.close : '' // float-ok: "> 0" presence check, the string itself is used
    if (remoteLast.value !== '') return remoteLast.value
    return bookMid(levels.value.asks[0]?.price, levels.value.bids[0]?.price)
  })
  const bookTop = computed<BookTop>(() => (isCurrent.value ? market.bookTop : levelsTop(levels.value)))
  /** Opposite-side levels (contracts) for a market-open walk. */
  const bookLevels = computed<ContractLevels>(() => (isCurrent.value
    ? { asks: market.asks.map((row) => ({ price: row.price, amount: row.amount })), bids: market.buys.map((row) => ({ price: row.price, amount: row.amount })) }
    : levels.value))

  /** Fresh top of book at submit time (live store read, or a new snapshot for another contract). */
  async function readBookTop(): Promise<BookTop> {
    if (isCurrent.value) return market.readBookTop()
    return levelsTop(await refresh())
  }
  async function readLevels(): Promise<ContractLevels> {
    if (isCurrent.value) return bookLevels.value
    return refresh()
  }

  return { isCurrent, mark, last, bookTop, bookLevels, readBookTop, readLevels }
}
