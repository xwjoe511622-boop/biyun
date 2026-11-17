import { i18n } from '@/i18n/composer'
import type { PublicInfoV4 } from '@/modules/api/types'
import { networkOptions, readCoinList } from './coins'
import { networkAddressRegex, sameAddress } from './evm'
import { asArray, asRecord, text } from './normalize'
import type { WalletAddress } from './types'

/**
 * Network model shared by deposit, withdraw and the address book.
 *
 * Contract v2 (`WALLET_ADDRESS_WITHDRAW_CONTRACT_20260926.md` §2): `addr/networks` returns
 * `[{ network, displayName, coins, addressRegex, needMemo }]` and withdrawal addresses are saved per
 * network, not per coin. The historical backend has no such endpoint; then the choices come from
 * `public_info_v4` (`followCoinList` branches, or the coin itself) and the address book stays per coin.
 */

export interface WalletNetwork {
  /** Contract network code, e.g. `BSC`. */
  network: string
  displayName: string
  coins: string[]
  /** Omitted by older connectors; an empty list explicitly disables all deposits on this network. */
  depositCoins?: string[]
  addressRegex: string
  needMemo: boolean
  /** §6.1 extras: EVM chain id, per-coin token contracts, checksum rule (`EIP-55`). */
  chainId?: number
  tokenContracts: Record<string, string>
  checksum: string
}

export function normalizeWalletNetworks(data: unknown): WalletNetwork[] {
  const record = asRecord(data)
  const rows = Array.isArray(data) ? data : Array.isArray(record.networks) ? record.networks : null
  if (rows === null) {
    throw new Error(i18n.global.t('serviceMessage.expectedANetworkArrayFromAddrNetworks'))
  }
  return asArray(rows)
    .map((row) => {
      const item = asRecord(row)
      const network = text(item.network).trim().toUpperCase()
      const contracts = asRecord(item.tokenContracts)
      const tokenContracts: Record<string, string> = {}
      Object.keys(contracts).forEach((coin) => {
        const value = text(contracts[coin]).trim()
        if (value !== '') tokenContracts[coin.toUpperCase()] = value
      })
      const chainRaw = text(item.chainId).trim()
      const entry: WalletNetwork = {
        network,
        displayName: text(item.displayName).trim() || network,
        coins: asArray(item.coins).map(coin => text(coin).trim().toUpperCase()).filter(coin => coin !== ''),
        addressRegex: networkAddressRegex(network, text(item.addressRegex), /^\d+$/.test(chainRaw) ? Number.parseInt(chainRaw, 10) : undefined),
        needMemo: item.needMemo === true || text(item.needMemo) === '1' || text(item.needMemo) === 'true',
        tokenContracts,
        checksum: text(item.checksum).trim(),
      }
      if (Object.hasOwn(item, 'assets')) {
        entry.depositCoins = asArray(item.assets).map(asRecord)
          .filter(asset => asset.depositEnabled === true && typeof asset.coin === 'string')
          .map(asset => text(asset.coin).trim().toUpperCase())
          .filter(coin => entry.coins.includes(coin))
      }
      if (/^\d+$/.test(chainRaw)) entry.chainId = Number.parseInt(chainRaw, 10)
      return entry
    })
    .filter(entry => entry.network !== '')
}

/** One selectable network for a coin. */
export interface NetworkChoice {
  /** Stable selection key. */
  id: string
  /** Visible network name. */
  label: string
  /** Secondary label (e.g. `BSC` under `BNB Smart Chain (BEP-20)`). */
  code: string
  /** Symbol used as `symbol` / `coinSymbol` in the CIAO and legacy requests. */
  requestSymbol: string
  /** Contract v2 network code; `''` for the historical per-coin backend. */
  network: string
  addressRegex: string
  needMemo: boolean
  /** Token contract of this coin on the network (§6.1 `tokenContracts`), `''` when not reported. */
  tokenContract: string
}

/**
 * Network choices for `coin`.
 *
 * When `serverNetworks` is a **non-null array** (even empty) it is the authoritative supported set: only the
 * server's networks that list the coin are returned, and a coin not listed yields `[]` — the legacy
 * `public_info_v4` branch map is **not** consulted. The legacy fallback applies only when `serverNetworks`
 * is `null` (the endpoint is absent / the historical backend).
 * Deposit choices use the operation metadata where available; earlier directories still supply `coins`.
 */
