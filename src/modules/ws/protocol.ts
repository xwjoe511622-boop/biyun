/**
 * Market WebSocket protocol, reverse-engineered from the legacy PC worker
 * (`app/view/src/components/BlockChain-ui-privatization/websocket/websocket.js`).
 *
 * Framing: every frame is a zlib deflate stream decoded with `pako.inflate`.
 * Envelope: `{ channel, ts, tick | data, event_rep?, ping? }`.
 * Channels:
 *   market_<symbol>_ticker                24h ticker deltas
 *   market_<symbol>_trade_ticker          recent trades (`top` caps the list)
 *   market_<symbol>_depth_step<level>     order book (full snapshot, then deltas)
 *   market_<symbol>_kline_<scale>         candles (`req` for history, `sub` for live)
 *   review                                all tickers in one payload
 */

export type WsEvent = 'req' | 'sub' | 'unsub'

export interface WsRequest {
  event: WsEvent
  params: Record<string, unknown>
}

/** `BTC/USDT` -> `btcusdt`. */
export function pairToSymbol(pair: string): string {
  return pair.replace('/', '').toLowerCase()
}

export function tickerChannel(symbol: string): string {
  return `market_${symbol.toLowerCase()}_ticker`
}

export function tradeChannel(symbol: string): string {
  return `market_${symbol.toLowerCase()}_trade_ticker`
}

/** `level` is the decimal-place count of the configured depth step (legacy behaviour). */
export function depthChannel(symbol: string, level: number): string {
  return `market_${symbol.toLowerCase()}_depth_step${level}`
}

export function klineChannel(symbol: string, scale: string): string {
  return `market_${symbol.toLowerCase()}_kline_${scale}`
}

export const REVIEW_CHANNEL = 'review'

export function buildReviewRequest(event: WsEvent = 'req'): WsRequest {
  return { event, params: { channel: REVIEW_CHANNEL } }
}

export function buildTickerRequest(event: WsEvent, symbol: string): WsRequest {
  const normalized = symbol.toLowerCase()
  return { event, params: { channel: tickerChannel(normalized), cb_id: normalized } }
}

export function buildTradeRequest(event: WsEvent, symbol: string, top = 100): WsRequest {
  const normalized = symbol.toLowerCase()
  return { event, params: { channel: tradeChannel(normalized), cb_id: normalized, top } }
}

export function buildDepthRequest(event: WsEvent, symbol: string, level: number): WsRequest {
  const normalized = symbol.toLowerCase()
  return { event, params: { channel: depthChannel(normalized, level), cb_id: normalized } }
}

export interface KlineRequestOptions {
  /** Pagination cursor: last known bar id (seconds). */
  endIdx?: number
  pageSize?: number
}

export function buildKlineRequest(
  event: WsEvent,
  symbol: string,
  scale: string,
  options: KlineRequestOptions = {},
): WsRequest {
  const normalized = symbol.toLowerCase()
  const params: Record<string, unknown> = {
    channel: klineChannel(normalized, scale),
    cb_id: normalized,
  }
  if (options.endIdx !== undefined) {
    params.endIdx = options.endIdx
    params.pageSize = options.pageSize ?? 50
  }
  if (options.pageSize !== undefined) params.pageSize = options.pageSize
  return { event, params }
}

export type ChannelKind = 'ticker' | 'trade' | 'depth' | 'kline' | 'review' | 'unknown'

export interface ParsedChannel {
  kind: ChannelKind
  /** Lowercase pair symbol, e.g. `btcusdt`. */
  symbol: string
  /** K-line scale, e.g. `1min`. */
  scale?: string
  /** Depth level as string, e.g. `8`. */
  depthLevel?: string
}

/**
 * Splits `market_<symbol>_<kind>...`. Spot symbols are one segment (`btcusdt`); futures symbols
 * carry the contract type prefix and therefore an underscore (`e_btcusdt`, legacy
 * `futureWebsocket.js:229-233`). The kind is located by its fixed channel suffix shape, so both
 * forms parse to the full symbol:
 *   ticker            -> last segment
 *   trade_ticker      -> last two segments
 *   depth_step<n>     -> last two segments
 *   kline_<scale>     -> last two segments
 */
