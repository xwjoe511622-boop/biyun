<script setup lang="ts">
import type { SocketState } from '@/modules/ws/kline-socket'
import TicketSelect from '@/components/futures/TicketSelect.vue'
import { computed, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp, Minus, Plus } from '@lucide/vue'
import { SKIN } from '@/core/skin'
import { canonicalDecimal, cmp, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { compactDecimal, depthBarWidth } from '@/modules/finance/display'
import { bidShare, bookSpread, sweepStats, type SweepStats } from '@/modules/market/book-aggregate'
import type { BookPick } from '@/modules/trade/book-fill'
import type { DepthLevel } from '@/stores/market'
import { columnDecimals, formatBookAmount, useMarketSource } from './market-source'

/**
 * Order book (spot, margin and futures terminals), laid out like Binance:
 *
 * - Every level the store holds is rendered; the column clips them. Asks are anchored to the
 *   spread and grow upward, bids grow downward, so the book always fills its column whatever its
 *   height — the row count never depends on a measured size (a stale measurement once left the
 *   book at 6 rows under a blank band, L151).
 * - Bars show cumulative depth, scaled to the deepest *visible* cumulative total of both sides.
 * - The mid row carries the last price (with its direction), the mark price when the market has
 *   one, and the spread. Hovering a level shows what sweeping up to it costs (average price, sum,
 *   value); clicking a level fills the ticket's price and, Binance style, the cumulative amount from the best
 *   level through the clicked one on the side that takes it (ask → buy, bid → sell; `modules/trade/book-fill.ts`).
 *   Clicking the last price fills the price only.
 * - Grouping steps come from the store (`bookSteps`: the market's price tick ×1/×10/×100/×1000, Binance style, e.g.
 *   BTC perp 0.1 / 1 / 10 / 100; the first is the default and a market switch resets to it). Asks ceil, bids floor.
 */
const { t } = useI18n()
const market = useMarketSource()
const emit = defineEmits<{ price: [value: string, pick?: BookPick] }>()
const props = withDefaults(defineProps<{ compact?: boolean; bookState?: SocketState }>(), { compact: false })

const emptyText = computed(() => {
  const state = props.bookState
  if (state === undefined) return t('trade.noBook')
  if (state !== 'open') return t(`status.${state}`)
  return t(!market.asks.length && !market.buys.length ? 'trade.noDepthData' : 'trade.noBook')
})

type Mode = 'both' | 'asks' | 'bids'
type Side = 'ask' | 'bid'
const mode = ref<Mode>('both')
/** Level row height in px; the OKX skin uses OKX's airier 24px rows (skin-okx.css sets the same height). */
const ROW_HEIGHT = SKIN === 'okx' ? 24 : 20

const symbol = computed(() => market.currentSymbol)
const steps = computed(() => market.bookSteps ?? symbol.value?.rules.depthSteps ?? [])
/** Custom dropdown (not a native <select>, whose popup is misplaced in narrow layouts). */
const stepOptions = computed(() => steps.value.map((step, index) => ({ value: String(index), label: canonicalDecimal(step) })))
const unit = computed(() => symbol.value?.volumeUnit ?? symbol.value?.base ?? '')
const asks = computed<DepthLevel[]>(() => market.asks)
const bids = computed<DepthLevel[]>(() => market.buys)

/**
 * Height of one side's viewport, only used to scale the bars to what is visible. Observed through a
 * function ref so a re-created element (e.g. after a mode switch) is always the one observed.
 */
const sideHeight = ref(0)
const observer = typeof ResizeObserver === 'undefined'
  ? null
  : new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (entry !== undefined && entry.target.isConnected) sideHeight.value = entry.contentRect.height
  })
