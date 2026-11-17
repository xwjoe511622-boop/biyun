<script setup lang="ts">
/**
 * Open-source trading chart (klinecharts 10 + @klinecharts/extension).
 *
 * Data comes from the exchange's own K-line WebSocket through
 * `@/modules/charts/kline-datafeed`; drawings and indicator selection are persisted per symbol
 * through `@/modules/charts/drawing-storage`. Nothing here talks to an external price vendor.
 *
 * The widget is created once per mount and never remounted for realtime data: symbol/timeframe
 * changes go through `setSymbol`/`setPeriod`, live bars arrive through `subscribeBar`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUpRight,
  Brush,
  ChartArea,
  ChartCandlestick,
  Check,
  ChevronDown,
  Circle as CircleIcon,
  Columns3,
  Eye,
  EyeOff,
  ImageDown,
  Info,
  LoaderCircle,
  Lock,
  LockOpen,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
  MousePointer2,
  MoveDiagonal,
  MoveRight,
  Palette,
  Redo2,
  RefreshCw,
  RotateCcw,
  Ruler,
  Save,
  Shapes,
  Square,
  Trash,
  TrendingUp,
  Triangle,
  TriangleAlert,
  Undo2,
} from '@lucide/vue'
import {
  dispose as disposeChart,
  init,
  registerOverlay,
  type Chart,
  type DeepPartial,
  type Overlay,
  type OverlayCreate,
  type OverlayEvent,
  type OverlayStyle,
  type Styles,
} from 'klinecharts'
import {
  arrow as arrowOverlay,
  circle as circleOverlay,
  measure as measureOverlay,
  rect as rectOverlay,
  triangle as triangleOverlay,
} from '@klinecharts/extension'
import { FALLBACK_WS_URL, WS_URL_OVERRIDE } from '@/config/endpoints'
import { runtimeWsUrl } from '@/config/runtime'
import { theme } from '@/core/theme'
import { createKlineDatafeed, scaleToPeriod, type DatafeedStatus, type KlineDatafeed } from '@/modules/charts/kline-datafeed'
import {
  DEFAULT_MAIN_INDICATOR,
  DEFAULT_SUB_INDICATOR,
  MAIN_INDICATORS,
  SUB_INDICATORS,
  buildSnapshot,
  clearSnapshot,
  countDrawingOmissions,
  drawingsEqual,
  isAnnotationOverlay,
  loadSnapshot,
  restoreSelection,
  sanitizeDrawings,
  saveSnapshot,
  sanitizeYAxisType,
  Y_AXIS_TYPES,
  type YAxisType,
  type CandleType,
  type MainIndicator,
  type StoredDrawing,
  type SubIndicator,
} from '@/modules/charts/drawing-storage'
import { useMarketSource } from './market-source'

/* Extra shapes shipped by the official extension package. */
registerOverlay(rectOverlay)
registerOverlay(circleOverlay)
registerOverlay(measureOverlay)
registerOverlay(triangleOverlay)
registerOverlay(arrowOverlay)

const CANDLE_PANE_ID = 'candle_pane'
const SUB_PANE_ID = 'sub_indicator_pane'
const DEFAULT_BAR_SPACE = 10
const DEFAULT_RIGHT_OFFSET = 80
const ANNOTATION_MAX = 64
const SAVE_DEBOUNCE_MS = 400
const HISTORY_LIMIT = 40
const FALLBACK_CANVAS_HEIGHT = 320

let instanceCount = 0

/** Drawing colours are borrowed from the existing design tokens (no new global palette). */
const COLORS: { key: string; cssVar: string; fallback: string }[] = [
  { key: 'up', cssVar: '--color-up', fallback: '#008f75' },
  { key: 'down', cssVar: '--color-down', fallback: '#d64c59' },
  { key: 'warning', cssVar: '--color-warning', fallback: '#b26a00' },
  { key: 'text', cssVar: '--color-text', fallback: '#1c2126' },
  { key: 'secondary', cssVar: '--color-text-secondary', fallback: '#5b646e' },
]

/** A type alias (not an interface) so vue-i18n still sees an implicit index signature. */
type LocalMessages = {
  chart: Record<string, string>
}

