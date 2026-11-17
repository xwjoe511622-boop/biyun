import { createI18n } from 'vue-i18n'
import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

export const MESSAGES = {
  'zh-CN': zhCN,
  'en-US': enUS,
}
export type MessageLocale = keyof typeof MESSAGES

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages: MESSAGES,
})

/** Translate outside Vue components, respecting the language requested by the caller. */
export function translateForLocale(locale: string, key: string, values: Record<string, unknown> = {}): string {
  const tag = locale.replace('_', '-')
  const language = (Object.keys(MESSAGES) as MessageLocale[]).find(code => code === tag || code.split('-')[0] === tag) ?? 'en-US'
  return i18n.global.t(key, values, { locale: language })
}
