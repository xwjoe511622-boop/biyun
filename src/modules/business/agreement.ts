import { bundledAgreement } from './agreements/published'
import { PRODUCT_RULES_DATE, PRODUCT_RULES_VERSION, type PublishedAgreementKind } from './agreements/metadata'
import type { Lang } from './format'
import { sanitizeHtml } from '@/modules/content/sanitize'
import { fetchCmsArticle, fetchFooterArticles, fetchHelpTree, type CmsArticle, type CmsLink } from '@/modules/content/content.api'

export type AgreementKind = PublishedAgreementKind
export type AgreementCmsStatus = 'published' | 'missing' | 'unavailable' | 'ambiguous' | 'invalid'
export interface AgreementPublication extends CmsArticle {
  source: 'cms' | 'site'
  version: string | null
  versionDate: string | null
  language: Lang
  cmsStatus: AgreementCmsStatus
}
const TITLES: Record<AgreementKind, readonly string[]> = {
  earn: ['理财服务协议', '理财协议', 'simple earn terms', 'simple earn agreement'],
  loan: ['借币服务协议', '借币协议', 'crypto loan agreement', 'loans terms', 'loan agreement'],
}
function matchingAgreements(links: CmsLink[], kind: AgreementKind): CmsLink[] {
  return [...new Map(links.filter(link => TITLES[kind].includes(link.title.trim().toLowerCase())).map(link => [link.fileName, link])).values()]
}
/** Only an unambiguous published product agreement qualifies; general terms are not a substitute. */
export function selectAgreement(links: CmsLink[], kind: AgreementKind): CmsLink | null {
  const matches = matchingAgreements(links, kind)
  return matches.length === 1 ? matches[0] ?? null : null
}
/** The article itself must still identify this product and contain readable text after the same rendering sanitizer. */
export function publishedAgreementArticle(article: CmsArticle, link: CmsLink, kind: AgreementKind): CmsArticle | null {
  if (article.fileName !== link.fileName || !TITLES[kind].includes(article.title.trim().toLowerCase())) return null
  const content = sanitizeHtml(article.content)
  const text = new DOMParser().parseFromString(content, 'text/html').body.textContent ?? ''
  if (text.replace(/[\s\u200b-\u200f\ufeff]/g, '') === '') return null
  return { ...article, content }
}

/** A failed online lookup never impersonates a successful online publication. The authorized site version is explicit. */
export async function loadAgreement(kind: AgreementKind, signal: AbortSignal, lang: Lang = 'zh'): Promise<AgreementPublication | null> {
  const site = (cmsStatus: AgreementCmsStatus): AgreementPublication | null => {
    const raw = bundledAgreement(kind, lang)
    const valid = publishedAgreementArticle(raw, { id: raw.fileName, title: raw.title, fileName: raw.fileName }, kind)
    return valid ? { ...valid, source: 'site', version: PRODUCT_RULES_VERSION, versionDate: PRODUCT_RULES_DATE, language: lang, cmsStatus } : null
  }
  const [tree, footer] = await Promise.allSettled([fetchHelpTree(signal), fetchFooterArticles(signal)])
  if (signal.aborted) throw new DOMException('Agreement request aborted', 'AbortError')
  if (tree.status === 'rejected' || footer.status === 'rejected') return site('unavailable')
  const matches = matchingAgreements([...tree.value.flatMap(category => category.articles), ...footer.value], kind)
  if (matches.length === 0) return site('missing')
  if (matches.length !== 1) return site('ambiguous')
  const link = matches[0]!
  try {
    const article = await fetchCmsArticle(link.fileName, signal)
    if (signal.aborted) throw new DOMException('Agreement request aborted', 'AbortError')
    const valid = publishedAgreementArticle(article, link, kind)
    return valid ? { ...valid, source: 'cms', version: null, versionDate: null, language: lang, cmsStatus: 'published' } : site('invalid')
  } catch (error) {
    if (signal.aborted) throw error
    return site('unavailable')
  }
}
