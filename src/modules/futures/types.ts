import { canonicalDecimal, isDecimalString, toDecString } from '@/modules/finance/decimal'
import { signedDec } from './signed'

/**
 * Futures payloads, normalised from the futures-web-api responses. Field names follow the Java VOs
 * (paths in `endpoints.ts`); every money/price value becomes a decimal string, missing values
 * become `''` and render as `--`. Nothing is defaulted to a made-up number.
 */

export type Obj = Record<string, unknown>

export function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Non-negative decimal string, `''` otherwise. */
export function udec(value: unknown): string {
  const text = canonicalDecimal(toDecString(value))
  return isDecimalString(text) ? text : ''
}

export function int(value: unknown): number | null {
  const text = toDecString(value)
  if (!/^-?\d+$/.test(text)) {
    return null
  }
  const parsed = Number.parseInt(text, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function list(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter(isObj) : []
}

/* ------------------------------------------------------------------ public_info */

/** `common/public_info` -> `contractList[]` (`ContractPageResultVo` + `CoinResultVo`). */
export interface FuturesContractRaw {
  id: number
  contractName: string
  symbol: string
  contractType: string
  contractSide: number | null
  multiplier: string
  multiplierCoin: string
  marginCoin: string
  marginRate: string
  base: string
  quote: string
  maxLever: number | null
  minLever: number | null
  capitalStartTime: number | null
  capitalFrequency: number | null
  sort: number
  coin: {
    symbolPricePrecision: number | null
    marginCoinPrecision: number | null
    depth: string[]
    minOrderVolume: string
    minOrderMoney: string
    maxMarketVolume: string
    maxMarketMoney: string
    maxLimitVolume: string
    maxLimitMoney: string
    priceRange: string
    fundsInStatus: number | null
    fundsOutStatus: number | null
  }
}

export interface FuturesPublicInfo {
  contractList: FuturesContractRaw[]
  /** Complete broker metadata, including delisted contracts; never used as the new-order selector. */
  allContractList?: FuturesContractRaw[]
  wsUrl: string
  marginCoinList: string[]
  currentTimeMillis: number | null
}

function normalizeContractRows(value: unknown): FuturesContractRaw[] {
  const contractList: FuturesContractRaw[] = []
  list(value).forEach((item) => {
    const id = int(item.id)
    const contractName = str(item.contractName).trim()
    if (id === null || contractName === '') return
    const coin = isObj(item.coinResultVo) ? item.coinResultVo : {}
    contractList.push({
      id,
      contractName,
      symbol: str(item.symbol),
      contractType: str(item.contractType),
      contractSide: int(item.contractSide),
      multiplier: udec(item.multiplier),
      multiplierCoin: str(item.multiplierCoin),
      marginCoin: str(item.marginCoin),
      marginRate: udec(item.marginRate),
      base: str(item.base),
      quote: str(item.quote),
      maxLever: int(item.maxLever),
      minLever: int(item.minLever),
      capitalStartTime: int(item.capitalStartTime),
      capitalFrequency: int(item.capitalFrequency),
      sort: int(item.sort) ?? 0,
      coin: {
        symbolPricePrecision: int(coin.symbolPricePrecision),
        marginCoinPrecision: int(coin.marginCoinPrecision),
        depth: Array.isArray(coin.depth) ? coin.depth.map(str).filter((entry) => entry !== '') : [],
        minOrderVolume: udec(coin.minOrderVolume),
        minOrderMoney: udec(coin.minOrderMoney),
        maxMarketVolume: udec(coin.maxMarketVolume),
        maxMarketMoney: udec(coin.maxMarketMoney),
        maxLimitVolume: udec(coin.maxLimitVolume),
        maxLimitMoney: udec(coin.maxLimitMoney),
        priceRange: udec(coin.priceRange),
        fundsInStatus: int(coin.fundsInStatus),
        fundsOutStatus: int(coin.fundsOutStatus),
      },
    })
  })
  return contractList
}

export function normalizePublicInfo(data: unknown): FuturesPublicInfo {
  const root = isObj(data) ? data : {}
  const contractList = normalizeContractRows(root.contractList)

  return {
    contractList,
    allContractList: root.allContractList === undefined ? contractList : normalizeContractRows(root.allContractList),
    wsUrl: str(root.wsUrl).trim(),
    marginCoinList: Array.isArray(root.marginCoinList) ? root.marginCoinList.map(str).filter((c) => c !== '') : [],
    currentTimeMillis: int(root.currentTimeMillis),
  }
}

/** `common/public_market_info` (`PublicController.java:188`). Rates are signed ratios. */
export interface FuturesMarketInfo {
  tagPrice: string
  indexPrice: string
  currentFundRate: string
  nextFundRate: string
}

export function normalizeMarketInfo(data: unknown): FuturesMarketInfo {
  const root = isObj(data) ? data : {}
  const positive = (value: unknown): string => {
    const text = udec(value)
    // The controller answers zeros when the RPC fails (it never reports the failure): treat 0 as missing.
    return text === '' || text === '0' ? '' : text
  }
  return {
    tagPrice: positive(root.tagPrice),
    indexPrice: positive(root.indexPrice),
    currentFundRate: signedDec(root.currentFundRate),
    nextFundRate: signedDec(root.nextFundRate),
  }
}

/** `common/funding_rate_list` rows: `{ ctime, amount (settle rate), contractName }`. */
export interface FundingRateRow {
  ctime: number | null
  rate: string
  contractName: string
}

export interface FundingRateList {
  line: FundingRateRow[]
  history: FundingRateRow[]
  count: number
}

function fundingRows(value: unknown): FundingRateRow[] {
  return list(value).map((row) => ({ ctime: int(row.ctime), rate: signedDec(row.amount), contractName: str(row.contractName) }))
}

export function normalizeFundingRateList(data: unknown): FundingRateList {
  const root = isObj(data) ? data : {}
  return {
    line: fundingRows(root.brokenLineList),
    history: fundingRows(root.historyList),
    count: int(root.count) ?? 0,
  }
}

/** `common/getMakerAndTaker` rows (`ContractConfig` fee subset, no contract id). */
export interface FeeRow {
  contractSide?: number | null
  openMakerFee: string
  openTakerFee: string
  closeMakerFee: string
  closeTakerFee: string
  multiplier: string
  /** Base coin of the contract the row belongs to (the only way to match a row to a contract). */
  multiplierCoin: string
  marginCoin: string
}

export function normalizeFeeRows(data: unknown): FeeRow[] {
  return list(data).map((row) => ({
    contractSide: int(row.contractSide),
    openMakerFee: signedDec(row.openMakerFee),
    openTakerFee: signedDec(row.openTakerFee),
    closeMakerFee: signedDec(row.closeMakerFee),
    closeTakerFee: signedDec(row.closeTakerFee),
    multiplier: udec(row.multiplier),
    multiplierCoin: str(row.multiplierCoin),
    marginCoin: str(row.marginCoin),
  }))
}

/* ------------------------------------------------------------------ user */

/** `user/get_user_config` (`UserConfigResultVo`). */
export interface FuturesUserConfig {
  marginModel: 1 | 2 | null
  marginModelCanSwitch: boolean
  nowLevel: number | null
  minLevel: number | null
  maxLevel: number | null
  userMaxLevel: number | null
  levelCanSwitch: boolean
  openContract: boolean
  transStatus: number | null
  coUnit: number | null
  pcSecondConfirm: number | null
  /** Server says no position and no open order on any contract (`positionModelCanSwitch` 1): the position mode may change. */
  positionModelCanSwitch: boolean
  currentTimeMillis: number | null
  expireTime: number | null
  /** leverage upper bound -> max position value at that leverage (`leverOriginCeiling`). */
  leverCeiling: Record<string, string>
}

export function normalizeUserConfig(data: unknown): FuturesUserConfig {
  const root = isObj(data) ? data : {}
  const model = int(root.marginModel)
  const ceiling: Record<string, string> = {}
  const rawCeiling = isObj(root.leverOriginCeiling) ? root.leverOriginCeiling : isObj(root.leverCeiling) ? root.leverCeiling : {}
  Object.entries(rawCeiling).forEach(([key, value]) => {
    const amount = udec(value)
    if (/^\d+$/.test(key) && amount !== '') ceiling[key] = amount
  })
  return {
    marginModel: model === 1 || model === 2 ? model : null,
    marginModelCanSwitch: int(root.marginModelCanSwitch) === 1,
    nowLevel: int(root.nowLevel),
    minLevel: int(root.minLevel),
    maxLevel: int(root.maxLevel),
    userMaxLevel: int(root.userMaxLevel),
    levelCanSwitch: int(root.levelCanSwitch) === 1,
    openContract: int(root.openContract) === 1,
    transStatus: int(root.transStatus),
    coUnit: int(root.coUnit),
    pcSecondConfirm: int(root.pcSecondConfirm),
    positionModelCanSwitch: int(root.positionModelCanSwitch) === 1,
    currentTimeMillis: int(root.currentTimeMillis),
    expireTime: int(root.expireTime),
    leverCeiling: ceiling,
  }
}

/* ------------------------------------------------------------------ assets */

/** `position/get_assets_list` -> `positionList[]` (`PositionResultVo`). */
export interface FuturesPosition {
  id: number
  contractId: number
  contractName: string
  symbol: string
  positionType: 1 | 2 | null
  orderSide: 'BUY' | 'SELL' | ''
  positionVolume: string
  canCloseVolume: string
  openAvgPrice: string
  /** The VO calls the mark price `indexPrice` ("标记价格"). */
  markPrice: string
  reducePrice: string
  holdAmount: string
  marginRate: string
  keepRate: string
  /** Exact maintenance from the same server risk snapshot as reducePrice; absent on older legacy responses. */
  maintenanceMargin?: string
  /** Highest close fee rate (`maxFeeRate`), used by the isolated liquidation formula. */
  maxFeeRate: string
  realizedAmount: string
  unRealizedAmount: string
  openRealizedAmount: string
  /** PnL of the open volume already moved into the margin balance by the per-minute settlement (open_price -> avg_price). */
  settleProfit: string
  returnRate: string
  leverageLevel: number | null
  positionBalance: string
  canSubMarginAmount: string
  capitalFee: string
  tradeFee: string
  takeProfitPrice: string
  stopLossPrice: string
}

/** `accountList[]` (`AccountResultVo`). */
export interface FuturesAccount {
  symbol: string
  totalAmount: string
  totalEquities: string
  isolatedEquities: string
  canUseAmount: string
  /** futures→spot transferable (server, Binance rule; unrealized profit excluded). `''` on servers before 2026-09-29. */
  transferableAmount: string
  /** Part of the free balance that only exists because of unrealized profit (not transferable). */
  transferHeldProfit: string
  totalMargin: string
  isolateMargin: string
  lockAmount: string
  realizedAmount: string
  /** Cumulative close-only PnL for this margin coin; absent on older servers, never inferred from equity. */
  cumulativeClosedPnl?: string
  currentPositionRealizedAmount?: string
  unRealizedAmount: string
  totalMarginRate: string
}

export interface FuturesAssets {
  positions: FuturesPosition[]
  accounts: FuturesAccount[]
}

function side(value: unknown): 'BUY' | 'SELL' | '' {
  const text = str(value).toUpperCase()
  return text === 'BUY' || text === 'SELL' ? text : ''
}

export function normalizeAssets(data: unknown): FuturesAssets {
  const root = isObj(data) ? data : {}
  const positions: FuturesPosition[] = []
  list(root.positionList).forEach((row) => {
    const id = int(row.id)
    const contractId = int(row.contractId)
    if (id === null || contractId === null) return
    const type = int(row.positionType)
    positions.push({
      id,
      contractId,
      contractName: str(row.contractName),
      symbol: str(row.symbol),
      positionType: type === 1 || type === 2 ? type : null,
      orderSide: side(row.orderSide),
      positionVolume: udec(row.positionVolume),
      canCloseVolume: udec(row.canCloseVolume),
      openAvgPrice: udec(row.openAvgPrice),
      markPrice: udec(row.indexPrice),
      reducePrice: signedDec(row.reducePrice),
      holdAmount: signedDec(row.holdAmount),
      marginRate: signedDec(row.marginRate),
      keepRate: signedDec(row.keepRate),
      maxFeeRate: signedDec(row.maxFeeRate),
      realizedAmount: signedDec(row.realizedAmount),
      unRealizedAmount: signedDec(row.unRealizedAmount),
      openRealizedAmount: signedDec(row.openRealizedAmount),
      settleProfit: signedDec(row.settleProfit),
      returnRate: signedDec(row.returnRate),
      leverageLevel: int(row.leverageLevel),
      positionBalance: signedDec(row.positionBalance),
      canSubMarginAmount: signedDec(row.canSubMarginAmount),
      capitalFee: signedDec(row.capitalFee),
      tradeFee: signedDec(row.tradeFee),
      takeProfitPrice: udec(row.takeProfitPrice),
      stopLossPrice: udec(row.stopLossPrice),
    })
  })
  const accounts = list(root.accountList).map((row) => ({
    symbol: str(row.symbol),
    totalAmount: signedDec(row.totalAmount),
    totalEquities: signedDec(row.totalEquities),
    isolatedEquities: signedDec(row.isolatedEquities),
    canUseAmount: signedDec(row.canUseAmount),
    transferableAmount: signedDec(row.transferableAmount),
    transferHeldProfit: signedDec(row.transferHeldProfit),
    totalMargin: signedDec(row.totalMargin),
    isolateMargin: signedDec(row.isolateMargin),
    lockAmount: signedDec(row.lockAmount),
    realizedAmount: signedDec(row.realizedAmount),
    cumulativeClosedPnl: signedDec(row.cumulativeClosedPnl),
    currentPositionRealizedAmount: signedDec(row.currentPositionRealizedAmount),
    unRealizedAmount: signedDec(row.unRealizedAmount),
    totalMarginRate: signedDec(row.totalMarginRate),
  }))
  return { positions, accounts }
}

/* ------------------------------------------------------------------ orders */

/** `order/current_order_list` / `history_order_list` -> `orderList[]` (`OrderController.formatOrder`). */
export interface FuturesOrder {
  id: string
  contractId: number | null
  contractName: string
  side: 'BUY' | 'SELL' | ''
  open: 'OPEN' | 'CLOSE' | ''
  type: number | null
  positionType: number | null
  price: string
  avgPrice: string
  volume: string
  dealVolume: string
  status: number | null
  tradeFee: string
  realizedAmount: string
  orderBalance: string
  memo: string
  liqPositionMsg: string
  ctime: number | null
  mtime: number | null
  /**
   * 'MARKET': the user placed a MARKET order that the server sent to the engine as an IOC limit at a protective price
   * (`type` stays 3; classic rows carry `origType` since fgw 0.8.9 / core 0.11.6). Shown as 市价.
   */
  origType?: string
  /** `/fapi` rows only: `volume` is contracts even for a MARKET OPEN (classic type-2 OPEN rows: the USDT value). */
  volumeIsContracts?: boolean
}

/** A market order: vendor type 2, or a MARKET order emulated as an IOC limit (`origType`). */
export function isMarketOrder(order: { type: number | null; origType?: string }): boolean {
  return order.type === 2 || order.origType === 'MARKET'
}

function openKind(value: unknown): 'OPEN' | 'CLOSE' | '' {
  const text = str(value).toUpperCase()
  return text === 'OPEN' || text === 'CLOSE' ? text : ''
}

function orderId(value: unknown): string {
  const text = str(value)
  return /^\d+$/.test(text) ? text : ''
}

export function normalizeOrders(data: unknown, key = 'orderList'): { rows: FuturesOrder[]; count: number } {
  const root = isObj(data) ? data : {}
  const rows: FuturesOrder[] = []
  list(root[key]).forEach((row) => {
    const id = orderId(row.id)
    if (id === '') return
    rows.push({
      id,
      contractId: int(row.contractId),
      contractName: str(row.contractName),
      side: side(row.side),
      open: openKind(row.open),
      type: int(row.type),
      positionType: int(row.positionType),
      price: udec(row.price),
      avgPrice: udec(row.avgPrice),
      volume: udec(row.volume),
      dealVolume: udec(row.dealVolume),
      status: int(row.status),
      tradeFee: signedDec(row.tradeFee),
      realizedAmount: signedDec(row.realizedAmount),
      orderBalance: signedDec(row.orderBalance),
      memo: str(row.memo),
      liqPositionMsg: str(row.liqPositionMsg),
      ctime: int(row.ctime),
      mtime: int(row.mtime),
      ...(str(row.origType) === 'MARKET' ? { origType: 'MARKET' } : {}),
    })
  })
  return { rows, count: int(root.count) ?? rows.length }
}

/** `order/trigger_order_list` / `history_trigger_order_list` -> `trigOrderList[]` (`formatTriggerOrder`). */
export interface FuturesTriggerOrder {
  id: string
  contractId: number | null
  contractName: string
  side: 'BUY' | 'SELL' | ''
  open: 'OPEN' | 'CLOSE' | ''
  /** Order type once triggered: 1 limit, 2 market (`timeInForce`). */
  type: number | null
  triggerType: number | null
  triggerPrice: string
  price: string
  volume: string
  status: number | null
  memo: string
  expireTime: number | null
  ctime: number | null
  mtime: number | null
  /** `/fapi` rows only: the price the trigger watches (classic rows: last price). */
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  /** `/fapi` rows only: TP/SL for the entire position (`closePosition=true`). */
  closePosition?: boolean
  /** `/fapi` rows only: `volume` is contracts even for a market OPEN (classic: the USDT value). */
  volumeIsContracts?: boolean
  /** `/fapi` rows only: fires when the watched price is ≥ (`up`) or ≤ (`down`) `triggerPrice`. */
  direction?: 'up' | 'down'
}

export function normalizeTriggerOrders(data: unknown): { rows: FuturesTriggerOrder[]; count: number } {
  const root = isObj(data) ? data : {}
  const rows: FuturesTriggerOrder[] = []
  list(root.trigOrderList).forEach((row) => {
    const id = orderId(row.id)
    if (id === '') return
    rows.push({
      id,
      contractId: int(row.contractId),
      contractName: str(row.contractName),
      side: side(row.side),
      open: openKind(row.open),
      type: int(row.type ?? row.timeInForce),
      triggerType: int(row.triggerType),
      triggerPrice: udec(row.triggerPrice),
      price: udec(row.price),
      volume: udec(row.volume),
      status: int(row.status),
      memo: str(row.memo),
      expireTime: int(row.expireTime),
      ctime: int(row.ctime),
      mtime: int(row.mtime),
    })
  })
  return { rows, count: int(root.count) ?? rows.length }
}

/** `order/his_trade_list` -> `tradeHisList[]` (`OrderController.formatTrade`). */
export interface FuturesTrade {
  id: string
  contractName: string
  side: 'BUY' | 'SELL' | ''
  open: 'OPEN' | 'CLOSE' | ''
  price: string
  volume: string
  fee: string
  feeCoin: string
  role: string
  ctime: number | null
  /** 'MARKET': the fill of a market order (vendor type 2 or a MARKET order emulated as an IOC limit; fgw 0.8.9). */
  origType?: string
}

export function normalizeTrades(data: unknown, key = 'tradeHisList'): { rows: FuturesTrade[]; count: number } {
  const root = isObj(data) ? data : {}
  const rows: FuturesTrade[] = []
  list(root[key]).forEach((row) => {
    const id = orderId(row.id)
    if (id === '') return
    rows.push({
      id,
      contractName: str(row.contractName),
      side: side(row.side),
      open: openKind(row.open),
      price: udec(row.price),
      volume: udec(row.volume),
      fee: signedDec(row.fee),
      feeCoin: str(row.feeCoin),
      role: str(row.role),
      ctime: int(row.ctime),
      ...(str(row.origType) === 'MARKET' ? { origType: 'MARKET' } : {}),
    })
  })
  return { rows, count: int(root.count) ?? rows.length }
}

/** `record/get_transaction_list` -> `transList[]` (`RecordController.formatTransMap`). */
export interface FuturesTransaction {
  id: string
  contractName: string
  /** Server-translated scene label. */
  type: string
  /** Signed amount string (`+12.5` / `-3`). */
  amount: string
  /** Server-formatted time (`yyyy-MM-dd HH:mm:ss`). */
  ctime: string
}

export function normalizeTransactions(data: unknown): { rows: FuturesTransaction[]; count: number } {
  const root = isObj(data) ? data : {}
  const rows = list(root.transList).map((row) => ({
    id: str(row.id),
    contractName: str(row.contractName),
    type: str(row.type),
    amount: signedDec(str(row.amount).replace(/^\+/, '')),
    ctime: str(row.ctime),
  }))
  return { rows, count: int(root.count) ?? rows.length }
}

/** `order/take_profit_stop_loss` (`formatTPSLTriggerOrder`). */
export interface TpslRow {
  id: string
  triggerPrice: string
  price: string
  volume: string
  status: number | null
}

export function normalizeTpsl(data: unknown): { takeProfit: TpslRow[]; stopLoss: TpslRow[] } {
  const root = isObj(data) ? data : {}
  const map = (value: unknown): TpslRow[] => list(value).map((row) => ({
    id: orderId(row.id), triggerPrice: udec(row.triggerPrice), price: udec(row.price), volume: udec(row.volume), status: int(row.status),
  })).filter((row) => row.id !== '')
  return { takeProfit: map(root.takeProfitList), stopLoss: map(root.stopLossList) }
}
