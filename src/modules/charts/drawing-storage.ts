/**
 * Browser persistence for the open-source chart (drawings + indicator selection).
 *
 * Storage is scoped per symbol and namespaced `picat.chart.modern.v1.*`. The legacy
 * TradingView keys (`picat.chart.layout.v1.*`) are never read or written: that widget's
 * serialized state cannot be loaded into klinecharts, so there is nothing to migrate.
 *
 * Only plain data survives a round trip: overlay callbacks, class instances and circular
 * references are stripped before anything is written, and a snapshot larger than 2 MB is
 * rejected instead of being silently truncated.
 */

export const SNAPSHOT_VERSION = 1
export const MAX_SNAPSHOT_BYTES = 2_000_000
export const MAX_DRAWINGS = 500
export const MAX_POINTS_PER_DRAWING = 3_000
export const MAX_STYLE_DEPTH = 6
export const STORAGE_NAMESPACE = 'picat.chart.modern.v1'

/** Indicator menus: exactly one main and one sub indicator can be active per symbol. */
export const MAIN_INDICATORS = ['MA', 'EMA', 'BOLL'] as const
export const SUB_INDICATORS = ['VOL', 'MACD', 'RSI'] as const
export const DEFAULT_MAIN_INDICATOR = 'MA'
export const DEFAULT_SUB_INDICATOR = 'VOL'

/**
 * The only overlays whose `extendData` is a user-visible text label. Every other overlay either
 * carries no `extendData` or carries an object/callback that must never reach storage.
 */
export const ANNOTATION_OVERLAY_NAMES = ['simpleAnnotation', 'simpleTag'] as const
/** Storage bound for annotation text; the toolbar dialog caps input at 64 characters. */
export const MAX_EXTEND_DATA_LENGTH = 256

export type CandleType = 'candle_solid' | 'area'
/** Price-axis scale of the candle pane; KLineCharts ships all three as built-in y axes. */
export const Y_AXIS_TYPES = ['normal', 'percentage', 'logarithm'] as const
export type YAxisType = (typeof Y_AXIS_TYPES)[number]
export type MainIndicator = (typeof MAIN_INDICATORS)[number]
export type SubIndicator = (typeof SUB_INDICATORS)[number]

/** An overlay point, in chart terms: milliseconds + price (never a data index). */
export interface StoredPoint {
  timestamp: number
  value: number
}

export interface StoredDrawing {
  name: string
  points: StoredPoint[]
  styles: Record<string, unknown> | null
  lock: boolean
  visible: boolean
  /**
   * Bounded text payload; present only for `simpleAnnotation`/`simpleTag`. The key is omitted for
   * every other overlay so an arbitrary object can never be persisted.
   */
  extendData?: string
}

export interface ChartSnapshot {
  version: number
  symbol: string
  main: MainIndicator | null
  sub: SubIndicator | null
  candleType: CandleType
  /** Added 2026-09-27 without a version bump: older snapshots lack it and read as `normal`. */
  yAxisType: YAxisType
  drawings: StoredDrawing[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type SaveResult = { ok: true } | { ok: false; reason: 'too_large' | 'unavailable' }
export interface LoadResult {
  snapshot: ChartSnapshot | null
  error: 'unavailable' | 'corrupt' | null
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) {
    return storage
  }
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** `BTC/USDT` and `btcusdt` are the same chart scope. */
export function normalizeSymbolKey(symbol: string): string {
  return symbol.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

export function snapshotKey(symbol: string): string {
  return `${STORAGE_NAMESPACE}.${normalizeSymbolKey(symbol)}`
}

/* ------------------------------------------------------------------ validation */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizeMainIndicator(value: unknown): MainIndicator | null {
  return typeof value === 'string' && (MAIN_INDICATORS as readonly string[]).includes(value)
    ? (value as MainIndicator)
    : null
}

export function sanitizeSubIndicator(value: unknown): SubIndicator | null {
  return typeof value === 'string' && (SUB_INDICATORS as readonly string[]).includes(value)
    ? (value as SubIndicator)
    : null
}

export function sanitizeCandleType(value: unknown): CandleType {
  return value === 'area' ? 'area' : 'candle_solid'
}

export function sanitizeYAxisType(value: unknown): YAxisType {
  return typeof value === 'string' && (Y_AXIS_TYPES as readonly string[]).includes(value) ? (value as YAxisType) : 'normal'
}

export function sanitizePoint(value: unknown): StoredPoint | null {
  if (!isRecord(value)) {
    return null
  }
  const timestamp = value.timestamp
  const price = value.value
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null
  }
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    return null
  }
  return { timestamp, value: price }
}

export function sanitizePoints(value: unknown): StoredPoint[] {
  if (!Array.isArray(value)) {
    return []
  }
  const points: StoredPoint[] = []
  value.slice(0, MAX_POINTS_PER_DRAWING).forEach((point) => {
    const parsed = sanitizePoint(point)
    if (parsed !== null) {
      points.push(parsed)
    }
  })
  return points
}

/**
 * Structural clone limited to JSON data. Functions, class instances, `undefined` values and
 * anything nested deeper than `MAX_STYLE_DEPTH` are dropped, so a live overlay's style object
 * (which may carry callbacks or shared references) can never break serialization.
 */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null) {
    return null
  }
  const type = typeof value
  if (type === 'number') {
    return Number.isFinite(value as number) ? value : null
  }
  if (type === 'string' || type === 'boolean') {
    return value
  }
  if (type !== 'object' || depth >= MAX_STYLE_DEPTH) {
    return undefined
  }
  if (Array.isArray(value)) {
    const list: unknown[] = []
    value.forEach((entry) => {
      const safe = jsonSafe(entry, depth + 1)
      if (safe !== undefined) {
        list.push(safe)
      }
    })
    return list
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  Object.keys(source).forEach((key) => {
    const safe = jsonSafe(source[key], depth + 1)
    if (safe !== undefined) {
      result[key] = safe
    }
  })
  return result
}

