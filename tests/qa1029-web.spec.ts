import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { OrderItem, PublicInfoV4 } from '@/modules/api/types'
import { orderAmountText } from '@/components/orders/display'
import { contentMessages } from '@/modules/content/i18n'
import { buildMarketSymbols } from '@/modules/market/symbols'
import { accountRiskBand, accountRiskText } from '@/modules/margin/risk'
import { buildContracts } from '@/modules/futures/contracts'
import { feeForContract } from '@/modules/futures/fees'
import { normalizeFeeRows, normalizePublicInfo } from '@/modules/futures/types'

describe('QA 10-29: user-visible financial and contract facts', () => {
  it('distinguishes actual zero risk rate from no debt and missing data', () => {
    expect(accountRiskBand('0', true)).toBe('liquidation')
    expect(accountRiskText('0', true)).toBe('0%')
    expect(accountRiskBand('0', false)).toBe('none')
    expect(accountRiskText('0', false)).toBe('--')
    expect(accountRiskBand('', null)).toBe('unknown')
    expect(accountRiskText('', null)).toBe('--')
  })

  it('uses English plural rules for zero, one and several help articles', () => {
    const t = createI18n({ legacy: false, locale: 'en-US', messages: contentMessages }).global.t
    expect(t('content.help.articles', 0)).toBe('No articles')
    expect(t('content.help.articles', 1)).toBe('1 article')
    expect(t('content.help.articles', 2)).toBe('2 articles')
  })

  it('shows the submitted quote spend of an unfilled market BUY, without confusing it with base fill quantity', () => {
    const units = { base: 'BTC', quote: 'USDT', baseDp: 8, quoteDp: 2 }
    const buy: OrderItem = { id: '1', side: 'BUY', status: 1, type: 2, volume: '0', total_price: '12345.6789' }
    expect(orderAmountText(buy, units)).toBe('12,345.67 USDT')
    expect(orderAmountText({ ...buy, total_price: undefined }, units)).toBe('--')
    expect(orderAmountText({ ...buy, type: 1, volume: '0.1234567890123456' }, units)).toBe('0.12345678 BTC')
    expect(orderAmountText({ ...buy, side: 'SELL', volume: '0.1' }, units)).toBe('0.1 BTC')
    expect(orderAmountText({ ...buy, total_price: '99999999999999999999.9999999999999999' }, units)).toBe('99,999,999,999,999,999,999.99 USDT')
  })

  it('hides isShow=0 from market discovery while keeping its metadata available for owned orders', () => {
    const info: PublicInfoV4 = { market: { market: { USDT: {
      'CC/USDT': { name: 'CC/USDT', symbol: 'ccusdt', price: 8, volume: 8, depth: '0.00000001', isShow: '0' },
      'BTC/USDT': { name: 'BTC/USDT', symbol: 'btcusdt', price: 2, volume: 8, depth: '0.01', isShow: 1 },
    } } } }
    expect(buildMarketSymbols(info).map(row => row.symbol)).toEqual(['btcusdt'])
    expect(buildMarketSymbols(info, { includeHidden: true }).map(row => row.symbol)).toEqual(['ccusdt', 'btcusdt'])
  })

  it('keeps delisted contract metadata separate from the trading selector on a cold start', () => {
    const info = normalizePublicInfo({ contractList: [], allContractList: [{ id: 8, contractName: 'E-SOL-USDT', symbol: 'SOL-USDT', multiplier: '0.1', multiplierCoin: 'SOL', marginCoin: 'USDT', contractSide: 1, status: 0, coinResultVo: { symbolPricePrecision: 3, marginCoinPrecision: 6 } }] })
    expect(buildContracts(info.contractList)).toEqual([])
    expect(buildContracts(info.allContractList ?? [])[0]?.multiplier).toBe('0.1')
    expect(buildContracts(info.allContractList ?? [])[0]?.id).toBe(8)
  })

  it('shows independent contract fee schedules and refuses an ambiguous match only for that contract', () => {
    const info = normalizePublicInfo({ contractList: [
      { id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', contractSide: 1 },
      { id: 2, contractName: 'E-ETH-USDT', symbol: 'ETH-USDT', multiplier: '0.001', multiplierCoin: 'ETH', marginCoin: 'USDT', contractSide: 1 },
    ] })
    const contracts = buildContracts(info.contractList)
    const rows = normalizeFeeRows([
      { multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', contractSide: 1, openMakerFee: '0.0001', openTakerFee: '0.0002', closeMakerFee: '0.0003', closeTakerFee: '0.0004' },
      { multiplier: '0.001', multiplierCoin: 'ETH', marginCoin: 'USDT', contractSide: 1, openMakerFee: '0.001', openTakerFee: '0.002', closeMakerFee: '0.003', closeTakerFee: '0.004' },
    ])
    expect(feeForContract(contracts[0], rows)?.openMakerFee).toBe('0.0001')
    expect(feeForContract(contracts[1], rows)?.closeTakerFee).toBe('0.004')
    expect(feeForContract(contracts[0], [...rows, { ...rows[0]!, openMakerFee: '0.1' }])).toBeNull()
    expect(feeForContract(contracts[1], [...rows, { ...rows[0]!, openMakerFee: '0.1' }])?.closeTakerFee).toBe('0.004')
  })
})