const MESSAGES: Record<'en-US' | 'zh-CN', LocalMessages> = {
  'en-US': {
    chart: {
      toolbar: 'Chart tools',
      zoneHint: 'Chart times are in {zone}. Daily, weekly and monthly candles open at 00:00 UTC.',
      selectTool: 'Select and pan (cancel drawing)',
      toolSegment: 'Trend segment',
      toolHorizontal: 'Horizontal line',
      toolRay: 'Ray',
      toolChannel: 'Price channel',
      toolFibonacci: 'Fibonacci retracement',
      toolBrush: 'Brush',
      toolAnnotation: 'Annotation',
      moreShapes: 'More shapes',
      shapeRect: 'Rectangle',
      shapeCircle: 'Circle',
      shapeMeasure: 'Measure',
      shapeTriangle: 'Triangle',
      shapeArrow: 'Arrow',
      color: 'Drawing colour',
      colorUp: 'Green',
      colorDown: 'Red',
      colorWarning: 'Amber',
      colorText: 'Ink',
      colorSecondary: 'Slate',
      needSelection: 'Select a drawing first',
      lockDrawing: 'Lock drawing',
      unlockDrawing: 'Unlock drawing',
      hideDrawing: 'Hide drawing',
      showDrawing: 'Show drawing',
      deleteDrawing: 'Delete drawing',
      undo: 'Undo',
      redo: 'Redo',
      save: 'Save drawings and indicators',
      saved: 'Saved in this browser',
      savePartial: 'Not everything was saved: points outside the loaded candles have no time and are dropped.',
      saveFailed: 'Chart was not saved. Check browser storage and retry.',
      saveTooLarge: 'Chart state is larger than 2 MB and was not saved.',
      storageUnavailable: 'Browser storage is unavailable, drawings will not persist.',
      storageCorrupt: 'Saved chart state could not be read and was reset.',
      mainIndicator: 'Main indicator',
      subIndicator: 'Sub indicator',
      indicatorNone: 'None',
      candle: 'Candles',
      area: 'Area',
      yAxis: 'Price scale',
      yAxisnormal: 'Linear',
      yAxispercentage: 'Percent',
      yAxislogarithm: 'Log',
      resetZoom: 'Reset zoom',
      screenshot: 'Export image',
      screenshotFailed: 'Image export failed in this browser.',
      fullscreen: 'Fullscreen',
      exitFullscreen: 'Exit fullscreen',
      fullscreenFailed: 'Fullscreen is not available in this browser.',
      loading: 'Loading chart data…',
      empty: 'No chart data yet',
      noHistory: 'No historical candles from the server yet — only candles built from live trades are shown.',
      error: 'Chart data unavailable',
      retry: 'Retry',
      annotationTitle: 'Annotation text',
      annotationPrompt: 'Text (max {max} characters)',
      annotationTooLong: 'Annotation must be at most {max} characters',
      annotationRequired: 'Enter some text for the annotation',
      confirm: 'Apply',
      cancel: 'Cancel',
      dismiss: 'Dismiss',
    },
  },
  'zh-CN': {
    chart: {
      toolbar: '图表工具',
      zoneHint: '图表时间按 {zone} 显示；日线、周线、月线均按 UTC 00:00 开盘切分。',
      selectTool: '选择与平移（取消绘制）',
      toolSegment: '趋势线',
      toolHorizontal: '水平线',
      toolRay: '射线',
      toolChannel: '价格通道',
      toolFibonacci: '斐波那契回调',
      toolBrush: '画笔',
      toolAnnotation: '文字标注',
      moreShapes: '更多图形',
      shapeRect: '矩形',
      shapeCircle: '圆形',
      shapeMeasure: '测量',
      shapeTriangle: '三角形',
      shapeArrow: '箭头',
      color: '绘图颜色',
      colorUp: '绿',
      colorDown: '红',
      colorWarning: '琥珀',
      colorText: '墨黑',
      colorSecondary: '灰蓝',
      needSelection: '请先选中一个绘图',
      lockDrawing: '锁定绘图',
      unlockDrawing: '解锁绘图',
      hideDrawing: '隐藏绘图',
      showDrawing: '显示绘图',
      deleteDrawing: '删除绘图',
      undo: '撤销',
      redo: '重做',
      save: '保存绘图与指标',
      saved: '已保存到本浏览器',
      savePartial: '部分内容未保存：位于已加载 K 线之外的标注点没有时间，已被忽略。',
      saveFailed: '图表未保存，请检查浏览器存储后重试。',
      saveTooLarge: '图表状态超过 2 MB，未保存。',
      storageUnavailable: '浏览器存储不可用，绘图无法持久保存。',
      storageCorrupt: '已保存的图表状态无法读取，已重置。',
      mainIndicator: '主图指标',
      subIndicator: '副图指标',
      indicatorNone: '无',
      candle: 'K 线',
      area: '面积图',
      yAxis: '价格坐标',
      yAxisnormal: '线性',
      yAxispercentage: '百分比',
      yAxislogarithm: '对数',
      resetZoom: '重置缩放',
      screenshot: '导出图片',
      screenshotFailed: '当前浏览器导出图片失败。',
      fullscreen: '全屏',
      exitFullscreen: '退出全屏',
      fullscreenFailed: '当前浏览器不支持全屏。',
      loading: '正在加载图表数据…',
      empty: '暂无图表数据',
      noHistory: '暂无历史 K 线数据，当前仅显示实时成交生成的 K 线。',
      error: '图表数据不可用',
      retry: '重试',
      annotationTitle: '标注文字',
      annotationPrompt: '文字（最多 {max} 个字符）',
      annotationTooLong: '标注文字不能超过 {max} 个字符',
      annotationRequired: '请输入标注内容',
      confirm: '确定',
      cancel: '取消',
      dismiss: '关闭',
    },
  },
}

const { t, locale } = useI18n({ useScope: 'local', messages: MESSAGES })
const market = useMarketSource()
/** `tools: false` folds the drawing/indicator strip away (OKX skin: toggled from ChartPanel's interval bar). */
const props = withDefaults(defineProps<{ tools?: boolean }>(), { tools: true })

const wrapper = ref<HTMLDivElement | null>(null)
const host = ref<HTMLDivElement | null>(null)
const annotationInput = ref<HTMLInputElement | null>(null)
const annotationInputId = `modern-chart-annotation-${(instanceCount += 1)}`

const chart = shallowRef<Chart | null>(null)
let feed: KlineDatafeed | null = null
let currentSymbolKey = ''
let applyingSnapshot = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let savedTimer: ReturnType<typeof setTimeout> | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null

const loadState = ref<'loading' | 'ready' | 'empty' | 'error'>('loading')
/** The server returned no history bars: whatever is drawn was built from live ticks only. */
const historyMissing = ref(false)
const notice = ref<string | null>(null)
const activeTool = ref<string | null>(null)
const activeOverlayId = ref<string | null>(null)
const shapesOpen = ref(false)
const selectedId = ref<string | null>(null)
const selectedLocked = ref(false)
const selectedVisible = ref(true)
const colorIndex = ref(0)
const mainIndicator = ref<MainIndicator | null>(DEFAULT_MAIN_INDICATOR)
const subIndicator = ref<SubIndicator | null>(DEFAULT_SUB_INDICATOR)
const candleType = ref<CandleType>('candle_solid')
const yAxisType = ref<YAxisType>('normal')
const isFullscreen = ref(false)
const savedTick = ref(false)
const annotation = ref<{ id: string; text: string; error: string | null } | null>(null)
const history = shallowRef<StoredDrawing[][]>([])
const historyIndex = ref(-1)

interface ToolItem {
  name: string
  label: string
  icon: Component
}

const DRAW_TOOLS: ToolItem[] = [
  { name: 'segment', label: 'chart.toolSegment', icon: TrendingUp },
  { name: 'horizontalStraightLine', label: 'chart.toolHorizontal', icon: Minus },
  { name: 'rayLine', label: 'chart.toolRay', icon: MoveRight },
  { name: 'priceChannelLine', label: 'chart.toolChannel', icon: Columns3 },
  { name: 'fibonacciLine', label: 'chart.toolFibonacci', icon: Ruler },
  { name: 'brush', label: 'chart.toolBrush', icon: Brush },
  { name: 'simpleAnnotation', label: 'chart.toolAnnotation', icon: MessageSquare },
]

const SHAPE_TOOLS: ToolItem[] = [
  { name: 'rect', label: 'chart.shapeRect', icon: Square },
  { name: 'circle', label: 'chart.shapeCircle', icon: CircleIcon },
  { name: 'measure', label: 'chart.shapeMeasure', icon: MoveDiagonal },
  { name: 'triangle', label: 'chart.shapeTriangle', icon: Triangle },
  { name: 'arrow', label: 'chart.shapeArrow', icon: ArrowUpRight },
]

