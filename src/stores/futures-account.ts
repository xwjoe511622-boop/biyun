import { isQuizRequiredError } from '@/modules/futures/quiz'
import { useFuturesQuizStore } from '@/stores/futures-quiz'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { ApiError, isApiError } from '@/core/errors'
import { showToast } from '@/core/toast'
import { session } from '@/core/session'
import { commitAll, createBalanceOverlay, createCoalescedRefresh, mergeById, type Commit } from '@/core/swr'
import { describeGuardError } from '@/modules/api/guard-errors'
import { describeApiError, guardedRefresh, isOrderResultUnknown, orderUnconfirmedText } from '@/modules/api/error-codes'
import { confirmRejectedSession, requestLanguage } from '@/modules/api/http'
import * as api from '@/modules/futures/api'
import { ensureFuturesMessages } from '@/modules/futures/i18n'
/** How long a 市价 close waits for its fill to show in 持仓 before saying nothing filled, and the re-read interval. */
export const CLOSE_FILL_WAIT_MS = 3000
export const CLOSE_FILL_POLL_MS = 400
/** Server codes for a close priced past the liquidation price (`ApiResultCode` 10058 / 10059 / 10063 / 10064). */
const PAST_LIQUIDATION_CODES = new Set(['10058', '10059', '10063', '10064'])
function isPastLiquidation(error_: unknown): boolean {
  return isApiError(error_) && PAST_LIQUIDATION_CODES.has(String(error_.code))
}
/**
 * A MARKET close refused as past the liquidation price: the Longbit futures guard turns a market CLOSE into an IOC limit
 * at mark x (1 -/+ marketTakeBound) and the order service checks that price against the liquidation price (09-30 live,
 * .86 log `checkReducePrice close_sell … orderPrice:2545.31, recucePrice:2642.27`). "Use market" would be wrong here.
 */
function marketCloseError(error_: unknown): string | null {
  if (!isPastLiquidation(error_)) return null
  ensureFuturesMessages()
  return i18n.global.t('fut.err.marketClosePastLiquidation')
}
import { leverageErrorKey } from '@/modules/futures/leverage-change'
import { clampAvailable, positionPnl, sumPnl, valueWireDp, type PositionPnl } from '@/modules/futures/math'
import { marketOpenValue } from '@/modules/futures/market-open'
import type { ContractLevels } from '@/modules/futures/use-contract-quote'
import { loadFuturesFilters, type FuturesContractFilter } from '@/modules/api/exchange-filters'
import { Decimal } from '@/modules/finance/decimal'
import { marketCloseWire, type MarketCloseWire } from '@/modules/futures/position-close'
import { REVERSE_POLL_MS, REVERSE_SETTLE_MS, type ReverseResult, type ReverseStep } from '@/modules/futures/reverse'
import { describeFuturesGateError, describeTransferError } from '@/modules/transfer/errors'
import { i18n } from '@/i18n'
import {
  INITIAL_OPEN_STATE,
  isNotOpenedError,
  openAccountReducer,
  type OpenAccountEvent,
  type OpenAccountState,
} from '@/modules/futures/open-account'
import type { FuturesAccount, FuturesOrder, FuturesPosition, FuturesUserConfig } from '@/modules/futures/types'
import { fetchFapiAccount, fetchPositionRisk } from '@/modules/futures/fapi'
import { describeFapiError, isFapiError } from '@/modules/futures/fapi-errors'
import { FAPI_CODE_USE_CLASSIC, cancelFapiOrder, fapiOrderParams, fapiOrdersEnabled, placeFapiOrder, takeRejectedLegs, type FapiAttachedOrder } from '@/modules/futures/fapi-order'
import { conditionalOrderParams, tpslLegParams, type WorkingType } from '@/modules/futures/fapi-conditional'
import {
  applyAccountUpdate,
  accountRiskSnapshot,
  contractForSymbol,
  hasRealId,
  mergeLegacyAccount,
  mergeLegacyPositions,
  snapshotToLegacy,
  withCanClose,
  type StreamAccountUpdate,
} from '@/modules/futures/stream-model'
import { useFuturesMarketStore } from './futures-market'
import type { ListKey } from './futures-orders'

/** Legacy `get_assets_list` poll while the user stream is NOT live (fallback; the pre-2026-10-01 behaviour). */
export const ASSETS_POLL_MS = 5_000
/** Safety snapshot while the user stream is live (events drive everything in between). */
export const SAFETY_POLL_MS = 60_000
/** Live mode: at most one legacy `get_assets_list` (legacy-only fields) per this gap; later requests trail. */
export const LEGACY_MIN_GAP_MS = 3_000
/** Live mode: snapshot reconcile after a burst of events (trailing). */
export const SNAPSHOT_DEBOUNCE_MS = 250
/**
 * Live mode with positions: mark-dependent values (margin balance, cross / isolated margin, margin ratio, notional) are
 * re-read from `/fapi/v3/account` this often — the cadence of the mark price itself (`public_market_info`, 10 s). The
 * 5 s legacy poll used to keep them fresh; events only come on fills / transfers.
 */
export const MARK_REFRESH_MS = 10_000
/** A failed event snapshot is retried this often, this many times. */
export const SNAPSHOT_RETRY_MS = 2_000
export const SNAPSHOT_RETRIES = 3
/** Second snapshot after a leverage change. */
export const CONFIG_FOLLOW_MS = 2_500

/** Parts of the one coalesced refresh after a futures action: the assets snapshot and/or order lists. */
export type FuturesRefreshPart = 'assets' | ListKey
/** Registered by the orders store: fetches the requested lists and returns their commits (fetch → commit). */
type ListPreparer = (parts: ReadonlySet<FuturesRefreshPart>) => Promise<Commit>[]

/**
 * Signed-in futures state: onboarding, per-contract user config (leverage / margin mode), the
 * margin account and open positions (`position/get_assets_list`), plus the trading actions.
 * Every action returns `null` on success or the server message. State conventions (`@/core/swr`): the assets
 * snapshot is stale-while-revalidate, an order's margin leaves 可用 at once (overlay, rolled back on refusal), and an
 * action ends in ONE coalesced refresh (assets + the affected order lists) committed together.
 */
/** Returned by `transfer()` when the server accepted the transfer but settles it asynchronously (code 105000). */
export const TRANSFER_PENDING = '__transfer_pending__'

