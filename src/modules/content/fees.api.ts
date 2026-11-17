import { z } from 'zod'
import { request } from '@/modules/api/http'
import { Decimal, toDecString } from '@/modules/finance/decimal'
import { list, parseWith, text } from './api-helpers'

/**
 * Public fee schedule. All endpoints are public (no `getUser` check in the controllers).
 *
 * - `PublicAct.java:2694` `fee_info` -> `{pairMapList:[{symbol, TRADE_MAKER_VIP0..9, TRADE_TAKER_VIP0..9}], …}`.
 *   Rates are decimal fractions (0.001 = 0.1%) per spot pair and VIP level (`ExFeeServiceImpl.commonFeeSetting`);
 *   a key is absent when that level is not configured. `withdrawMapList`/`otcFees`/`depositMapList` only cover
 *   fiat coins (and the latter two are copies of the first — server bug at :2711-2712), so they are not shown.
 * - `PublicAct.java:2726` `coins_info` -> `ConfigCoinSymbol[]` (`coinSymbol, name, mainChainName, withdrawMin,
 *   withdrawMax` = amount limits, `depositMin`, `depositOpen`, `withdrawOpen`).
 * - `PublicAct.java:2740` `coins_fee` -> `{ <SYMBOL>: {defaultWithdrawFee, withdrawMin, withdrawMax, depositRate, …} }`
 *   where `withdrawMin/Max` are the min/max withdrawal **fee** (FeeType 900/901), not amount limits.
 * - futures-web-api `PublicController.java:839` `GET common/getMakerAndTaker` ->
 *   `ContractConfig[]` with only `openMakerFee/openTakerFee/closeMakerFee/closeTakerFee/multiplierCoin/marginCoin/
 *   contractSide` populated (the legacy fee page labels rows `multiplierCoin/marginCoin`).
 */
export const FEE_ENDPOINTS = {
  spot: 'fee_info',
  coins: 'coins_info',
  coinFees: 'coins_fee',
  futures: 'common/getMakerAndTaker',
} as const

export const VIP_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export interface SpotFeeRow {
  /** `btcusdt` */
  symbol: string
  /** VIP level -> rate (decimal fraction string); only configured levels are present. */
  maker: Record<number, string>
  taker: Record<number, string>
}

export interface CoinFeeRow {
  coin: string
  name: string
  network: string
  depositOpen: boolean
  withdrawOpen: boolean
  depositMin: string
  withdrawMin: string
  withdrawMax: string
  /** `coins_fee[coin].defaultWithdrawFee`; '' when no fee row is configured. */
  withdrawFee: string
  /** Min/max bound of the withdrawal fee (FeeType 900/901); '' when absent. */
  withdrawFeeMin: string
  withdrawFeeMax: string
}

export interface FuturesFeeRow {
  label: string
  contractSide: string
  openMaker: string
  openTaker: string
  closeMaker: string
  closeTaker: string
}

const rate = z.union([z.number().finite(), z.string()]).nullish().transform((value) => toDecString(value))
const spotSchema = z
  .object({ pairMapList: list(z.record(z.string(), z.unknown())) })
  .passthrough()
const coinSchema = z
  .object({
    coinSymbol: z.string().min(1),
    name: text,
    showName: text,
    mainChainName: text,
    depositOpen: text,
    withdrawOpen: text,
    depositMin: rate,
    withdrawMin: rate,
    withdrawMax: rate,
    isOpen: text,
  })
  .passthrough()
const coinsSchema = list(coinSchema)
const coinFeeSchema = z
  .record(
    z.string(),
    z.object({ defaultWithdrawFee: rate, withdrawMin: rate, withdrawMax: rate }).passthrough().nullable(),
  )
  .nullish()
  .transform((value) => value ?? {})
const futuresSchema = list(
  z
    .object({
      multiplierCoin: text,
      marginCoin: text,
      contractSide: text,
      contractSideDesc: text,
      openMakerFee: rate,
      openTakerFee: rate,
      closeMakerFee: rate,
      closeTakerFee: rate,
    })
    .passthrough(),
)

