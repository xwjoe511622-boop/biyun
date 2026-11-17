import { i18n, MESSAGES, type MessageLocale } from './composer'
import { setLanguageProvider } from '@/modules/api/http'
import { defaultBrand } from '@/config/runtime'
import { LOCALES, isSupportedLocale, type LocaleOption } from './catalog'

export { LOCALES, isSupportedLocale, type LocaleOption }

const LOCALE_STORAGE_KEY = 'picat.ui.locale'

/** The language picked in the header survives reloads and new tabs (storage may be unavailable). */
function readSavedLocale(): string | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY)
    return value !== null && LOCALES.some((locale) => locale.code === value) ? value : null
  } catch {
    return null
  }
}

function initialLocale(): MessageLocale {
  const fromQuery = new URLSearchParams(window.location.search).get('lang')
  if (fromQuery !== null && isSwitchable(fromQuery)) {
    return fromQuery
  }
  const saved = readSavedLocale()
  if (saved !== null && isSwitchable(saved)) return saved
  const brandDefault = defaultBrand.defaultLocale
  return isSwitchable(brandDefault) ? brandDefault : 'zh-CN'
}

/** Listed in the catalog and backed by a message file (both are required to switch). */
function isSwitchable(code: string): code is MessageLocale {
  return isSupportedLocale(code) && Object.prototype.hasOwnProperty.call(MESSAGES, code)
}

export { i18n }
i18n.global.locale.value = initialLocale()

document.documentElement.lang = i18n.global.locale.value

/** `zh-CN` -> `zh_CN` for the `exchange-language` header. */
export function apiLanguage(code: string = i18n.global.locale.value): string {
  const match = LOCALES.find((locale) => locale.code === code)
  return match === undefined ? 'zh_CN' : match.apiValue
}

export function currentLocale(): string {
  return i18n.global.locale.value
}

export function setLocale(code: string): void {
  if (!isSwitchable(code)) {
    return
  }
  i18n.global.locale.value = code
  document.documentElement.lang = code
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code)
  } catch {
    /* Private mode / blocked storage: the choice lasts for this page only. */
  }
}

/** The HTTP layer reads the locale lazily so requests always use the active language. */
setLanguageProvider(() => apiLanguage())
