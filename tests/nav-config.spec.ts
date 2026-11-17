import { describe, expect, it } from 'vitest'
import { FOOTER_COLUMNS, NAV_BY_SKIN, navRoutes } from '@/components/layout/nav-config'

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

describe('header nav config', () => {
  for (const [skin, groups] of Object.entries(NAV_BY_SKIN)) {
    it(`${skin}: every route appears at most once across all groups`, () => {
      expect(duplicates(navRoutes(groups))).toEqual([])
    })
    it(`${skin}: quick buy and C2C live only under 买币`, () => {
      const buy = groups.find((group) => group.key === 'buy')
      expect(navRoutes(buy === undefined ? [] : [buy])).toEqual(['/quick-buy', '/otc'])
    })
  }

  it('okx has no standalone 合约 item; futures sit inside 交易', () => {
    const okx = NAV_BY_SKIN.okx
    expect(okx.some((group) => group.to === '/futures')).toBe(false)
    const trade = okx.find((group) => group.key === 'trade')
    expect(navRoutes(trade === undefined ? [] : [trade])).toContain('/futures')
  })
})

describe('footer columns', () => {
  it('never repeat a link inside one column', () => {
    for (const column of FOOTER_COLUMNS) expect(duplicates(column.links.map((link) => link.to))).toEqual([])
  })
})
