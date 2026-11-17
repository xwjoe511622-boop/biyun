import { Decimal } from '@/modules/finance/decimal'
import { coinUsdValue, type ValuationRow } from './valuation'

export interface EquityHolding { coin: string; amount: string }
export interface FuturesEquityHolding { coin: string; walletBalance: string; unrealizedProfit: string; marginBalance: string }
/** Enough significant digits for bounded wire coefficients and their exact sums/products. */
const Exact = Decimal.clone({ precision: 256, rounding: Decimal.ROUND_DOWN, toExpNeg: -256, toExpPos: 256 })
type Tickers = Record<string, { close?: string } | undefined>

function decimal(value: unknown, maxDigits = 64): Decimal | null {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && value.replace(/[-.]/g, '').length <= maxDigits ? new Exact(value) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Server aggregates actual margin ledger types, including closed/delisted pairs, less principal/interest. */
export function marginEquityHoldings(raw: unknown): EquityHolding[] | null {
  const holdings = record(raw)?.portfolioHoldings
  if (!Array.isArray(holdings)) return null
  const result: EquityHolding[] = []
  for (const row of holdings) {
    const account = record(row)
    if (account === null) return null
    const coin = account.coin
    const net = decimal(account.balance)
    if (typeof coin !== 'string' || coin === '' || net === null) return null
    result.push({ coin: coin.toUpperCase(), amount: net.toFixed() })
  }
  return result
}


/** Validate all three figures from the same response; a missing/contradictory leg is never zero. */
export function futuresEquityHoldings(raw: unknown): FuturesEquityHolding[] | null {
  const assets = record(raw)?.assets
  if (!Array.isArray(assets) || assets.length === 0) return null
  const result: FuturesEquityHolding[] = []
  const seen = new Set<string>()
  for (const value of assets) {
    const row = record(value)
    const coin = row?.asset
    const wallet = decimal(row?.walletBalance)
    const pnl = decimal(row?.unrealizedProfit)
    const equity = decimal(row?.marginBalance)
    if (typeof coin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(coin)
      || seen.has(coin.toUpperCase()) || wallet === null || pnl === null || equity === null
      || !wallet.plus(pnl).equals(equity)) return null
    seen.add(coin.toUpperCase())
    result.push({ coin: coin.toUpperCase(), walletBalance: wallet.toFixed(), unrealizedProfit: pnl.toFixed(), marginBalance: equity.toFixed() })
  }
  return result
}

/** One valuation per account: futures marginBalance already includes wallet and unrealized PnL. */
export function portfolioEquityUsd(spot: readonly ValuationRow[], additional: readonly EquityHolding[], tickers: Tickers): string {
  let total = new Exact(0)
  for (const row of spot) {
    const amount = decimal(row.total)
    if (amount === null) return ''
    if (amount.isZero()) continue
    const value = coinUsdValue(row.coin, amount.abs().toFixed(), row.btcValuation, tickers, exactProduct)
    const priced = decimal(value, 256)
    if (priced === null) return ''
    total = total.plus(amount.isNegative() ? priced.negated() : priced)
  }
  for (const row of additional) {
    const amount = decimal(row.amount)
    if (amount === null) return ''
    if (amount.isZero()) continue
    const value = coinUsdValue(row.coin, amount.abs().toFixed(), '', tickers, exactProduct)
    const priced = decimal(value, 256)
    if (priced === null) return ''
    total = total.plus(amount.isNegative() ? priced.negated() : priced)
  }
  // No intermediate rounding: the shared valuation display truncates USD to 2 / BTC to 8 places.
  return total.toFixed()
}

function exactProduct(left: string, right: string): string {
  // Public prices and account coefficients are bounded by their wire readers; never round between legs.
  if (left.replace(/[-.]/g, '').length > 64 || right.replace(/[-.]/g, '').length > 64) return ''
  return new Exact(left).times(right).toFixed()
}

export function portfolioBreakdownUsd(spot: readonly ValuationRow[], futures: readonly FuturesEquityHolding[], margin: readonly EquityHolding[], tickers: Tickers) {
  const total = portfolioEquityUsd(spot, [...futures.map(row => ({ coin: row.coin, amount: row.marginBalance })), ...margin], tickers)
  const balance = portfolioEquityUsd(spot, [...futures.map(row => ({ coin: row.coin, amount: row.walletBalance })), ...margin], tickers)
  const unrealized = portfolioEquityUsd([], futures.map(row => ({ coin: row.coin, amount: row.unrealizedProfit })), tickers)
  return total === '' || balance === '' || unrealized === '' ? { total: '', balance: '', unrealized: '' } : { total, balance, unrealized }
}