const canUndo = computed<boolean>(() => historyIndex.value > 0)
const canRedo = computed<boolean>(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)
const hasSelection = computed<boolean>(() => selectedId.value !== null)
/** The chart shows UTC (UTC iron rule, QA-008: it was pinned to Asia/Shanghai while this label claimed the viewer's
 *  zone); candle buckets are UTC too, see futures-md kline_time.rs. */
const zoneLabel = 'UTC'
const selectedTitle = (enabled: boolean, label: string): string => (enabled ? label : `${label} · ${t('chart.needSelection')}`)

/* ------------------------------------------------------------------ theme helpers */

function cssColor(cssVar: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
  return value === '' ? fallback : value
}

function activeColor(): string {
  const entry = COLORS[colorIndex.value] ?? COLORS[0]
  return cssColor(entry.cssVar, entry.fallback)
}

/** `#rrggbb` -> `rgba(...)`, anything else passes through untouched. */
function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (match === null) {
    return color
  }
  const value = Number.parseInt(match[1], 16)
  const red = (value >> 16) & 0xff
  const green = (value >> 8) & 0xff
  const blue = value & 0xff
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function overlayStyleFor(color: string): DeepPartial<OverlayStyle> {
  const fill = withAlpha(color, 0.16)
  return {
    point: { color, borderColor: color, activeColor: color, activeBorderColor: color },
    line: { color },
    arc: { color },
    path: { color },
    polygon: { color: fill, borderColor: color },
    rect: { color: fill, borderColor: color },
    circle: { color: fill, borderColor: color },
    text: { borderColor: color, backgroundColor: color },
  }
}

function chartStyles(dark: boolean, type: CandleType): DeepPartial<Styles> {
  // Canvas does not inherit the page's CSS font. Keep an explicit cross-platform fallback.
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'Arial, "Microsoft YaHei", sans-serif'
  const up = cssColor('--color-up', dark ? '#28ba96' : '#008f75')
  const down = cssColor('--color-down', dark ? '#f06b78' : '#d64c59')
  const text = cssColor('--color-text', dark ? '#f0f2f4' : '#1c2126')
  const muted = cssColor('--color-text-muted', dark ? '#89929d' : '#767e88')
  const secondary = cssColor('--color-text-secondary', dark ? '#b0b6bf' : '#5b646e')
  const surface = cssColor('--color-surface', dark ? '#151719' : '#ffffff')
  const border = cssColor('--color-border', dark ? '#2b2e32' : '#e3e6ea')
  const grid = dark ? '#202326' : '#f0f2f4'
  const axis = dark ? '#2b2e32' : '#e3e6ea'
  return {
    grid: {
      show: true,
      horizontal: { color: grid },
      vertical: { color: grid },
    },
    candle: {
      type,
      bar: {
        compareRule: 'current_open',
        upColor: up,
        downColor: down,
        noChangeColor: muted,
        upBorderColor: up,
        downBorderColor: down,
        noChangeBorderColor: muted,
        upWickColor: up,
        downWickColor: down,
        noChangeWickColor: muted,
      },
      area: {
        lineColor: up,
        backgroundColor: [
          { offset: 0, color: withAlpha(up, 0.02) },
          { offset: 1, color: withAlpha(up, 0.24) },
        ],
      },
      priceMark: {
        show: true,
        high: { color: muted, textFamily: family },
        low: { color: muted, textFamily: family },
        last: { show: true, upColor: up, downColor: down, noChangeColor: muted, text: { family } },
      },
      tooltip: {
        showRule: 'follow_cross',
        rect: { color: surface, borderColor: border },
        title: { color: muted, family },
        legend: { color: secondary, family },
      },
    },
    indicator: {
      ohlc: { upColor: withAlpha(up, 0.7), downColor: withAlpha(down, 0.7), noChangeColor: muted },
      bars: [{ upColor: withAlpha(up, 0.7), downColor: withAlpha(down, 0.7), noChangeColor: muted }],
      lines: [{ color: '#ff9600' }, { color: '#935ebd' }, { color: '#1677ff' }, { color: '#e11d74' }, { color: '#01c5c4' }],
      circles: [{ upColor: withAlpha(up, 0.7), downColor: withAlpha(down, 0.7), noChangeColor: muted }],
      texts: [{ color: muted, family }],
      lastValueMark: { text: { color: text, family } },
      tooltip: { title: { color: muted, family }, legend: { color: secondary, family } },
    },
    xAxis: {
      axisLine: { color: axis },
      tickLine: { color: axis },
      tickText: { color: muted, family },
    },
    yAxis: {
      axisLine: { color: axis },
      tickLine: { color: axis },
      tickText: { color: muted, family },
    },
    separator: { color: border },
    crosshair: {
      horizontal: {
        line: { color: muted },
        text: { backgroundColor: muted, borderColor: muted, color: surface, family },
      },
      vertical: {
        line: { color: muted },
        text: { backgroundColor: muted, borderColor: muted, color: surface, family },
      },
    },
    overlay: { text: { family } },
  }
}

/* ------------------------------------------------------------------ chart lifecycle */

/** Same URL as the market store, so the datafeed leases the store's socket instead of a new one. */
function wsUrl(): string {
  if (market.chartWsUrl !== undefined) {
    return market.chartWsUrl()
  }
  if (WS_URL_OVERRIDE !== null && WS_URL_OVERRIDE !== '') {
    return WS_URL_OVERRIDE
  }
  return runtimeWsUrl() ?? FALLBACK_WS_URL
}

function handleStatus(status: DatafeedStatus): void {
  if (status === 'connecting' || status === 'loading') {
    loadState.value = 'loading'
    return
  }
  loadState.value = status
}

function ensureChart(): Chart | null {
  if (chart.value !== null) {
    return chart.value
  }
  const element = host.value
  if (element === null) {
    return null
  }
  const dark = theme.value === 'dark'
  const instance = init(element, {
    locale: chartLocale(),
    timezone: 'UTC',
    styles: chartStyles(dark, candleType.value),
    layout: {
      barSpaceLimit: { min: 2, max: 40 },
      pane: { height: 100, minHeight: 40, dragEnabled: true, order: 0, state: 'normal' },
    },
  })
  if (instance === null) {
    loadState.value = 'error'
    showNotice(t('chart.error'))
    return null
  }
  chart.value = instance
  return instance
}