let observed: Element | null = null
const askSide = shallowRef<Element | null>(null)
const bidSide = shallowRef<Element | null>(null)
/** Stable function refs: Vue calls them only when the element itself is mounted or removed. */
const setAskSide = (element: Element | ComponentPublicInstance | null): void => { askSide.value = element instanceof Element ? element : null }
const setBidSide = (element: Element | ComponentPublicInstance | null): void => { bidSide.value = element instanceof Element ? element : null }
watchEffect(() => {
  const element = mode.value === 'bids' ? bidSide.value : askSide.value
  if (element === observed) return
  if (observed !== null) observer?.unobserve(observed)
  observed = element
  if (element !== null) observer?.observe(element)
}, { flush: 'post' })
onBeforeUnmount(() => {
  observer?.disconnect()
  observed = null
})

/** The compact phone book uses 20 px rows in both skins (styles/skin-okx.css), so more levels fit. */
const rowHeight = computed(() => (props.compact ? 20 : ROW_HEIGHT))
const visibleRows = computed(() => (sideHeight.value > 0 ? Math.max(1, Math.floor(sideHeight.value / rowHeight.value)) : Number.POSITIVE_INFINITY))
const maxTotal = computed(() => {
  const deepest = (rows: DepthLevel[]): string => rows[Math.min(rows.length, visibleRows.value) - 1]?.total ?? '0'
  const candidates = [mode.value !== 'bids' ? deepest(asks.value) : '0', mode.value !== 'asks' ? deepest(bids.value) : '0']
  return candidates.reduce((acc, value) => (isDecimalString(value) && cmp(value, acc) > 0 ? value : acc), '0')
})

/** Both-sides view: asks farthest first (top) so the best ask sits on the spread. */
const askDisplay = computed(() => asks.value.map((row, index) => ({ row, index })).reverse())
const bidDisplay = computed(() => bids.value.map((row, index) => ({ row, index })))

/** Last-price direction versus the previous pushed close. */
const lastDirection = ref<'up' | 'down' | 'flat'>('flat')
watch(
  () => market.ticker.close,
  (next, previous) => {
    if (!isDecimalString(next) || !isDecimalString(previous ?? '')) return
    const order = cmp(next, previous as string)
    if (order !== 0) lastDirection.value = order > 0 ? 'up' : 'down'
  },
)

const spread = computed(() => bookSpread(asks.value[0]?.price, bids.value[0]?.price))
const ratio = computed(() => bidShare(asks.value, bids.value))
const mark = computed(() => (isDecimalString(market.markPrice ?? '') ? (market.markPrice as string) : ''))

function price(value: string): string {
  return groupDigits(canonicalDecimal(value), symbol.value?.pricePrecision ?? 2)
}

/**
 * Book rows are aggregated to the selected step, so they show only the step's decimals (step 1 or 10 → integers, 0.1 →
 * one decimal), like Binance. Otherwise 0.01 / 0.1 / 1 look identical when quotes sit on whole prices.
 */
const rowDecimals = computed(() => {
  const step = steps.value[market.depthStepIndex]
  const full = symbol.value?.pricePrecision ?? 2
  if (step === undefined || !isDecimalString(step)) return full
  const fraction = canonicalDecimal(step).split('.')[1] ?? ''
  return Math.min(full, fraction.length)
})
function rowPrice(value: string): string {
  return groupDigits(canonicalDecimal(value), rowDecimals.value)
}

/** Both sides share one width so amounts and totals line up across the spread. */
const amountDecimals = computed(() => columnDecimals([...asks.value, ...bids.value].map((level) => canonicalDecimal(level.amount))))
function amount(value: string): string {
  return formatBookAmount(canonicalDecimal(value), symbol.value, amountDecimals.value)
}

/** Level amounts/totals: full figures while they fit the column, `2.49M` style beyond 10 characters. */
function cell(value: string): string {
  const full = amount(value)
  return full.length > 10 && isDecimalString(value) && cmp(value, '1000') >= 0 ? compactDecimal(value, 2) : full
}

function quoteValue(value: string): string {
  if (!isDecimalString(value)) return '--'
  return groupDigits(canonicalDecimal(value), cmp(value, '1') >= 0 ? 2 : 6)
}