/** `0.002` -> `0.2` (percent without the sign). Returns '' for missing / non-numeric values. */
export function rateToPercent(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return ''
  return new Decimal(value).times(100).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed()
}

export function normalizeSpotFees(rows: Array<Record<string, unknown>>): SpotFeeRow[] {
  const out: SpotFeeRow[] = []
  for (const row of rows) {
    const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toLowerCase() : ''
    if (symbol === '') continue
    const maker: Record<number, string> = {}
    const taker: Record<number, string> = {}
    for (const level of VIP_LEVELS) {
      const m = toDecString(row[`TRADE_MAKER_VIP${level}`])
      const t = toDecString(row[`TRADE_TAKER_VIP${level}`])
      if (m !== '') maker[level] = m
      if (t !== '') taker[level] = t
    }
    out.push({ symbol, maker, taker })
  }
  return out
}

/** VIP levels that have at least one configured maker or taker rate. */
export function configuredLevels(rows: SpotFeeRow[]): number[] {
  const levels = new Set<number>()
  for (const row of rows) {
    Object.keys(row.maker).forEach((key) => levels.add(Number(key))) // float-ok: VIP level key
    Object.keys(row.taker).forEach((key) => levels.add(Number(key))) // float-ok: VIP level key
  }
  return [...levels].sort((a, b) => a - b)
}

export async function fetchSpotFees(signal?: AbortSignal): Promise<SpotFeeRow[]> {
  const data = await request<unknown>(FEE_ENDPOINTS.spot, { body: {}, signal })
  return normalizeSpotFees(parseWith(spotSchema, FEE_ENDPOINTS.spot, data).pairMapList)
}

export async function fetchCoinFees(signal?: AbortSignal): Promise<CoinFeeRow[]> {
  const [coinsRaw, feesRaw] = await Promise.all([
    request<unknown>(FEE_ENDPOINTS.coins, { body: {}, signal }),
    request<unknown>(FEE_ENDPOINTS.coinFees, { body: {}, signal }),
  ])
  const coins = parseWith(coinsSchema, FEE_ENDPOINTS.coins, coinsRaw)
  const fees = parseWith(coinFeeSchema, FEE_ENDPOINTS.coinFees, feesRaw)
  return coins
    .filter((coin) => coin.isOpen !== '0')
    .map((coin) => {
      const fee = fees[coin.coinSymbol] ?? fees[coin.coinSymbol.toUpperCase()] ?? null
      return {
        coin: coin.coinSymbol.toUpperCase(),
        name: coin.showName !== '' ? coin.showName : coin.name,
        network: coin.mainChainName,
        depositOpen: coin.depositOpen === '1',
        withdrawOpen: coin.withdrawOpen === '1',
        depositMin: coin.depositMin,
        withdrawMin: coin.withdrawMin,
        withdrawMax: coin.withdrawMax,
        withdrawFee: fee?.defaultWithdrawFee ?? '',
        withdrawFeeMin: fee?.withdrawMin ?? '',
        withdrawFeeMax: fee?.withdrawMax ?? '',
      }
    })
}

export async function fetchFuturesFees(signal?: AbortSignal): Promise<FuturesFeeRow[]> {
  const data = await request<unknown>(FEE_ENDPOINTS.futures, { method: 'GET', api: 'futures', signal })
  return parseWith(futuresSchema, FEE_ENDPOINTS.futures, data).map((row) => ({
    label: row.multiplierCoin !== '' && row.marginCoin !== '' ? `${row.multiplierCoin}/${row.marginCoin}` : row.multiplierCoin || row.marginCoin || '--',
    contractSide: row.contractSideDesc !== '' ? row.contractSideDesc : row.contractSide,
    openMaker: row.openMakerFee,
    openTaker: row.openTakerFee,
    closeMaker: row.closeMakerFee,
    closeTaker: row.closeTakerFee,
  }))
}