function chartLocale(): string {
  return locale.value.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

function symbolInfo(): { ticker: string; pricePrecision: number; volumePrecision: number } | null {
  const symbol = market.currentSymbol
  if (symbol === undefined) {
    return null
  }
  return { ticker: symbol.pair, pricePrecision: symbol.pricePrecision, volumePrecision: symbol.volumePrecision }
}

function startDatafeed(instance: Chart): void {
  feed?.dispose()
  feed = createKlineDatafeed({
    url: wsUrl(),
    channelSymbol: market.chartChannelSymbol,
    onStatus: handleStatus,
    onHistory: (type, bars) => {
      if (type === 'init') historyMissing.value = bars === 0
      else if (bars > 0) historyMissing.value = false
    },
    // After a realtime gap the missed bars cannot be spliced from live ticks; reload the series
    // from the server so the chart shows the real history instead of a hole.
    onReconnect: () => instance.resetData(),
  })
  loadState.value = 'loading'
  instance.setDataLoader(feed.dataLoader)
}

/** Loads the snapshot for the current symbol and applies indicators, candle type and drawings. */
function setupSeries(): void {
  const instance = ensureChart()
  const symbol = market.currentSymbol
  if (instance === null || symbol === undefined) {
    if (symbol === undefined) {
      loadState.value = 'empty'
    }
    return
  }
  cancelTool()
  clearSelection()
  currentSymbolKey = symbol.symbol
  const loaded = loadSnapshot(symbol.symbol)
  if (loaded.error === 'unavailable') {
    showNotice(t('chart.storageUnavailable'))
  } else if (loaded.error === 'corrupt') {
    clearSnapshot(symbol.symbol)
    showNotice(t('chart.storageCorrupt'))
  }
  const snapshot = loaded.snapshot
  // A snapshot that explicitly stored `null` means "no indicator"; only a missing snapshot gets
  // the defaults, so a saved NONE is not silently turned back into the default MA/VOL.
  const selection = restoreSelection(snapshot)
  mainIndicator.value = selection.main
  subIndicator.value = selection.sub
  candleType.value = selection.candleType
  yAxisType.value = selection.yAxisType
  const drawings = snapshot?.drawings ?? []
  applyIndicators()
  instance.setStyles({ candle: { type: candleType.value } })
  applyYAxisType()
  restoreDrawings(drawings)
  resetHistory(drawings)
  loadState.value = 'loading'
}

/** Pushes symbol/period onto the widget; only a real change triggers a server reload. */
function syncSeries(): void {
  const instance = chart.value
  const info = symbolInfo()
  if (instance === null || info === null) {
    return
  }
  const period = scaleToPeriod(market.klineScale) ?? scaleToPeriod(market.klineScales[0])
  const existing = instance.getSymbol()
  const changed =
    existing === null ||
    existing.ticker !== info.ticker ||
    existing.pricePrecision !== info.pricePrecision ||
    existing.volumePrecision !== info.volumePrecision
  if (changed) {
    instance.setSymbol(info)
  }
  if (period !== null) {
    const current = instance.getPeriod()
    if (current === null || current.type !== period.type || current.span !== period.span) {
      instance.setPeriod(period)
    }
  }
}

function applyIndicators(): void {
  const instance = chart.value
  if (instance === null) {
    return
  }
  instance.removeIndicator({ paneId: CANDLE_PANE_ID })
  if (mainIndicator.value !== null) {
    instance.createIndicator({ name: mainIndicator.value, paneId: CANDLE_PANE_ID })
  }
  instance.removeIndicator({ paneId: SUB_PANE_ID })
  if (subIndicator.value !== null) {
    instance.createIndicator({ name: subIndicator.value, paneId: SUB_PANE_ID })
  }
}

function setMainIndicator(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  mainIndicator.value = value === '' ? null : (value as MainIndicator)
  applyIndicators()
  scheduleSave()
}

function setSubIndicator(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  subIndicator.value = value === '' ? null : (value as SubIndicator)
  applyIndicators()
  scheduleSave()
}

function toggleCandleType(): void {
  candleType.value = candleType.value === 'area' ? 'candle_solid' : 'area'
  chart.value?.setStyles({ candle: { type: candleType.value } })
  scheduleSave()
}

/** Linear / percentage (vs first visible close) / logarithmic price axis on the candle pane. */
function applyYAxisType(): void {
  const instance = chart.value
  if (instance === null) return
  const current = instance.getYAxes({ paneId: CANDLE_PANE_ID })[0]
  if (current !== undefined && current.name === yAxisType.value) return
  instance.overrideYAxis({ paneId: CANDLE_PANE_ID, name: yAxisType.value })
}

function setYAxisType(event: Event): void {
  yAxisType.value = sanitizeYAxisType((event.target as HTMLSelectElement).value)
  applyYAxisType()
  scheduleSave()
}

function retry(): void {
  const instance = ensureChart()
  if (instance === null) {
    return
  }
  startDatafeed(instance)
}

/* ------------------------------------------------------------------ toolbar actions */

function showNotice(message: string): void {
  notice.value = message
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer)
  }
  noticeTimer = setTimeout(() => {
    notice.value = null
    noticeTimer = null
  }, 6000)
}

function dismissNotice(): void {
  notice.value = null
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
}

function overlayCallbacks(): Pick<OverlayCreate, 'onSelected' | 'onDeselected' | 'onRemoved' | 'onPressedMoveEnd' | 'onDrawEnd'> {
  return {
    onSelected: (event: OverlayEvent<unknown>) => {
      selectOverlay(event.overlay.id)
    },
    onDeselected: (event: OverlayEvent<unknown>) => {
      if (selectedId.value === event.overlay.id) {
        clearSelection()
      }
    },
    onRemoved: (event: OverlayEvent<unknown>) => {
      if (activeOverlayId.value === event.overlay.id) {
        activeOverlayId.value = null
      }
      if (selectedId.value === event.overlay.id) {
        clearSelection()
      }
      if (applyingSnapshot) {
        return
      }
      pushHistory()
      scheduleSave()
    },
    onPressedMoveEnd: () => {
      if (applyingSnapshot) {
        return
      }
      pushHistory()
      scheduleSave()
    },
    onDrawEnd: (event: OverlayEvent<unknown>) => {
      const overlay = event.overlay
      if (activeOverlayId.value === overlay.id) {
        activeOverlayId.value = null
      }
      activeTool.value = null
      selectOverlay(overlay.id)
      pushHistory()
      scheduleSave()
      if (overlay.name === 'simpleAnnotation') {
        openAnnotation(overlay.id)
      }
    },
  }
}

function startTool(name: string): void {
  const instance = chart.value
  if (instance === null) {
    return
  }
  cancelTool()
  shapesOpen.value = false
  const created = instance.createOverlay({
    name,
    styles: overlayStyleFor(activeColor()),
    ...overlayCallbacks(),
  })
  activeTool.value = name
  activeOverlayId.value = typeof created === 'string' ? created : null
}

