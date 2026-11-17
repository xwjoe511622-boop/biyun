import { describe, expect, it } from 'vitest'
import { LOCALES, isSupportedLocale, type LocaleOption } from '@/i18n/catalog'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'
import {
  SEARCH_THRESHOLD,
  filterLocales,
  localeRows,
  moveIndex,
  secondaryLine,
  trapIndex,
} from '@/components/layout/locale-panel-model'

const MESSAGE_FILES: Record<string, object> = { 'zh-CN': zhCN, 'en-US': enUS }

const FRENCH: LocaleOption = {
  code: 'fr-FR',
  apiValue: 'fr_FR',
  label: 'Français',
  englishName: 'French',
  names: { 'zh-CN': '法语', 'en-US': 'French' },
  region: 'France',
  glyph: 'Fr',
}

describe('locale catalog', () => {
  it('lists only languages that ship a message file', () => {
    expect(LOCALES.map((option) => option.code)).toEqual(['zh-CN', 'en-US'])
    for (const option of LOCALES) expect(MESSAGE_FILES[option.code]).toBeDefined()
  })

  it('has unique codes and the API header values the backend expects', () => {
    expect(new Set(LOCALES.map((option) => option.code)).size).toBe(LOCALES.length)
    expect(LOCALES.map((option) => option.apiValue)).toEqual(['zh_CN', 'en_US'])
    expect(isSupportedLocale('en-US')).toBe(true)
    expect(isSupportedLocale('fr-FR')).toBe(false)
  })

  it('does not need search for the current short list', () => {
    expect(LOCALES.length).toBeLessThanOrEqual(SEARCH_THRESHOLD)
  })
})

describe('locale rows', () => {
  it('shows the native name large and a second line in the UI language', () => {
    expect(localeRows(LOCALES, 'zh-CN', 'zh-CN')).toEqual([
      { code: 'zh-CN', primary: '简体中文', secondary: 'Chinese (Simplified)', glyph: '文', selected: true },
      { code: 'en-US', primary: 'English', secondary: '英语 · 美国', glyph: 'Aa', selected: false },
    ])
    const en = localeRows(LOCALES, 'en-US', 'en-US')
    expect(en.map((row) => row.secondary)).toEqual(['Chinese (Simplified)', 'United States'])
    expect(en.filter((row) => row.selected).map((row) => row.code)).toEqual(['en-US'])
  })

  it('falls back to the English name for a UI language without a translation', () => {
    expect(secondaryLine(FRENCH, 'ja-JP')).toBe('French · France')
    expect(secondaryLine(FRENCH, 'zh-CN')).toBe('法语 · France')
  })
})

describe('filterLocales', () => {
  const list = [...LOCALES, FRENCH]
  it('matches native, English, localized names and codes, ignoring case and accents', () => {
    expect(filterLocales(list, '').length).toBe(3)
    expect(filterLocales(list, 'chinese').map((o) => o.code)).toEqual(['zh-CN'])
    expect(filterLocales(list, '英语').map((o) => o.code)).toEqual(['en-US'])
    expect(filterLocales(list, 'FRANCAIS').map((o) => o.code)).toEqual(['fr-FR'])
    expect(filterLocales(list, 'en-us').map((o) => o.code)).toEqual(['en-US'])
    expect(filterLocales(list, 'klingon')).toEqual([])
  })
})

describe('keyboard movement', () => {
  it('moves through a two-column grid and clamps at the ends', () => {
    expect(moveIndex(0, 'ArrowRight', 5, 2)).toBe(1)
    expect(moveIndex(0, 'ArrowDown', 5, 2)).toBe(2)
    expect(moveIndex(3, 'ArrowDown', 5, 2)).toBe(4)
    expect(moveIndex(1, 'ArrowUp', 5, 2)).toBe(0)
    expect(moveIndex(0, 'ArrowLeft', 5, 2)).toBe(0)
    expect(moveIndex(2, 'End', 5, 2)).toBe(4)
    expect(moveIndex(4, 'Home', 5, 2)).toBe(0)
    expect(moveIndex(-1, 'ArrowDown', 2, 1)).toBe(1)
    expect(moveIndex(0, 'a', 5, 2)).toBeNull()
    expect(moveIndex(0, 'ArrowDown', 0, 2)).toBeNull()
  })

  it('wraps Tab inside the focus trap', () => {
    expect(trapIndex(2, 3, false)).toBe(0)
    expect(trapIndex(0, 3, true)).toBe(2)
    expect(trapIndex(-1, 3, false)).toBe(0)
    expect(trapIndex(-1, 3, true)).toBe(2)
    expect(trapIndex(0, 0, false)).toBe(-1)
  })
})
