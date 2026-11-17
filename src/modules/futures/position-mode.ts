/**
 * Binance position modes on a hedge-only backend (2026-09-29).
 *
 * Binance defaults to One-way (单向持仓): one net position per contract, only 「买入/做多」「卖出/做空」, and
 * 「只减仓」. Hedge (双向持仓) opens/closes long and short separately (开多/开空/平多/平空).
 *
 * Our backend keeps long and short positions apart and every order carries `open` = OPEN | CLOSE. Its own
 * SINGLE mode (`user_ext.position_model` 1) does NOT net orders: it only restricts them, and a reversing OPEN
 * auto-cancels resting CLOSE orders (`ValidateServiceImpl.checkSingle`). So the server stays in hedge mode (2) and
 * One-way is mapped here:
 *
 * | holding on this contract | action            | backend orders                                        |
 * | ------------------------ | ----------------- | ----------------------------------------------------- |
 * | none / same side         | buy (sell) q      | OPEN q                                                |
 * | opposite, closable c     | q <= c            | CLOSE q                                               |
 * | opposite, c = size       | q > c             | CLOSE c, then OPEN q − c (sequential)                 |
 * | opposite, c < size       | q > c             | refused: resting close orders hold size − c           |
 * | opposite                 | reduce-only q     | CLOSE min(q, c)                                       |
 * | none / same side         | reduce-only       | refused                                               |
 * | long AND short (legacy)  | anything          | refused: shown as hedge, close one side first         |
 *
 * Default (2026-09-30): Hedge, although Binance defaults new accounts to One-way. Every existing Longbit user has only
 * ever seen 开多/开空/平多/平空; silently switching them would turn 「卖出/做空」 into "close my long" on the next click.
 * One-way is an opt-in preference (偏好设置 → 持仓模式), stored per uid in this browser.
 */
import { computed, ref, type ComputedRef } from 'vue'

export type PositionMode = 'oneWay' | 'hedge'
export type OrderSide = 'BUY' | 'SELL'

export const POSITION_MODE_KEY = 'picat.futures.positionMode'
export const DEFAULT_POSITION_MODE: PositionMode = 'hedge'

function modeKey(uid: string | number | null | undefined): string {
  return uid === null || uid === undefined || uid === '' ? POSITION_MODE_KEY : `${POSITION_MODE_KEY}.${uid}`
}

/** The user's position mode (per uid in this browser); Hedge unless the user chose One-way. */
export function readPositionMode(uid: string | number | null | undefined): PositionMode {
  try {
    const saved = localStorage.getItem(modeKey(uid))
    return saved === 'oneWay' || saved === 'hedge' ? saved : DEFAULT_POSITION_MODE
  } catch {
    return DEFAULT_POSITION_MODE
  }
}

export function savePositionMode(uid: string | number | null | undefined, mode: PositionMode): void {
  try {
    localStorage.setItem(modeKey(uid), mode)
  } catch {
    // Private mode: the choice simply is not remembered.
  }
}

/** Bumped on every save so `usePositionMode` re-reads storage (all panels in this tab follow at once). */
const modeVersion = ref(0)

/**
 * Reactive position mode for the signed-in uid. Without a uid (profile not loaded yet) the mode is Hedge and cannot be
 * saved, so a half-loaded session never stores a preference under the anonymous key.
 */
export function usePositionMode(uid: () => string | number | null | undefined): { mode: ComputedRef<PositionMode>; setMode: (next: PositionMode) => boolean } {
  const mode = computed<PositionMode>(() => {
    void modeVersion.value
    const id = uid()
    return id === null || id === undefined || id === '' ? DEFAULT_POSITION_MODE : readPositionMode(id)
  })
  function setMode(next: PositionMode): boolean {
    const id = uid()
    if (id === null || id === undefined || id === '') return false
    savePositionMode(id, next)
    modeVersion.value += 1
    return true
  }
  return { mode, setMode }
}

/** Positions of one contract → the long / short holding One-way plans with (the ticket's margin mode first). */
export function holdingsOf(
  positions: readonly { orderSide: 'BUY' | 'SELL' | ''; positionType: 1 | 2 | null; positionVolume: string; canCloseVolume: string }[],
  marginModel: 1 | 2,
): { long: SideHolding | null; short: SideHolding | null } {
  const pick = (side: OrderSide): SideHolding | null => {
    const row = positions.find((entry) => entry.orderSide === side && entry.positionType === marginModel)
      ?? positions.find((entry) => entry.orderSide === side)
    return row === undefined ? null : { volume: row.positionVolume, canClose: row.canCloseVolume }
  }
  return { long: pick('BUY'), short: pick('SELL') }
}

