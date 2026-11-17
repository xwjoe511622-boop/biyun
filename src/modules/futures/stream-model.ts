import { Decimal, canonicalDecimal, isDecimalString } from '@/modules/finance/decimal'
import type { FuturesContract } from './contracts'
import type { FapiAccount, FapiOpenOrder, FapiPositionRisk } from './fapi'
import { isSignedDecimal, signedDec } from './signed'
import type { FuturesAccount, FuturesOrder, FuturesPosition } from './types'
import { udec } from './types'

/**
 * User-stream / `/fapi` snapshot → the legacy row shapes the futures UI renders (`FuturesPosition`, `FuturesAccount`,
 * `FuturesOrder`). Pure functions; the live store (`stores/futures-live.ts`) owns the state.
 *
 * Units: the stream and snapshots use Binance symbols (`BTCUSDT`) and quantities in COIN; the UI keeps contracts
 * (`E-BTC-USDT`, coin = contracts × multiplier). Field equality with `position/get_assets_list` was checked on B on
 * 2026-10-01 (cross and isolated): holdAmount (cross) = account totalMargin, holdAmount (isolated) = isolatedWallet,
 * marginRate = holdAmount ÷ notional, totalMargin = marginBalance − isolated − openOrderInitialMargin,
 * totalMarginRate = marginBalance ÷ Σ notional, canUseAmount = availableBalance, transferable = maxWithdrawAmount.
 *
 * Fields the snapshots do not carry stay with the legacy endpoint (`LEGACY_POSITION_FIELDS`).
 */

/** Position fields only `position/get_assets_list` knows; kept from the last legacy read. */
export const LEGACY_POSITION_FIELDS = [
  'id', 'realizedAmount', 'tradeFee', 'capitalFee', 'canSubMarginAmount', 'maxFeeRate', 'settleProfit',
  'takeProfitPrice', 'stopLossPrice', 'returnRate',
] as const

/** `E-BTC-USDT` → `BTCUSDT` (doc §3: outputs use the Binance symbol only). */
export function fapiSymbol(contract: Pick<FuturesContract, 'contractName'>): string {
  return contract.contractName.toUpperCase().replace(/^E-/, '').replace(/[-_]/g, '')
}

export function contractForSymbol(contracts: readonly FuturesContract[], symbol: unknown): FuturesContract | undefined {
  if (typeof symbol !== 'string' || symbol === '') return undefined
  const wanted = symbol.toUpperCase().replace(/^E[-_]/, '').replace(/[-_]/g, '')
  return contracts.find((entry) => fapiSymbol(entry) === wanted)
}

function dec(value: unknown): Decimal | null {
  const text = canonicalDecimal(typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '')
  if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) return null
  return new Decimal(text)
}

function decText(value: Decimal): string {
  return canonicalDecimal(value.toFixed())
}

/** Coin quantity → contracts (`''` when unknown). Always non-negative. */
export function coinToContracts(coin: unknown, multiplier: string): string {
  const quantity = dec(coin)
  const size = isDecimalString(multiplier) ? new Decimal(multiplier) : null
  if (quantity === null || size === null || size.lte(0)) return ''
  return decText(quantity.abs().dividedBy(size))
}

/** Contracts → coin quantity (`''` when unknown). */
export function contractsToCoin(contracts: string, multiplier: string): string {
  const volume = dec(contracts)
  const size = isDecimalString(multiplier) ? new Decimal(multiplier) : null
  if (volume === null || size === null) return ''
  return decText(volume.times(size))
}

/** Binance `o` / `f` → legacy order type (1 limit, 2 market, 3 IOC, 4 FOK, 5 post only). */
export function legacyOrderType(type: unknown, timeInForce: unknown): number | null {
  const kind = String(type ?? '').toUpperCase()
  const tif = String(timeInForce ?? '').toUpperCase()
  if (kind === 'MARKET') return 2
  if (kind !== 'LIMIT') return null
  if (tif === 'IOC') return 3
  if (tif === 'FOK') return 4
  if (tif === 'GTX') return 5
  return 1
}