/** Esc / the select tool: removes the half-drawn overlay and clears the active tool. */
function cancelTool(): void {
  const instance = chart.value
  const id = activeOverlayId.value
  activeTool.value = null
  activeOverlayId.value = null
  if (instance !== null && id !== null) {
    instance.removeOverlay({ id })
  }
}

function selectOverlay(id: string): void {
  const overlay = findOverlay(id)
  selectedId.value = overlay === null ? null : id
  selectedLocked.value = overlay?.lock ?? false
  selectedVisible.value = overlay?.visible ?? true
}

function clearSelection(): void {
  selectedId.value = null
  selectedLocked.value = false
  selectedVisible.value = true
}

function findOverlay(id: string): Overlay<unknown> | null {
  return chart.value?.getOverlays({ id })[0] ?? null
}

function toggleLock(): void {
  const id = selectedId.value
  const overlay = id === null ? null : findOverlay(id)
  if (id === null || overlay === null) {
    return
  }
  chart.value?.overrideOverlay({ id, lock: !overlay.lock })
  selectOverlay(id)
  pushHistory()
  scheduleSave()
}

function toggleVisible(): void {
  const id = selectedId.value
  const overlay = id === null ? null : findOverlay(id)
  if (id === null || overlay === null) {
    return
  }
  chart.value?.overrideOverlay({ id, visible: !overlay.visible })
  selectOverlay(id)
  pushHistory()
  scheduleSave()
}

function deleteSelected(): void {
  const id = selectedId.value
  if (id === null) {
    return
  }
  chart.value?.removeOverlay({ id })
  clearSelection()
  pushHistory()
  scheduleSave()
}

function applyColor(index: number): void {
  colorIndex.value = index
  const id = selectedId.value
  if (id === null) {
    return
  }
  chart.value?.overrideOverlay({ id, styles: overlayStyleFor(activeColor()) })
  pushHistory()
  scheduleSave()
}

/* ------------------------------------------------------------------ annotation */

function openAnnotation(id: string): void {
  annotation.value = { id, text: '', error: null }
  void nextTick(() => {
    annotationInput.value?.focus()
  })
}

function confirmAnnotation(): void {
  const dialog = annotation.value
  const instance = chart.value
  if (dialog === null || instance === null) {
    return
  }
  const text = dialog.text.trim()
  if (text === '') {
    dialog.error = t('chart.annotationRequired')
    return
  }
  if (text.length > ANNOTATION_MAX) {
    dialog.error = t('chart.annotationTooLong', { max: ANNOTATION_MAX })
    return
  }
  instance.overrideOverlay({ id: dialog.id, extendData: text })
  annotation.value = null
  pushHistory()
  scheduleSave()
}

function cancelAnnotation(): void {
  const dialog = annotation.value
  annotation.value = null
  if (dialog !== null) {
    // An annotation without text is meaningless, so cancelling removes the placeholder.
    chart.value?.removeOverlay({ id: dialog.id })
  }
}

/* ------------------------------------------------------------------ drawings + history */

function toStored(overlay: Overlay<unknown>): unknown {
  const drawing: Record<string, unknown> = {
    name: overlay.name,
    points: overlay.points,
    styles: overlay.styles,
    lock: overlay.lock,
    visible: overlay.visible,
  }
  // Only the annotation overlays carry text; every other overlay's `extendData` may be an object
  // or a callback and must never reach storage.
  if (isAnnotationOverlay(overlay.name)) {
    drawing.extendData = overlay.extendData
  }
  return drawing
}

/** Raw overlay payloads that are complete drawings (a half-drawn shape has `currentStep !== -1`). */
function chartDrawings(): unknown[] {
  const instance = chart.value
  if (instance === null) {
    return []
  }
  // `getOverlays()` also returns the overlay that is still being drawn (`currentStep !== -1`);
  // a half-finished shape must never reach the undo stack or browser storage.
  return instance.getOverlays().filter((overlay) => overlay.currentStep === -1).map(toStored)
}

function currentDrawings(): StoredDrawing[] {
  return sanitizeDrawings(chartDrawings())
}

function restoreDrawings(drawings: StoredDrawing[]): void {
  const instance = chart.value
  if (instance === null) {
    return
  }
  applyingSnapshot = true
  try {
    instance.removeOverlay({})
    // Recreated overlays get new ids, so any selection from before the restore is now stale.
    clearSelection()
    drawings.forEach((drawing) => {
      instance.createOverlay({
        name: drawing.name,
        points: drawing.points.map((point) => ({ timestamp: point.timestamp, value: point.value })),
        lock: drawing.lock,
        visible: drawing.visible,
        ...(drawing.extendData === undefined ? {} : { extendData: drawing.extendData }),
        ...(drawing.styles === null ? {} : { styles: drawing.styles as unknown as DeepPartial<OverlayStyle> }),
        ...overlayCallbacks(),
      })
    })
  } finally {
    applyingSnapshot = false
  }
}

function resetHistory(drawings: StoredDrawing[]): void {
  history.value = [drawings]
  historyIndex.value = 0
}

/** Snapshot of the current drawings, stored only when it differs from the last step. */
function pushHistory(): void {
  if (applyingSnapshot) {
    return
  }
  const drawings = currentDrawings()
  const index = historyIndex.value
  const current = history.value[index]
  if (current !== undefined && drawingsEqual(current, drawings)) {
    return
  }
  const next = history.value.slice(0, Math.max(0, index + 1))
  next.push(drawings)
  while (next.length > HISTORY_LIMIT) {
    next.shift()
  }
  history.value = next
  historyIndex.value = next.length - 1
}

function undo(): void {
  if (!canUndo.value) {
    return
  }
  historyIndex.value -= 1
  restoreDrawings(history.value[historyIndex.value] ?? [])
  scheduleSave()
}

function redo(): void {
  if (!canRedo.value) {
    return
  }
  historyIndex.value += 1
  restoreDrawings(history.value[historyIndex.value] ?? [])
  scheduleSave()
}

/* ------------------------------------------------------------------ persistence */

/**
 * Persists the chart state under the symbol the drawings currently belong to, never under the
 * market store's selection (which may already point at the next symbol).
 */
