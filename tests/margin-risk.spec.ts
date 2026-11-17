import { describe, expect, it } from 'vitest'
import type { PublicInfoV4 } from '@/modules/api/types'
import { buildMarketSymbols } from '@/modules/market/symbols'
import { normalizeAccountsOverview, normalizeSymbolAccount } from '@/modules/margin/normalize'
import {
  formatBurstPrice,
  formatDailyRate,
  formatRiskRate,
  netAssetsInQuote,
  riskBand,
  riskColor,
  riskGaugeFraction,
} from '@/modules/margin/risk'
import { buildMarginMarkets, isLeverSwitchOpen } from '@/modules/margin/symbols'

describe('margin risk display', () => {
  it('maps the server percent risk rate onto the LeverUtils thresholds', () => {
    expect(riskBand('0')).toBe('none')
    expect(riskBand('')).toBe('unknown')
    expect(riskBand('abc')).toBe('unknown')
    expect(riskBand('105')).toBe('liquidation')
    expect(riskBand('110')).toBe('liquidation')
    expect(riskBand('111')).toBe('danger')
    expect(riskBand('130')).toBe('danger')
    expect(riskBand('149')).toBe('caution')
    expect(riskBand('150')).toBe('normal')
    expect(riskBand('199')).toBe('normal')
    expect(riskBand('200')).toBe('safe')
    expect(riskBand('950')).toBe('safe')
  })

  it('uses theme tokens for band colours and muted for no-debt', () => {
    expect(riskColor('safe')).toBe('var(--color-up)')
    expect(riskColor('caution')).toBe('var(--color-accent)')
    expect(riskColor('liquidation')).toBe('var(--color-down)')
    expect(riskColor('none')).toBe('var(--color-text-muted)')
  })

  it('never shows a zero risk rate or liquidation price as a real value', () => {
    expect(formatRiskRate('0')).toBe('--')
    expect(formatRiskRate('')).toBe('--')
    expect(formatRiskRate('156')).toBe('156%')
    expect(formatBurstPrice('0', 2)).toBe('--')
    expect(formatBurstPrice('', 2)).toBe('--')
    expect(formatBurstPrice('41234.56789', 2)).toBe('41234.56')
  })

  it('clamps the gauge between 100% and 300%', () => {
    expect(riskGaugeFraction('0')).toBe(0)
    expect(riskGaugeFraction('50')).toBe(0)
    expect(riskGaugeFraction('200')).toBeCloseTo(0.5)
    expect(riskGaugeFraction('999')).toBe(1)
  })

  it('treats a pair without a borrow rule (multiple 0, QA-051 SOL/USDT) as not configured', async () => {
    const { hasBorrowRule } = await import('@/modules/margin/risk')
    expect(hasBorrowRule({ multiple: '3' })).toBe(true)
    expect(hasBorrowRule({ multiple: '0' })).toBe(false)
    expect(hasBorrowRule({ multiple: '' })).toBe(false)
  })

  it('formats the daily rate fraction as percent', () => {
    expect(formatDailyRate('0.0005')).toBe('0.05%')
    expect(formatDailyRate('0.001')).toBe('0.1%')
    expect(formatDailyRate('')).toBe('--')
  })

  it('derives net assets in quote from returned balances and the live price only', () => {
    expect(netAssetsInQuote({ baseTotalBalance: '1', baseBorrowBalance: '0.5', quoteTotalBalance: '1000', quoteBorrowBalance: '200', price: '40000' })).toBe('20800')
    expect(netAssetsInQuote({ baseTotalBalance: '1', baseBorrowBalance: '0', quoteTotalBalance: '0', quoteBorrowBalance: '0', price: '' })).toBe('')
  })
})

