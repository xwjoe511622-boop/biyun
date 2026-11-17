import { describe, expect, it } from 'vitest'
import type { PublicInfoV4 } from '@/modules/api/types'
import { buildMarketSymbols } from '@/modules/market/symbols'
import { categoryTabs, coinTagOf, inCategory, isPairCategory, NEW_CATEGORY, tagLabel } from '@/components/trade/pair-category'

// Fixture coins are arbitrary names: categories must follow the admin tags, never the coin's name.
const pair = (base: string) => ({ symbol: `${base.toLowerCase()}usdt`, price: 2, volume: 4, name: `${base}/USDT`, depth: '0.01' })
const info: PublicInfoV4 = {
  market: {
    market: { USDT: { 'AAA/USDT': pair('AAA'), 'BBB/USDT': pair('BBB'), 'CCC/USDT': pair('CCC'), 'DDD/USDT': pair('DDD') } },
    coinList: {
      AAA: { name: 'AAA', coinTag: '1' },
      BBB: { name: 'BBB', coinTag: '3' },
      CCC: { name: 'CCC', coinTag: '' },
      DDD: { name: 'DDD', coinTag: 1 },
    },
    coinTagLangs: { zh_CN: { 1: '主流币', 3: '股票' }, en_US: { 1: 'Top', 3: 'Stocks' } },
  },
}
const symbols = buildMarketSymbols(info)
const bySym = (base: string) => symbols.find((entry) => entry.base === base)!

describe('pair categories come from the admin coin tags', () => {
  it('reads the tag index of the base coin (blank / invalid = none)', () => {
    expect(coinTagOf(bySym('AAA'))).toBe('1')
    expect(coinTagOf(bySym('DDD'))).toBe('1')
    expect(coinTagOf(bySym('CCC'))).toBe('')
  })

  it('builds one tab per used tag in admin order, labelled in the current language, then new', () => {
    const tabs = categoryTabs(symbols, new Set(['CCC/USDT']), info.market?.coinTagLangs, 'zh_CN')
    expect(tabs).toEqual([{ id: 'tag:1', label: '主流币' }, { id: 'tag:3', label: '股票' }, { id: NEW_CATEGORY, label: undefined }])
    expect(categoryTabs(symbols, new Set(), info.market?.coinTagLangs, 'en_US').map((tab) => tab.label)).toEqual(['Top', 'Stocks'])
  })

  it('shows no tag tab when the admin assigned no tags (no built-in coin lists)', () => {
    const plain = buildMarketSymbols({ market: { ...info.market, coinList: {} } })
    expect(categoryTabs(plain, new Set(), undefined, 'zh_CN')).toEqual([])
  })

  it('filters by tag and by new flag', () => {
    const newPairs = new Set(['CCC/USDT'])
    expect(symbols.filter((entry) => inCategory(entry, 'tag:1', newPairs)).map((entry) => entry.base).sort()).toEqual(['AAA', 'DDD'])
    expect(symbols.filter((entry) => inCategory(entry, 'tag:3', newPairs)).map((entry) => entry.base)).toEqual(['BBB'])
    expect(symbols.filter((entry) => inCategory(entry, NEW_CATEGORY, newPairs)).map((entry) => entry.base)).toEqual(['CCC'])
    expect(inCategory(bySym('AAA'), 'USDT', newPairs)).toBe(false)
  })

  it('label falls back to another language, then to #index', () => {
    expect(tagLabel({ en_US: { 2: 'Gold' } }, 'zh_CN', '2')).toBe('Gold')
    expect(tagLabel(undefined, 'zh_CN', '2')).toBe('#2')
  })

  it('category ids never collide with quote / fav / all tabs', () => {
    expect(isPairCategory('tag:1')).toBe(true)
    expect(isPairCategory(NEW_CATEGORY)).toBe(true)
    for (const other of ['all', 'fav', 'USDT', 'tag:', 'tag:0', 'major']) expect(isPairCategory(other)).toBe(false)
  })
})