function persist(): void {
  if (currentSymbolKey === '') {
    return
  }
  const raw = chartDrawings()
  const result = saveSnapshot(
    buildSnapshot({
      symbol: currentSymbolKey,
      main: mainIndicator.value,
      sub: subIndicator.value,
      candleType: candleType.value,
      yAxisType: yAxisType.value,
      drawings: sanitizeDrawings(raw),
    }),
  )
  if (!result.ok) {
    showNotice(t(result.reason === 'too_large' ? 'chart.saveTooLarge' : 'chart.saveFailed'))
    return
  }
  // Points drawn in the blank margin have no timestamp and cannot be restored later, so report
  // the limitation instead of claiming that everything was saved.
  const omissions = countDrawingOmissions(raw)
  if (omissions.drawings > 0 || omissions.points > 0) {
    showNotice(t('chart.savePartial'))
    return
  }
  savedTick.value = true
  if (savedTimer !== null) {
    clearTimeout(savedTimer)
  }
  savedTimer = setTimeout(() => {
    savedTick.value = false
    savedTimer = null
  }, 2000)
}

function scheduleSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    persist()
  }, SAVE_DEBOUNCE_MS)
}

function flushSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  persist()
}

function saveNow(): void {
  flushSave()
}

/* ------------------------------------------------------------------ misc actions */

function resetZoom(): void {
  const instance = chart.value
  if (instance === null) {
    return
  }
  instance.setBarSpace(DEFAULT_BAR_SPACE)
  instance.setOffsetRightDistance(DEFAULT_RIGHT_OFFSET)
  instance.scrollToRealTime(0)
}

function exportImage(): void {
  const instance = chart.value
  if (instance === null) {
    return
  }
  try {
    const dark = theme.value === 'dark'
    const url = instance.getConvertPictureUrl(true, 'png', cssColor('--color-surface', dark ? '#151719' : '#ffffff'))
    const link = document.createElement('a')
    link.href = url
    link.download = `${currentSymbolKey === '' ? 'chart' : currentSymbolKey}-${market.klineScale}.png`
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch {
    showNotice(t('chart.screenshotFailed'))
  }
}

async function toggleFullscreen(): Promise<void> {
  const element = wrapper.value
  if (element === null) {
    return
  }
  try {
    if (document.fullscreenElement !== null) {
      await document.exitFullscreen()
    } else {
      await element.requestFullscreen()
    }
    isFullscreen.value = document.fullscreenElement === element
    chart.value?.resize()
  } catch {
    showNotice(t('chart.fullscreenFailed'))
  }
}

function handleFullscreenChange(): void {
  isFullscreen.value = wrapper.value !== null && document.fullscreenElement === wrapper.value
  chart.value?.resize()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return
  }
  if (annotation.value !== null) {
    cancelAnnotation()
    return
  }
  if (shapesOpen.value) {
    shapesOpen.value = false
    return
  }
  cancelTool()
}

function closeShapesOnOutside(event: MouseEvent): void {
  if (!shapesOpen.value) {
    return
  }
  const target = event.target
  if (target instanceof Node && wrapper.value?.contains(target) === true) {
    return
  }
  shapesOpen.value = false
}

/** klinecharts needs a container with a real, finite height; panels may still be sizing. */
function ensureHostHeight(): void {
  const element = host.value
  if (element === null || typeof window === 'undefined') {
    return
  }
  // Measure the space the layout gives the chart (the parent), not the host itself: once the fallback height is set
  // the host would otherwise keep it forever and leave a blank band when the grid cell grows (owner 10-22, pro /trade).
  const room = element.parentElement?.clientHeight ?? element.clientHeight
  if (!Number.isFinite(room) || room < 120) {
    element.style.height = `${FALLBACK_CANVAS_HEIGHT}px`
  } else if (element.style.height !== '') {
    element.style.height = ''
  }
}

/** Keeps the canvas filling its cell whenever the layout changes size (window resize, grid rows settling, data). */
let sizeObserver: ResizeObserver | null = null
let sizeFrame = 0
function watchHostSize(): void {
  const parent = host.value?.parentElement
  if (parent === null || parent === undefined || typeof ResizeObserver === 'undefined') {
    return
  }
  sizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(sizeFrame)
    sizeFrame = requestAnimationFrame(() => {
      ensureHostHeight()
      chart.value?.resize()
    })
  })
  sizeObserver.observe(parent)
}

/* ------------------------------------------------------------------ watchers */

watch(
  () =>
    `${market.currentSymbolName}|${market.currentSymbol?.pricePrecision ?? ''}|${market.currentSymbol?.volumePrecision ?? ''}`,
  () => {
    if (market.currentSymbol === undefined) {
      return
    }
    // Flush first: the pending state still belongs to the previous symbol.
    flushSave()
    setupSeries()
    syncSeries()
  },
)

watch(
  () => market.klineScale,
  () => {
    syncSeries()
  },
)

watch(theme, (value) => {
  chart.value?.setStyles(chartStyles(value === 'dark', candleType.value))
})

watch(locale, () => {
  chart.value?.setLocale(chartLocale())
})

watch(annotation, (value) => {
  if (value !== null) {
    void nextTick(() => {
      annotationInput.value?.focus()
    })
  }
})

onMounted(() => {
  ensureHostHeight()
  watchHostSize()
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('mousedown', closeShapesOnOutside)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  const instance = ensureChart()
  if (instance === null) {
    return
  }
  const info = symbolInfo()
  if (info === null) {
    loadState.value = 'empty'
    return
  }
  // Symbol and period are pushed before the loader exists, so the first load happens once.
  instance.setSymbol(info)
  const period = scaleToPeriod(market.klineScale) ?? scaleToPeriod(market.klineScales[0])
  if (period !== null) {
    instance.setPeriod(period)
  }
  setupSeries()
  startDatafeed(instance)
})

onBeforeUnmount(() => {
  sizeObserver?.disconnect()
  sizeObserver = null
  cancelAnimationFrame(sizeFrame)
  // Final flush so drawings made in the last moments are not lost.
  flushSave()
  if (savedTimer !== null) {
    clearTimeout(savedTimer)
    savedTimer = null
  }
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('mousedown', closeShapesOnOutside)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  feed?.dispose()
  feed = null
  const instance = chart.value
  chart.value = null
  if (instance !== null) {
    disposeChart(instance)
  }
})
defineExpose({ toggleFullscreen })
</script>

