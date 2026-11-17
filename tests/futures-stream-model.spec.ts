/**
 * User stream / `/fapi` snapshot → legacy rows. Fixtures are B's live answers of 2026-10-01 (cross with a resting
 * open + close order; isolated), each next to what `position/get_assets_list` / `current_order_list` said at the
 * same moment: the mapped values must render the same.
 */
import { describe, expect, it } from 'vitest'
import { Decimal } from '@/modules/finance/decimal'
import { isolatedShortfall } from '@/modules/futures/leverage-change'
import { buildContract } from '@/modules/futures/contracts'
import type { FapiAccount, FapiOpenOrder, FapiPositionRisk } from '@/modules/futures/fapi'
import {
  applyAccountUpdate,
  accountRiskSnapshot,
  coinToContracts,
  contractForSymbol,
  fapiSymbol,
  fillNotice,
  hasRealId,
  isolatedMarginOf,
  legacyOrderType,
  mergeLegacyPositions,
  mergeLegacyAccount,
  orderFromSnapshot,
  orderFromStream,
  snapshotToLegacy,
  withCanClose,
  type StreamOrder,
} from '@/modules/futures/stream-model'
import { isMarketOrder, normalizeAssets, normalizeOrders, normalizePublicInfo, normalizeTrades } from '@/modules/futures/types'

const info = normalizePublicInfo({
  contractList: [
    { id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4 } },
    { id: 2, contractName: 'E-ETH-USDT', symbol: 'ETH-USDT', multiplier: '0.001', multiplierCoin: 'ETH', marginCoin: 'USDT', marginRate: '1', base: 'ETH', quote: 'USDT', coinResultVo: { symbolPricePrecision: 2, marginCoinPrecision: 4 } },
  ],
})
const contracts = info.contractList.map(buildContract).filter((entry) => entry !== null)
const btc = contracts[0]!

/** Same number on both sides (the legacy JSON numbers are doubles; compare at 8 dp). */
function same(a: string, b: string, dp = 8): void {
  expect(new Decimal(a).toDecimalPlaces(dp).toFixed(), `${a} vs ${b}`).toBe(new Decimal(b).toDecimalPlaces(dp).toFixed())
}