const lastPrice = computed(() => (isDecimalString(market.ticker.close) ? price(market.ticker.close) : '--'))

/** Hover: the swept range (hovered level back to the spread) and its cost card. */
const hover = ref<{ side: Side; index: number; stats: SweepStats | null; x: number; y: number; flip: boolean } | null>(null)
const CARD_WIDTH = 210

function enter(side: Side, index: number, event: MouseEvent): void {
  const rows = side === 'ask' ? asks.value : bids.value
  const stats = sweepStats(rows.slice(0, index + 1), symbol.value?.valueMultiplier ?? '1', symbol.value?.volumeIsValue === true)
  const row = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const book = (event.currentTarget as HTMLElement).closest('.book')?.getBoundingClientRect() ?? row
  const flip = book.right + 8 + CARD_WIDTH > window.innerWidth
  hover.value = { side, index, stats, x: flip ? book.left - 8 : book.right + 8, y: row.top + row.height / 2, flip }
}

function inSweep(side: Side, index: number): boolean {
  const current = hover.value
  return current !== null && current.side === side && index <= current.index
}

function flashClass(row: DepthLevel): string {
  return row.diff === 1 ? 'flash-grow' : row.diff === 2 ? 'flash-shrink' : ''
}

/** `side` + `index` (the level's position from the best price) when a book row was clicked. */
function pick(value: string, side?: Side, index?: number): void {
  if (!isDecimalString(value)) return
  if (side === undefined || index === undefined) emit('price', canonicalDecimal(value))
  else emit('price', canonicalDecimal(value), { book: side, index })
}
</script>

