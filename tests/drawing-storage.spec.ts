import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_OVERLAY_NAMES,
  DEFAULT_MAIN_INDICATOR,
  DEFAULT_SUB_INDICATOR,
  MAX_EXTEND_DATA_LENGTH,
  MAX_SNAPSHOT_BYTES,
  STORAGE_NAMESPACE,
  buildSnapshot,
  clearSnapshot,
  countDrawingOmissions,
  drawingsEqual,
  isAnnotationOverlay,
  jsonSafe,
  loadSnapshot,
  parseSnapshot,
  restoreSelection,
  sanitizeCandleType,
  sanitizeDrawing,
  sanitizeDrawings,
  sanitizeExtendData,
  sanitizeMainIndicator,
  sanitizePoint,
  sanitizeSubIndicator,
  sanitizeYAxisType,
  saveSnapshot,
  serializeSnapshot,
  snapshotKey,
  type ChartSnapshot,
  type StorageLike,
} from '@/modules/charts/drawing-storage'

class MemoryStorage implements StorageLike {
  readonly entries = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('QuotaExceededError')
    }
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }
}

const SEGMENT = {
  name: 'segment',
  points: [
    { timestamp: 1_790_360_400_000, value: 61_000.5, dataIndex: 12 },
    { timestamp: 1_790_367_600_000, value: 62_500, dataIndex: 18 },
  ],
  styles: { line: { color: '#008f75', size: 1 }, text: { color: '#ffffff' } },
  lock: false,
  visible: true,
}

describe('snapshot scoping', () => {
  it('namespaces keys per symbol and never reuses the legacy TradingView key', () => {
    expect(snapshotKey('btcusdt')).toBe(`${STORAGE_NAMESPACE}.btcusdt`)
    expect(snapshotKey('BTC/USDT')).toBe(`${STORAGE_NAMESPACE}.btcusdt`)
    expect(snapshotKey('BTC/USDT')).not.toContain('picat.chart.layout')
  })

  it('round trips one symbol without touching another', () => {
    const storage = new MemoryStorage()
    const snapshot = buildSnapshot({
      symbol: 'btcusdt',
      main: 'EMA',
      sub: 'MACD',
      candleType: 'area',
      drawings: [SEGMENT],
    })
    expect(saveSnapshot(snapshot, storage)).toEqual({ ok: true })

    const loaded = loadSnapshot('BTC/USDT', storage)
    expect(loaded.error).toBeNull()
    expect(loaded.snapshot).toEqual({
      version: 1,
      symbol: 'btcusdt',
      main: 'EMA',
      sub: 'MACD',
      candleType: 'area',
      yAxisType: 'normal',
      drawings: [
        {
          name: 'segment',
          points: [
            { timestamp: 1_790_360_400_000, value: 61_000.5 },
            { timestamp: 1_790_367_600_000, value: 62_500 },
          ],
          styles: { line: { color: '#008f75', size: 1 }, text: { color: '#ffffff' } },
          lock: false,
          visible: true,
        },
      ],
    })
    expect(loadSnapshot('ethusdt', storage)).toEqual({ snapshot: null, error: null })
  })

  it('clears a stored snapshot', () => {
    const storage = new MemoryStorage()
    saveSnapshot(buildSnapshot({ symbol: 'btcusdt', main: 'MA', sub: 'VOL', candleType: 'candle_solid', drawings: [] }), storage)
    clearSnapshot('btcusdt', storage)
    expect(loadSnapshot('btcusdt', storage)).toEqual({ snapshot: null, error: null })
  })
})