function sanitizeStyles(value: unknown): Record<string, unknown> | null {
  const safe = jsonSafe(value)
  if (!isRecord(safe)) {
    return null
  }
  return Object.keys(safe).length === 0 ? null : safe
}

/** True for the built-in annotation overlays that render `extendData` as text. */
export function isAnnotationOverlay(name: string): boolean {
  return (ANNOTATION_OVERLAY_NAMES as readonly string[]).includes(name)
}

/**
 * Keeps only a bounded plain-text `extendData` for the annotation overlays. Anything else
 * (missing, non-string, empty/whitespace, longer than the bound) is dropped rather than truncated
 * so no invented text is ever persisted.
 */
export function sanitizeExtendData(name: string, value: unknown): string | undefined {
  if (!isAnnotationOverlay(name) || typeof value !== 'string') {
    return undefined
  }
  const text = value.trim()
  if (text === '' || text.length > MAX_EXTEND_DATA_LENGTH) {
    return undefined
  }
  return text
}

export function sanitizeDrawing(value: unknown): StoredDrawing | null {
  if (!isRecord(value)) {
    return null
  }
  const name = value.name
  if (typeof name !== 'string' || name.trim() === '') {
    return null
  }
  const trimmedName = name.trim()
  const points = sanitizePoints(value.points)
  if (points.length === 0) {
    return null
  }
  const extendData = sanitizeExtendData(trimmedName, value.extendData)
  return {
    name: trimmedName,
    points,
    styles: sanitizeStyles(value.styles),
    lock: value.lock === true,
    visible: value.visible !== false,
    ...(extendData === undefined ? {} : { extendData }),
  }
}

export function sanitizeDrawings(value: unknown): StoredDrawing[] {
  if (!Array.isArray(value)) {
    return []
  }
  const drawings: StoredDrawing[] = []
  value.slice(0, MAX_DRAWINGS).forEach((entry) => {
    const drawing = sanitizeDrawing(entry)
    if (drawing !== null) {
      drawings.push(drawing)
    }
  })
  return drawings
}

export interface DrawingOmission {
  /** Drawings that could not be stored at all (no valid name, or no storable points). */
  drawings: number
  /** Drawings that were stored but lost at least one point. */
  points: number
}

/**
 * Reports what `sanitizeDrawings` would drop from an on-chart payload. A point drawn in the blank
 * margin the server has no candles for carries only a price and no timestamp, so it cannot be
 * restored later; the caller must tell the user instead of claiming everything was saved.
 */
export function countDrawingOmissions(value: unknown): DrawingOmission {
  if (!Array.isArray(value)) {
    return { drawings: 0, points: 0 }
  }
  let drawings = Math.max(0, value.length - MAX_DRAWINGS)
  let points = 0
  value.slice(0, MAX_DRAWINGS).forEach((entry) => {
    const kept = sanitizeDrawing(entry)
    if (kept === null) {
      drawings += 1
      return
    }
    const rawPoints = isRecord(entry) && Array.isArray(entry.points) ? entry.points : []
    if (kept.points.length < rawPoints.length) {
      points += 1
    }
  })
  return { drawings, points }
}