export const useFuturesAccountStore = defineStore('futures-account', () => {
  const market = useFuturesMarketStore()

  const open = ref<OpenAccountState>({ ...INITIAL_OPEN_STATE })
  const config = shallowRef<FuturesUserConfig | null>(null)
  const configError = ref<string | null>(null)
  const configLoading = ref(false)
  const accounts = shallowRef<FuturesAccount[]>([])
  const positions = shallowRef<FuturesPosition[]>([])
  const assetsLoading = ref(false)
  const assetsError = ref<string | null>(null)
  const assetsLoaded = ref(false)
  const busy = ref<string | null>(null)
  /**
   * User stream live (2026-10-01, `stores/futures-live.ts`): positions / balances come from stream events and `/fapi`
   * snapshots; `get_assets_list` only fills the legacy-only fields (id, realized PnL, fees, TP/SL …). False → the old
   * legacy-only behaviour (5 s poll).
   */
  const live = ref(false)
  /** Route of the last order request: Binance-style `/fapi/v1/order` or the classic `order/order_create`. */
  const orderRoute = ref<'fapi' | 'classic' | null>(null)
  /** The server said `-4000` (copy trading): this session stays on the classic entry. */
  let classicOnly = false
  /** Margin-coin wallet / cross wallet of the last snapshot or event (ACCOUNT_UPDATE deltas). */
  let wallet: { wb: string; cw: string } | null = null
  /** Bumped by every applied stream event: a snapshot requested before it is stale and is redone. */
  let eventSeq = 0
  /** Newer snapshot requests own the commit; delayed responses/commits cannot replace a newer risk group. */
  let snapshotRequestSeq = 0
  let lastLegacyAt = 0
  let legacyTimer: ReturnType<typeof setTimeout> | null = null
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  let lastSafetyAt = 0
  let lastMarkAt = 0
  let configFollowTimer: ReturnType<typeof setTimeout> | null = null
  /** Open orders of every contract (orders store), for 可平 (canCloseVolume) in live mode. */
  let openOrdersSource: () => Iterable<FuturesOrder> = () => []
  const overlay = createBalanceOverlay()
  let listPreparer: ListPreparer | null = null
  const refresher = createCoalescedRefresh<FuturesRefreshPart>(async (parts) => {
    const tasks: Promise<Commit>[] = []
    if (parts.has('assets')) tasks.push(prepareAssets())
    if (listPreparer !== null) tasks.push(...listPreparer(parts))
    commitAll(await Promise.all(tasks))
  })

  let generation = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let token = session.getToken()
  onScopeDispose(session.onInvalidate((snapshot) => {
    if (snapshot.token !== token) reset()
    token = snapshot.token
  }))

  function dispatch(event: OpenAccountEvent): void {
    open.value = openAccountReducer(open.value, event)
  }

  /** Guard filters (marketTakeBound per contract) for 市价 closes; loaded once, a plain MARKET order until then. */
  const closeFilters = shallowRef<Record<string, FuturesContractFilter>>({})
  void loadFuturesFilters().then((filters) => { closeFilters.value = filters }).catch(() => undefined)

  /** How a 市价 close of `position` goes on the wire (IOC one tick inside the liquidation price when needed). */
  function marketCloseWireFor(position: FuturesPosition): MarketCloseWire {
    if (position.orderSide === '') return { type: 2, price: '' }
    const filter = closeFilters.value[String(position.contractId)]
    const bound = filter?.marketTakeBound ?? (filter?.multiplierDown ? new Decimal(1).minus(filter.multiplierDown).toFixed() : '0.05')
    const own = market.allContracts.find((entry) => entry.id === position.contractId)
    return marketCloseWire({
      positionSide: position.orderSide,
      liquidationPrice: position.reducePrice,
      mark: positionPnls.value.get(position.id)?.mark || position.markPrice,
      takeBound: bound,
      pricePrecision: own?.pricePrecision ?? 2,
    })
  }

  function describe(error_: unknown): string {
    // Binance-style order entry (`/fapi`, 10-01): its codes and filter refusals in plain words.
    const fapi = describeFapiError(error_, requestLanguage())
    if (fapi !== null) return fapi
    // 2026-09-29 rate limits (-1003 / -1015) and Binance-style order rules (-1013): one clear line in the UI language
    const guard = describeGuardError(error_, requestLanguage())
    if (guard !== null) return guard
    // Unconfirmed order (200011 / timeout): the one text that says "do not resubmit" (placeOrder also refreshes).
    if (isOrderResultUnknown(error_)) return orderUnconfirmedText(requestLanguage())
    // A LIMIT close priced past the liquidation price (10058 / 10059 checkReducePrice, 10063 / 10064 light_close): say
    // what to do. A 市价 close is a MARKET order, which the server never refuses for this (2026-09-30 owner bug).
    // 10013 ORDER_POSITION_LIMIT (leverage tier cap): the server text has no numbers; say what to do.
    if (isApiError(error_) && String(error_.code) === '10013') {
      ensureFuturesMessages()
      return i18n.global.t('fut.err.positionLimit')
    }
    if (isPastLiquidation(error_)) {
      ensureFuturesMessages()
      return i18n.global.t('fut.err.pastLiquidation')
    }
    // Everything else: the futures code table (product = futures: 10001 is 「可用余额不足」 here), sub-reasons, server msg.
    return describeApiError(error_, requestLanguage())
  }

  /**
   * Futures-gate failures in plain words (never a bare code). A futures 10002 is first checked against the spot
   * session (one `common/user_info` probe): signed out there too → the session is cleared and the UI asks to log in;
   * spot still valid → a futures-side auth hiccup (e.g. the 2026-09-29 JWT rotation window), shown with a retry.
   */
  async function gateError(error_: unknown): Promise<string> {
    if (isApiError(error_) && (error_.kind === 'unauthorized' || error_.code === '10002')) {
      const token = session.getToken()
      if (token !== null && token !== '') await confirmRejectedSession(token)
    }
    return describeFuturesGateError(error_, requestLanguage(), session.isAuthenticated()).text
  }

  const isOpened = computed(() => open.value.status === 'opened')
  const marginCoin = computed(() => market.currentContract?.marginCoin ?? 'USDT')
  const account = computed<FuturesAccount | undefined>(() =>
    accounts.value.find((entry) => entry.symbol.toUpperCase() === marginCoin.value) ?? accounts.value[0],
  )
  const available = computed(() => overlay.adjust('available', clampAvailable(account.value?.canUseAmount ?? '')))
  /**
   * futures→spot transferable (2026-09-29): the server's `transferableAmount` (Binance rule — cross wallet balance without
   * unrealized profit, minus cross initial margin, plus unrealized loss, floored at 0). Older servers do not send it: fall
   * back to 可用 (the server still enforces the rule on the transfer itself).
   */
  const transferable = computed(() => {
    const raw = account.value?.transferableAmount ?? ''
    return overlay.adjust('available', clampAvailable(raw !== '' ? raw : (account.value?.canUseAmount ?? '')))
  })
  /** Unrealized profit that makes 可用 larger than 可划转 (`''` when unknown). */
  const transferHeldProfit = computed(() => account.value?.transferHeldProfit ?? '')
  const leverage = computed(() => config.value?.nowLevel ?? null)
  const marginModel = computed<1 | 2>(() => config.value?.marginModel ?? 1)
  /**
   * Mark price for a position (2026-09-29): the live mark of the selected contract (`public_market_info` tagPrice,
   * refreshed every 10 s) when it is known, else the mark the server used for this row (`indexPrice`).
   */
  function markFor(position: FuturesPosition): string {
    const live = market.markPrice
    if (position.contractId === market.currentContract?.id && live !== '' && Number(live) > 0) return live // float-ok: "> 0" presence check, the string itself is used
    return position.markPrice
  }
  /**
   * Position PnL / ROE on the mark-price basis (Binance): `qty × (mark − entry) × direction`, ROE = PnL ÷ (qty × mark ÷
   * leverage). Live FAPI rows use the effective accounting entry, matching outstanding PnL in account equity;
   * older legacy rows retain their own historical entry. Already-settled profit is not added to equity again.
   * Keyed by position id.
   */
  const positionPnls = computed(() => {
    const out = new Map<number, PositionPnl>()
    for (const position of positions.value) {
      const own = market.allContracts.find((entry) => entry.id === position.contractId)
      const multiplier = own?.multiplier ?? ''
      out.set(position.id, positionPnl({
        side: position.orderSide,
        volume: position.positionVolume,
        multiplier,
        entry: position.openAvgPrice,
        mark: markFor(position),
        leverage: position.leverageLevel,
        marginRate: own?.marginRate,
      }))
    }
    return out
  })
  /** Account unrealized PnL: sum of the mark-based position PnL in the current margin coin (`''` when none). */
  const unrealizedPnl = computed(() => {
    const coin = marginCoin.value
    const values: string[] = []
    for (const position of positions.value) {
      const own = market.allContracts.find((entry) => entry.id === position.contractId)
      if (own !== undefined && own.marginCoin.toUpperCase() !== coin.toUpperCase()) continue
      values.push(positionPnls.value.get(position.id)?.pnl ?? '')
    }
    return sumPnl(values)
  })
  const contractPositions = computed(() => {
    const id = market.currentContract?.id
    return positions.value.filter((entry) => entry.contractId === id)
  })

  /** Closable contracts on the current contract for a closing `side` (SELL closes longs). */
  function canCloseFor(closeSide: 'BUY' | 'SELL'): string {
    const holding = closeSide === 'SELL' ? 'BUY' : 'SELL'
    const match = contractPositions.value.find((entry) => entry.orderSide === holding && entry.positionType === marginModel.value)
      ?? contractPositions.value.find((entry) => entry.orderSide === holding)
    return match?.canCloseVolume ?? ''
  }

  function reset(): void {
    generation += 1
    stopPolling()
    refresher.cancel()
    live.value = false
    wallet = null
    classicOnly = false
    orderRoute.value = null
    clearLiveTimers()
    overlay.clear()
    open.value = { ...INITIAL_OPEN_STATE }
    config.value = null
    configError.value = null
    accounts.value = []
    positions.value = []
    assetsError.value = null
    assetsLoaded.value = false
    busy.value = null
  }

  /**
   * Config decides whether the account exists. Not opened (openContract=0 / 100501) → silently create
   * it (`ensureOpened`), no prompt: every user has a futures account by default (owner rule 2026-09-27).
   */
  async function loadConfig(autoOpen = true): Promise<void> {
    const contract = market.currentContract
    if (!session.isAuthenticated() || contract === undefined) return
    const current = generation
    configLoading.value = true
    configError.value = null
    dispatch({ type: 'check' })
    try {
      const result = await api.fetchUserConfig(contract.id)
      if (current !== generation) return
      config.value = result
      dispatch({ type: 'config', openContract: result.openContract })
      if (!result.openContract && autoOpen) {
        configLoading.value = false
        await ensureOpened()
      }
    } catch (error_) {
      if (current !== generation) return
      if (isNotOpenedError(error_)) {
        dispatch({ type: 'notOpened' })
        if (autoOpen) {
          configLoading.value = false
          await ensureOpened()
        }
      } else {
        const message = await gateError(error_)
        if (current !== generation) return
        configError.value = message
        dispatch({ type: 'checkFailed', message })
      }
    } finally {
      if (current === generation) configLoading.value = false
    }
  }

  /**
   * Assets snapshot. Legacy mode: `get_assets_list` owns everything. Live mode: `/fapi` account + positionRisk (core
   * memory) own the live numbers and `get_assets_list` (at most once per LEGACY_MIN_GAP_MS, else trailing) adds the
   * legacy-only fields; a failing `/fapi` read falls back to the full legacy commit.
   */
  async function prepareAssets(): Promise<Commit> {
    if (!live.value) return prepareLegacyAssets(false)
    const legacyDue = Date.now() - lastLegacyAt >= LEGACY_MIN_GAP_MS
    if (!legacyDue) scheduleLegacy(LEGACY_MIN_GAP_MS)
    const [liveCommit, legacy] = await Promise.all([prepareLiveSnapshot(), legacyDue ? prepareLegacyAssets(true) : Promise.resolve(null)])
    if (liveCommit === 'failed') return prepareLegacyAssets(false)
    return () => {
      liveCommit?.()
      legacy?.()
    }
  }

  /** Fetch → commit; the positions list is merged by id so an unchanged position keeps its row (no re-render churn). */
  async function prepareLegacyAssets(enrichOnly: boolean): Promise<Commit> {
    if (!session.isAuthenticated() || !isOpened.value) return null
    const current = generation
    const stamp = overlay.stamp()
    assetsLoading.value = !assetsLoaded.value
    lastLegacyAt = Date.now()
    try {
      const result = await api.fetchAssets()
      if (current !== generation) return null
      return () => {
        if (current !== generation) return
        if (enrichOnly && live.value) {
          // Live rows stay; only the fields the stream / snapshots do not carry move (the legacy read may lag the core).
          positions.value = mergeLegacyPositions(positions.value, result.positions)
          const coin = marginCoin.value.toUpperCase()
          const legacyRow = result.accounts.find((row) => row.symbol.toUpperCase() === coin)
          accounts.value = accounts.value.map((row) => (row.symbol.toUpperCase() === coin ? mergeLegacyAccount(row, legacyRow) ?? row : row))
        } else {
          accounts.value = mergeById(accounts.value, result.accounts, (row) => row.symbol)
          positions.value = mergeById(positions.value, result.positions, (row) => String(row.id))
        }
        overlay.reconcile(stamp)
        assetsError.value = null
        assetsLoaded.value = true
        assetsLoading.value = false
      }
    } catch (error_) {
      if (current !== generation) return null
      return () => {
        if (current !== generation) return
        assetsLoading.value = false
        if (isNotOpenedError(error_)) {
          dispatch({ type: 'notOpened' })
          void ensureOpened()
        } else {
          // Plain words for the "合约账户 --" case (futures restarting, futures-only 10002 …), never a bare code.
          assetsError.value = describeFuturesGateError(error_, requestLanguage(), session.isAuthenticated()).text
        }
      }
    }
  }

  async function loadAssets(): Promise<void> {
    ;(await prepareAssets())?.()
  }

  /* ------------------------------------------------------------ live (user stream) */

  /**
   * `/fapi/v3/account` + `/fapi/v3/positionRisk` → rows (see `snapshotToLegacy`). `'failed'` when the snapshot could
   * not be read (caller falls back to legacy). A snapshot overtaken by a stream event is dropped and redone.
   */
  async function prepareLiveSnapshot(attempt = 0): Promise<Commit | 'failed'> {
    if (!session.isAuthenticated() || !isOpened.value) return null
    const current = generation
    const seq = eventSeq
    const request = ++snapshotRequestSeq
    const stamp = overlay.stamp()
    let fapiAccount: Awaited<ReturnType<typeof fetchFapiAccount>>
    let risk: Awaited<ReturnType<typeof fetchPositionRisk>>
    try {
      fapiAccount = await fetchFapiAccount()
      const heldNow = fapiAccount.positions.some((entry) => Number(entry.positionAmt) !== 0) || positions.value.length > 0 // float-ok: "!== 0" presence check, boolean only
      risk = accountRiskSnapshot(fapiAccount) ?? (heldNow ? await fetchPositionRisk() : [])
    } catch {
      return current === generation ? 'failed' : null
    }
    if (current !== generation || request !== snapshotRequestSeq) return null
    if (seq !== eventSeq) {
      if (attempt < 2) return prepareLiveSnapshot(attempt + 1)
      scheduleSnapshot()
      return null
    }
    return () => {
      if (current !== generation || request !== snapshotRequestSeq) return
      if (seq !== eventSeq) {
        scheduleSnapshot()
        return
      }
      commitLiveSnapshot(fapiAccount, risk)
      overlay.reconcile(stamp)
      assetsError.value = null
      assetsLoaded.value = true
      assetsLoading.value = false
    }
  }

  function commitLiveSnapshot(fapiAccount: Parameters<typeof snapshotToLegacy>[0]['account'], risk: Parameters<typeof snapshotToLegacy>[0]['risk']): void {
    const coin = marginCoin.value.toUpperCase()
    const snapshot = snapshotToLegacy({
      account: fapiAccount,
      risk,
      contracts: market.allContracts,
      previousPositions: positions.value,
      previousAccount: accounts.value.find((row) => row.symbol.toUpperCase() === coin),
      marginCoin: coin,
      openOrders: openOrdersSource(),
    })
    positions.value = mergeById(positions.value, snapshot.positions, (row) => String(row.id))
    if (snapshot.account !== null) {
      const next = snapshot.account
      accounts.value = accounts.value.some((row) => row.symbol.toUpperCase() === coin)
        ? mergeById(accounts.value, accounts.value.map((row) => (row.symbol.toUpperCase() === coin ? next : row)), (row) => row.symbol)
        : [...accounts.value, next]
    }
    wallet = snapshot.wallet
    if (snapshot.missingIds) scheduleLegacy(0)
  }

  /** Live mode on / off (set by the live store after a resync, or when the socket drops). */
  function setLive(on: boolean): void {
    if (live.value === on) return
    live.value = on
    if (!on) {
      snapshotRequestSeq += 1
      clearLiveTimers()
    }
  }

  function clearLiveTimers(): void {
    if (configFollowTimer !== null) clearTimeout(configFollowTimer)
    configFollowTimer = null
    if (legacyTimer !== null) clearTimeout(legacyTimer)
    if (snapshotTimer !== null) clearTimeout(snapshotTimer)
    legacyTimer = null
    snapshotTimer = null
  }

  /** Legacy-only fields (id of a new position, realized PnL, fees, TP/SL) read once, no sooner than `delay`. */
  function scheduleLegacy(delay: number): void {
    if (!live.value || legacyTimer !== null) return
    const wait = Math.max(delay, LEGACY_MIN_GAP_MS - (Date.now() - lastLegacyAt))
    legacyTimer = setTimeout(() => {
      legacyTimer = null
      if (!live.value) return
      void prepareLegacyAssets(true).then((commit) => commit?.())
    }, Math.max(0, wait))
  }

  /**
   * One `/fapi` snapshot after a burst of stream events (margins, liquidation price, balances). A failed read is retried
   * (2 s, up to 3 times): otherwise the incremental values would stand until the 60 s safety snapshot (10-01 live S7).
   */
  function scheduleSnapshot(attempt = 0): void {
    if (!live.value || snapshotTimer !== null) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      if (!live.value) return
      void prepareLiveSnapshot().then((commit) => {
        if (commit !== 'failed') commit?.()
        else if (attempt < SNAPSHOT_RETRIES) scheduleSnapshot(attempt + 1)
      })
    }, attempt === 0 ? SNAPSHOT_DEBOUNCE_MS : SNAPSHOT_RETRY_MS)
  }

  /** The orders store hands over its open orders (all contracts) for 可平. */
  function registerOpenOrders(source: () => Iterable<FuturesOrder>): () => void {
    openOrdersSource = source
    return () => { if (openOrdersSource === source) openOrdersSource = () => [] }
  }

  /** Open orders changed (stream): 可平 follows at once. */
  function openOrdersChanged(): void {
    if (positions.value.length === 0) return
    const next = withCanClose(positions.value, openOrdersSource())
    if (next.some((row, index) => row !== positions.value[index])) positions.value = next
  }

  /** ACCOUNT_UPDATE: rows change at once, then one snapshot (and, for fills / new positions, one legacy read). */
  function applyStreamAccountUpdate(update: StreamAccountUpdate): void {
    eventSeq += 1
    const coin = marginCoin.value.toUpperCase()
    const result = applyAccountUpdate({
      update,
      positions: positions.value,
      account: accounts.value.find((row) => row.symbol.toUpperCase() === coin),
      wallet,
      contracts: market.allContracts,
      marginCoin: coin,
      leverageFor: (contractId) => {
        const own = contractId === market.currentContract?.id ? (config.value?.nowLevel ?? null) : null
        return own ?? positions.value.find((row) => row.contractId === contractId)?.leverageLevel ?? null
      },
    })
    positions.value = withCanClose(result.positions, openOrdersSource())
    if (result.account !== undefined) {
      const next = result.account
      accounts.value = accounts.value.map((row) => (row.symbol.toUpperCase() === coin ? next : row))
    }
    wallet = result.wallet
    assetsLoaded.value = true
    scheduleSnapshot()
    if (result.added) scheduleLegacy(0)
    else if (result.positionsChanged || String(update.m).toUpperCase() === 'MARGIN_TRANSFER') scheduleLegacy(1_500)
  }

  /** ACCOUNT_CONFIG_UPDATE `{s, l}`: leverage of a contract (config and its positions). */
  function applyStreamConfig(update: { s?: unknown; l?: unknown }): void {
    eventSeq += 1
    const own = contractForSymbol(market.allContracts, update.s)
    const level = typeof update.l === 'number' ? update.l : Number(update.l) // float-ok: integer leverage
    if (own === undefined || !Number.isInteger(level) || level <= 0) return
    if (own.id === market.currentContract?.id && config.value !== null && config.value.nowLevel !== level) config.value = { ...config.value, nowLevel: level }
    if (positions.value.some((row) => row.contractId === own.id && row.leverageLevel !== level)) {
      positions.value = positions.value.map((row) => (row.contractId === own.id ? { ...row, leverageLevel: level } : row))
    }
    scheduleSnapshot()
    // The positions' initial margin (可用) follows the new leverage a moment after the config event (10-01 live S4).
    if (configFollowTimer !== null) clearTimeout(configFollowTimer)
    configFollowTimer = setTimeout(() => { configFollowTimer = null; scheduleSnapshot() }, CONFIG_FOLLOW_MS)
  }

  /** Is this row's id the server's (a stream-only row has a negative placeholder until the legacy read)? */
  function positionReady(position: FuturesPosition): boolean {
    return hasRealId(position)
  }

  /** The one refresh after an action (coalesced; see `@/core/swr`). */
  function refreshAfterAction(...parts: FuturesRefreshPart[]): Promise<void> {
    return refresher.request(...parts)
  }

  /** The orders store hands over how to fetch its lists, so one refresh can commit assets and lists together. */
  function registerListRefresh(preparer: ListPreparer): () => void {
    listPreparer = preparer
    return () => { if (listPreparer === preparer) listPreparer = null }
  }

  /**
   * Stream not live: `get_assets_list` every ASSETS_POLL_MS (fallback). Live: a safety snapshot every SAFETY_POLL_MS
   * (`/fapi` account; positionRisk only with positions; the legacy read only with positions). Paused while hidden.
   */
  function startPolling(): void {
    stopPolling()
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (!live.value) {
        void loadAssets()
        return
      }
      if (Date.now() - lastSafetyAt >= SAFETY_POLL_MS) {
        lastSafetyAt = Date.now()
        lastMarkAt = Date.now()
        void safetyRefresh()
        return
      }
      if (positions.value.length > 0 && Date.now() - lastMarkAt >= MARK_REFRESH_MS) {
        lastMarkAt = Date.now()
        void markRefresh()
      }
    }, ASSETS_POLL_MS)
  }

  /** Risk revaluation: commit one full risk group. Never join a fresh maintenance value to an old liquidation price. */
  async function markRefresh(): Promise<void> {
    const commit = await prepareLiveSnapshot()
    if (!live.value) return
    if (commit === 'failed') scheduleSnapshot()
    else commit?.()
  }

  async function safetyRefresh(): Promise<void> {
    const snapshot = await prepareLiveSnapshot()
    if (snapshot === 'failed') {
      await loadAssets()
      return
    }
    snapshot?.()
    if (positions.value.length > 0) (await prepareLegacyAssets(true))?.()
  }

  /** Live mode began (resync done): the next safety tick is a full interval away. */
  function markSynced(): void {
    lastSafetyAt = Date.now()
  }

  function stopPolling(): void {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
  }

  /** Config first (it also tells whether the account is opened), then assets. */
  async function refresh(): Promise<void> {
    await loadConfig()
    if (isOpened.value) await loadAssets()
  }

  let ensurePromise: Promise<boolean> | null = null

  /**
   * Makes sure the futures account exists: `user/create_co_id` (idempotent, same path as the old
   * "open" button, no agreement) and one re-check. Concurrent callers share one attempt. Resolves
   * true when the account is opened; on failure the state is `error` with `initFailed`.
   */
  function ensureOpened(force = false): Promise<boolean> {
    // force: the server just said "not opened" (105001) although the local state says opened (stale).
    if (force && ensurePromise === null) dispatch({ type: 'notOpened' })
    if (isOpened.value) return Promise.resolve(true)
    if (ensurePromise !== null) return ensurePromise
    const current = generation
    const attempt = (async (): Promise<boolean> => {
      dispatch({ type: 'autoOpen' })
      try {
        try {
          await api.openFuturesAccount()
        } catch (gateError_) {
          // risk quiz required (100520): ask in the global dialog; a pass opens the account server-side, then the
          // (idempotent) create_co_id below succeeds. Closing the dialog leaves the `quiz` state (not an error).
          if (!isQuizRequiredError(gateError_)) throw gateError_
          dispatch({ type: 'quizRequired' })
          const passed = await useFuturesQuizStore().ask()
          if (current !== generation) return false
          if (!passed) return false
          dispatch({ type: 'autoOpen' })
          await api.openFuturesAccount()
        }
        if (current !== generation) return false
        await loadConfig(false)
        if (current !== generation) return false
        // openContract still 0 (or config failed) after create_co_id: fail closed.
        if (open.value.status !== 'opened') {
          dispatch({ type: 'openFailed', message: open.value.error ?? 'openContract=0' })
          return false
        }
        await loadAssets()
        return true
      } catch (error_) {
        const message = await gateError(error_)
        if (current === generation) dispatch({ type: 'openFailed', message })
        return false
      }
    })()
    ensurePromise = attempt
    void attempt.finally(() => { if (ensurePromise === attempt) ensurePromise = null })
    return attempt
  }

  /** 「另一操作进行中」 — returned (never null = success) when an action is refused because another one is running. */
  function busyText(): string {
    ensureFuturesMessages()
    return i18n.global.t('fut.pm.busy')
  }

  /** 「无法执行：仓位 / 合约信息不完整，请刷新后重试」 for an action whose inputs are missing (never a silent success). */
  function incompleteText(): string {
    ensureFuturesMessages()
    return i18n.global.t('fut.err.incomplete')
  }

  /**
   * A position shown from the stream before `get_assets_list` gave its server id (≤ LEGACY_MIN_GAP_MS): margin / TP-SL
   * need that id, so say so (never send the placeholder) and fetch it now.
   */
  function pendingIdText(): string {
    scheduleLegacy(0)
    return incompleteText()
  }

  async function run(label: string, action: () => Promise<void>, translate?: (error_: unknown) => string | null): Promise<string | null> {
    // null means success to every caller: a refused start is a message, not null (10-01 audit: transfer, adjust margin,
    // TP/SL, leverage and margin mode all "succeeded" with nothing sent while another action ran).
    if (busy.value !== null) return busyText()
    busy.value = label
    const current = generation
    try {
      await action()
      return null
    } catch (error_) {
      if (isNotOpenedError(error_)) {
        dispatch({ type: 'notOpened' })
        void ensureOpened()
      }
      return translate?.(error_) ?? describe(error_)
    } finally {
      if (current === generation) busy.value = null
    }
  }

  /** `user/level_edit` refusals (10067–10070 since the 2026-09-29 backend guards, 10023 / 10012 before) in the user's language. */
  function leverageError(error_: unknown): string | null {
    const key = isApiError(error_) ? leverageErrorKey(error_.code) : null
    if (key === null) return null
    ensureFuturesMessages()
    return i18n.global.t(key)
  }

  /**
   * Change the contract leverage. Since the 2026-09-29 backend guards the server moves the missing isolated margin
   * from 可用 atomically with the change (answer `data.isolatedTopUps`); only when an older server answers without it
   * are the `topUps` computed by `planLeverageChange` added here afterwards. Positions change leverage too, so
   * positions and 可用 are reloaded as well as the config.
   */
  async function setLeverage(level: number, topUps: { positionId: number; amount: string }[] = []): Promise<string | null> {
    const contract = market.currentContract
    if (contract === undefined) return incompleteText()
    const failures: string[] = []
    const result = await run('leverage', async () => {
      const { serverTopUp } = await api.editLeverage(contract.id, level)
      for (const topUp of serverTopUp ? [] : topUps.filter((entry) => entry.positionId > 0)) {
        try {
          await api.changePositionMargin(topUp.positionId, topUp.amount)
        } catch (error_) {
          failures.push(describe(error_))
        }
      }
    }, leverageError)
    if (result !== null) return result
    await Promise.all([loadConfig(), loadAssets()])
    if (failures.length === 0) return null
    ensureFuturesMessages()
    return i18n.global.t('fut.lev.topUpFailed', { lever: level, reason: [...new Set(failures)].join('；') })
  }

  async function setMarginModel(model: 1 | 2): Promise<string | null> {
    const contract = market.currentContract
    if (contract === undefined) return incompleteText()
    const result = await run('marginModel', () => api.editMarginModel(contract.id, model))
    if (result === null) await loadConfig()
    return result
  }

  /* ------------------------------------------------------------ order entry route (10-01) */

  function mustUseClassic(error_: unknown): boolean {
    return isApiError(error_) && error_.code === FAPI_CODE_USE_CLASSIC
  }

  /**
   * New order: Binance-style `POST /fapi/v1/order` (fgw → core) when the payload maps onto it, else — and after a
   * `-4000` (copy trading; remembered for the session) — the classic `order/order_create`. 条件委托 go to `/fapi` as
   * STOP / TAKE_PROFIT[_MARKET] (core trigger engine, 10-02); an opening order with attached TP/SL (OTO) stays classic
   * until `/fapi` has OTO. A market OPEN by value is turned into whole contracts from the live book of the page contract.
   */
  async function createOrderRouted(payload: api.CreateOrderPayload): Promise<string[]> {
    const own = market.allContracts.find((entry) => entry.id === payload.contractId)
    if (fapiOrdersEnabled() && !classicOnly && own !== undefined) {
      const onPage = own.id === market.currentContract?.id
      const fallbackPrice = onPage ? (market.ticker.close || market.markPrice) : ''
      const workingType: WorkingType = payload.workingType ?? 'CONTRACT_PRICE'
      const reference = !onPage ? '' : workingType === 'MARK_PRICE' ? market.markPrice : (market.ticker.close || '')
      const params = payload.isConditionOrder
        ? conditionalOrderParams(payload, { contract: own, workingType, reference })
        : fapiOrderParams(payload, { contract: own, levels: onPage ? (payload.side === 'BUY' ? market.asks : market.buys) : [], fallbackPrice })
      // A conditional never silently drops to the classic engine (last price only, no -2021 check): say why instead.
      if (params === null && payload.isConditionOrder) {
        ensureFuturesMessages()
        const at = (payload.triggerPrice ?? '').trim()
        const same = /^\d+(\.\d+)?$/.test(reference) && /^\d+(\.\d+)?$/.test(at) && new Decimal(at).eq(reference)
        throw new Error(same ? (describeFapiError(new ApiError({ kind: 'http', code: '-2021', message: '', path: 'fapi/v1/order', product: 'futures' }), requestLanguage()) ?? '') : i18n.global.t('fut.cond.noReference'))
      }
      if (params !== null) {
        try {
          const ids = await placeFapiOrder(params)
          orderRoute.value = 'fapi'
          const rejected = takeRejectedLegs()
          if (rejected.length > 0) warnRejectedLegs(rejected)
          return ids
        } catch (error_) {
          if (!mustUseClassic(error_)) throw error_
          classicOnly = true
        }
      }
    }
    orderRoute.value = 'classic'
    return api.createOrder(payload)
  }

  /**
   * The entry was placed but an attached TP/SL leg was refused (`attachedOrders[].status = REJECTED`): say so loudly —
   * the position will open without that protection.
   */
  function warnRejectedLegs(legs: FapiAttachedOrder[]): void {
    ensureFuturesMessages()
    const t = i18n.global.t
    const names = legs.map((leg) => (String(leg.leg ?? leg.type ?? '').toUpperCase().startsWith('T') ? t('fut.trigType.2') : t('fut.trigType.1')))
    const first = legs[0]
    const reason = first === undefined ? '' : (describeFapiError(new ApiError({ kind: 'http', code: String(first.code ?? ''), message: String(first.msg ?? ''), path: 'fapi/v1/order', product: 'futures' }), requestLanguage()) ?? String(first.msg ?? ''))
    showToast(t('fut.cond.legRejected', { legs: [...new Set(names)].join('、'), reason }), 'error', { key: 'fut-oto-rejected', timeout: 10000 })
  }

  /** Cancel one conditional / TP-SL order: `DELETE /fapi/v1/order` (ids ≥ 8e18 go to the trigger engine), classic after `-4000`. */
  async function cancelConditionalRouted(contractId: number, orderId: string): Promise<void> {
    const own = market.allContracts.find((entry) => entry.id === contractId)
    if (fapiOrdersEnabled() && !classicOnly && own !== undefined) {
      try {
        await cancelFapiOrder(own, orderId)
        return
      } catch (error_) {
        if (!mustUseClassic(error_)) throw error_
        classicOnly = true
      }
    }
    await api.cancelOrder(contractId, orderId, true)
  }

  /** Cancel one open (non-conditional) order: `DELETE /fapi/v1/order`, classic after `-4000`. */
  async function cancelOrderRouted(contractId: number, orderId: string): Promise<void> {
    const own = market.allContracts.find((entry) => entry.id === contractId)
    if (fapiOrdersEnabled() && !classicOnly && own !== undefined) {
      try {
        await cancelFapiOrder(own, orderId)
        return
      } catch (error_) {
        if (!mustUseClassic(error_)) throw error_
        classicOnly = true
      }
    }
    await api.cancelOrder(contractId, orderId, false)
  }

  const orderOps: api.OrderOps = { create: createOrderRouted, cancel: cancelOrderRouted }

  /** Is the `/fapi` entry in use for this session (not switched off, no `-4000` seen)? */
  function fapiOrdersActive(): boolean {
    return fapiOrdersEnabled() && !classicOnly
  }

  /** The server said `-4000`: stay on the classic entry for this session. */
  function useClassicOrders(): void {
    classicOnly = true
  }

  /**
   * Places an order. `reserve` (the ticket's margin estimate) leaves 可用 at once and is rolled back if the server
   * refuses; `onAccepted` receives the new order ids. The follow-up refresh is not awaited: the caller shows the
   * pending row / toast immediately and the one coalesced refresh reconciles.
   */
  async function placeOrder(payload: api.CreateOrderPayload, options: { reserve?: string; onAccepted?: (ids: string[]) => void } = {}): Promise<string | null> {
    // Another action is running: nothing was sent (never report that as a placed order).
    if (busy.value !== null) return busyText()
    const reservation = options.reserve !== undefined && /^\d+(\.\d+)?$/.test(options.reserve) && Number(options.reserve) > 0 // float-ok: "> 0" check on a validated decimal string, boolean only; the reserve string is applied
      ? overlay.apply({ available: `-${options.reserve}` })
      : null
    let ids: string[] = []
    const marketClose = (payload.type === 2 || payload.type === 3) && payload.open === 'CLOSE' && !payload.isConditionOrder
    const held = payload.side === 'BUY' ? 'SELL' : 'BUY'
    const before = marketClose ? heldVolume(payload.contractId, held, payload.positionType) : 0
    let failure: unknown = null
    const result = await run('order', async () => {
      try {
        ids = await createOrderRouted(payload)
      } catch (error_) {
        failure = error_
        throw error_
      }
    }, marketClose ? marketCloseError : undefined)
    if (result !== null) {
      reservation?.rollback()
      if (isOrderResultUnknown(failure) || (isFapiError(failure) && failure.code === '-1007')) {
        // 200011 / timeout: the order may exist. Never retry; re-read 当前委托 / 条件委托 and 持仓 while `busy` keeps the
        // submit buttons disabled (no double click during the refresh), then return the "do not resubmit" text.
        busy.value = 'order'
        const current = generation
        try {
          await guardedRefresh(() => refreshAfterAction('assets', 'current', 'trigger'))
        } finally {
          if (current === generation && busy.value === 'order') busy.value = null
        }
        return orderUnconfirmedText(requestLanguage())
      }
      return result
    }
    reservation?.settle()
    options.onAccepted?.(ids)
    if (marketClose && before > 0) return (await awaitCloseFill(payload.contractId, held, payload.positionType, before)) ? null : noFillMessage()
    void refreshAfterAction('assets', payload.isConditionOrder ? 'trigger' : 'current')
    return null
  }

  /** Contracts held on `contractId` / `orderSide` / `positionType` in the last snapshot (0 when the position is gone). */
  function heldVolume(contractId: number, orderSide: 'BUY' | 'SELL', positionType: number): number {
    const row = positions.value.find((entry) => entry.contractId === contractId && entry.orderSide === orderSide && entry.positionType === positionType)
    return row === undefined ? 0 : Number(row.positionVolume) || 0 // float-ok: whole-contract count, only compared to detect a fill
  }

  /**
   * A 市价 close is accepted first and fills (or is cancelled) asynchronously: re-read 持仓 until the position shrank, for
   * at most `CLOSE_FILL_WAIT_MS`. false = nothing filled (10-01 owner bug: futures market making was paused, the book
   * was empty, the IOC/MARKET close was cancelled with 0 filled and the UI still said 「已提交」).
   */
  async function awaitCloseFill(contractId: number, orderSide: 'BUY' | 'SELL', positionType: number, before: number): Promise<boolean> {
    const deadline = Date.now() + CLOSE_FILL_WAIT_MS
    for (;;) {
      await refreshAfterAction('assets', 'current', 'history', 'positionHistory')
      if (heldVolume(contractId, orderSide, positionType) < before) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, CLOSE_FILL_POLL_MS))
    }
  }

  function noFillMessage(): string {
    ensureFuturesMessages()
    return i18n.global.t('fut.err.closeNoFill')
  }

  async function closeAtMarket(position: FuturesPosition): Promise<string | null> {
    if (position.positionType === null || position.orderSide === '') return incompleteText()
    // Another action is running: nothing is sent. '' (not null), so the caller never reports a close that did not happen.
    if (busy.value !== null) return busyText()
    const { orderSide, positionType } = position
    const before = Number(position.positionVolume) || 0 // float-ok: whole-contract count, only compared to detect a fill
    const result = await run(`close:${position.id}`, () => api.marketClosePosition({ ...position, orderSide, positionType }, marketCloseWireFor(position), orderOps), marketCloseError)
    if (result !== null) return result
    // Awaited so the row keeps "平仓中" until the refreshed positions arrive; a close that filled nothing says so.
    return (await awaitCloseFill(position.contractId, orderSide, positionType, before)) ? null : noFillMessage()
  }

  /**
   * 反手: market-close the whole position (a MARKET CLOSE order, `api.marketClosePosition`), then market-open the opposite side with the same contracts
   * (`marketOpenValue`: book walk + ½ contract, same margin mode and leverage). Two server calls, not atomic: when the open is refused the
   * position stays closed and the result says step 2 failed. `onStep` drives the 「1/2 · 2/2」 progress.
   */
  async function reversePosition(
    position: FuturesPosition,
    onStep?: (step: ReverseStep) => void,
    quote?: { readLevels: () => Promise<ContractLevels>; last: () => string },
  ): Promise<ReverseResult> {
    const own = market.contracts.find((entry) => entry.id === position.contractId)
    if (busy.value !== null || position.positionType === null || position.orderSide === '' || own === undefined) return { ok: false, step: 1, message: incompleteText() }
    const current = position.contractId === market.currentContract?.id
    const openSide = position.orderSide === 'BUY' ? 'SELL' : 'BUY'
    const positionType = position.positionType
    let step: ReverseStep = 1
    const result = await run(`reverse:${position.id}`, async () => {
      onStep?.(1)
      await api.marketClosePosition({ ...position, orderSide: position.orderSide as 'BUY' | 'SELL', positionType }, marketCloseWireFor(position), orderOps)
      // The closed row leaves 持仓 at once; a close that filled nothing (empty book) stops here — never open the other
      // side on top of a position that is still there.
      if (!(await awaitCloseFill(position.contractId, position.orderSide as 'BUY' | 'SELL', positionType, Number(position.positionVolume) || 0))) { // float-ok: whole-contract count, only compared to detect a fill
        throw new Error(noFillMessage())
      }
      step = 2
      onStep?.(2)
      // Priced AFTER the close, from the POSITION's contract book (the page may show another contract; L640).
      const levels = quote !== undefined
        ? await quote.readLevels().catch(() => ({ asks: [], bids: [] }))
        : current ? { asks: market.asks, bids: market.buys } : { asks: [], bids: [] }
      const lastText = quote !== undefined ? quote.last() : current ? market.ticker.close : ''
      const price = /^\d+(\.\d+)?$/.test(lastText) && Number(lastText) > 0 ? lastText : markFor(position) // float-ok: "> 0" check on a validated decimal string, boolean only; the string itself is used
      const value = marketOpenValue({ side: openSide, contracts: position.positionVolume, multiplier: own.multiplier, levels: openSide === 'BUY' ? levels.asks : levels.bids, fallbackPrice: price, dp: valueWireDp(own) }).value
      if (value === '') throw new Error(i18n.global.t('fut.pos.reverseNoPrice'))
      await createOrderRouted({
        contractId: position.contractId, positionType, side: openSide, open: 'OPEN', type: 2, volume: value, price: '', contracts: position.positionVolume,
        leverageLevel: position.leverageLevel ?? leverage.value ?? 1, isConditionOrder: false,
      })
    }, (error_) => (step === 1 ? marketCloseError(error_) : null))
    await refreshAfterAction('assets', 'current', 'history', 'positionHistory')
    if (result !== null) return { ok: false, step, message: result }
    // The open fills asynchronously: keep 「反手中 2/2」 up and re-read 持仓 until the new side shows (≤ REVERSE_SETTLE_MS).
    const shows = (): boolean => positions.value.some((entry) => entry.contractId === position.contractId && entry.orderSide === openSide && Number(entry.positionVolume) > 0) // float-ok: "> 0" presence check, boolean only
    const deadline = Date.now() + REVERSE_SETTLE_MS
    while (!shows() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REVERSE_POLL_MS))
      await refreshAfterAction('assets')
    }
    return { ok: true, visible: shows() }
  }

  /**
   * 一键平仓: market-close every open position (all contracts) one by one with a MARKET CLOSE order (`api.marketClosePosition`). Keeps going after a failure
   * so one rejected position does not leave the rest open; returns the failures joined, or null when all closed.
   */
  /** 一键平仓 outcome for the result toast: how many closed, and each failure by contract (`busy`: nothing was sent). */
  async function closeAllAtMarket(): Promise<{ closed: number; failures: string[]; busy: boolean }> {
    const targets = positions.value.filter((position) => position.positionType !== null && position.orderSide !== '')
    if (targets.length === 0) return { closed: 0, failures: [], busy: false }
    if (busy.value !== null) return { closed: 0, failures: [], busy: true }
    const failures: string[] = []
    let closed = 0
    const result = await run('closeAll', async () => {
      for (const position of targets) {
        try {
          await api.marketClosePosition({ ...position, orderSide: position.orderSide as 'BUY' | 'SELL', positionType: position.positionType as 1 | 2 }, marketCloseWireFor(position), orderOps)
          closed += 1
        } catch (error_) {
          const own = market.allContracts.find((entry) => entry.id === position.contractId)
          failures.push(`${own?.displayName || position.contractName || position.contractId}：${marketCloseError(error_) ?? describe(error_)}`)
        }
      }
    })
    await refreshAfterAction('assets', 'current', 'history', 'positionHistory')
    if (result !== null) failures.push(result)
    return { closed, failures, busy: false }
  }

  async function adjustMargin(position: FuturesPosition, amount: string): Promise<string | null> {
    if (!hasRealId(position)) return pendingIdText()
    const result = await run(`margin:${position.id}`, () => api.changePositionMargin(position.id, amount))
    if (result === null) await refreshAfterAction('assets')
    return result
  }

  /**
   * Position TP/SL. `/fapi`: one TAKE_PROFIT_MARKET / STOP_MARKET close order per leg (`closePosition` for the entire
   * position, Binance default; else the leg's quantity), watching `workingType`. Classic `order_tpsl_create` only for a
   * `-4000` account (copy trading). Returns null when every leg was placed.
   */
  async function createTpsl(position: FuturesPosition, legs: api.TpslLeg[], options: { workingType?: WorkingType; closePosition?: boolean } = {}): Promise<string | null> {
    if (position.positionType === null || position.orderSide === '' || position.leverageLevel === null) return incompleteText()
    const own = market.allContracts.find((entry) => entry.id === position.contractId)
    if (fapiOrdersActive() && own !== undefined) {
      const side = position.orderSide
      let classic = false
      const result = await run(`tpsl:${position.id}`, async () => {
        for (const leg of legs) {
          try {
            await placeFapiOrder(tpslLegParams({
              contract: own, positionSide: side, kind: leg.triggerType === 2 ? 'tp' : 'sl', stopPrice: leg.triggerPrice,
              workingType: options.workingType ?? 'CONTRACT_PRICE', closePosition: options.closePosition === true, contracts: leg.volume,
            }))
          } catch (error_) {
            if (!mustUseClassic(error_)) throw error_
            classicOnly = true
            classic = true
            return
          }
        }
      })
      if (!classic) {
        void refreshAfterAction('assets', 'trigger')
        return result
      }
    }
    if (!hasRealId(position)) return pendingIdText()
    const input = {
      contractId: position.contractId,
      positionId: position.id,
      positionType: position.positionType,
      leverageLevel: position.leverageLevel,
      closeSide: position.orderSide === 'BUY' ? 'SELL' as const : 'BUY' as const,
      legs,
    }
    const result = await run(`tpsl:${position.id}`, () => api.createTpsl(input))
    if (result === null) await refreshAfterAction('assets', 'trigger')
    return result
  }

  /** 105001 (no futures account yet, nothing debited) → create it silently and retry exactly once. */
  /**
   * `co_transfer` answers 105000 when the transfer did not finish on the spot: either nothing moved, or one side is
   * booked and the server reconciler completes or refunds it within ~2–3 min (docs/03-reference/api/co-transfer.md).
   * The UI shows that as "processing", not a hard failure, and balances are re-read while it settles.
   */
  async function transfer(direction: api.TransferDirection, amount: string, coin: string): Promise<string | null> {
    let pending = false
    const result = await run('transfer', async () => {
      await market.refreshPublicInfo()
      const entries = market.allContracts.filter(entry => entry.marginCoin.toUpperCase() === coin.toUpperCase())
      if (entries.length === 0 || !entries.some(entry => direction === 'wallet_to_contract' ? entry.fundsIn : entry.fundsOut)) {
        ensureFuturesMessages()
        throw new Error(i18n.global.t('fut.transferClosed'))
      }
      try {
        await transferOnce(direction, amount, coin)
      } catch (error_) {
        if (isApiError(error_) && error_.code === '105000') {
          pending = true
          return
        }
        throw error_
      }
    }, (error_) => describeTransferError(error_, requestLanguage()).text) // never「接口返回错误码 -1」(2026-09-29)
    if (pending) {
      for (const delay of [30_000, 90_000, 180_000]) setTimeout(() => { void loadAssets() }, delay)
      return TRANSFER_PENDING
    }
    if (result === null) await refreshAfterAction('assets')
    return result
  }

  /** One transfer, with a single retry after opening the futures account if the server says it isn't opened yet. */
  async function transferOnce(direction: api.TransferDirection, amount: string, coin: string): Promise<void> {
    try {
      await api.transferFunds(direction, amount, coin)
    } catch (error_) {
      if (!isNotOpenedError(error_)) throw error_
      // Plain errors below so `run` does not start another silent open (one attempt, one retry).
      if (!(await ensureOpened(true))) throw new Error(open.value.error ?? describe(error_))
      try {
        await api.transferFunds(direction, amount, coin)
      } catch (retryError) {
        throw isNotOpenedError(retryError) ? new Error(describe(retryError)) : retryError
      }
    }
  }

  return {
    open,
    config,
    configError,
    configLoading,
    accounts,
    positions,
    assetsLoading,
    assetsError,
    assetsLoaded,
    busy,
    isOpened,
    marginCoin,
    account,
    available,
    transferable,
    transferHeldProfit,
    leverage,
    marginModel,
    contractPositions,
    positionPnls,
    live,
    orderRoute,
    cancelOrderRouted,
    cancelConditionalRouted,
    fapiOrdersActive,
    useClassicOrders,
    setLive,
    markSynced,
    commitLiveSnapshot,
    prepareLiveSnapshot,
    applyStreamAccountUpdate,
    applyStreamConfig,
    registerOpenOrders,
    openOrdersChanged,
    scheduleLegacy,
    scheduleSnapshot,
    positionReady,
    marketCloseWireFor,
    unrealizedPnl,
    canCloseFor,
    reset,
    loadConfig,
    loadAssets,
    prepareAssets,
    refreshAfterAction,
    registerListRefresh,
    refresh,
    startPolling,
    stopPolling,
    ensureOpened,
    setLeverage,
    setMarginModel,
    placeOrder,
    closeAtMarket,
    closeAllAtMarket,
    reversePosition,
    adjustMargin,
    createTpsl,
    transfer,
  }
})
