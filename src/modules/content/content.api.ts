import { z } from 'zod'
import { request } from '@/modules/api/http'
import { idText, list, parseWith, text, count } from './api-helpers'

/**
 * Announcements and CMS articles (all public, POST JSON under `/fe-ex-api/`).
 *
 * Sources (exchange-web-api `com/chainup/exchange/api/`):
 * - `NoticeInfoAct.java:55`  `notice/notice_info_list` body `{page, pageSize, keyword}` ->
 *   `{noticeInfoList:[{id,title,lang,timeLong,content}], count, pageSize, openSearch}`; items come from
 *   `NoticeInfoServiceImpl.java:107-132` ordered `stime desc, ctime desc` (stime = pin time, so pinned
 *   notices are first; no explicit pinned flag is returned). The list title is HTML-encoded.
 * - `NoticeInfoAct.java:111` `notice/notice_info` body `{id}` -> `{noticeInfo:{id,title,content,ctime,lang}}`.
 * - `CmsAct.java:58`  `cms/list` (no body) -> `[{id, articleTypeName, cmsArticleList:[{id,title,fileName}]}]`
 *   (HelpCenter type; the server answers a SystemError when no HelpCenter type exists for the language).
 * - `CmsAct.java:104` `cms/info` body `{fileName}` -> `{articleTypeId,title,content,fileName,ctimeLong}`;
 *   `10044` when the article does not exist.
 * - `CmsAct.java:155` `cms/footer/list` (no body) -> `[{id,title,fileName}]` (terms, privacy, …).
 */
export const CONTENT_ENDPOINTS = {
  noticeList: 'notice/notice_info_list',
  noticeDetail: 'notice/notice_info',
  helpTree: 'cms/list',
  cmsArticle: 'cms/info',
  footerArticles: 'cms/footer/list',
} as const

/** Server code returned by `cms/info` when no article matches the fileName + language. */
export const CMS_ARTICLE_NOT_FOUND = '10044'

export interface NoticeSummary {
  id: string
  title: string
  /** Epoch ms (`timeLong`), or null when missing. */
  time: number | null
  /** Raw HTML body (always sanitized before rendering). */
  content: string
}

export interface NoticePage {
  items: NoticeSummary[]
  count: number
  searchable: boolean
}

export interface NoticeDetail {
  id: string
  title: string
  time: number | null
  content: string
}

export interface CmsLink {
  id: string
  title: string
  fileName: string
}

export interface HelpCategory {
  id: string
  name: string
  articles: CmsLink[]
}

export interface CmsArticle {
  title: string
  content: string
  fileName: string
  time: number | null
  categoryId: string
}

const epoch = z
  .union([z.number().finite(), z.string().regex(/^\d+$/)])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : Number(value))) // float-ok: epoch timestamp

const noticeItem = z.object({ id: idText, title: text, timeLong: epoch, content: text }).passthrough()
const noticeListSchema = z
  .object({ noticeInfoList: list(noticeItem), count, openSearch: text })
  .passthrough()
const noticeDetailSchema = z
  .object({ noticeInfo: z.object({ id: idText, title: text, content: text, ctime: epoch }).passthrough() })
  .passthrough()
const cmsLink = z.object({ id: idText, title: text, fileName: z.string().min(1) }).passthrough()
const helpTreeSchema = list(
  z.object({ id: idText, articleTypeName: text, cmsArticleList: list(cmsLink) }).passthrough(),
)
const cmsArticleSchema = z
  .object({ title: text, content: text, fileName: text, ctimeLong: epoch, articleTypeId: text })
  .passthrough()
const footerSchema = list(cmsLink)

/** Decodes HTML entities in a plain-text field (the list endpoint HTML-encodes titles). */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${value.replace(/</g, '&lt;')}`, 'text/html')
  return doc.body.textContent ?? ''
}

export interface NoticeQuery {
  page: number
  pageSize: number
  keyword?: string
}

export async function fetchNotices(query: NoticeQuery, signal?: AbortSignal): Promise<NoticePage> {
  const body: Record<string, unknown> = { page: query.page, pageSize: query.pageSize }
  const keyword = query.keyword?.trim() ?? ''
  if (keyword !== '') body.keyword = keyword
  const data = await request<unknown>(CONTENT_ENDPOINTS.noticeList, { body, signal })
  const parsed = parseWith(noticeListSchema, CONTENT_ENDPOINTS.noticeList, data)
  return {
    count: parsed.count,
    searchable: parsed.openSearch === '1',
    items: parsed.noticeInfoList.map((item) => ({
      id: item.id,
      title: decodeEntities(item.title),
      time: item.timeLong,
      content: item.content,
    })),
  }
}

export async function fetchNotice(id: string, signal?: AbortSignal): Promise<NoticeDetail> {
  const data = await request<unknown>(CONTENT_ENDPOINTS.noticeDetail, { body: { id: Number(id) }, signal }) // float-ok: notice id
  const parsed = parseWith(noticeDetailSchema, CONTENT_ENDPOINTS.noticeDetail, data)
  const notice = parsed.noticeInfo
  return { id: notice.id, title: decodeEntities(notice.title), time: notice.ctime, content: notice.content }
}

export async function fetchHelpTree(signal?: AbortSignal): Promise<HelpCategory[]> {
  const data = await request<unknown>(CONTENT_ENDPOINTS.helpTree, { body: {}, signal })
  return parseWith(helpTreeSchema, CONTENT_ENDPOINTS.helpTree, data).map((category) => ({
    id: category.id,
    name: category.articleTypeName,
    articles: category.cmsArticleList.map((article) => ({ id: article.id, title: article.title, fileName: article.fileName })),
  }))
}

export async function fetchCmsArticle(fileName: string, signal?: AbortSignal): Promise<CmsArticle> {
  const data = await request<unknown>(CONTENT_ENDPOINTS.cmsArticle, { body: { fileName }, signal })
  const parsed = parseWith(cmsArticleSchema, CONTENT_ENDPOINTS.cmsArticle, data)
  return {
    title: parsed.title,
    content: parsed.content,
    fileName: parsed.fileName === '' ? fileName : parsed.fileName,
    time: parsed.ctimeLong,
    categoryId: parsed.articleTypeId,
  }
}

export async function fetchFooterArticles(signal?: AbortSignal): Promise<CmsLink[]> {
  const data = await request<unknown>(CONTENT_ENDPOINTS.footerArticles, { body: {}, signal })
  return parseWith(footerSchema, CONTENT_ENDPOINTS.footerArticles, data).map((item) => ({
    id: item.id,
    title: item.title,
    fileName: item.fileName,
  }))
}

/** Valid `/notices/:id` param: server ids are positive integers. */
export function isNoticeId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,17}$/.test(value)
}

/** Client-side filter across the already-loaded help tree (the server has no help search endpoint). */
export function searchHelp(categories: HelpCategory[], keyword: string): Array<CmsLink & { category: string }> {
  const needle = keyword.trim().toLowerCase()
  if (needle === '') return []
  const hits: Array<CmsLink & { category: string }> = []
  for (const category of categories) {
    for (const article of category.articles) {
      if (article.title.toLowerCase().includes(needle)) hits.push({ ...article, category: category.name })
    }
  }
  return hits
}