<template>
  <div ref="wrapper" class="modern-chart" :class="{ 'is-fullscreen': isFullscreen }">
    <div v-show="props.tools" class="chart-toolbar" role="toolbar" :aria-label="t('chart.toolbar')">
      <div class="tool-group">
        <button
          class="chart-tool"
          type="button"
          :class="{ active: activeTool === null }"
          :aria-pressed="activeTool === null"
          :title="t('chart.selectTool')"
          :aria-label="t('chart.selectTool')"
          @click="cancelTool"
        >
          <MousePointer2 :size="15" aria-hidden="true" />
        </button>
        <button
          v-for="tool in DRAW_TOOLS"
          :key="tool.name"
          class="chart-tool"
          type="button"
          :class="{ active: activeTool === tool.name }"
          :aria-pressed="activeTool === tool.name"
          :title="t(tool.label)"
          :aria-label="t(tool.label)"
          @click="startTool(tool.name)"
        >
          <component :is="tool.icon" :size="15" aria-hidden="true" />
        </button>
        <div class="tool-menu-wrap">
          <button
            class="chart-tool"
            type="button"
            :class="{ active: shapesOpen }"
            :aria-expanded="shapesOpen"
            aria-haspopup="menu"
            :title="t('chart.moreShapes')"
            :aria-label="t('chart.moreShapes')"
            @click="shapesOpen = !shapesOpen"
          >
            <Shapes :size="15" aria-hidden="true" />
            <ChevronDown :size="11" aria-hidden="true" />
          </button>
          <div v-if="shapesOpen" class="tool-menu" role="menu">
            <button
              v-for="shape in SHAPE_TOOLS"
              :key="shape.name"
              class="tool-menu-item"
              type="button"
              role="menuitem"
              :title="t(shape.label)"
              @click="startTool(shape.name)"
            >
              <component :is="shape.icon" :size="14" aria-hidden="true" />
              <span>{{ t(shape.label) }}</span>
            </button>
          </div>
        </div>
      </div>

      <span class="tool-divider" aria-hidden="true" />

      <div class="tool-group" role="group" :aria-label="t('chart.color')">
        <span class="tool-label" aria-hidden="true"><Palette :size="13" /></span>
        <button
          v-for="(color, index) in COLORS"
          :key="color.key"
          class="color-swatch"
          type="button"
          :class="{ active: colorIndex === index }"
          :style="{ background: `var(${color.cssVar}, ${color.fallback})` }"
          :title="t(`chart.color${color.key.charAt(0).toUpperCase()}${color.key.slice(1)}`)"
          :aria-label="t(`chart.color${color.key.charAt(0).toUpperCase()}${color.key.slice(1)}`)"
          :aria-pressed="colorIndex === index"
          @click="applyColor(index)"
        />
      </div>

      <span class="tool-divider" aria-hidden="true" />

      <div class="tool-group">
        <button
          class="chart-tool"
          type="button"
          :disabled="!hasSelection"
          :title="selectedTitle(hasSelection, t(selectedLocked ? 'chart.unlockDrawing' : 'chart.lockDrawing'))"
          :aria-label="t(selectedLocked ? 'chart.unlockDrawing' : 'chart.lockDrawing')"
          :aria-pressed="selectedLocked"
          @click="toggleLock"
        >
          <LockOpen v-if="selectedLocked" :size="15" aria-hidden="true" />
          <Lock v-else :size="15" aria-hidden="true" />
        </button>
        <button
          class="chart-tool"
          type="button"
          :disabled="!hasSelection"
          :title="selectedTitle(hasSelection, t(selectedVisible ? 'chart.hideDrawing' : 'chart.showDrawing'))"
          :aria-label="t(selectedVisible ? 'chart.hideDrawing' : 'chart.showDrawing')"
          :aria-pressed="!selectedVisible"
          @click="toggleVisible"
        >
          <EyeOff v-if="selectedVisible" :size="15" aria-hidden="true" />
          <Eye v-else :size="15" aria-hidden="true" />
        </button>
        <button
          class="chart-tool danger"
          type="button"
          :disabled="!hasSelection"
          :title="selectedTitle(hasSelection, t('chart.deleteDrawing'))"
          :aria-label="t('chart.deleteDrawing')"
          @click="deleteSelected"
        >
          <Trash :size="15" aria-hidden="true" />
        </button>
      </div>

      <span class="tool-divider" aria-hidden="true" />

      <div class="tool-group">
        <button class="chart-tool" type="button" :disabled="!canUndo" :title="t('chart.undo')" :aria-label="t('chart.undo')" @click="undo">
          <Undo2 :size="15" aria-hidden="true" />
        </button>
        <button class="chart-tool" type="button" :disabled="!canRedo" :title="t('chart.redo')" :aria-label="t('chart.redo')" @click="redo">
          <Redo2 :size="15" aria-hidden="true" />
        </button>
        <button
          class="chart-tool"
          type="button"
          :title="t(savedTick ? 'chart.saved' : 'chart.save')"
          :aria-label="t('chart.save')"
          @click="saveNow"
        >
          <Check v-if="savedTick" :size="15" aria-hidden="true" />
          <Save v-else :size="15" aria-hidden="true" />
        </button>
      </div>

      <span class="tool-divider" aria-hidden="true" />

      <div class="tool-group">
        <label class="chart-select" :title="t('chart.mainIndicator')">
          <span class="sr-only">{{ t('chart.mainIndicator') }}</span>
          <select :value="mainIndicator ?? ''" :aria-label="t('chart.mainIndicator')" @change="setMainIndicator">
            <option value="">{{ t('chart.indicatorNone') }}</option>
            <option v-for="name in MAIN_INDICATORS" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="chart-select" :title="t('chart.subIndicator')">
          <span class="sr-only">{{ t('chart.subIndicator') }}</span>
          <select :value="subIndicator ?? ''" :aria-label="t('chart.subIndicator')" @change="setSubIndicator">
            <option value="">{{ t('chart.indicatorNone') }}</option>
            <option v-for="name in SUB_INDICATORS" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label class="chart-select" :title="t('chart.yAxis')">
          <span class="sr-only">{{ t('chart.yAxis') }}</span>
          <select :value="yAxisType" :aria-label="t('chart.yAxis')" @change="setYAxisType">
            <option v-for="name in Y_AXIS_TYPES" :key="name" :value="name">{{ t(`chart.yAxis${name}`) }}</option>
          </select>
        </label>
      </div>

      <span class="tool-divider" aria-hidden="true" />

      <div class="tool-group">
        <button
          class="chart-tool"
          type="button"
          :title="t(candleType === 'area' ? 'chart.candle' : 'chart.area')"
          :aria-label="t(candleType === 'area' ? 'chart.candle' : 'chart.area')"
          @click="toggleCandleType"
        >
          <ChartCandlestick v-if="candleType === 'area'" :size="15" aria-hidden="true" />
          <ChartArea v-else :size="15" aria-hidden="true" />
        </button>
        <span class="chart-zone" data-testid="chart-zone" :title="t('chart.zoneHint', { zone: zoneLabel })">{{ zoneLabel }}</span>
        <button class="chart-tool" type="button" :title="t('chart.resetZoom')" :aria-label="t('chart.resetZoom')" @click="resetZoom">
          <RotateCcw :size="15" aria-hidden="true" />
        </button>
        <button class="chart-tool" type="button" :title="t('chart.screenshot')" :aria-label="t('chart.screenshot')" @click="exportImage">
          <ImageDown :size="15" aria-hidden="true" />
        </button>
        <button
          class="chart-tool"
          type="button"
          :title="t(isFullscreen ? 'chart.exitFullscreen' : 'chart.fullscreen')"
          :aria-label="t(isFullscreen ? 'chart.exitFullscreen' : 'chart.fullscreen')"
          :aria-pressed="isFullscreen"
          @click="toggleFullscreen"
        >
          <Minimize2 v-if="isFullscreen" :size="15" aria-hidden="true" />
          <Maximize2 v-else :size="15" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="chart-canvas">
      <div ref="host" class="chart-host"></div>

      <div v-if="loadState === 'ready' && historyMissing" class="chart-history-note" role="status">
        <Info :size="13" aria-hidden="true" />
        <span>{{ t('chart.noHistory') }}</span>
      </div>
      <div v-if="loadState !== 'ready'" class="chart-state" :class="`is-${loadState}`">
        <template v-if="loadState === 'loading'">
          <LoaderCircle class="spin" :size="16" aria-hidden="true" />
          <span>{{ t('chart.loading') }}</span>
        </template>
        <template v-else-if="loadState === 'empty'">
          <Info :size="16" aria-hidden="true" />
          <span>{{ historyMissing ? t('chart.noHistory') : t('chart.empty') }}</span>
          <button class="state-action" type="button" @click="retry">
            <RefreshCw :size="13" aria-hidden="true" />
            <span>{{ t('chart.retry') }}</span>
          </button>
        </template>
        <template v-else>
          <TriangleAlert :size="16" aria-hidden="true" />
          <span>{{ t('chart.error') }}</span>
          <button class="state-action" type="button" @click="retry">
            <RefreshCw :size="13" aria-hidden="true" />
            <span>{{ t('chart.retry') }}</span>
          </button>
        </template>
      </div>

      <div v-if="annotation !== null" class="chart-dialog" role="dialog" :aria-label="t('chart.annotationTitle')">
        <label class="chart-dialog-label" :for="annotationInputId">{{ t('chart.annotationTitle') }}</label>
        <input
          :id="annotationInputId"
          ref="annotationInput"
          v-model="annotation.text"
          class="chart-input"
          type="text"
          :maxlength="ANNOTATION_MAX"
          :placeholder="t('chart.annotationPrompt', { max: ANNOTATION_MAX })"
          @keydown.enter.prevent="confirmAnnotation"
          @keydown.esc.prevent="cancelAnnotation"
        />
        <p v-if="annotation.error !== null" class="field-error">{{ annotation.error }}</p>
        <div class="chart-dialog-actions">
          <button class="state-action" type="button" @click="confirmAnnotation">{{ t('chart.confirm') }}</button>
          <button class="state-action ghost" type="button" @click="cancelAnnotation">{{ t('chart.cancel') }}</button>
        </div>
      </div>

      <p v-if="notice !== null" class="chart-notice notice notice-error" role="alert">
        <span>{{ notice }}</span>
        <button class="notice-close" type="button" :title="t('chart.dismiss')" :aria-label="t('chart.dismiss')" @click="dismissNotice">×</button>
      </p>
    </div>
  </div>
