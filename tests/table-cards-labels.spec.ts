import { describe, expect, it } from 'vitest'

/**
 * `.table-cards` (src/styles/base.css) turns a table into one card per record on phones, labelling each value from
 * the cell's `data-label`. A cell without one would show a bare value, so every <td> of such a table must carry
 * `data-label` (or `:data-label`; `data-label=""` marks the card heading). Owner 10-22: mobile right-side overflow.
 */
const sources = import.meta.glob<string>('../src/**/*.vue', { query: '?raw', import: 'default', eager: true })

function cardTables(source: string): string[] {
  const out: string[] = []
  const re = /<table\b[^>]*\btable-cards\b[^>]*>([\s\S]*?)<\/table>/g
  for (let m = re.exec(source); m !== null; m = re.exec(source)) out.push(m[1] ?? '')
  return out
}

const files = Object.entries(sources).map(([path, text]) => ({ path, tables: cardTables(text) })).filter((f) => f.tables.length > 0)

describe('table-cards data-label contract', () => {
  it('is used by the phone-friendly tables (VIP, fees, loans, vesting, affiliate, records)', () => {
    const names = files.map((f) => f.path.split('/').pop())
    for (const expected of ['VipView.vue', 'FeesView.vue', 'LoansView.vue', 'VestingView.vue', 'AffiliateView.vue', 'BizRecords.vue']) {
      expect(names).toContain(expected)
    }
  })
  for (const f of files) {
    it(`every <td> is labelled in ${f.path.replace('../src/', '')}`, () => {
      for (const table of f.tables) {
        const body = table.slice(table.indexOf('<tbody'))
        const cells = body.match(/<td\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? []
        expect(cells.length).toBeGreaterThan(0)
        for (const cell of cells) expect(cell, cell).toMatch(/\s:?data-label=/)
      }
    })
  }
})