export interface SideHolding {
  /** Position size in whole contracts. */
  volume: string
  /** Closable contracts (size minus resting close orders). */
  canClose: string
}

export interface OneWayInput {
  side: OrderSide
  reduceOnly: boolean
  /** Order size in whole contracts. */
  contracts: string
  long: SideHolding | null
  short: SideHolding | null
}

export interface OneWayLeg {
  open: 'OPEN' | 'CLOSE'
  side: OrderSide
  contracts: string
}

export type OneWayRefusal = 'invalidSize' | 'hedgeConflict' | 'noPositionToReduce' | 'reduceOnlySameSide' | 'heldByCloseOrders'

export type OneWayPlan =
  | { ok: true; legs: OneWayLeg[] }
  | { ok: false; key: OneWayRefusal; params?: Record<string, string> }

function whole(value: string): bigint | null {
  const text = value.trim()
  if (!/^\d+(\.0+)?$/.test(text)) return null
  return BigInt(text.split('.')[0])
}

function held(holding: SideHolding | null): { volume: bigint; canClose: bigint } | null {
  if (holding === null) return null
  const volume = whole(holding.volume) ?? 0n
  if (volume <= 0n) return null
  const canClose = whole(holding.canClose) ?? 0n
  return { volume, canClose: canClose < 0n ? 0n : canClose > volume ? volume : canClose }
}

/** Whether this contract holds both a long and a short (legacy hedge data): One-way cannot represent it. */
export function isHedgeConflict(long: SideHolding | null, short: SideHolding | null): boolean {
  return held(long) !== null && held(short) !== null
}

/** Backend orders for a One-way buy/sell (see the table above). Whole contracts in, whole contracts out. */
export function oneWayPlan(input: OneWayInput): OneWayPlan {
  const size = whole(input.contracts)
  if (size === null || size <= 0n) return { ok: false, key: 'invalidSize' }
  const long = held(input.long)
  const short = held(input.short)
  if (long !== null && short !== null) return { ok: false, key: 'hedgeConflict' }
  const opposite = input.side === 'BUY' ? short : long
  const same = input.side === 'BUY' ? long : short

  if (input.reduceOnly) {
    if (opposite === null) return { ok: false, key: same !== null ? 'reduceOnlySameSide' : 'noPositionToReduce' }
    if (opposite.canClose <= 0n) return { ok: false, key: 'heldByCloseOrders', params: { held: String(opposite.volume) } }
    const qty = size < opposite.canClose ? size : opposite.canClose
    return { ok: true, legs: [{ open: 'CLOSE', side: input.side, contracts: String(qty) }] }
  }

  if (opposite === null) return { ok: true, legs: [{ open: 'OPEN', side: input.side, contracts: String(size) }] }
  if (size <= opposite.canClose) return { ok: true, legs: [{ open: 'CLOSE', side: input.side, contracts: String(size) }] }
  if (opposite.canClose < opposite.volume) {
    return { ok: false, key: 'heldByCloseOrders', params: { held: String(opposite.volume - opposite.canClose) } } // float-ok: not float (BigInt whole contracts)
  }
  return {
    ok: true,
    legs: [
      { open: 'CLOSE', side: input.side, contracts: String(opposite.canClose) },
      { open: 'OPEN', side: input.side, contracts: String(size - opposite.canClose) },
    ],
  }
}

/**
 * The One-way 最大 for `side` in contracts: the closable opposite position plus what can still be opened
 * (`maxOpen`, contracts). Reduce-only: the closable opposite position only. `''` when unknown.
 */
export function oneWayMaxContracts(input: { side: OrderSide; reduceOnly: boolean; maxOpen: string; long: SideHolding | null; short: SideHolding | null }): string {
  const long = held(input.long)
  const short = held(input.short)
  const opposite = input.side === 'BUY' ? short : long
  const closable = opposite === null ? 0n : opposite.canClose
  if (input.reduceOnly) return String(closable)
  // With resting close orders the remainder cannot reverse (it would leave both sides open).
  if (opposite !== null && opposite.canClose < opposite.volume) return String(closable)
  const open = whole(input.maxOpen)
  if (open === null) return closable > 0n ? String(closable) : ''
  return String(closable + open)
}
