import { inject, type InjectionKey } from 'vue'
import type { SymbolInfo } from 'klinecharts'
import type { SocketState } from '@/modules/ws/kline-socket'
import type { TradeTick } from '@/modules/ws/protocol'
import { decimalPlaces, groupDigits } from '@/modules/finance/decimal'
import { useMarketStore, type DepthLevel, type TickerSnapshot } from '@/stores/market'

/**
 * Market data seam shared by the terminal widgets (order book, depth chart, recent trades, chart).
 *
 * Spot provides nothing and the widgets keep reading the spot `market` store exactly as before.
 * Another terminal (USDT-margined futures) provides its own source with `provide(MARKET_SOURCE, …)`
 * so the same widgets render its book/trades/chart without forking them.
 */
export interface MarketSourceSymbol {
  /** Channel symbol, e.g. `btcusdt` (spot) or `e_btcusdt` (futures). Also the chart storage key. */
  symbol: string
  pair: string
  base: string
  quote: string
  pricePrecision: number
  volumePrecision: number
  rules: { depthSteps: string[] }
  /** Unit label for book/trade amounts; defaults to `base` (futures books are quoted in contracts). */
  volumeUnit?: string
  /**
   * Quote value of one volume unit per unit of price: `1` for spot (volume is in base coin), the
   * contract face value for futures (volume is in contracts). Value = vol * valueMultiplier * price.
   */
  valueMultiplier?: string
  /** Volumes are already quote-coin values (futures shown in USDT): value = vol, no price factor. */
  volumeIsValue?: boolean
  /** Decimals of book/trade amounts when they differ from `volumePrecision` (the chart keeps the latter). */
  volumeDisplayPrecision?: number
}

export interface MarketSource {
  readonly currentSymbol: MarketSourceSymbol | undefined
  readonly currentSymbolName: string
  readonly ticker: TickerSnapshot
  readonly asks: DepthLevel[]
  readonly buys: DepthLevel[]
  readonly trades: TradeTick[]
  readonly depthStepIndex: number
  /**
   * Book grouping steps the selector offers (server steps plus client-side coarser ones); index =
   * `depthStepIndex`. Falls back to `currentSymbol.rules.depthSteps`.
   */
  readonly bookSteps?: string[]
  /** Mark price for the book's mid row (futures); absent or '' elsewhere. */
  readonly markPrice?: string
  readonly connectionState: SocketState
  readonly klineScale: string
  readonly klineScales: string[]
  setDepthStepIndex(index: number): void
  /**
   * Market WebSocket URL; the chart leases the same shared socket (`modules/ws/shared-socket`), so
   * the book, trades and chart ride on one connection. Resolved by the chart itself when absent.
   */
  chartWsUrl?: () => string
  /** Channel symbol derived from the chart's symbol info; spot strips separators when absent. */
  chartChannelSymbol?: (symbol: SymbolInfo | null | undefined) => string
}

export const MARKET_SOURCE: InjectionKey<MarketSource> = Symbol('market-source')

/** The provided source, or the spot market store (unchanged spot behaviour). */
export function useMarketSource(): MarketSource {
  return inject(MARKET_SOURCE, null) ?? useMarketStore()
}

/**
 * Book / trade amount for display (canonical decimal string in, grouped string out). A source that names
 * `volumeDisplayPrecision` (futures) gets exactly that. Spot pads to `padTo`, the most decimals among the rows on
 * screen (`columnDecimals`), so the column lines up ("0.37120" under "0.37059", 10-24 walkthrough P3-1) without the
 * configured quantity precision's run of zeros (BTC is configured with 8, the book carries 5), and never cuts digits
 * the server sent.
 */
export function formatBookAmount(value: string, symbol: MarketSourceSymbol | undefined, padTo = 0): string {
  const display = symbol?.volumeDisplayPrecision
  if (display !== undefined) return groupDigits(value, display)
  const sent = decimalPlaces(value)
  return sent === null ? value : groupDigits(value, Math.max(sent, padTo))
}

/** Most decimals among `values` (canonical decimal strings); anything else is ignored. */
export function columnDecimals(values: readonly string[]): number {
  return values.reduce((most, value) => Math.max(most, decimalPlaces(value) ?? 0), 0)
}