describe('margin account contract', () => {
  it('normalises lever/finance/symbol/balance including the capital-EX quote key', () => {
    const account = normalizeSymbolAccount({
      symbol: 'btcusdt', name: 'BTC/USDT', baseCoin: 'BTC', quoteCoin: 'USDT',
      baseNormalBalance: 0.5, baseCanBorrow: '1.2', quoteCanTransfer: 100.25, riskRate: 156, burstPrice: 0,
      quoteEXNormalBalance: 12.5, rate: 0.0005, multiple: 3, baseReturnPrecision: 8,
    })
    expect(account).not.toBeNull()
    expect(account?.baseNormalBalance).toBe('0.5')
    expect(account?.baseCanBorrow).toBe('1.2')
    expect(account?.quoteCanTransfer).toBe('100.25')
    expect(account?.quoteExNormalBalance).toBe('12.5')
    expect(account?.riskRate).toBe('156')
    expect(account?.burstPrice).toBe('0')
    // Missing fields stay empty rather than becoming zero.
    expect(account?.quoteBorrowBalance).toBe('')
  })

  it('takes the open-borrow total from a non-full first page when the server count lags (QA-054)', async () => {
    const { borrowTotal, normalizeBorrowPage } = await import('@/modules/margin/normalize')
    const stale = normalizeBorrowPage({ count: 2, financeList: [{ id: '11', coin: 'USDT', borrowMoney: '10', status: 1 }] })
    expect(borrowTotal(stale, 1, 10)).toBe(1)
    const full = normalizeBorrowPage({ count: 12, financeList: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), status: 1 })) })
    expect(borrowTotal(full, 1, 10)).toBe(12)
    const second = normalizeBorrowPage({ count: 12, financeList: [{ id: '11', status: 1 }, { id: '12', status: 1 }] })
    expect(borrowTotal(second, 2, 10)).toBe(12)
    expect(borrowTotal(normalizeBorrowPage({ count: 0, financeList: [] }), 1, 10)).toBe(0)
  })

  it('reads every pair from lever/finance/balance leverMap', () => {
    const overview = normalizeAccountsOverview({
      totalBalance: 0.01, totalBalanceSymbol: 'BTC',
      leverMap: { 'ETH/USDT': { symbol: 'ethusdt', name: 'ETH/USDT' }, 'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT' } },
    })
    expect(overview.totalBalance).toBe('0.01')
    expect(overview.accounts.map(entry => entry.name)).toEqual(['BTC/USDT', 'ETH/USDT'])
  })

  it('lists margin pairs only when lever_open = 1 and the pair has is_open_lever', () => {
    const info = {
      switch: { lever_open: '1' },
      market: {
        coinList: {},
        market: {
          USDT: {
            'BTC/USDT': { symbol: 'btcusdt', name: 'BTC/USDT', price: 2, volume: 6, depth: '0.01', is_open_lever: 1, multiple: 5 },
            'ETH/USDT': { symbol: 'ethusdt', name: 'ETH/USDT', price: 2, volume: 4, depth: '0.01', is_open_lever: 0, multiple: 3 },
          },
        },
      },
    } as unknown as PublicInfoV4
    const symbols = buildMarketSymbols(info)
    expect(isLeverSwitchOpen(info)).toBe(true)
    const markets = buildMarginMarkets(info, symbols)
    expect(markets.map(entry => entry.symbol.pair)).toEqual(['BTC/USDT'])
    expect(markets[0].multiple).toBe('5')
    const closed = { ...info, switch: { lever_open: '0' } } as PublicInfoV4
    expect(buildMarginMarkets(closed, symbols)).toEqual([])
  })
})

describe('amount display', () => {
  it('rounds down, trims zeros, keeps the sign and never shows missing as 0', async () => {
    const { displayAmount } = await import('@/modules/margin/risk')
    expect(displayAmount('0.01000000')).toBe('0.01')
    // QA-005: fills and fees are shown exactly, never cut to the input precision
    const { exactAmount } = await import('@/modules/margin/risk')
    expect(exactAmount('0.0041516300000000')).toBe('0.00415163')
    expect(exactAmount('0.000000245')).toBe('0.000000245')
    expect(exactAmount('12345.5')).toBe('12,345.5')
    expect(exactAmount('-0.5')).toBe('-0.5')
    expect(exactAmount('')).toBe('--')
    expect(displayAmount('1520.429999999', 2)).toBe('1,520.42')
    expect(displayAmount('-3600.456', 2)).toBe('-3,600.45')
    expect(displayAmount('')).toBe('--')
    expect(displayAmount(undefined)).toBe('--')
  })
})