<template>
  <section class="book" :class="{ compact }" :aria-label="t('trade.orderBook')">
    <header class="book-head">
      <span class="book-title">{{ t('trade.orderBook') }}</span>
      <div class="book-tools">
        <div class="modes" role="group" :aria-label="t('trade.orderBook')">
          <button class="mode" :class="{ active: mode === 'both' }" type="button" :title="t('trade.bookBoth')" :aria-label="t('trade.bookBoth')" :aria-pressed="mode === 'both'" @click="mode = 'both'">
            <i class="bars both"><b></b><b></b><b></b><b></b></i>
          </button>
          <button class="mode" :class="{ active: mode === 'bids' }" type="button" :title="t('trade.bookBids')" :aria-label="t('trade.bookBids')" :aria-pressed="mode === 'bids'" @click="mode = 'bids'">
            <i class="bars bids"><b></b><b></b><b></b><b></b></i>
          </button>
          <button class="mode" :class="{ active: mode === 'asks' }" type="button" :title="t('trade.bookAsks')" :aria-label="t('trade.bookAsks')" :aria-pressed="mode === 'asks'" @click="mode = 'asks'">
            <i class="bars asks"><b></b><b></b><b></b><b></b></i>
          </button>
        </div>
        <button v-if="SKIN === 'okx'" class="step-btn" type="button" :disabled="market.depthStepIndex <= 0" :aria-label="t('trade.depthStep')" @click="market.setDepthStepIndex(market.depthStepIndex - 1)"><Minus :size="13" /></button>
        <TicketSelect
          class="step-select num"
          testid="book-step"
          :label="t('trade.depthStep')"
          :options="stepOptions"
          :model-value="String(market.depthStepIndex)"
          @update:model-value="market.setDepthStepIndex(Number($event))"
        />
        <button v-if="SKIN === 'okx'" class="step-btn" type="button" :disabled="market.depthStepIndex >= steps.length - 1" :aria-label="t('trade.depthStep')" @click="market.setDepthStepIndex(market.depthStepIndex + 1)"><Plus :size="13" /></button>
      </div>
    </header>

    <div class="cols">
      <span>{{ t('trade.priceUnit', { quote: symbol?.quote ?? '' }) }}</span>
      <span>{{ t('trade.amountCol', { base: unit }) }}</span>
      <span v-if="!compact">{{ t('trade.cumulative', { base: unit }) }}</span>
    </div>

    <div class="book-body" :class="`mode-${mode}`" @mouseleave="hover = null">
      <div v-if="mode === 'both'" :ref="setAskSide" class="side asks">
        <button
          v-for="{ row, index } in askDisplay"
          :key="`a-${row.price}`"
          class="level ask"
          :class="[flashClass(row), { sweep: inSweep('ask', index), edge: hover?.side === 'ask' && hover.index === index, cut: index >= visibleRows }]"
          type="button"
          :style="{ '--w': depthBarWidth(row.total, maxTotal) }"
          @mouseenter="enter('ask', index, $event)"
          @click="pick(row.price, 'ask', index)"
        >
          <span class="num p">{{ rowPrice(row.price) }}</span>
          <span class="num">{{ cell(row.amount) }}</span>
          <span v-if="!compact" class="num">{{ cell(row.total) }}</span>
        </button>
        <p v-if="asks.length === 0" class="side-empty">{{ emptyText }}</p>
      </div>

      <div class="mid" :class="{ top: mode !== 'both', compact }">
        <button class="mid-last num" :class="lastDirection" type="button" :title="t('trade.usePrice')" @click="pick(market.ticker.close)">
          {{ lastPrice }}
          <ArrowUp v-if="lastDirection === 'up'" :size="compact ? 16 : 15" aria-hidden="true" />
          <ArrowDown v-else-if="lastDirection === 'down'" :size="compact ? 16 : 15" aria-hidden="true" />
        </button>
        <span v-if="mark !== ''" class="mid-mark num" :title="t('trade.bookMark')">{{ price(mark) }}</span>
        <span v-if="!compact && spread !== null" class="mid-spread num" :title="`${t('trade.spread')} ${price(spread.value)}`">{{ spread.pct }}%</span>
      </div>

      <div v-if="mode === 'asks'" :ref="setAskSide" class="side asks single">
        <button
          v-for="(row, index) in asks"
          :key="`a-${row.price}`"
          class="level ask"
          :class="[flashClass(row), { sweep: inSweep('ask', index), edge: hover?.side === 'ask' && hover.index === index, cut: index >= visibleRows }]"
          type="button"
          :style="{ '--w': depthBarWidth(row.total, maxTotal) }"
          @mouseenter="enter('ask', index, $event)"
          @click="pick(row.price, 'ask', index)"
        >
          <span class="num p">{{ rowPrice(row.price) }}</span>
          <span class="num">{{ cell(row.amount) }}</span>
          <span v-if="!compact" class="num">{{ cell(row.total) }}</span>
        </button>
        <p v-if="asks.length === 0" class="side-empty">{{ emptyText }}</p>
      </div>

      <div v-if="mode !== 'asks'" :ref="setBidSide" class="side bids" :class="{ single: mode === 'bids' }">
        <button
          v-for="{ row, index } in bidDisplay"
          :key="`b-${row.price}`"
          class="level bid"
          :class="[flashClass(row), { sweep: inSweep('bid', index), edge: hover?.side === 'bid' && hover.index === index, cut: index >= visibleRows }]"
          type="button"
          :style="{ '--w': depthBarWidth(row.total, maxTotal) }"
          @mouseenter="enter('bid', index, $event)"
          @click="pick(row.price, 'bid', index)"
        >
          <span class="num p">{{ rowPrice(row.price) }}</span>
          <span class="num">{{ cell(row.amount) }}</span>
          <span v-if="!compact" class="num">{{ cell(row.total) }}</span>
        </button>
        <p v-if="bids.length === 0" class="side-empty">{{ emptyText }}</p>
      </div>
    </div>

    <footer class="ratio" :title="t('trade.bookRatio')">
      <template v-if="ratio !== null">
        <span class="r-label up">B <b class="num">{{ ratio.bidPct }}%</b></span>
        <span class="r-track"><i class="r-bid" :style="{ width: `${ratio.bidPct}%` }"></i><i class="r-ask" :style="{ width: `${ratio.askPct}%` }"></i></span>
        <span class="r-label down"><b class="num">{{ ratio.askPct }}%</b> S</span>
      </template>
      <span v-else class="r-none">{{ emptyText }}</span>
    </footer>

    <Teleport to="body">
      <div
        v-if="hover !== null && hover.stats !== null"
        class="book-card"
        :class="{ flip: hover.flip }"
        :style="{ left: `${hover.x}px`, top: `${hover.y}px`, width: `${CARD_WIDTH}px` }"
        role="tooltip"
      >
        <p><span>{{ t('trade.bookAvg') }}</span><b class="num">≈ {{ price(hover.stats.avgPrice) }}</b></p>
        <p><span>{{ t('trade.bookSum', { unit }) }}</span><b class="num">{{ amount(hover.stats.sumAmount) }}</b></p>
        <p v-if="symbol?.volumeIsValue !== true"><span>{{ t('trade.bookSum', { unit: symbol?.quote ?? '' }) }}</span><b class="num">{{ quoteValue(hover.stats.sumValue) }}</b></p>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.book { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--color-surface); }