</template>

<style scoped>
.modern-chart {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--color-surface);
}

.modern-chart.is-fullscreen {
  background: var(--color-surface);
  padding: var(--space-2);
}

.chart-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  min-height: 36px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.tool-divider {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--color-border);
}

.tool-label {
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  color: var(--color-text-muted);
}

.chart-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-width: 24px;
  height: 26px;
  padding: 0 3px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
}

.chart-tool:hover:not(:disabled) {
  background: var(--color-surface-alt);
  color: var(--color-text);
}

.chart-tool.active {
  border-color: var(--color-border-strong);
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.chart-tool:disabled {
  color: var(--color-text-muted);
  opacity: 0.45;
  cursor: not-allowed;
}

.chart-tool.danger:hover:not(:disabled) {
  color: var(--color-down);
}

.color-swatch {
  width: 14px;
  height: 14px;
  border: 1px solid var(--color-border-strong);
  border-radius: 50%;
}

.color-swatch.active {
  outline: 2px solid var(--color-text);
  outline-offset: 1px;
}

.tool-menu-wrap {
  position: relative;
}

.tool-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
}

.tool-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
}

.tool-menu-item:hover {
  background: var(--color-surface-alt);
  color: var(--color-text);
}

.chart-select select {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.chart-canvas {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.chart-host {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 120px;
}

.chart-state {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: calc(100% - 24px);
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.chart-history-note {
  position: absolute;
  /* Below the indicator legend row of the candle pane. */
  top: 34px;
  left: 50%;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 140px);
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 11px;
  transform: translateX(-50%);
  pointer-events: none;
}

.chart-state.is-error {
  border-color: var(--color-down-soft);
  color: var(--color-down);
}

.state-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-xs);
  pointer-events: auto;
  /* Next to the long 「暂无历史 K 线数据…」 notice the button was squeezed and 「重试」 wrapped (QA-065). */
  flex-shrink: 0;
  white-space: nowrap;
}

.state-action.ghost {
  color: var(--color-text-secondary);
}

.chart-dialog {
  position: absolute;
  bottom: 12px;
  left: 50%;
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(320px, calc(100% - 24px));
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  transform: translateX(-50%);
}

.chart-dialog-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.chart-input {
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-sm);
}

.chart-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.chart-notice {
  position: absolute;
  bottom: 8px;
  left: 8px;
  z-index: 7;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  max-width: calc(100% - 16px);
}

.notice-close {
  flex: 0 0 auto;
  line-height: 1;
  color: inherit;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.spin {
  animation: chart-spin 900ms linear infinite;
}

@keyframes chart-spin {
  to {
    transform: rotate(360deg);
  }
}
.chart-zone {
  align-self: center;
  padding: 0 6px;
  font-size: 11px;
  color: var(--color-text-secondary, #5b646e);
  white-space: nowrap;
  cursor: help;
}
</style>