describe('indicator restore', () => {
  it('restores a saved single main/sub selection', () => {
    const snapshot = parseSnapshot({
      version: 1,
      symbol: 'btcusdt',
      main: 'BOLL',
      sub: 'RSI',
      candleType: 'candle_solid',
      drawings: [],
    })
    expect(snapshot?.main).toBe('BOLL')
    expect(snapshot?.sub).toBe('RSI')
  })

  it('falls back to no indicator for unknown or missing values', () => {
    expect(sanitizeMainIndicator('MA')).toBe('MA')
    expect(sanitizeMainIndicator('VOL')).toBeNull()
    expect(sanitizeMainIndicator(undefined)).toBeNull()
    expect(sanitizeSubIndicator('MACD')).toBe('MACD')
    expect(sanitizeSubIndicator('BOLL')).toBeNull()
    expect(sanitizeSubIndicator(null)).toBeNull()
    const snapshot = parseSnapshot({ version: 1, symbol: 'btcusdt', main: 'KDJ', sub: 'OBV', candleType: 'weird', drawings: [] })
    expect(snapshot?.main).toBeNull()
    expect(snapshot?.sub).toBeNull()
    expect(snapshot?.candleType).toBe('candle_solid')
    expect(sanitizeCandleType('area')).toBe('area')
  })

  it('keeps an explicitly saved "none" instead of turning it into the default', () => {
    const storage = new MemoryStorage()
    expect(
      saveSnapshot(buildSnapshot({ symbol: 'btcusdt', main: null, sub: null, candleType: 'area', drawings: [] }), storage),
    ).toEqual({ ok: true })

    const loaded = loadSnapshot('btcusdt', storage)
    expect(loaded.snapshot?.main).toBeNull()
    expect(loaded.snapshot?.sub).toBeNull()

    // A stored NONE must stay off; only a symbol with no snapshot at all gets the defaults.
    expect(restoreSelection(loaded.snapshot)).toEqual({ main: null, sub: null, candleType: 'area', yAxisType: 'normal' })
    expect(restoreSelection(null)).toEqual({
      main: DEFAULT_MAIN_INDICATOR,
      sub: DEFAULT_SUB_INDICATOR,
      candleType: 'candle_solid',
      yAxisType: 'normal',
    })

    const mixed = parseSnapshot({ version: 1, symbol: 'ethusdt', main: null, sub: 'RSI', candleType: 'candle_solid', drawings: [] })
    expect(restoreSelection(mixed)).toEqual({ main: null, sub: 'RSI', candleType: 'candle_solid', yAxisType: 'normal' })
  })
})