export function parseChannel(channel: string): ParsedChannel {
  if (channel === REVIEW_CHANNEL) {
    return { kind: 'review', symbol: '' }
  }
  const parts = channel.split('_')
  if (parts.length < 3 || parts[0] !== 'market') {
    return { kind: 'unknown', symbol: '' }
  }
  const last = parts.length - 1
  const symbolUpTo = (end: number): string => parts.slice(1, end).join('_')
  if (parts.length >= 4) {
    const kind = parts[last - 1]
    if (kind === 'trade' && parts[last] === 'ticker') {
      return { kind: 'trade', symbol: symbolUpTo(last - 1) }
    }
    if (kind === 'depth' && parts[last].startsWith('step')) {
      return { kind: 'depth', symbol: symbolUpTo(last - 1), depthLevel: parts[last].replace(/^step/, '') }
    }
    if (kind === 'kline') {
      return { kind: 'kline', symbol: symbolUpTo(last - 1), scale: parts[last] }
    }
  }
  if (parts[last] === 'ticker') {
    return { kind: 'ticker', symbol: symbolUpTo(last) }
  }
  // Legacy positional fallback (e.g. `market_btcusdt_depth` without a step).
  const symbol = parts[1]
  const kind = parts[2]
  if (kind === 'depth') {
    const rawLevel: string | undefined = parts[3]
    return { kind: 'depth', symbol, depthLevel: (rawLevel ?? '').replace(/^step/, '') }
  }
  if (kind === 'kline') {
    return { kind: 'kline', symbol, scale: parts[3] }
  }
  if (kind === 'trade') {
    return { kind: 'trade', symbol }
  }
  return { kind: 'unknown', symbol }
}

/* ------------------------------------------------------------------ payloads */

export interface TickerTick {
  close?: string | number
  open?: string | number
  high?: string | number
  low?: string | number
  vol?: string | number
  amount?: string | number
  /** 24h change as a ratio, e.g. `0.0123` = +1.23%. */
  rose?: string | number
  [key: string]: unknown
}

export interface TradeTick {
  /** Server trade id when pushed (`trade_ticker` rows carry it). */
  id?: string | number
  price: string | number
  vol: string | number
  /**
   * Trade value in the quote coin. Spot WS sends `vol * price`; the futures store overwrites it
   * with `vol * multiplier * price` because the futures WS value lacks the face value (L43).
   */
  amount?: string | number
  side?: string
  ts: string | number
}

export type DepthSnapshotRow = [string | number, string | number, ...unknown[]]

export interface DepthSnapshot {
  asks?: DepthSnapshotRow[] | null
  buys?: DepthSnapshotRow[] | null
}

export interface DepthDelta {
  side: 'asks' | 'buys'
  price: string | number
  volume: string | number
}

export interface KlineBar {
  id: string | number
  open: string | number
  high: string | number
  low: string | number
  close: string | number
  vol: string | number
}

export interface WsMessage {
  channel?: string
  event_rep?: string
  ts?: number
  ping?: string | number
  tick?: unknown
  data?: unknown
}

export function isTickerMessage(message: WsMessage): boolean {
  return message.tick !== undefined && parseChannel(message.channel ?? '').kind === 'ticker'
}

export function isTradeMessage(message: WsMessage): boolean {
  return parseChannel(message.channel ?? '').kind === 'trade'
}

export function isDepthMessage(message: WsMessage): boolean {
  return parseChannel(message.channel ?? '').kind === 'depth'
}

export function isKlineHistoryMessage(message: WsMessage): boolean {
  return parseChannel(message.channel ?? '').kind === 'kline' && message.event_rep === 'rep'
}

export function isKlineUpdateMessage(message: WsMessage): boolean {
  const kind = parseChannel(message.channel ?? '').kind
  return kind === 'kline' && message.event_rep !== 'rep' && message.tick !== undefined
}
