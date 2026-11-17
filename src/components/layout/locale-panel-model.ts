import { translateForLocale } from '@/i18n/composer'
import type { LocaleOption } from '@/i18n/catalog'

/** Search appears only once a list is long enough to need it (Binance/OKX lists have 20+ entries; ours has 2). */
export const SEARCH_THRESHOLD = 8

/** One row of the language list, already worded for the current UI language. */
export interface LocaleRow {
  code: string
  /** Big line: the language in its own script. */
  primary: string
  /** Small line: its name in the UI language (or English when that equals `primary`), plus the region. */
  secondary: string
  glyph: string
  selected: boolean
}

/** Secondary line for a language, written in the UI language `uiCode`. */
export function secondaryLine(option: LocaleOption, uiCode: string): string {
  const inUi = option.names[uiCode] ?? option.englishName
  const name = inUi === option.label ? (option.englishName === option.label ? '' : option.englishName) : inUi
  if (option.region === '') return name
  const region = uiCode === 'zh-CN' ? regionZh(option.region) : option.region
  return name === '' ? region : `${name} · ${region}`
}

const REGION_ZH: Readonly<Record<string, string>> = { 'United States': 'localeRegion.unitedStates' }
function regionZh(region: string): string {
  return REGION_ZH[region] ? translateForLocale('zh', REGION_ZH[region]) : region
}

export function localeRows(options: readonly LocaleOption[], uiCode: string, current: string): LocaleRow[] {
  return options.map((option) => ({
    code: option.code,
    primary: option.label,
    secondary: secondaryLine(option, uiCode),
    glyph: option.glyph,
    selected: option.code === current,
  }))
}

/** Case- and accent-insensitive match on the native, English and localized names and the code. */
export function filterLocales(options: readonly LocaleOption[], query: string): LocaleOption[] {
  const needle = fold(query)
  if (needle === '') return [...options]
  return options.filter((option) =>
    [option.label, option.englishName, option.code, option.region, ...Object.values(option.names)].some((text) => fold(text).includes(needle)),
  )
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/**
 * Roving-focus move inside a grid of `count` cells laid out in `columns` columns. Arrow keys move by one
 * cell / one row, Home/End jump to the ends; the index never leaves [0, count). Unknown keys return `null`.
 */
export function moveIndex(current: number, key: string, count: number, columns: number): number | null {
  if (count <= 0) return null
  const cols = Math.max(1, Math.floor(columns))
  const last = count - 1
  const from = Math.min(Math.max(current, 0), last)
  switch (key) {
    case 'ArrowRight': return Math.min(from + 1, last)
    case 'ArrowLeft': return Math.max(from - 1, 0)
    case 'ArrowDown': return Math.min(from + cols, last)
    case 'ArrowUp': return Math.max(from - cols, 0)
    case 'Home': return 0
    case 'End': return last
    default: return null
  }
}

/** Next element for Tab / Shift+Tab inside a focus trap (wraps at both ends). */
export function trapIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  return backwards ? (current - 1 + count) % count : (current + 1) % count
}
