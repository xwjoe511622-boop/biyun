import type { FuturesContractRaw } from './types'

/**
 * Contract model used by the futures terminal, projected from `common/public_info` `contractList[]`.
 */
export interface FuturesContract {
  id: number
  /** Server contract name, e.g. `E-BTC-USDT`. */
  contractName: string
  /** WebSocket channel symbol, e.g. `e_btcusdt` (legacy `future.js:244-246`). */
  wsSymbol: string
  /** `BTC-USDT` as configured (`ContractPageResultVo.symbol`). */
  symbol: string
  /** `BTCUSDT` for display. */
  displayName: string
  base: string
  quote: string
  marginCoin: string
  contractType: string
  /** 1 = forward/USDT-margined, 0 = inverse. */
  contractSide: number | null
  /** Contract face value in `multiplierCoin` (e.g. `0.001` BTC per contract). */
  multiplier: string
  multiplierCoin: string
  /** Margin exchange rate used by the legacy cost formula (normally `1`). */
  marginRate: string
  minLever: number
  maxLever: number
  pricePrecision: number
  marginCoinPrecision: number
  /** Raw depth precision digits from `coinResultVo.depth` (channel step = list index). */
  depthDigits: string[]
  /** Human step per depth option: digit `n` -> `10^-n` (legacy `fixDepthNumber`). */
  depthSteps: string[]
  capitalStartTime: number | null
  capitalFrequency: number | null
  fundsIn: boolean
  fundsOut: boolean
  minOrderVolume: string
  minOrderMoney: string
  maxLimitVolume: string
  maxMarketVolume: string
  maxMarketMoney: string
  maxLimitMoney: string
  priceRange: string
  sort: number
}

/** `E-BTC-USDT` -> `e_btcusdt`; `''` for names that do not have the `TYPE-BASE-QUOTE` shape. */
export function contractWsSymbol(contractName: string): string {
  const parts = contractName.trim().toLowerCase().split('-')
  if (parts.length !== 3 || parts.some((part) => !/^[a-z0-9]+$/.test(part))) {
    return ''
  }
  return `${parts[0]}_${parts[1]}${parts[2]}`
}

/** Precision digit -> step string: `0` -> `1`, `1` -> `0.1`, `4` -> `0.0001`. */
export function depthDigitToStep(digit: string): string {
  if (!/^\d+$/.test(digit)) {
    return ''
  }
  const places = Number.parseInt(digit, 10)
  if (places <= 0) {
    return '1'
  }
  if (places > 18) {
    return ''
  }
  return `0.${'0'.repeat(places - 1)}1`
}

function splitSymbol(raw: FuturesContractRaw): { base: string; quote: string } {
  if (raw.base !== '' && raw.quote !== '') {
    return { base: raw.base.toUpperCase(), quote: raw.quote.toUpperCase() }
  }
  const parts = raw.contractName.toUpperCase().split('-')
  if (parts.length === 3) {
    return { base: raw.base !== '' ? raw.base.toUpperCase() : parts[1], quote: raw.quote !== '' ? raw.quote.toUpperCase() : parts[2] }
  }
  const fromSymbol = raw.symbol.toUpperCase().split('-')
  return { base: fromSymbol[0] ?? '', quote: fromSymbol[1] ?? '' }
}

export function buildContract(raw: FuturesContractRaw): FuturesContract | null {
  const wsSymbol = contractWsSymbol(raw.contractName)
  if (wsSymbol === '') {
    return null
  }
  const { base, quote } = splitSymbol(raw)
  const digits = raw.coin.depth.filter((digit) => depthDigitToStep(digit) !== '')
  // `['0','0','0']` means "only one level" in the legacy UI (depth.js:58-60).
  const usable = digits.length > 0 && digits.every((digit) => digit === '0') ? ['0'] : digits
  const minLever = raw.minLever !== null && raw.minLever > 0 ? raw.minLever : 1
  const maxLever = raw.maxLever !== null && raw.maxLever >= minLever ? raw.maxLever : minLever
  return {
    id: raw.id,
    contractName: raw.contractName,
    wsSymbol,
    symbol: raw.symbol,
    displayName: `${base}${quote}`,
    base,
    quote,
    marginCoin: raw.marginCoin !== '' ? raw.marginCoin.toUpperCase() : quote,
    contractType: raw.contractType,
    contractSide: raw.contractSide,
    multiplier: raw.multiplier,
    multiplierCoin: raw.multiplierCoin !== '' ? raw.multiplierCoin : base,
    marginRate: raw.marginRate !== '' && raw.marginRate !== '0' ? raw.marginRate : '1',
    minLever,
    maxLever,
    pricePrecision: raw.coin.symbolPricePrecision ?? 2,
    marginCoinPrecision: raw.coin.marginCoinPrecision ?? 4,
    depthDigits: usable,
    depthSteps: usable.map(depthDigitToStep),
    capitalStartTime: raw.capitalStartTime,
    capitalFrequency: raw.capitalFrequency !== null && raw.capitalFrequency > 0 ? raw.capitalFrequency : null,
    fundsIn: raw.coin.fundsInStatus === 1,
    fundsOut: raw.coin.fundsOutStatus === 1,
    minOrderVolume: raw.coin.minOrderVolume,
    minOrderMoney: raw.coin.minOrderMoney,
    maxLimitVolume: raw.coin.maxLimitVolume,
    maxMarketVolume: raw.coin.maxMarketVolume,
    maxMarketMoney: raw.coin.maxMarketMoney,
    maxLimitMoney: raw.coin.maxLimitMoney,
    priceRange: raw.coin.priceRange,
    sort: raw.sort,
  }
}

export function buildContracts(rows: FuturesContractRaw[]): FuturesContract[] {
  return rows
    .map(buildContract)
    .filter((entry): entry is FuturesContract => entry !== null)
    .sort((left, right) => left.sort - right.sort)
}

/** `BTCUSDT` preferred, otherwise the first contract. */
export function pickDefaultContract(contracts: FuturesContract[], preferred?: string | null): FuturesContract | undefined {
  if (preferred !== undefined && preferred !== null && preferred !== '') {
    const saved = contracts.find((entry) => entry.contractName === preferred)
    if (saved !== undefined) return saved
  }
  return contracts.find((entry) => entry.base === 'BTC') ?? contracts[0]
}
