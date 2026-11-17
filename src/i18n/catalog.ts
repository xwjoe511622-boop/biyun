/**
 * Languages the web app really ships (each one has a full message file under ./locales). Pure data so the
 * header's language panel, the footer select and tests share one list.
 *
 * Adding a language: translate ./locales/<code>.ts, register it in ./index.ts `messages`, then add one entry
 * here. Never list a language without its message file — the UI would silently fall back to English.
 */
export interface LocaleOption {
  /** BCP-47 code used by vue-i18n, <html lang> and the `?lang=` query. */
  code: string
  /** Value sent in the `exchange-language` header (`BaseAct.getLanguage`). */
  apiValue: string
  /** Name in its own language (what a speaker looks for). */
  label: string
  /** English name, also a search key. */
  englishName: string
  /** Name as written in each UI language, keyed by UI locale code. */
  names: Readonly<Record<string, string>>
  /** Region the variant is written for, in English (`''` when the language has one variant here). */
  region: string
  /** One or two characters of the script, shown as the row's mark (scripts, not flags: a language is not a country). */
  glyph: string
}

export const LOCALES: readonly LocaleOption[] = [
  {
    code: 'zh-CN',
    apiValue: 'zh_CN',
    label: '简体中文',
    englishName: 'Chinese (Simplified)',
    names: { 'zh-CN': '简体中文', 'en-US': 'Chinese (Simplified)' },
    region: '',
    glyph: '文',
  },
  {
    code: 'en-US',
    apiValue: 'en_US',
    label: 'English',
    englishName: 'English',
    names: { 'zh-CN': '英语', 'en-US': 'English' },
    region: 'United States',
    glyph: 'Aa',
  },
]

export function isSupportedLocale(code: string): boolean {
  return LOCALES.some((locale) => locale.code === code)
}