/* ---- 09:18:35 cross: 10 contracts long, a resting BUY OPEN 20 @ 75342.2 and a SELL CLOSE 4 @ 100456.2 */
const crossLegacy = normalizeAssets({
  positionList: [{ id: 1259, contractId: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', positionVolume: 10, canCloseVolume: 6, openAvgPrice: 83713.1, indexPrice: 83719.24191434549, reducePrice: -10004307.663887966, holdAmount: 10040.506444398845, marginRate: 119.9306899442717, realizedAmount: 0, orderSide: 'BUY', positionType: 1, canSubMarginAmount: 0, openRealizedAmount: 0.006141914345488435, keepRate: 0.004, maxFeeRate: 0.00075, unRealizedAmount: 0.006141914345488435, leverageLevel: 20, positionBalance: 83.71924191434549, tradeFee: '-0.062784825', capitalFee: '0', takeProfitPrice: null, stopLossPrice: null }],
  accountList: [{ symbol: 'USDT', totalAmount: '10048.0406643988447784348', canUseAmount: 10036.314340388783, transferableAmount: '10036.31434038', isolateMargin: '0', lockAmount: '7.53422', unRealizedAmount: '0.0061419143454884348', transferHeldProfit: '0.00000000', realizedAmount: '0', totalMargin: '10040.5064443988447784348', totalMarginRate: '120.0206838313127324' }],
})
const crossAccount: FapiAccount = {
  assets: [{ asset: 'USDT', availableBalance: '10036.3143403887820156', crossUnPnl: '0.0061419143454884348', crossWalletBalance: '10048.03452248449929', initialMargin: '11.7201820957172744', maintMargin: '0.3348769676573819537392', marginBalance: '10048.0406643988447784348', maxWithdrawAmount: '10036.3143403887820156', openOrderInitialMargin: '7.53422', positionInitialMargin: '4.1859620957172744', unrealizedProfit: '0.0061419143454884348', walletBalance: '10048.03452248449929' }],
  positions: [{ isolatedWallet: '0', notional: '83.7192419143454884348', positionAmt: '0.001', positionSide: 'LONG', symbol: 'BTCUSDT' }],
}
const crossRisk: FapiPositionRisk[] = [{ breakEvenPrice: '83713.1', entryPrice: '83713.1', initialMargin: '4.1859620957172744', isolatedMargin: '0', isolatedWallet: '0', leverage: '20', liquidationPrice: '-10004307.6638879671338859', maintMargin: '0.3348769676573819537392', marginType: 'cross', markPrice: '83719.2419143454884348', notional: '83.7192419143454884348', positionAmt: '0.001', positionSide: 'LONG', symbol: 'BTCUSDT', unRealizedProfit: '0.0061419143454884348' }]
const crossOpen: FapiOpenOrder[] = [
  { avgPrice: '0', executedQty: '0', orderId: '3490755423105925120', origQty: '0.002', origType: 'LIMIT', positionSide: 'LONG', price: '75342.2', reduceOnly: false, side: 'BUY', status: 'NEW', symbol: 'BTCUSDT', time: 1790846307000, timeInForce: 'GTC', type: 'LIMIT', updateTime: 1790846307326 },
  { avgPrice: '0', executedQty: '0', orderId: '3490755457465663488', origQty: '0.0004', origType: 'LIMIT', positionSide: 'LONG', price: '100456.2', reduceOnly: false, side: 'SELL', status: 'NEW', symbol: 'BTCUSDT', time: 1790846309000, timeInForce: 'GTC', type: 'LIMIT', updateTime: 1790846309816 },
]
const crossLegacyOrders = normalizeOrders({ count: 2, orderList: [
  { side: 'SELL', positionType: 1, avgPrice: 0, type: 1, mtime: 1790846309000, volume: 4, dealVolume: 0, price: 100456.2, contractId: 1, ctime: 1790846309000, contractName: 'E-BTC-USDT', id: '3490755457465663488', orderBalance: 40.18248, open: 'CLOSE', status: 0 },
  { side: 'BUY', positionType: 1, avgPrice: 0, type: 1, mtime: 1790846307000, volume: 20, dealVolume: 0, price: 75342.2, contractId: 1, ctime: 1790846307000, contractName: 'E-BTC-USDT', id: '3490755423105925120', orderBalance: 150.6844, open: 'OPEN', status: 0 },
] })

/* ---- 09:25:39 isolated: 10 contracts long, isolated wallet 4.13631175 */
const isoLegacy = normalizeAssets({
  positionList: [{ id: 1261, contractId: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', positionVolume: 10, canCloseVolume: 10, openAvgPrice: 83731, indexPrice: 83731, reducePrice: 79974.56744536548, holdAmount: 4.13631175, marginRate: 0.0494000041800527, realizedAmount: 0, orderSide: 'BUY', positionType: 2, keepRate: 0.004, unRealizedAmount: 0, leverageLevel: 20, positionBalance: 83.731, tradeFee: '-0.06279825' }],
  accountList: [{ symbol: 'USDT', totalAmount: '10047.78064838449929', canUseAmount: 10043.6443366345, transferableAmount: '10043.64433663', isolateMargin: '4.13631175', lockAmount: '0', unRealizedAmount: '0', transferHeldProfit: '0.00000000', realizedAmount: '0', totalMargin: '10043.64433663449929', totalMarginRate: '120.0007243241391992' }],
})
const isoAccount: FapiAccount = {
  assets: [{ asset: 'USDT', availableBalance: '10043.64433663449929', crossUnPnl: '0', crossWalletBalance: '10043.64433663449929', initialMargin: '4.13631175', maintMargin: '0.334924', marginBalance: '10047.78064838449929', maxWithdrawAmount: '10043.64433663449929', openOrderInitialMargin: '0', positionInitialMargin: '4.13631175', unrealizedProfit: '0', walletBalance: '10047.78064838449929' }],
  positions: [{ isolatedWallet: '4.13631175', notional: '83.731', positionAmt: '0.001', positionSide: 'LONG', symbol: 'BTCUSDT' }],
}
const isoRisk: FapiPositionRisk[] = [{ entryPrice: '83731', isolatedMargin: '4.13631175', isolatedWallet: '4.13631175', leverage: '20', liquidationPrice: '79974.5674453654860587', maintMargin: '0.334924', marginType: 'isolated', markPrice: '83731', notional: '83.731', positionAmt: '0.001', positionSide: 'LONG', symbol: 'BTCUSDT', unRealizedProfit: '0' }]

describe('QA016 account risk snapshot extension', () => {
  it('does not subtract historical settled profit again from effective-cost PnL in leverage preview', () => {
    const risk = { ...isoRisk[0]!, entryPrice: '99000', markPrice: '100000', notional: '100', unRealizedProfit: '1', isolatedWallet: '25' }
    const previous = { ...isoLegacy.positions[0]!, settleProfit: '4', realizedAmount: '0' }
    const snapshot = snapshotToLegacy({ account: isoAccount, risk: [risk], contracts, previousPositions: [previous],
      previousAccount: isoLegacy.accounts[0], marginCoin: 'USDT', openOrders: [] })
    expect(snapshot.positions[0]?.openRealizedAmount).toBe('')
    expect(snapshot.positions[0]?.unRealizedAmount).toBe('1')
    expect(isolatedShortfall(snapshot.positions[0]!, 2)?.toFixed()).toBe('26')
  })
  it('reads exact risk fields from one versioned account and refuses missing data instead of borrowing a previous liquidation', () => {
    const risk = crossRisk[0]!
    const account: FapiAccount = { ...crossAccount, riskSnapshotVersion: 1, positions: [{ ...risk, unrealizedProfit: risk.unRealizedProfit }] }
    expect(accountRiskSnapshot(account)?.[0]).toMatchObject({ liquidationPrice: risk.liquidationPrice, maintMargin: risk.maintMargin, markPrice: risk.markPrice })
    expect(accountRiskSnapshot({ ...account, riskSnapshotVersion: undefined })).toBeNull()
    expect(accountRiskSnapshot({ ...account, positions: [{ ...account.positions[0]!, liquidationPrice: undefined }] })).toBeNull()
    expect(accountRiskSnapshot({ ...account, positions: [{ ...account.positions[0]!, maintMargin: '1e-3' }] })).toBeNull()
    expect(accountRiskSnapshot({ ...account, positions: [] })).toEqual([])
    const snapshot = snapshotToLegacy({ account, risk: [{ ...risk, liquidationPrice: '123', maintMargin: '999' }], contracts,
      previousPositions: crossLegacy.positions, previousAccount: crossLegacy.accounts[0], marginCoin: 'USDT', openOrders: [] })
    expect(snapshot.positions[0]?.reducePrice).toBe(risk.liquidationPrice)
    expect(snapshot.positions[0]?.maintenanceMargin).toBe(risk.maintMargin)
  })
})

describe('symbols and units', () => {
  it('maps E-BTC-USDT ↔ BTCUSDT and coin ↔ contracts by the multiplier', () => {
    expect(fapiSymbol(btc)).toBe('BTCUSDT')
    expect(contractForSymbol(contracts, 'ETHUSDT')?.id).toBe(2)
    expect(contractForSymbol(contracts, 'e_btcusdt')?.id).toBe(1)
    expect(contractForSymbol(contracts, 'XRPUSDT')).toBeUndefined()
    expect(coinToContracts('0.001', '0.0001')).toBe('10')
    expect(coinToContracts('-0.0004', '0.0001')).toBe('4')
    expect(coinToContracts('0.002', '0.001')).toBe('2')
  })

  it('maps Binance order types to the legacy codes', () => {
    expect(legacyOrderType('LIMIT', 'GTC')).toBe(1)
    expect(legacyOrderType('MARKET', 'GTC')).toBe(2)
    expect(legacyOrderType('LIMIT', 'IOC')).toBe(3)
    expect(legacyOrderType('LIMIT', 'FOK')).toBe(4)
    expect(legacyOrderType('LIMIT', 'GTX')).toBe(5)
  })
})

describe('snapshot → legacy rows (same values as get_assets_list)', () => {
  const openOrders = crossOpen.map((row) => orderFromSnapshot(row, btc, 1))

  it('cross position with resting orders', () => {
    const live = snapshotToLegacy({ account: crossAccount, risk: crossRisk, contracts, previousPositions: crossLegacy.positions, previousAccount: crossLegacy.accounts[0], marginCoin: 'USDT', openOrders })
    const legacy = crossLegacy.positions[0]!
    const position = live.positions[0]!
    expect(position.id).toBe(1259)
    expect(position.positionVolume).toBe('10')
    expect(position.canCloseVolume).toBe('6')
    for (const field of ['openAvgPrice', 'markPrice', 'reducePrice', 'holdAmount', 'marginRate', 'keepRate', 'unRealizedAmount', 'positionBalance'] as const) same(position[field], legacy[field], 6)
    expect(position.leverageLevel).toBe(20)
    expect(position.tradeFee).toBe(legacy.tradeFee)
    const account = live.account!
    const legacyAccount = crossLegacy.accounts[0]!
    for (const field of ['totalAmount', 'canUseAmount', 'transferableAmount', 'totalMargin', 'isolateMargin', 'lockAmount', 'unRealizedAmount', 'totalMarginRate', 'transferHeldProfit'] as const) same(account[field], legacyAccount[field], 6)
    expect(live.missingIds).toBe(false)
    expect(live.wallet).toEqual({ wb: '10048.03452248449929', cw: '10048.03452248449929' })
  })

  it('isolated position', () => {
    const live = snapshotToLegacy({ account: isoAccount, risk: isoRisk, contracts, previousPositions: isoLegacy.positions, previousAccount: isoLegacy.accounts[0], marginCoin: 'USDT', openOrders: [] })
    const legacy = isoLegacy.positions[0]!
    const position = live.positions[0]!
    expect(position.positionType).toBe(2)
    expect(position.canCloseVolume).toBe('10')
    for (const field of ['openAvgPrice', 'reducePrice', 'holdAmount', 'marginRate', 'keepRate', 'positionBalance'] as const) same(position[field], legacy[field], 6)
    for (const field of ['totalAmount', 'canUseAmount', 'transferableAmount', 'totalMargin', 'isolateMargin', 'lockAmount', 'totalMarginRate'] as const) same(live.account![field], isoLegacy.accounts[0]![field], 6)
  })

  it('a position the legacy endpoint has not returned yet gets a placeholder id; the legacy merge fills it', () => {
    const live = snapshotToLegacy({ account: isoAccount, risk: isoRisk, contracts, previousPositions: [], previousAccount: undefined, marginCoin: 'USDT', openOrders: [] })
    expect(live.missingIds).toBe(true)
    expect(hasRealId(live.positions[0]!)).toBe(false)
    const merged = mergeLegacyPositions(live.positions, isoLegacy.positions)
    expect(merged[0]!.id).toBe(1261)
    expect(merged[0]!.tradeFee).toBe('-0.06279825')
    // live numbers stay
    expect(merged[0]!.holdAmount).toBe(live.positions[0]!.holdAmount)
  })

  it('isolated margin = wallet + unrealized loss, a profit not counted (legacy holdAmount; 10-01 live)', () => {
    expect(isolatedMarginOf({ isolatedWallet: '4.129372875', unRealizedProfit: '-0.0333421049499972' })).toBe('4.0960307700500028')
    expect(isolatedMarginOf({ isolatedWallet: '4.13844895', unRealizedProfit: '0.0029299986' })).toBe('4.13844895')
  })

  it('no position: totalMarginRate is 0 like the legacy endpoint', () => {
    const live = snapshotToLegacy({ account: { ...crossAccount, positions: [] }, risk: [], contracts, previousPositions: [], previousAccount: crossLegacy.accounts[0], marginCoin: 'USDT', openOrders: [] })
    expect(live.account!.totalMarginRate).toBe('0')
    expect(live.positions).toEqual([])
  })

  it('a legacy read that lags the stream never brings a closed position back', () => {
    const merged = mergeLegacyPositions([], crossLegacy.positions)
    expect(merged).toEqual([])
  })
})

describe('orders', () => {
  it('openOrders rows equal current_order_list rows (fields the table shows)', () => {
    const mapped = crossOpen.map((row) => orderFromSnapshot(row, btc, 1))
    for (const legacy of crossLegacyOrders.rows) {
      const row = mapped.find((entry) => entry.id === legacy.id)!
      for (const field of ['side', 'open', 'type', 'price', 'volume', 'dealVolume', 'ctime', 'contractId', 'contractName', 'positionType', 'status'] as const) expect(row[field], field).toEqual(legacy[field])
    }
  })

  const newEvent: StreamOrder = { s: 'BTCUSDT', c: '0', S: 'SELL', o: 'LIMIT', f: 'GTC', q: '0.0004', p: '100456.2', ap: '0', x: 'NEW', X: 'NEW', i: '3490755457465663488', l: '0', z: '0', L: '0', T: 1790846309824, b: '150.6844', a: '40.18248', R: false, ps: 'LONG', rp: '0' }

  it('ORDER_TRADE_UPDATE NEW equals the legacy row; the frozen balance is the ask side for a SELL', () => {
    const row = orderFromStream(newEvent, btc, 1)
    const legacy = crossLegacyOrders.rows[0]!
    for (const field of ['id', 'side', 'open', 'type', 'price', 'volume', 'dealVolume', 'ctime', 'status', 'positionType'] as const) expect(row[field], field).toEqual(legacy[field])
    expect(row.orderBalance).toBe('40.18248')
  })

  it('a partial fill keeps creation time and frozen balance, updates filled and status', () => {
    const first = orderFromStream(newEvent, btc, 1)
    const partial = orderFromStream({ ...newEvent, x: 'TRADE', X: 'PARTIALLY_FILLED', z: '0.0002', l: '0.0002', ap: '100456.2', T: 1790846399000, a: '0' }, btc, 1, first)
    expect(partial.dealVolume).toBe('2')
    expect(partial.status).toBe(3)
    expect(partial.ctime).toBe(first.ctime)
    expect(partial.orderBalance).toBe('40.18248')
  })

  // 10-03 owner bug: 全部平仓 / 市价 orders listed as "IOC". The server emulates MARKET as an IOC limit and now reports
  // Binance type / origType MARKET (stream, openOrders) or `origType: 'MARKET'` next to type 3 (classic lists).
  it('a MARKET order from the stream is 市价 with its quantity in contracts', () => {
    const market = orderFromStream({ ...newEvent, o: 'MARKET', f: 'GTC', p: '0', q: '0.001', S: 'BUY', ps: 'LONG' }, btc, 1)
    expect(market.type).toBe(2)
    expect(isMarketOrder(market)).toBe(true)
    expect(market.volume).toBe('10')
    expect(market.volumeIsContracts).toBe(true)
    const snap = orderFromSnapshot({ ...crossOpen[0]!, type: 'MARKET', origType: 'MARKET', timeInForce: 'GTC', price: '0' }, btc, 1)
    expect(isMarketOrder(snap)).toBe(true)
    expect(snap.volumeIsContracts).toBe(true)
    // a user IOC stays IOC
    expect(isMarketOrder(orderFromStream({ ...newEvent, f: 'IOC' }, btc, 1))).toBe(false)
  })

  it('classic rows: origType MARKET marks an emulated market order, other rows unchanged', () => {
    const { rows } = normalizeOrders({ orderList: [
      { id: '1', contractId: 1, side: 'SELL', open: 'CLOSE', type: 3, price: '84169.6', volume: '10', dealVolume: 10, status: 2, origType: 'MARKET' },
      { id: '2', contractId: 1, side: 'SELL', open: 'CLOSE', type: 3, price: '84169.6', volume: '10', dealVolume: 10, status: 2 },
    ] })
    expect(rows.map((row) => [row.type, row.origType, isMarketOrder(row)])).toEqual([[3, 'MARKET', true], [3, undefined, false]])
    expect('origType' in rows[1]!).toBe(false)
    const trades = normalizeTrades({ tradeHisList: [{ id: '5', side: 'SELL', open: 'CLOSE', price: '1', volume: '1', origType: 'MARKET' }, { id: '6', side: 'SELL', open: 'CLOSE', price: '1', volume: '1' }] }).rows
    expect(trades.map((row) => row.origType)).toEqual(['MARKET', undefined])
  })

  it('可平 = volume − remaining close orders on that side', () => {
    const orders = crossOpen.map((row) => orderFromSnapshot(row, btc, 1))
    const [position] = withCanClose([{ ...crossLegacy.positions[0]!, canCloseVolume: '' }], orders)
    expect(position!.canCloseVolume).toBe('6')
    const [none] = withCanClose([{ ...crossLegacy.positions[0]!, canCloseVolume: '' }], [])
    expect(none!.canCloseVolume).toBe('10')
  })

  it('fill notice for TRADE only, cumulative quantity and average price', () => {
    const trade = { ...newEvent, S: 'BUY', ps: 'LONG', x: 'TRADE', X: 'FILLED', l: '0.001', z: '0.001', L: '83713.1', ap: '83713.1', f: 'IOC', q: '0.001' }
    const fill = fillNotice(trade, btc)!
    expect(fill).toMatchObject({ side: 'BUY', open: 'OPEN', filledCoin: '0.001', avgPrice: '83713.1', complete: true, orderId: '3490755457465663488' })
    expect(fillNotice(newEvent, btc)).toBeNull()
  })
})

describe('ACCOUNT_UPDATE applied at once', () => {
  const base = { contracts, marginCoin: 'USDT', leverageFor: () => 20 }

  it('opens a new position row (placeholder id) and closes it at pa 0', () => {
    const opened = applyAccountUpdate({ ...base, positions: [], account: crossLegacy.accounts[0], wallet: { wb: '10048.0973', cw: '10048.0973' }, update: { m: 'ORDER', B: [{ a: 'USDT', wb: '10048.0345', cw: '10048.0345', bc: '0' }], P: [{ s: 'BTCUSDT', pa: '0.001', ep: '83713.1', up: '0.0007', mt: 'cross', iw: '0', ps: 'LONG' }] } })
    expect(opened.added).toBe(true)
    expect(opened.positions[0]).toMatchObject({ contractId: 1, orderSide: 'BUY', positionType: 1, positionVolume: '10', openAvgPrice: '83713.1', leverageLevel: 20 })
    expect(hasRealId(opened.positions[0]!)).toBe(false)
    // ORDER: balances wait for the snapshot (margin moves the event does not carry)
    expect(opened.account).toBe(crossLegacy.accounts[0])
    expect(opened.wallet).toEqual({ wb: '10048.0345', cw: '10048.0345' })
    const closed = applyAccountUpdate({ ...base, positions: opened.positions, account: opened.account, wallet: opened.wallet, update: { m: 'ORDER', P: [{ s: 'BTCUSDT', pa: '0', ep: '0', mt: 'cross', iw: '0', ps: 'LONG' }] } })
    expect(closed.positions).toEqual([])
    expect(closed.positionsChanged).toBe(true)
  })

  it('isolated margin transfer moves the position margin and the balances by the wallet deltas', () => {
    const result = applyAccountUpdate({ ...base, positions: isoLegacy.positions, account: isoLegacy.accounts[0], wallet: { wb: '10047.78064838449929', cw: '10043.64433663449929' }, update: { m: 'MARGIN_TRANSFER', B: [{ a: 'USDT', wb: '10047.78064838449929', cw: '10042.64433663449929' }], P: [{ s: 'BTCUSDT', pa: '0.001', ep: '83731', up: '0', mt: 'isolated', iw: '5.13631175', ps: 'LONG' }] } })
    expect(result.positions[0]!.holdAmount).toBe('5.13631175')
    expect(result.positions[0]!.id).toBe(1261)
    same(result.account!.canUseAmount, '10042.6443366345')
    same(result.account!.isolateMargin, '5.13631175')
    same(result.account!.totalAmount, '10047.78064838449929')
  })

  it('a deposit (transfer in) raises balances by the wallet delta', () => {
    const result = applyAccountUpdate({ ...base, positions: [], account: isoLegacy.accounts[0], wallet: { wb: '100', cw: '100' }, update: { m: 'DEPOSIT', B: [{ a: 'USDT', wb: '150', cw: '150' }] } })
    same(result.account!.canUseAmount, '10093.6443366345')
    same(result.account!.totalAmount, '10097.78064838449929')
  })
})


it('a delisted contract supplied as metadata still maps its existing position and close quantity', () => {
  const metadata = normalizePublicInfo({ contractList: [], allContractList: [{ id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', status: 0, coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4 } }] })
  expect(metadata.contractList).toEqual([])
  const complete = (metadata.allContractList ?? []).map(buildContract).filter(entry => entry !== null)
  const live = snapshotToLegacy({ account: crossAccount, risk: crossRisk, contracts: complete, previousPositions: crossLegacy.positions, previousAccount: crossLegacy.accounts[0], marginCoin: 'USDT', openOrders: [] })
  expect(live.positions).toHaveLength(1)
  expect(live.positions[0]?.contractId).toBe(1)
  expect(live.positions[0]?.positionVolume).toBe('10')
  expect(live.positions[0]?.canCloseVolume).toBe('10')
})


describe('QA-122 cumulative close PnL across live account refreshes', () => {
  it('enriches new cumulative fields when old fields are unchanged and retains them through live updates', () => {
    const before = crossLegacy.accounts[0]!
    const legacy = { ...before, cumulativeClosedPnl: '-0.0735000000000001', currentPositionRealizedAmount: '0' }
    const enriched = mergeLegacyAccount(before, legacy)!
    expect(enriched).not.toBe(before)
    expect(enriched.cumulativeClosedPnl).toBe('-0.0735000000000001')
    expect(enriched.realizedAmount).toBe('0')
    const snapshot = snapshotToLegacy({ account: crossAccount, risk: [], contracts, previousPositions: [], previousAccount: enriched, marginCoin: 'USDT', openOrders: [] })
    expect(snapshot.account!.cumulativeClosedPnl).toBe('-0.0735000000000001')
    expect(snapshot.account!.currentPositionRealizedAmount).toBe('0')
    const updated = applyAccountUpdate({ update: { m: 'MARGIN_TRANSFER', B: [{ a: 'USDT', wb: '10049', cw: '10049' }] }, positions: [], account: snapshot.account!, wallet: snapshot.wallet, contracts, marginCoin: 'USDT', leverageFor: () => null })
    expect(updated.account?.cumulativeClosedPnl).toBe('-0.0735000000000001')
    expect(updated.account?.currentPositionRealizedAmount).toBe('0')
    expect(mergeLegacyAccount(enriched, legacy)).toBe(enriched)
  })
  it('leaves cumulative PnL unknown on older servers without substituting current-position zero', () => {
    const snapshot = snapshotToLegacy({ account: crossAccount, risk: [], contracts, previousPositions: [], previousAccount: crossLegacy.accounts[0], marginCoin: 'USDT', openOrders: [] })
    expect(snapshot.account!.cumulativeClosedPnl).toBe('')
    expect(snapshot.account!.realizedAmount).toBe('0')
  })
})