describe('drawing sanitising', () => {
  it('keeps only millisecond time/value points', () => {
    expect(sanitizePoint({ timestamp: 1_000, value: 5, dataIndex: 3 })).toEqual({ timestamp: 1_000, value: 5 })
    expect(sanitizePoint({ timestamp: 1_000 })).toBeNull()
    expect(sanitizePoint({ timestamp: Number.NaN, value: 5 })).toBeNull()
    expect(sanitizePoint({ timestamp: 0, value: 5 })).toBeNull()
    expect(sanitizePoint('nope')).toBeNull()
    expect(sanitizePoint({ timestamp: 1_000, value: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('rejects drawings without a name or usable points', () => {
    expect(sanitizeDrawing(SEGMENT)?.name).toBe('segment')
    expect(sanitizeDrawing({ ...SEGMENT, name: '  ' })).toBeNull()
    expect(sanitizeDrawing({ ...SEGMENT, points: [] })).toBeNull()
    expect(sanitizeDrawing({ ...SEGMENT, points: [{ dataIndex: 4 }] })).toBeNull()
    expect(sanitizeDrawing(null)).toBeNull()
    expect(sanitizeDrawings([SEGMENT, 'junk', { name: 'segment' }])).toHaveLength(1)
  })

  it('drops callbacks, class instances and circular references from styles', () => {
    const circular: Record<string, unknown> = { color: '#fff' }
    circular.self = circular
    const styles = jsonSafe({
      line: { color: '#fff', callback: () => undefined, size: undefined },
      broken: Number.NaN,
      date: new Date(0),
      circular,
    }) as Record<string, unknown>
    expect(styles.line).toEqual({ color: '#fff' })
    expect(styles.broken).toBeNull()
    expect(styles.date).toEqual({})
    // A circular reference is truncated by the depth limit instead of throwing.
    expect(() => JSON.stringify(styles)).not.toThrow()
  })

  it('drops live overlay callbacks before serializing', () => {
    const drawing = sanitizeDrawing({
      name: 'brush',
      lock: 'yes',
      visible: false,
      points: [{ timestamp: 1, value: 2 }],
      styles: { path: { color: '#fff' }, onDrawEnd: () => undefined },
      onRemoved: () => undefined,
      createPointFigures: () => undefined,
    })
    expect(drawing).toEqual({
      name: 'brush',
      points: [{ timestamp: 1, value: 2 }],
      styles: { path: { color: '#fff' } },
      lock: false,
      visible: false,
    })
    expect(JSON.stringify(drawing)).not.toContain('onRemoved')
  })

  it('keeps bounded annotation text for simpleAnnotation/simpleTag only', () => {
    const annotation = {
      name: 'simpleAnnotation',
      points: [{ timestamp: 1_790_360_400_000, value: 61_000 }],
      extendData: '  buy zone  ',
      lock: false,
      visible: true,
    }
    expect(sanitizeDrawing(annotation)?.extendData).toBe('buy zone')
    expect(sanitizeDrawing({ ...annotation, name: 'simpleTag' })?.extendData).toBe('buy zone')

    // Every other overlay may hold objects or callbacks in extendData: never persisted.
    expect(sanitizeDrawing({ ...annotation, name: 'segment' })).not.toHaveProperty('extendData')
    expect(sanitizeDrawing({ ...annotation, name: 'brush', extendData: { raw: 1 } })).not.toHaveProperty('extendData')

    // Non-string, empty and over-long text is dropped rather than invented or truncated.
    expect(sanitizeDrawing({ ...annotation, extendData: 42 })).not.toHaveProperty('extendData')
    expect(sanitizeDrawing({ ...annotation, extendData: '   ' })).not.toHaveProperty('extendData')
    expect(sanitizeDrawing({ ...annotation, extendData: 'x'.repeat(MAX_EXTEND_DATA_LENGTH + 1) })).not.toHaveProperty(
      'extendData',
    )
    expect(sanitizeExtendData('simpleAnnotation', 'x'.repeat(MAX_EXTEND_DATA_LENGTH))).toHaveLength(MAX_EXTEND_DATA_LENGTH)
    expect(ANNOTATION_OVERLAY_NAMES).toEqual(['simpleAnnotation', 'simpleTag'])
    expect(isAnnotationOverlay('simpleTag')).toBe(true)
    expect(isAnnotationOverlay('segment')).toBe(false)
  })

  it('reports drawings and points that cannot be stored', () => {
    // A margin point has a price but no time, so the whole drawing is unstorable.
    const blankMargin = { name: 'segment', points: [{ value: 61_000 }, { value: 62_000 }], lock: false, visible: true }
    expect(countDrawingOmissions([blankMargin])).toEqual({ drawings: 1, points: 0 })

    // One blank point on an otherwise valid drawing loses that point but keeps the drawing.
    const partial = { name: 'brush', points: [{ timestamp: 1_000, value: 5 }, { value: 6 }] }
    expect(countDrawingOmissions([partial])).toEqual({ drawings: 0, points: 1 })

    expect(countDrawingOmissions([SEGMENT])).toEqual({ drawings: 0, points: 0 })
    expect(countDrawingOmissions('nope')).toEqual({ drawings: 0, points: 0 })
  })
})

describe('annotation persistence', () => {
  it('reloads annotation text through storage so it comes back on restore', () => {
    const storage = new MemoryStorage()
    const snapshot = buildSnapshot({
      symbol: 'btcusdt',
      main: null,
      sub: null,
      candleType: 'candle_solid',
      drawings: [
        {
          name: 'simpleAnnotation',
          points: [
            { timestamp: 1_790_360_400_000, value: 61_000.5 },
            { timestamp: 1_790_367_600_000, value: 62_500 },
          ],
          extendData: 'breakout retest',
          styles: { line: { color: '#008f75' } },
          lock: false,
          visible: true,
        },
      ],
    })
    expect(saveSnapshot(snapshot, storage)).toEqual({ ok: true })

    const loaded = loadSnapshot('BTC/USDT', storage)
    const drawing = loaded.snapshot?.drawings[0]
    expect(drawing?.extendData).toBe('breakout retest')
    expect(typeof drawing?.extendData).toBe('string')

    // An arbitrary object payload must never reach storage, even on an annotation.
    const unsafe = buildSnapshot({
      symbol: 'btcusdt',
      main: null,
      sub: null,
      candleType: 'candle_solid',
      drawings: [{ ...SEGMENT, name: 'simpleAnnotation', extendData: { raw: 1 } }],
    })
    expect(unsafe.drawings[0]).not.toHaveProperty('extendData')
  })
})

describe('size budget and failure handling', () => {
  it('rejects a snapshot above the 2 MB budget instead of truncating it', () => {
    const snapshot: ChartSnapshot = {
      version: 1,
      symbol: 'btcusdt',
      main: 'MA',
      sub: 'VOL',
      candleType: 'candle_solid',
      yAxisType: 'normal',
      drawings: [
        {
          name: 'brush',
          points: [{ timestamp: 1, value: 1 }],
          styles: { text: { value: 'x'.repeat(MAX_SNAPSHOT_BYTES) } },
          lock: false,
          visible: true,
        },
      ],
    }
    expect(serializeSnapshot(snapshot)).toBeNull()
    expect(saveSnapshot(snapshot, new MemoryStorage())).toEqual({ ok: false, reason: 'too_large' })
  })

  it('caps the number of stored drawings and points per drawing', () => {
    const many = Array.from({ length: 600 }, () => SEGMENT)
    expect(sanitizeDrawings(many)).toHaveLength(500)
    const long = { ...SEGMENT, points: Array.from({ length: 4_000 }, (_value, index) => ({ timestamp: index + 1, value: 1 })) }
    expect(sanitizeDrawing(long)?.points).toHaveLength(3000)
  })

  it('reports unavailable storage and corrupt payloads', () => {
    expect(saveSnapshot(buildSnapshot({ symbol: 'btcusdt', main: 'MA', sub: 'VOL', candleType: 'candle_solid', drawings: [] }), null)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(loadSnapshot('btcusdt', null)).toEqual({ snapshot: null, error: 'unavailable' })

    const storage = new MemoryStorage()
    storage.entries.set(snapshotKey('btcusdt'), '{not json')
    expect(loadSnapshot('btcusdt', storage)).toEqual({ snapshot: null, error: 'corrupt' })

    storage.entries.set(snapshotKey('btcusdt'), JSON.stringify({ version: 99, symbol: 'btcusdt' }))
    expect(loadSnapshot('btcusdt', storage)).toEqual({ snapshot: null, error: 'corrupt' })

    const failing = new MemoryStorage()
    failing.failWrites = true
    expect(saveSnapshot(buildSnapshot({ symbol: 'btcusdt', main: 'MA', sub: 'VOL', candleType: 'candle_solid', drawings: [] }), failing)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(MAX_SNAPSHOT_BYTES).toBe(2_000_000)
  })
})

describe('undo comparison', () => {
  it('compares validated drawing lists structurally', () => {
    const first = sanitizeDrawings([SEGMENT])
    const second = sanitizeDrawings([
      { ...SEGMENT, points: [...SEGMENT.points], styles: { line: { color: '#008f75', size: 1 }, text: { color: '#ffffff' } } },
    ])
    expect(drawingsEqual(first, second)).toBe(true)
    expect(drawingsEqual(first, sanitizeDrawings([{ ...SEGMENT, lock: true }]))).toBe(false)
  })

  it('never serializes functions through the snapshot builder', () => {
    const snapshot: ChartSnapshot = buildSnapshot({
      symbol: 'btcusdt',
      main: 'MA',
      sub: 'VOL',
      candleType: 'candle_solid',
      drawings: [{ ...SEGMENT, onRemoved: () => undefined }],
    })
    expect(Object.keys(snapshot).sort()).toEqual(['candleType', 'drawings', 'main', 'sub', 'symbol', 'version', 'yAxisType'])
    expect(Object.keys(snapshot.drawings[0]).sort()).toEqual(['lock', 'name', 'points', 'styles', 'visible'])
  })
})

describe('price axis scale', () => {
  it('round trips the y-axis type and falls back to linear for old or unknown values', () => {
    const storage = new MemoryStorage()
    saveSnapshot(buildSnapshot({ symbol: 'btcusdt', main: 'MA', sub: null, candleType: 'candle_solid', yAxisType: 'logarithm', drawings: [] }), storage)
    const loaded = loadSnapshot('btcusdt', storage)
    expect(loaded.snapshot?.yAxisType).toBe('logarithm')
    expect(restoreSelection(loaded.snapshot).yAxisType).toBe('logarithm')
    expect(parseSnapshot({ version: 1, symbol: 'btcusdt', main: null, sub: null, candleType: 'area', drawings: [] })?.yAxisType).toBe('normal')
    expect(sanitizeYAxisType('percentage')).toBe('percentage')
    expect(sanitizeYAxisType('exp')).toBe('normal')
    expect(sanitizeYAxisType(3)).toBe('normal')
    expect(restoreSelection(null).yAxisType).toBe('normal')
  })
})
