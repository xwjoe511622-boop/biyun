import type { MarketSymbol } from '@/modules/market/symbols'

/**
 * Market-list categories of the OKX-style pair list (OKX: 全部 / 主流币 / 新币种 / 股票 …), driven only by the admin
 * configuration on `/common/public_info_v4` — no coin or pair list in code (owner 10-22: 「所有交易对不应该硬编码在代码中」):
 *
 * - tag categories: the coin tags the admin defines (KV `coin_tag_categorys`, entries with `use = "1"`) and assigns per
 *   coin (币种配置 › 币种标签). public_info_v4 sends `market.coinList[BASE].coinTag` = the tag's 1-based index (blank =
 *   no tag) and `market.coinTagLangs[lang_key][index]` = its localized label (`coin.tag.<tag_key>` language rows).
 *   Category id `tag:<index>`; label from the current language, then any language, then `#<index>`.
 * - `new`: the admin's per-pair `newcoinFlag` (币对配置 › 新币标记).
 *
 * Listing a new coin under "股票" / "黄金" / "主流币" = assign the tag in the admin; no deploy. A category with no pair in
 * the current list is not shown.
 */
export type PairCategory = string

export const NEW_CATEGORY = 'new'
const TAG_PREFIX = 'tag:'

export interface CategoryTab {
  id: PairCategory
  /** Label from the admin's tag languages; `undefined` = the caller's own label (only `new`). */
  label: string | undefined
}

/** `market.coinTagLangs` of public_info_v4: `lang_key` (e.g. `zh_CN`) -> tag index -> label. */
export type CoinTagLangs = Record<string, Record<string, string> | undefined>

/** The admin tag index of a pair's base coin (`"3"`), or `''` when the coin has no tag. */
export function coinTagOf(entry: MarketSymbol): string {
  const raw = entry.coin?.coinTag
  if (typeof raw !== 'string' && typeof raw !== 'number') return ''
  const tag = String(raw).trim()
  return /^[1-9][0-9]*$/.test(tag) ? tag : ''
}

export function isPairCategory(value: string): boolean {
  return value === NEW_CATEGORY || /^tag:[1-9][0-9]*$/.test(value)
}

export function inCategory(entry: MarketSymbol, category: PairCategory, newPairs: ReadonlySet<string>): boolean {
  if (category === NEW_CATEGORY) return newPairs.has(entry.pair)
  if (!category.startsWith(TAG_PREFIX)) return false
  const tag = coinTagOf(entry)
  return tag !== '' && `${TAG_PREFIX}${tag}` === category
}

/** Label of tag `index` in `apiLang` (`zh_CN`), else the first language that has it, else `#<index>`. */
export function tagLabel(langs: CoinTagLangs | undefined, apiLang: string, index: string): string {
  const pick = (row: Record<string, string> | undefined): string => {
    const value = row?.[index]
    return typeof value === 'string' ? value.trim() : ''
  }
  if (langs !== undefined && langs !== null) {
    const wanted = apiLang.toLowerCase()
    const exact = Object.keys(langs).find((key) => key.toLowerCase() === wanted)
    const own = exact === undefined ? '' : pick(langs[exact])
    if (own !== '') return own
    for (const key of Object.keys(langs).sort()) {
      const other = pick(langs[key])
      if (other !== '') return other
    }
  }
  return `#${index}`
}

/**
 * Tabs for `entries`: one per admin tag that holds at least one pair (tag index order = the admin's order), then
 * `new` when any pair is flagged new.
 */
export function categoryTabs(entries: readonly MarketSymbol[], newPairs: ReadonlySet<string>, langs: CoinTagLangs | undefined,
  apiLang: string): CategoryTab[] {
  const tags = new Set<string>()
  for (const entry of entries) {
    const tag = coinTagOf(entry)
    if (tag !== '') tags.add(tag)
  }
  const tabs: CategoryTab[] = [...tags]
    .sort((left, right) => Number(left) - Number(right)) // float-ok: small integer tag indexes, ordering only
    .map((tag) => ({ id: `${TAG_PREFIX}${tag}`, label: tagLabel(langs, apiLang, tag) }))
  if (entries.some((entry) => newPairs.has(entry.pair))) tabs.push({ id: NEW_CATEGORY, label: undefined })
  return tabs
}
