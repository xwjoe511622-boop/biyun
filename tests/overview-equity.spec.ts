import { describe, expect, it } from 'vitest'
import { futuresEquityHoldings, marginEquityHoldings, portfolioBreakdownUsd, portfolioEquityUsd } from '../src/modules/wallet/overview-equity'

describe('QA-072 account overview includes futures equity and margin net assets', () => {
  const tickers = { btcusdt: { close: '80000' } }
  it('adds futures margin balance once, with stablecoin holdings independent of BTC repricing', () => {
    const spot = [{ coin: 'USDT', total: '1799749.7189157187', btcValuation: '22' }, { coin: 'BTC', total: '0.0031055839', btcValuation: '0.0031055839' }]
    expect(portfolioEquityUsd(spot, [{ coin: 'USDT', amount: '200000.044517' }], tickers)).toBe('1999998.2101447187')
    expect(portfolioEquityUsd([{ coin: 'USDT', total: '0.1', btcValuation: '9' }], [{ coin: 'USDT', amount: '0.2' }], { btcusdt: { close: '1' } })).toBe('0.3')
  })
  it('uses signed net margin after principal and accrued interest, never echoed spot balances or gross debt', () => {
    const rows = marginEquityHoldings({ portfolioHoldings: [{ coin: 'BTC', balance: '-0.0001' }, { coin: 'USDT', balance: '10.0000000000000001' }], leverMap: {}, totalBalance: '100000' })
    expect(rows).toEqual([{ coin: 'BTC', amount: '-0.0001' }, { coin: 'USDT', amount: '10.0000000000000001' }])
    expect(portfolioEquityUsd([], rows ?? [], tickers)).toBe('2.0000000000000001')
  })
  it('never invents zero for a missing account response, invalid decimal or missing nonzero price', () => {
    expect(marginEquityHoldings({})).toBeNull()
    expect(marginEquityHoldings({ portfolioHoldings: [] })).toEqual([])
    expect(marginEquityHoldings({ portfolioHoldings: [{ coin: 'BTC', balance: 0.1 }] })).toBeNull()
    expect(portfolioEquityUsd([], [{ coin: 'SOL', amount: '1' }], tickers)).toBe('')
    expect(portfolioEquityUsd([], [{ coin: 'SOL', amount: '0' }], {})).toBe('0')
    expect(portfolioEquityUsd([], [{ coin: 'USDT', amount: '' }], tickers)).toBe('')
  })
  it('preserves large values and full scale without intermediate truncation or division by an absent price', () => {
    expect(portfolioEquityUsd([], [{ coin: 'USDT', amount: '999999999999999999.0000000000000001' }], {})).toBe('999999999999999999.0000000000000001')
    expect(portfolioEquityUsd([], [{ coin: 'BTC', amount: '1' }], { btcusdt: { close: '0' } })).toBe('')
  })
})

describe('futures wallet, unrealized PnL and equity share one exact read', () => {
  const read = (wallet: string, pnl: string, equity: string, asset = 'USDT') => ({ assets: [{ asset, walletBalance: wallet, unrealizedProfit: pnl, marginBalance: equity }] })
  it('values each margin asset at its own quote and preserves signed PnL without double counting', () => {
    const futures = futuresEquityHoldings(read('0.3', '-0.1', '0.2', 'BTC'))!
    expect(portfolioBreakdownUsd([{ coin: 'USDT', total: '0.1', btcValuation: '9' }], futures, [], { btcusdt: { close: '100' } }))
      .toEqual({ total: '20.1', balance: '30.1', unrealized: '-10' })
  })
  it('keeps USDT balance valuation constant while PnL refreshes, independent of BTC prices', () => {
    const first = futuresEquityHoldings(read('0.1', '0.2', '0.3'))!
    const second = futuresEquityHoldings(read('0.1', '0.3', '0.4'))!
    expect(portfolioBreakdownUsd([], first, [], { btcusdt: { close: '1' } })).toEqual({ total: '0.3', balance: '0.1', unrealized: '0.2' })
    expect(portfolioBreakdownUsd([], second, [], { btcusdt: { close: '999999' } })).toEqual({ total: '0.4', balance: '0.1', unrealized: '0.3' })
  })
  it('preserves maximum scale and huge values, with no intermediate rounding or division', () => {
    const value = '9999999999999999.9999999999999999'
    const futures = futuresEquityHoldings(read(value, '0.0000000000000001', '10000000000000000'))!
    expect(portfolioBreakdownUsd([], futures, [], {})).toEqual({ total: '10000000000000000', balance: value, unrealized: '0.0000000000000001' })
    expect(portfolioEquityUsd([{ coin: 'BTC', total: '9'.repeat(64), btcValuation: '' }], [], { btcusdt: { close: '10' } })).toBe('9'.repeat(64) + '0')
    expect(futuresEquityHoldings(read('0','0','0'))).not.toBeNull()
    expect(portfolioBreakdownUsd([], futuresEquityHoldings(read('1','-1','0','BTC'))!, [], { btcusdt: { close: '0' } })).toEqual({ total: '', balance: '', unrealized: '' })
  })
  it('rejects incomplete, duplicate, numeric or contradictory figures as unknown', () => {
    for (const value of [{}, { assets: null }, { assets: [{ asset: 'USDT', marginBalance: '1' }] },
      { assets: [{ asset: 'USDT', walletBalance: 1, unrealizedProfit: '0', marginBalance: '1' }] },
      read('0.1','0.2','0.4'), read('1e2','0','100'), read('NaN','0','0'),
      { assets: [...read('1','0','1').assets, ...read('1','0','1','usdt').assets] }]) {
      expect(futuresEquityHoldings(value)).toBeNull()
    }
    expect(futuresEquityHoldings({ assets: [] })).toBeNull()
  })
})
