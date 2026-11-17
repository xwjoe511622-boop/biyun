import { computed, type Ref } from 'vue'
import { Decimal, canonicalDecimal, isDecimalString, toDecString } from '@/modules/finance/decimal'
import type { MarketSource, MarketSourceSymbol } from '@/components/trade/market-source'
import type { TradeTick } from '@/modules/ws/protocol'
import type { DepthLevel } from '@/stores/market'
import { contractsAmount, displayDp, sizeUnitLabel, type SizeContract, type SizeUnit } from './size-unit'

/**
 * Futures market data for the shared terminal widgets (order book, depth chart, recent trades) with
 * every contract quantity restated in the chosen size unit. Book levels convert at their own level
 * price and cumulative totals are re-summed in the unit (so USDT totals are real notionals); trades
 * convert at the trade price. The underlying store keeps raw contracts.
 */
export function createSizedMarketSource(
  source: MarketSource,
  unit: Ref<SizeUnit>,
  contract: () => SizeContract | undefined,
  contractsLabel: () => string,
): MarketSource {
  const convert = (contracts: string, price: string): string => {
    const current = contract()
    return contractsAmount(contracts, unit.value, current, price).amount
  }

  function levels(rows: readonly DepthLevel[]): DepthLevel[] {
    if (unit.value === 'cont' || contract() === undefined) return rows as DepthLevel[]
    let total = new Decimal(0)
    return rows.map((row) => {
      const amount = convert(row.amount, row.price)
      if (isDecimalString(amount)) total = total.plus(amount)
      return { ...row, amount: amount === '' ? row.amount : amount, total: canonicalDecimal(total.toFixed()) }
    })
  }

  const asks = computed(() => levels(source.asks))
  const buys = computed(() => levels(source.buys))
  const trades = computed<TradeTick[]>(() => {
    if (unit.value === 'cont' || contract() === undefined) return source.trades
    return source.trades.map((trade) => {
      const amount = convert(canonicalDecimal(toDecString(trade.vol)), canonicalDecimal(toDecString(trade.price)))
      return amount === '' ? trade : { ...trade, vol: amount }
    })
  })
  const symbol = computed<MarketSourceSymbol | undefined>(() => {
    const base = source.currentSymbol
    const current = contract()
    if (base === undefined || current === undefined) return base
    const value = unit.value
    return {
      ...base,
      volumeUnit: sizeUnitLabel(value, current, contractsLabel()),
      volumeDisplayPrecision: displayDp(value, current.multiplier),
      valueMultiplier: value === 'cont' ? current.multiplier : '1',
      volumeIsValue: value === 'quote',
    }
  })

  return {
    get currentSymbol() { return symbol.value },
    get currentSymbolName() { return source.currentSymbolName },
    get ticker() { return source.ticker },
    get asks() { return asks.value },
    get buys() { return buys.value },
    get trades() { return trades.value },
    get depthStepIndex() { return source.depthStepIndex },
    get bookSteps() { return source.bookSteps },
    get markPrice() { return source.markPrice },
    get connectionState() { return source.connectionState },
    get klineScale() { return source.klineScale },
    get klineScales() { return source.klineScales },
    setDepthStepIndex: (index: number) => source.setDepthStepIndex(index),
    chartWsUrl: source.chartWsUrl === undefined ? undefined : () => source.chartWsUrl?.() ?? '',
    chartChannelSymbol: source.chartChannelSymbol === undefined ? undefined : (info) => source.chartChannelSymbol?.(info) ?? '',
  }
}
