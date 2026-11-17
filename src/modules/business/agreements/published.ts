import { translateForLocale } from '@/i18n/composer'
/** Owner-authorized BITWINEX product rules. Versioned source is shared by the reading pages and action dialogs. */
import earnZh from './v0.1/earn.zh.html?raw'
import earnEn from './v0.1/earn.en.html?raw'
import loanZh from './v0.1/loan.zh.html?raw'
import loanEn from './v0.1/loan.en.html?raw'
import type { CmsArticle } from '@/modules/content/content.api'
import type { Lang } from '@/modules/business/format'

import { PRODUCT_RULES_VERSION, type PublishedAgreementKind } from './metadata'
const TEXT: Record<PublishedAgreementKind, Record<Lang, string>> = { earn: { zh: earnZh, en: earnEn }, loan: { zh: loanZh, en: loanEn } }
const TITLES = { earn: 'productTerms.simpleEarnAgreement', loan: 'productTerms.cryptoLoanAgreement' }

export function bundledAgreement(kind: PublishedAgreementKind, lang: Lang): CmsArticle {
  return { title: translateForLocale(lang, TITLES[kind]), fileName: `bitwinex-${kind}-rules-v${PRODUCT_RULES_VERSION}-${lang}`, content: TEXT[kind][lang], time: null, categoryId: 'published-product-rules' }
}