/** Binance order status → legacy status (0 new, 2 filled, 3 partially filled, 4 cancelled). */
export function legacyOrderStatus(status: unknown): number | null {
  switch (String(status ?? '').toUpperCase()) {
    case 'NEW': return 0
    case 'PARTIALLY_FILLED': return 3
    case 'FILLED': return 2
    case 'CANCELED':
    case 'EXPIRED': return 4
    default: return null
  }
}

export function isTerminalStatus(status: unknown): boolean {
  const text = String(status ?? '').toUpperCase()
  return text === 'FILLED' || text === 'CANCELED' || text === 'EXPIRED' || text === 'REJECTED' || text === 'EXPIRED_IN_MATCH'
}

/** Hedge mode: BUY+LONG / SELL+SHORT open, the others close. One-way (`BOTH`): reduce-only closes. */
export function openKindOf(side: unknown, positionSide: unknown, reduceOnly: unknown): 'OPEN' | 'CLOSE' {
  const s = String(side ?? '').toUpperCase()
  const ps = String(positionSide ?? '').toUpperCase()
  if (ps === 'LONG') return s === 'BUY' ? 'OPEN' : 'CLOSE'
  if (ps === 'SHORT') return s === 'SELL' ? 'OPEN' : 'CLOSE'
  return reduceOnly === true ? 'CLOSE' : 'OPEN'
}

function sideOf(value: unknown): 'BUY' | 'SELL' | '' {
  const text = String(value ?? '').toUpperCase()
  return text === 'BUY' || text === 'SELL' ? text : ''
}

/** Legacy `ctime` is whole seconds in ms (`1790846309000`); the stream `T` has ms. */
function secondsMs(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN // float-ok: epoch timestamp
  return Number.isFinite(number) && number > 0 ? Math.floor(number / 1000) * 1000 : null
}

function idText(value: unknown): string {
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : typeof value === 'string' ? value : ''
  return /^\d+$/.test(text) ? text : ''
}

/** `ORDER_TRADE_UPDATE.o` (the order part). */
export interface StreamOrder {
  s: string
  c?: string
  S: string
  o: string
  f: string
  q: string
  p: string
  ap: string
  x: string
  X: string
  i: string | number
  l: string
  z: string
  L: string
  n?: string
  T: number
  b?: string
  a?: string
  R?: boolean
  ps: string
  rp?: string
}

/** One open order from the stream (`positionType` = the contract's margin mode; the stream does not carry it). */
export function orderFromStream(order: StreamOrder, contract: FuturesContract, positionType: number | null, previous?: FuturesOrder): FuturesOrder {
  const side = sideOf(order.S)
  const balance = side === 'BUY' ? order.b : order.a
  return {
    id: idText(order.i),
    contractId: contract.id,
    contractName: contract.contractName,
    side,
    open: openKindOf(order.S, order.ps, order.R),
    type: legacyOrderType(order.o, order.f),
    positionType: previous?.positionType ?? positionType,
    price: udec(order.p),
    avgPrice: udec(order.ap),
    volume: coinToContracts(order.q, contract.multiplier),
    dealVolume: coinToContracts(order.z, contract.multiplier),
    status: legacyOrderStatus(order.X),
    tradeFee: previous?.tradeFee ?? '0',
    realizedAmount: previous?.realizedAmount ?? '0',
    // `b` / `a` (bid / ask notional) are the order's frozen balance on NEW; later events may carry stale values.
    orderBalance: previous?.orderBalance ?? (order.X === 'NEW' ? udec(balance) : ''),
    memo: '',
    liqPositionMsg: '',
    ctime: previous?.ctime ?? secondsMs(order.T),
    mtime: secondsMs(order.T),
    // Binance quantities are coin: converted to contracts above, also for MARKET (2) rows
    volumeIsContracts: true,
  }
}

