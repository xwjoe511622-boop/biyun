import type { CoinListItem, PublicInfoV4 } from '@/modules/api/types'
import { safeWebUrl } from '@/core/urls'
import { DEFAULT_COIN_PRECISION, DEFAULT_FIAT_PRECISION } from './amounts'

/**
 * OTC-tradable coins come from the spot `common/public_info_v4` coin list (`market.coinList[COIN].otcOpen`),
 * exactly as the legacy hall did (`fiatdeal/center.js#dataProcessin`). Precision:
 * coin amounts → `showPrecision`; fiat amounts → `fiatPrecision[paycoin.toLowerCase()]`
 * (legacy `otcTrade.js#priceFix`), falling back to 2.
 */

export interface OtcCoin {
  coin: string
  showName: string
  icon: string
  coinDp: number
  fiatPrecision: Record<string, number>
  sort: number
}

function precision(value: unknown, fallback: number): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,2}$/.test(text)) return fallback
  return Number.parseInt(text, 10)
}

export function readOtcCoins(publicInfo: PublicInfoV4 | null): OtcCoin[] {
  const coinList = publicInfo?.market?.coinList
  if (coinList === undefined || coinList === null || typeof coinList !== 'object') return []
  return Object.entries(coinList as Record<string, CoinListItem>)
    .filter(([, meta]) => String(meta?.otcOpen ?? '').trim() === '1')
    .map(([key, meta]) => {
      const fiat: Record<string, number> = {}
      const rawFiat = meta.fiatPrecision
      if (rawFiat !== null && typeof rawFiat === 'object') {
        Object.entries(rawFiat as Record<string, unknown>).forEach(([code, value]) => {
          fiat[code.toLowerCase()] = precision(value, DEFAULT_FIAT_PRECISION)
        })
      }
      const coin = (typeof meta.name === 'string' && meta.name !== '' ? meta.name : key).toUpperCase()
      return {
        coin,
        showName: typeof meta.showName === 'string' && meta.showName !== '' ? meta.showName : coin,
        icon: safeWebUrl(meta.icon),
        coinDp: precision(meta.showPrecision, DEFAULT_COIN_PRECISION),
        fiatPrecision: fiat,
        sort: typeof meta.sort === 'number' ? meta.sort : 0,
      }
    })
    .sort((a, b) => a.sort - b.sort)
}

export function fiatDpFor(coin: OtcCoin | undefined, payCoin: string): number {
  if (coin === undefined || payCoin === '') return DEFAULT_FIAT_PRECISION
  return coin.fiatPrecision[payCoin.toLowerCase()] ?? DEFAULT_FIAT_PRECISION
}

export function coinDpFor(coin: OtcCoin | undefined): number {
  return coin?.coinDp ?? DEFAULT_COIN_PRECISION
}