.book-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 44px; flex: 0 0 44px; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
.book-title { font-family: var(--font-display); font-size: 14px; font-weight: 650; white-space: nowrap; }
.book-tools { display: flex; align-items: center; gap: 6px; }
.modes { display: flex; gap: 2px; }
.mode { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; opacity: 0.5; transition: opacity 0.15s, background-color 0.15s; }
.mode:hover { opacity: 0.85; }
.mode.active { opacity: 1; background: var(--color-hover); }
.bars { display: grid; gap: 2px; width: 13px; }
.bars b { display: block; height: 2px; border-radius: 1px; }
.bars.both b:nth-child(-n + 2) { background: var(--color-down); }
.bars.both b:nth-child(n + 3) { background: var(--color-up); }
.bars.bids b { background: var(--color-up); }
.bars.asks b { background: var(--color-down); }
.step-select {
  height: 26px; align-items: center; padding: 0 4px; border: 1px solid var(--color-border); border-radius: 6px;
  background: var(--color-surface-alt); color: var(--color-text); font-size: 11px;
}
.step-select :deep(.ts-trigger) { height: 24px; font-size: 11px; }
.step-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; background: var(--color-surface-alt); color: var(--color-text-secondary); }
.step-btn:hover:not(:disabled) { color: var(--color-text); background: var(--color-hover); }
.step-btn:disabled { opacity: 0.4; cursor: default; }

.cols, .level { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr); column-gap: 8px; }
.cols { flex: 0 0 auto; padding: 7px 12px 5px; color: var(--color-text-muted); font-size: 11px; }
.cols span:not(:first-child), .level span:not(:first-child) { text-align: right; }
/* Headers wrap rather than cut the unit (「Amount (US…」, QA-064); the body rows stay single-line. */
.cols span { overflow-wrap: anywhere; line-height: 1.25; }