/* ------------------------------------------------------------------ snapshots */

export interface SnapshotInput {
  symbol: string
  main: unknown
  sub: unknown
  candleType: unknown
  yAxisType?: unknown
  drawings: unknown
}

/** Builds the validated, serializable chart state for one symbol. */
export function buildSnapshot(input: SnapshotInput): ChartSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    symbol: normalizeSymbolKey(input.symbol),
    main: sanitizeMainIndicator(input.main),
    sub: sanitizeSubIndicator(input.sub),
    candleType: sanitizeCandleType(input.candleType),
    yAxisType: sanitizeYAxisType(input.yAxisType),
    drawings: sanitizeDrawings(input.drawings),
  }
}

/** Accepts anything that may have been in storage; `null` when it is not a usable snapshot. */
export function parseSnapshot(value: unknown): ChartSnapshot | null {
  if (!isRecord(value) || value.version !== SNAPSHOT_VERSION) {
    return null
  }
  const symbol = value.symbol
  if (typeof symbol !== 'string' || normalizeSymbolKey(symbol) === '') {
    return null
  }
  return {
    version: SNAPSHOT_VERSION,
    symbol: normalizeSymbolKey(symbol),
    main: sanitizeMainIndicator(value.main),
    sub: sanitizeSubIndicator(value.sub),
    candleType: sanitizeCandleType(value.candleType),
    yAxisType: sanitizeYAxisType(value.yAxisType),
    drawings: sanitizeDrawings(value.drawings),
  }
}

export interface RestoredSelection {
  main: MainIndicator | null
  sub: SubIndicator | null
  candleType: CandleType
  yAxisType: YAxisType
}

/**
 * Restores the persisted indicator/candle selection for a symbol. There is no snapshot only when
 * the symbol has never been configured: that is the one case that gets the defaults. A snapshot
 * that explicitly stored `null` means the user turned the indicator off, so it must stay off
 * instead of silently falling back to the default.
 */
export function restoreSelection(snapshot: ChartSnapshot | null): RestoredSelection {
  if (snapshot === null) {
    return { main: DEFAULT_MAIN_INDICATOR, sub: DEFAULT_SUB_INDICATOR, candleType: 'candle_solid', yAxisType: 'normal' }
  }
  return { main: snapshot.main, sub: snapshot.sub, candleType: snapshot.candleType, yAxisType: snapshot.yAxisType }
}

/** Serialized form, or `null` when it cannot be serialized or exceeds the 2 MB budget. */
export function serializeSnapshot(snapshot: ChartSnapshot): string | null {
  let text: string
  try {
    text = JSON.stringify(snapshot)
  } catch {
    return null
  }
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength >= MAX_SNAPSHOT_BYTES) {
    return null
  }
  return text
}

export function saveSnapshot(snapshot: ChartSnapshot, storage?: StorageLike | null): SaveResult {
  const text = serializeSnapshot(snapshot)
  if (text === null) {
    return { ok: false, reason: 'too_large' }
  }
  const target = resolveStorage(storage)
  if (target === null) {
    return { ok: false, reason: 'unavailable' }
  }
  try {
    target.setItem(snapshotKey(snapshot.symbol), text)
    return { ok: true }
  } catch {
    // Quota errors and disabled storage must be reported, never swallowed.
    return { ok: false, reason: 'unavailable' }
  }
}

export function loadSnapshot(symbol: string, storage?: StorageLike | null): LoadResult {
  const target = resolveStorage(storage)
  if (target === null) {
    return { snapshot: null, error: 'unavailable' }
  }
  let raw: string | null
  try {
    raw = target.getItem(snapshotKey(symbol))
  } catch {
    return { snapshot: null, error: 'unavailable' }
  }
  if (raw === null || raw === '') {
    return { snapshot: null, error: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { snapshot: null, error: 'corrupt' }
  }
  const snapshot = parseSnapshot(parsed)
  return snapshot === null ? { snapshot: null, error: 'corrupt' } : { snapshot, error: null }
}

export function clearSnapshot(symbol: string, storage?: StorageLike | null): void {
  const target = resolveStorage(storage)
  if (target === null) {
    return
  }
  try {
    target.removeItem(snapshotKey(symbol))
  } catch {
    /* Removing an optional layout must never break the chart. */
  }
}

/** True when two drawing lists serialize identically; used to collapse undo steps. */
export function drawingsEqual(left: StoredDrawing[], right: StoredDrawing[]): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}