export function networkChoicesForCoin(
  publicInfo: PublicInfoV4 | null,
  coin: string,
  serverNetworks: WalletNetwork[] | null,
  operation?: 'deposit',
): NetworkChoice[] {
  if (coin === '') {
    return []
  }
  const upper = coin.toUpperCase()
  if (serverNetworks !== null) {
    return serverNetworks
      .filter(entry => (operation === 'deposit' ? (entry.depositCoins ?? entry.coins) : entry.coins).includes(upper))
      .map(entry => ({
        id: entry.network,
        label: entry.displayName,
        code: entry.network,
        requestSymbol: coin,
        network: entry.network,
        addressRegex: entry.addressRegex,
        needMemo: entry.needMemo,
        tokenContract: entry.tokenContracts[upper] ?? '',
      }))
  }
  const branches = networkOptions(publicInfo, coin)
  if (branches.length > 0) {
    return branches.map(option => ({
      id: option.code,
      label: option.label,
      code: option.code,
      requestSymbol: option.code,
      network: '',
      addressRegex: '',
      needMemo: false,
      tokenContract: '',
    }))
  }
  const entry = readCoinList(publicInfo)[coin] as Record<string, unknown> | undefined
  const chainName = typeof entry?.mainChainName === 'string' ? entry.mainChainName.trim() : ''
  return [{
    id: coin,
    label: chainName !== '' ? chainName : coin,
    code: coin,
    requestSymbol: coin,
    network: '',
    addressRegex: '',
    needMemo: false,
    tokenContract: '',
  }]
}

/**
 * Coins in the authoritative server directory (union across networks). `null` means the directory is not
 * available (historical backend) — callers keep the legacy coin list then.
 */
export function supportedCoins(serverNetworks: WalletNetwork[] | null, operation?: 'deposit'): Set<string> | null {
  if (serverNetworks === null) {
    return null
  }
  const coins = new Set<string>()
  for (const entry of serverNetworks) {
    const available = operation === 'deposit' ? (entry.depositCoins ?? entry.coins) : entry.coins
    for (const coin of available) {
      coins.add(coin.toUpperCase())
    }
  }
  return coins
}

/** Saved addresses usable for a choice: same network (v2) or same chain symbol (historical). */
export function savedAddressesFor(list: WalletAddress[], choice: NetworkChoice | undefined): WalletAddress[] {
  if (choice === undefined) {
    return []
  }
  if (choice.network !== '') {
    return list.filter(entry => (entry.network ?? '').toUpperCase() === choice.network.toUpperCase())
  }
  const symbol = choice.requestSymbol.toUpperCase()
  return list.filter(entry => (entry.network ?? '') === '' && entry.coin === symbol)
}

export function findSavedAddress(list: WalletAddress[], address: string): WalletAddress | undefined {
  const value = address.trim()
  if (value === '') {
    return undefined
  }
  return list.find(entry => entry.tag === '' && sameAddress(entry.address, value))
}

export interface AddressGroup {
  /** `net:BSC` for contract rows, `coin:USDT` for historical per-coin rows. */
  key: string
  title: string
  subtitle: string
  network: string
  coins: string[]
  entries: WalletAddress[]
}

/**
 * Groups the address book by network (contract v2). Historical rows without a network are grouped by
 * their coin instead, and labelled as such, because the old backend never said which network they use.
 */
export function groupAddressesByNetwork(list: WalletAddress[], networks: WalletNetwork[] | null): AddressGroup[] {
  const groups = new Map<string, AddressGroup>()
  for (const entry of list) {
    const network = (entry.network ?? '').toUpperCase()
    const key = network !== '' ? `net:${network}` : `coin:${entry.coin}`
    let group = groups.get(key)
    if (group === undefined) {
      const known = network === '' ? undefined : (networks ?? []).find(item => item.network === network)
      group = {
        key,
        title: network !== '' ? known?.displayName ?? network : entry.coin,
        subtitle: network,
        network,
        coins: known?.coins ?? (network === '' ? [entry.coin] : []),
        entries: [],
      }
      groups.set(key, group)
    }
    group.entries.push(entry)
  }
  return [...groups.values()].sort((left, right) => {
    // Network groups first (the v2 model), then any historical per-coin leftovers.
    const leftLegacy = left.network === '' ? 1 : 0
    const rightLegacy = right.network === '' ? 1 : 0
    return leftLegacy - rightLegacy || left.title.localeCompare(right.title)
  })
}

/**
 * Explorer transaction URL. The server `txidAddr` is preferred (validated by the caller). A BscScan
 * link is only built for a row whose network is known to be `BSC` and whose hash is a 32-byte hex.
 */
const EXPLORERS: Record<string, string> = {
  BSC: 'https://bscscan.com/tx/',
}

export function explorerTxUrl(network: string, txid: string): string {
  const base = EXPLORERS[network.toUpperCase()]
  const hash = txid.trim()
  return base !== undefined && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${base}${hash}` : ''
}

/** Coin → contract network map (only when a coin maps to exactly one network). */
export function coinNetworkMap(networks: WalletNetwork[] | null): Record<string, string> {
  const map: Record<string, string> = {}
  const counts: Record<string, number> = {}
  for (const entry of networks ?? []) {
    for (const coin of entry.coins) {
      counts[coin] = (counts[coin] ?? 0) + 1
      map[coin] = entry.network
    }
  }
  Object.keys(counts).forEach((coin) => {
    if (counts[coin] !== 1) delete map[coin]
  })
  return map
}