export function orderFromSnapshot(order: FapiOpenOrder, contract: FuturesContract, positionType: number | null): FuturesOrder {
  return {
    id: idText(order.orderId),
    contractId: contract.id,
    contractName: contract.contractName,
    side: sideOf(order.side),
    open: openKindOf(order.side, order.positionSide, order.reduceOnly),
    type: legacyOrderType(order.origType ?? order.type, order.timeInForce),
    positionType,
    price: udec(order.price),
    avgPrice: udec(order.avgPrice),
    volume: coinToContracts(order.origQty, contract.multiplier),
    dealVolume: coinToContracts(order.executedQty, contract.multiplier),
    status: legacyOrderStatus(order.status),
    tradeFee: '0',
    realizedAmount: '0',
    orderBalance: '',
    memo: '',
    liqPositionMsg: '',
    ctime: secondsMs(order.time),
    mtime: secondsMs(order.updateTime),
    volumeIsContracts: true,
  }
}

/** Legacy `current_order_list` order: newest second first, then ascending id within the same second (10-01 live). */
export function compareOrders(a: FuturesOrder, b: FuturesOrder): number {
  const time = (b.ctime ?? 0) - (a.ctime ?? 0)
  if (time !== 0) return time
  if (a.id.length !== b.id.length) return a.id.length - b.id.length
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/* ------------------------------------------------------------------ positions */

export function positionKey(contractId: number, orderSide: string, positionType: number | null): string {
  return `${contractId}:${orderSide}:${positionType ?? ''}`
}

export function keyOfPosition(position: Pick<FuturesPosition, 'contractId' | 'orderSide' | 'positionType'>): string {
  return positionKey(position.contractId, position.orderSide, position.positionType)
}

function positionSideOf(positionSide: unknown, amount: Decimal | null): 'BUY' | 'SELL' | '' {
  const text = String(positionSide ?? '').toUpperCase()
  if (text === 'LONG') return 'BUY'
  if (text === 'SHORT') return 'SELL'
  if (amount === null || amount.isZero()) return ''
  return amount.isNegative() ? 'SELL' : 'BUY'
}

function marginTypeOf(value: unknown): 1 | 2 {
  return String(value ?? '').toLowerCase() === 'isolated' ? 2 : 1
}

let syntheticIds = 0
/** A position seen on the stream before the legacy endpoint gave its id: negative, never sent to the server. */
export function syntheticPositionId(): number {
  syntheticIds += 1
  return -syntheticIds
}

export function hasRealId(position: Pick<FuturesPosition, 'id'>): boolean {
  return position.id > 0
}

function blankPosition(contract: FuturesContract, orderSide: 'BUY' | 'SELL', positionType: 1 | 2): FuturesPosition {
  return {
    id: syntheticPositionId(), contractId: contract.id, contractName: contract.contractName, symbol: contract.symbol, positionType, orderSide,
    positionVolume: '', canCloseVolume: '', openAvgPrice: '', markPrice: '', reducePrice: '', holdAmount: '', marginRate: '', keepRate: '',
    maxFeeRate: '', realizedAmount: '', unRealizedAmount: '', openRealizedAmount: '', settleProfit: '', returnRate: '', leverageLevel: null,
    positionBalance: '', canSubMarginAmount: '', capitalFee: '', tradeFee: '', takeProfitPrice: '', stopLossPrice: '',
  }
}

/**
 * Isolated position margin as the legacy `holdAmount` / `isolateMargin` show it: wallet + unrealized LOSS (a profit is
 * not counted). 2026-10-01 B live: wallet 4.129372875, PnL −0.0333 → legacy 4.0960307700; wallet 4.13844895, PnL
 * positive → legacy 4.13844895. (Binance `isolatedMargin` adds a profit too, so it is not used.)
 */
export function isolatedMarginOf(risk: Pick<FapiPositionRisk, 'isolatedWallet' | 'unRealizedProfit'>): string {
  const wallet = dec(risk.isolatedWallet)
  const pnl = dec(risk.unRealizedProfit) ?? new Decimal(0)
  return wallet === null ? '' : decText(wallet.plus(Decimal.min(0, pnl)))
}

function ratio(numerator: string, denominator: string, dp = 16): string {
  const top = dec(numerator)
  const bottom = dec(denominator)
  if (top === null || bottom === null || bottom.isZero()) return ''
  return canonicalDecimal(top.dividedBy(bottom.abs()).toDecimalPlaces(dp).toFixed())
}

/** Contracts still free to close per position key: volume − remaining CLOSE orders on that side and margin mode. */
export function withCanClose(positions: readonly FuturesPosition[], openOrders: Iterable<FuturesOrder>): FuturesPosition[] {
  const resting = new Map<string, Decimal>()
  for (const order of openOrders) {
    if (order.open !== 'CLOSE' || order.contractId === null) continue
    const held = order.side === 'BUY' ? 'SELL' : 'BUY'
    const left = (dec(order.volume) ?? new Decimal(0)).minus(dec(order.dealVolume) ?? new Decimal(0))
    if (left.lte(0)) continue
    for (const type of order.positionType === 1 || order.positionType === 2 ? [order.positionType] : [1, 2]) {
      const key = positionKey(order.contractId, held, type)
      resting.set(key, (resting.get(key) ?? new Decimal(0)).plus(left))
    }
  }
  return positions.map((position) => {
    const volume = dec(position.positionVolume)
    if (volume === null) return position
    const free = Decimal.max(0, volume.minus(resting.get(keyOfPosition(position)) ?? 0))
    const canCloseVolume = decText(free)
    return canCloseVolume === position.canCloseVolume ? position : { ...position, canCloseVolume }
  })
}

export interface LiveSnapshot {
  positions: FuturesPosition[]
  account: FuturesAccount | null
  /** Wallet / cross wallet balance of the margin coin (for the incremental ACCOUNT_UPDATE deltas). */
  wallet: { wb: string; cw: string } | null
  /** Keys present now that have no legacy id yet (the caller reads `get_assets_list` once). */
  missingIds: boolean
}

/** Read actual risk fields from one versioned account response. Never reuse an earlier row's liquidation price. */
export function accountRiskSnapshot(account: FapiAccount): FapiPositionRisk[] | null {
  if (account.riskSnapshotVersion !== 1) return null
  const valid = (value: unknown): value is string => typeof value === 'string' && isSignedDecimal(value)
  const rows: FapiPositionRisk[] = []
  for (const entry of account.positions) {
    if (!valid(entry.positionAmt) || typeof entry.symbol !== 'string' || entry.symbol === '') return null
    if (new Decimal(entry.positionAmt).isZero()) continue
    const { entryPrice, markPrice, liquidationPrice, leverage, marginType, maintMargin, unrealizedProfit } = entry
    if (!valid(entryPrice) || !valid(markPrice) || !valid(liquidationPrice)
      || !valid(maintMargin) || !valid(unrealizedProfit) || !valid(entry.notional)
      || !valid(entry.isolatedWallet) || typeof leverage !== 'string' || !/^[1-9]\d*$/.test(leverage)
      || (marginType !== 'isolated' && marginType !== 'cross') || !['LONG', 'SHORT'].includes(entry.positionSide)) return null
    rows.push({
      symbol: entry.symbol, positionSide: entry.positionSide, positionAmt: entry.positionAmt, entryPrice,
      breakEvenPrice: entry.breakEvenPrice, markPrice, liquidationPrice, leverage, marginType, maintMargin,
      unRealizedProfit: unrealizedProfit, isolatedWallet: entry.isolatedWallet, notional: entry.notional,
      initialMargin: entry.initialMargin,
    })
  }
  return rows
}

/**
 * `/fapi/v3/account` + `/fapi/v3/positionRisk` → legacy rows. Rows keep their identity (`previous`, keyed by contract
 * + side + margin mode) and every legacy-only field; positions absent from the snapshot are gone.
 */
export function snapshotToLegacy(input: {
  account: FapiAccount
  risk: readonly FapiPositionRisk[]
  contracts: readonly FuturesContract[]
  previousPositions: readonly FuturesPosition[]
  previousAccount: FuturesAccount | undefined
  marginCoin: string
  openOrders: Iterable<FuturesOrder>
}): LiveSnapshot {
  const asset = input.account.assets.find((entry) => entry.asset.toUpperCase() === input.marginCoin.toUpperCase()) ?? input.account.assets[0]
  const previousByKey = new Map(input.previousPositions.map((position) => [keyOfPosition(position), position]))
  let isolated = new Decimal(0)
  let notional = new Decimal(0)
  const rows: { position: FuturesPosition; risk: FapiPositionRisk }[] = []
  // Also covers first-connect/reconnect, whose caller may have fetched the older separate risk endpoint in parallel.
  for (const risk of accountRiskSnapshot(input.account) ?? input.risk) {
    const contract = contractForSymbol(input.contracts, risk.symbol)
    const amount = dec(risk.positionAmt)
    if (contract === undefined || amount === null || amount.isZero()) continue
    const orderSide = positionSideOf(risk.positionSide, amount)
    if (orderSide === '') continue
    const positionType = marginTypeOf(risk.marginType)
    const key = positionKey(contract.id, orderSide, positionType)
    const base = previousByKey.get(key) ?? blankPosition(contract, orderSide, positionType)
    const value = (dec(risk.notional) ?? new Decimal(0)).abs()
    notional = notional.plus(value)
    if (positionType === 2) isolated = isolated.plus(dec(isolatedMarginOf(risk)) ?? 0)
    rows.push({
      risk,
      position: {
        ...base,
        contractName: base.contractName || contract.contractName,
        symbol: base.symbol || contract.symbol,
        positionVolume: coinToContracts(risk.positionAmt, contract.multiplier),
        openAvgPrice: udec(risk.entryPrice),
        markPrice: udec(risk.markPrice),
        reducePrice: signedDec(risk.liquidationPrice),
        unRealizedAmount: signedDec(risk.unRealizedProfit),
        // FAPI PnL is mark vs effective avg_price; it cannot impersonate legacy mark-vs-original-open PnL.
        // Leave the legacy-only component unknown so leverage preview does not subtract settled PnL twice.
        openRealizedAmount: '',
        leverageLevel: /^\d+$/.test(String(risk.leverage)) ? Number(risk.leverage) : base.leverageLevel, // float-ok: integer leverage
        positionBalance: udec(value.toFixed()),
        keepRate: risk.maintMargin !== undefined && !value.isZero() ? ratio(risk.maintMargin, value.toFixed(), 10) : base.keepRate,
        maintenanceMargin: risk.maintMargin === undefined ? undefined : udec(risk.maintMargin),
      },
    })
  }
  let account: FuturesAccount | null = null
  let wallet: { wb: string; cw: string } | null = null
  if (asset !== undefined) {
    const balance = dec(asset.marginBalance) ?? new Decimal(0)
    const lock = dec(asset.openOrderInitialMargin) ?? new Decimal(0)
    // cross wallet + cross PnL − order margin (= marginBalance − isolated margins − order margin when no isolated PnL)
    const crossMargin = (dec(asset.crossWalletBalance) ?? balance.minus(isolated)).plus(dec(asset.crossUnPnl) ?? 0).minus(lock)
    const available = dec(asset.availableBalance)
    const withdraw = dec(asset.maxWithdrawAmount)
    const previous = input.previousAccount
    account = {
      symbol: previous?.symbol ?? asset.asset,
      totalAmount: signedDec(asset.marginBalance),
      totalEquities: previous?.totalEquities ?? '',
      isolatedEquities: previous?.isolatedEquities ?? '',
      canUseAmount: signedDec(asset.availableBalance),
      transferableAmount: signedDec(asset.maxWithdrawAmount),
      transferHeldProfit: available !== null && withdraw !== null ? decText(Decimal.max(0, available.minus(withdraw))) : (previous?.transferHeldProfit ?? ''),
      totalMargin: decText(crossMargin),
      isolateMargin: decText(isolated),
      lockAmount: signedDec(asset.openOrderInitialMargin),
      realizedAmount: previous?.realizedAmount ?? '',
      cumulativeClosedPnl: previous?.cumulativeClosedPnl ?? '',
      currentPositionRealizedAmount: previous?.currentPositionRealizedAmount ?? '',
      unRealizedAmount: signedDec(asset.unrealizedProfit),
      // No position: the legacy endpoint says 0.
      totalMarginRate: notional.isZero() ? '0' : ratio(balance.toFixed(), notional.toFixed()),
    }
    wallet = { wb: signedDec(asset.walletBalance), cw: signedDec(asset.crossWalletBalance) }
  }
  const crossHold = account?.totalMargin ?? ''
  const positions = rows.map(({ position, risk }) => {
    const holdAmount = position.positionType === 2 ? isolatedMarginOf(risk) : crossHold
    return { ...position, holdAmount, marginRate: holdAmount === '' ? '' : ratio(holdAmount, position.positionBalance) }
  })
  return {
    positions: withCanClose(positions, input.openOrders),
    account,
    wallet,
    missingIds: positions.some((position) => !hasRealId(position)),
  }
}

/** `ACCOUNT_UPDATE.a` */
export interface StreamAccountUpdate {
  m: string
  B?: { a: string; wb: string; cw: string; bc?: string }[]
  P?: { s: string; pa: string; ep: string; up?: string; mt?: string; iw?: string; ps: string }[]
}

export interface AppliedAccountUpdate {
  positions: FuturesPosition[]
  account: FuturesAccount | undefined
  wallet: { wb: string; cw: string } | null
  /** A position key appeared that has no legacy id. */
  added: boolean
  /** Positions changed (fills): legacy-only fields (realized PnL, fees) are stale. */
  positionsChanged: boolean
}

/**
 * Applies one ACCOUNT_UPDATE to the rows at once (qty, entry, isolated margin, unrealized PnL; a closed position
 * leaves). Balances move by the wallet delta for transfers / funding / adjustments; an ORDER update changes margins
 * the event does not carry, so balances wait for the snapshot that the caller schedules.
 */
export function applyAccountUpdate(input: {
  update: StreamAccountUpdate
  positions: readonly FuturesPosition[]
  account: FuturesAccount | undefined
  wallet: { wb: string; cw: string } | null
  contracts: readonly FuturesContract[]
  marginCoin: string
  leverageFor: (contractId: number) => number | null
}): AppliedAccountUpdate {
  let positions = [...input.positions]
  let added = false
  let positionsChanged = false
  for (const entry of input.update.P ?? []) {
    const contract = contractForSymbol(input.contracts, entry.s)
    const amount = dec(entry.pa)
    if (contract === undefined || amount === null) continue
    const positionType = marginTypeOf(entry.mt)
    const orderSide = positionSideOf(entry.ps, amount)
    positionsChanged = true
    if (amount.isZero()) {
      const sides = orderSide === '' ? ['BUY', 'SELL'] : [orderSide]
      positions = positions.filter((row) => !(row.contractId === contract.id && row.positionType === positionType && sides.includes(row.orderSide)))
      continue
    }
    if (orderSide === '') continue
    const key = positionKey(contract.id, orderSide, positionType)
    const index = positions.findIndex((row) => keyOfPosition(row) === key)
    const base = index >= 0 ? positions[index] : { ...blankPosition(contract, orderSide, positionType), leverageLevel: input.leverageFor(contract.id) }
    if (index < 0) added = true
    const next: FuturesPosition = {
      ...base,
      positionVolume: coinToContracts(entry.pa, contract.multiplier),
      openAvgPrice: udec(entry.ep),
      unRealizedAmount: entry.up !== undefined ? signedDec(entry.up) : base.unRealizedAmount,
      openRealizedAmount: entry.up !== undefined ? '' : base.openRealizedAmount,
      holdAmount: positionType === 2 && entry.iw !== undefined ? isolatedMarginOf({ isolatedWallet: entry.iw, unRealizedProfit: entry.up ?? '0' }) : base.holdAmount,
    }
    if (index >= 0) positions[index] = next
    else positions = [next, ...positions]
  }
  let account = input.account
  let wallet = input.wallet
  const balance = (input.update.B ?? []).find((entry) => entry.a.toUpperCase() === input.marginCoin.toUpperCase())
  if (balance !== undefined) {
    const nextWallet = { wb: signedDec(balance.wb), cw: signedDec(balance.cw) }
    const reason = String(input.update.m ?? '').toUpperCase()
    if (account !== undefined && wallet !== null && reason !== 'ORDER') {
      const dWallet = (dec(nextWallet.wb) ?? new Decimal(0)).minus(dec(wallet.wb) ?? 0)
      const dCross = (dec(nextWallet.cw) ?? new Decimal(0)).minus(dec(wallet.cw) ?? 0)
      const shift = (value: string, delta: Decimal): string => {
        const current = dec(value)
        return current === null ? value : decText(current.plus(delta))
      }
      account = {
        ...account,
        totalAmount: shift(account.totalAmount, dWallet),
        canUseAmount: shift(account.canUseAmount, dCross),
        transferableAmount: shift(account.transferableAmount, dCross),
        totalMargin: shift(account.totalMargin, dCross),
        isolateMargin: shift(account.isolateMargin, dWallet.minus(dCross)),
      }
    }
    wallet = nextWallet
  }
  return { positions, account, wallet, added, positionsChanged }
}

/**
 * Legacy `get_assets_list` rows onto the live rows: only the legacy-only fields (and the real id) move; which positions
 * exist and every live number stay with the stream / snapshot (the legacy read may lag the core by a settle cycle).
 */
export function mergeLegacyPositions(live: readonly FuturesPosition[], legacy: readonly FuturesPosition[]): FuturesPosition[] {
  const byKey = new Map(legacy.map((position) => [keyOfPosition(position), position]))
  return live.map((position) => {
    const source = byKey.get(keyOfPosition(position))
    if (source === undefined) return position
    let changed = false
    const next = { ...position } as Record<string, unknown>
    for (const field of LEGACY_POSITION_FIELDS) {
      if (next[field] !== source[field]) {
        next[field] = source[field]
        changed = true
      }
    }
    return changed ? (next as unknown as FuturesPosition) : position
  })
}

/** Legacy account fields the snapshot does not carry. */
export function mergeLegacyAccount(live: FuturesAccount | undefined, legacy: FuturesAccount | undefined): FuturesAccount | undefined {
  if (live === undefined || legacy === undefined) return live ?? legacy
  if (live.realizedAmount === legacy.realizedAmount && live.totalEquities === legacy.totalEquities && live.isolatedEquities === legacy.isolatedEquities
    && live.cumulativeClosedPnl === legacy.cumulativeClosedPnl && live.currentPositionRealizedAmount === legacy.currentPositionRealizedAmount) return live
  return { ...live, realizedAmount: legacy.realizedAmount, totalEquities: legacy.totalEquities, isolatedEquities: legacy.isolatedEquities,
    cumulativeClosedPnl: legacy.cumulativeClosedPnl, currentPositionRealizedAmount: legacy.currentPositionRealizedAmount }
}

/* ------------------------------------------------------------------ fills */

export interface FillNotice {
  orderId: string
  contract: FuturesContract
  side: 'BUY' | 'SELL' | ''
  open: 'OPEN' | 'CLOSE'
  /** Cumulative filled quantity in coin, and the average price. */
  filledCoin: string
  avgPrice: string
  /** Order fully filled (`X` FILLED). */
  complete: boolean
}

export function fillNotice(order: StreamOrder, contract: FuturesContract): FillNotice | null {
  if (String(order.x).toUpperCase() !== 'TRADE') return null
  const filled = dec(order.z)
  if (filled === null || filled.lte(0)) return null
  return {
    orderId: idText(order.i),
    contract,
    side: sideOf(order.S),
    open: openKindOf(order.S, order.ps, order.R),
    filledCoin: decText(filled),
    avgPrice: udec(order.ap) || udec(order.L),
    complete: String(order.X).toUpperCase() === 'FILLED',
  }
}
