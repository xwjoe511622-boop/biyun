import type { CoinListItem, PublicInfoV4 } from '@/modules/api/types'
import { isDecimalString, isZero, toDecString } from '@/modules/finance/decimal'

/**
 * Coin/network metadata is read from `/common/public_info_v4` (`market.coinList`), the only
 * server-provided source for display names, precision, tag coins and the multi-main-chain branch
 * map. Nothing here is hard-coded per coin.
 */

export interface CoinMeta {
  coin: string
  /** `coinList[coin].showName` when present, otherwise the symbol. */
  showName: string
  /** Display/validation decimals; falls back to 8 when the server omits it. */
  showPrecision: number
  isFiat: boolean
  /** `1` = coin exists on more than one main chain (legacy `haveBranch`). */
  mainChainType: number
  /** `1`/`2` = the address carries a memo/tag (legacy `isHavePage`). */
  tagType: number
  sort: number
}

export interface NetworkOption {
  /** Chain symbol used as `symbol` / `coinSymbol` in wallet requests. */
  code: string
  label: string
}

function asCoinMap(value: unknown): Record<string, CoinListItem> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, CoinListItem>)
    : {}
}

export function readCoinList(publicInfo: PublicInfoV4 | null): Record<string, CoinListItem> {
  return asCoinMap(publicInfo?.market?.coinList)
}

export function readFollowCoinList(
  publicInfo: PublicInfoV4 | null,
): Record<string, Record<string, CoinListItem>> {
  const raw = publicInfo?.market?.followCoinList
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return {}
  }
  const result: Record<string, Record<string, CoinListItem>> = {}
  Object.keys(raw as Record<string, unknown>).forEach((coin) => {
    result[coin] = asCoinMap((raw as Record<string, unknown>)[coin])
  })
  return result
}

function integer(value: unknown, fallback: number): number {
  const raw = toDecString(value)
  if (!/^\d+$/.test(raw)) {
    return fallback
  }
  return Number.parseInt(raw, 10)
}

function metaFrom(coin: string, entry: CoinListItem | undefined): CoinMeta {
  return {
    coin,
    showName: typeof entry?.showName === 'string' && entry.showName !== '' ? entry.showName : coin,
    showPrecision: integer(entry?.showPrecision, 8),
    isFiat: integer(entry?.isFiat, 0) === 1,
    mainChainType: integer(entry?.mainChainType, 0),
    tagType: integer(entry?.tagType, 0),
    sort: integer(entry?.sort, 0),
  }
}

export function coinMeta(publicInfo: PublicInfoV4 | null, coin: string): CoinMeta {
  return metaFrom(coin, readCoinList(publicInfo)[coin])
}

/** Branch entry (main-chain variant) when the coin has multiple chains; otherwise the coin itself. */
export function coinMetaForBranch(
  publicInfo: PublicInfoV4 | null,
  coin: string,
  branch: string,
): CoinMeta {
  if (branch === '') {
    return coinMeta(publicInfo, coin)
  }
  const branchEntry = readFollowCoinList(publicInfo)[coin]?.[branch]
  return metaFrom(branch, branchEntry ?? readCoinList(publicInfo)[coin])
}

export function coinDisplayName(publicInfo: PublicInfoV4 | null, coin: string): string {
  return coinMeta(publicInfo, coin).showName
}

/**
 * Network selector options. Empty when the coin is single-chain (`mainChainType !== 1`), which is
 * the legacy `haveBranch` rule from `mainChainMixins.js`.
 */
export function networkOptions(publicInfo: PublicInfoV4 | null, coin: string): NetworkOption[] {
  const meta = coinMeta(publicInfo, coin)
  if (meta.mainChainType !== 1) {
    return []
  }
  const branches = readFollowCoinList(publicInfo)[coin]
  if (branches === undefined) {
    return []
  }
  return Object.keys(branches).map((code) => {
    const entry = branches[code]
    const label = typeof entry.mainChainName === 'string' && entry.mainChainName !== ''
      ? entry.mainChainName
      : code
    return { code, label }
  })
}

/** Default branch, mirroring `branchInit`: the coin's own symbol when listed, else the first. */
export function defaultNetwork(publicInfo: PublicInfoV4 | null, coin: string): string {
  const options = networkOptions(publicInfo, coin)
  if (options.length === 0) {
    return coin
  }
  return options.some(option => option.code === coin) ? coin : options[0].code
}

export interface CoinRow {
  coin: string
  showName: string
  available: string
  locked: string
  total: string
  btcValuation: string
  /** `false` only when the server explicitly returned `0`. `null` = not reported. */
  depositOpen: boolean | null
  withdrawOpen: boolean | null
  isFiat: boolean
}

function openFlag(value: unknown): boolean | null {
  const raw = toDecString(value)
  if (raw === '0') {
    return false
  }
  if (raw === '1') {
    return true
  }
  return null
}

function cleanDec(value: unknown): string {
  const raw = toDecString(value)
  return isDecimalString(raw) ? raw : ''
}

/** True when every reported balance of the row is zero. Unknown (`''`) values never count as zero. */
export function isZeroRow(row: CoinRow): boolean {
  const values = [row.available, row.locked, row.total].filter(value => value !== '')
  return values.length > 0 && values.every(value => isZero(value))
}

export function buildCoinRows(
  allCoinMap: Record<string, { [key: string]: unknown }> | undefined,
  publicInfo: PublicInfoV4 | null,
): CoinRow[] {
  if (allCoinMap === undefined) {
    return []
  }
  return Object.keys(allCoinMap)
    .map((key) => {
      const entry = allCoinMap[key]
      const coin = String(entry.coinName ?? key).toUpperCase()
      const meta = coinMeta(publicInfo, coin)
      // The legacy selectors skip a coin when either the balance entry or the coin list marks it fiat.
      const entryFiat = integer(entry.isFiat, 0) === 1
      return {
        coin,
        showName: meta.showName,
        available: cleanDec(entry.normal_balance),
        locked: cleanDec(entry.lock_balance),
        total: cleanDec(entry.total_balance),
        btcValuation: cleanDec(entry.btcValuatin),
        depositOpen: openFlag(entry.depositOpen),
        withdrawOpen: openFlag(entry.withdrawOpen),
        isFiat: entryFiat || meta.isFiat,
      }
    })
    .filter(row => !row.isFiat)
    .sort((left, right) => left.coin.localeCompare(right.coin))
}

/**
 * Coins offered by the wallet selectors: only coins the balance snapshot actually returned and
 * the backend did not mark as fiat. `depositOpen`/`withdrawOpen` are resolved by the callers.
 */
export function walletCoins(
  allCoinMap: Record<string, { [key: string]: unknown }> | undefined,
  publicInfo: PublicInfoV4 | null,
): CoinRow[] {
  return buildCoinRows(allCoinMap, publicInfo)
}