.book-body { position: relative; flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.side { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
/* Both sides: each takes half; asks hug the spread (bottom) and clip at the top, bids clip at the bottom. */
.mode-both .side { flex: 1 1 0; }
.mode-both .asks { justify-content: flex-end; }
.side.single { flex: 1 1 auto; justify-content: flex-start; }
.side-empty { margin: auto 0; padding: 14px 0; color: var(--color-text-muted); font-size: 12px; text-align: center; }

.level {
  position: relative; width: 100%; height: 20px; flex: 0 0 20px; align-items: center; padding: 0 12px;
  font-size: 12px; line-height: 20px; color: var(--color-text); text-align: left; cursor: pointer;
}
.level::before {
  content: ''; position: absolute; top: 1px; bottom: 1px; right: 0; width: var(--w);
  transition: width 0.3s var(--ease-out); pointer-events: none;
}
.level.ask::before { background: var(--color-down-bar); }
.level.bid::before { background: var(--color-up-bar); }
.level span { position: relative; overflow: hidden; white-space: nowrap; text-overflow: clip; }
.level .num { font-variant-numeric: tabular-nums; }
.level.ask .p { color: var(--color-down); }
.level.bid .p { color: var(--color-up); }
.level:hover, .level.sweep { background: var(--color-hover); }
.level.edge.ask { box-shadow: inset 0 1px 0 var(--color-border-strong); }
.level.edge.bid { box-shadow: inset 0 -1px 0 var(--color-border-strong); }
/* The row the column edge cuts through is hidden instead of drawn half (never affects the count). */
.level.cut { visibility: hidden; }
.level.flash-grow { animation: flash-up 0.6s ease-out; }
.level.flash-shrink { animation: flash-down 0.6s ease-out; }

.mid {
  display: flex; align-items: center; gap: 10px; flex: 0 0 40px; height: 40px; padding: 0 12px;
  border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border);
}
.mid.top { border-top: 0; }
.mid-last { display: inline-flex; align-items: center; gap: 2px; padding: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; cursor: pointer; }
.mid-last.flat { color: var(--color-text); }
.mid-last.up { color: var(--color-up); }
.mid-last.down { color: var(--color-down); }
.mid-mark {
  color: var(--color-text-secondary); font-size: 12px; text-decoration: underline dotted var(--color-text-muted);
  text-underline-offset: 3px; cursor: help; white-space: nowrap;
}
.mid-spread { margin-left: auto; color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }

.ratio { display: flex; align-items: center; gap: 8px; height: 32px; flex: 0 0 32px; padding: 0 12px; border-top: 1px solid var(--color-border); font-size: 11px; }
.r-label { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; white-space: nowrap; }
.r-label b { font-weight: 600; }
.r-track { display: flex; flex: 1; gap: 2px; height: 4px; }
.r-track i { display: block; height: 100%; transition: width 0.4s var(--ease-out); }
.r-bid { background: var(--color-up); border-radius: 2px 0 0 2px; }
.r-ask { background: var(--color-down); border-radius: 0 2px 2px 0; }
.r-none { margin: 0 auto; color: var(--color-text-muted); }

@media (hover: none) {
  .level:hover { background: transparent; }
}

/* Compact (Binance H5) book: two columns, no total, denser rows, big last price. */
.book.compact .book-title { display: none; }
.book.compact .book-head { height: 40px; flex-basis: 40px; padding: 0 8px; }
.book.compact .book-tools { gap: 4px; }
.book.compact .cols,
.book.compact .level { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); column-gap: 6px; }
.book.compact .cols { padding: 6px 8px 4px; }
.book.compact .level { padding: 0 8px; font-size: 12px; }
.book.compact .mid {
  flex: 0 0 auto; height: auto; flex-direction: column; align-items: flex-start;
  justify-content: center; gap: 3px; padding: 7px 8px;
}
.book.compact .mid.top { border-top: 0; }
.book.compact .mid-last { font-size: 20px; line-height: 1.1; letter-spacing: -0.01em; }
.book.compact .mid-mark { font-size: 11px; text-underline-offset: 2px; }
.book.compact .ratio { height: 28px; flex-basis: 28px; padding: 0 8px; }
/* 320–360 px phones: six-digit quantities otherwise clip in the ~140 px book column. */
@media (max-width: 380px) {
  .book.compact .cols, .book.compact .level { column-gap: 4px; padding-left: 6px; padding-right: 6px; }
  .book.compact .level { font-size: 11px; }
}
</style>

<style>
/* Teleported to <body>: not scoped. */
.book-card {
  position: fixed; z-index: 60; display: grid; gap: 4px; padding: 9px 12px; transform: translateY(-50%);
  border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-elevated); box-shadow: var(--shadow-pop);
  font-size: 12px; pointer-events: none;
}
.book-card.flip { transform: translate(-100%, -50%); }
.book-card p { display: flex; justify-content: space-between; gap: 12px; margin: 0; }
.book-card span { color: var(--color-text-muted); white-space: nowrap; }
.book-card b { font-weight: 600; white-space: nowrap; }
</style>
