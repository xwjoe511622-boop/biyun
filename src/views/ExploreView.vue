<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import ProductArt from '@/components/common/ProductArt.vue'
import { OKX_NAV, PREDICT_ENTRY, type NavItemDef } from '@/components/layout/nav-config'
import { useFuturesBoard } from '@/components/home/okx/use-futures-board'
import { vTick } from '@/components/home/fx/fx'
import { coinTagOf } from '@/components/trade/pair-category'
import { isFeatureEnabled, type FeatureFlagKey } from '@/core/feature-flags'
import { apiLanguage } from '@/i18n'
import { groupDigits, isDecimalString, isSignedDecimalString } from '@/modules/finance/decimal'
import { percentView, type PercentView } from '@/modules/finance/display'
import type { MarketSymbol } from '@/modules/market/symbols'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useMarketStore } from '@/stores/market'

/**
 * 探索 (phone bottom-navigation tab; discovery page since 2026-11-17).
 *   热门板块   the admin's coin tags (币种配置 › 币种标签: AI, RWA, 黄金, Meme …) as sectors, each with its live average
 *              24h change and leader, plus 美股 / 黄金 perpetual quotes from the futures board. All real tickers.
 *   板块行情   the selected sector's pairs.
 *   产品       the 金融 menu's entries; one that is not open yet (`core/feature-flags.ts`) carries 暂未开放 and opens
 *              its preview page. No product figure is shown for anything that is not live.
 */
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '探索', sub: '按板块发现机会：实时行情覆盖加密货币、黄金与美股。',
      sectors: '热门板块', coins: '{n} 个币种', contracts: '{n} 个合约', avg: '板块平均', lead: '领涨',
      stocks: '美股', gold: '黄金合约', quoteOnly: '仅行情', name: '名称', last: '最新价', change: '24h 涨跌', perp: '永续',
      products: '产品', soon: '暂未开放', up: '上涨 {n}', down: '下跌 {n}', live: '已上线', none: '暂无数据',
    },
    'en-US': {
      title: 'Explore', sub: 'Discover by sector: live quotes for crypto, gold and US stocks.',
      sectors: 'Sectors', coins: '{n} coins', contracts: '{n} contracts', avg: 'Sector average', lead: 'Leader',
      stocks: 'US stocks', gold: 'Gold futures', quoteOnly: 'Quotes only', name: 'Name', last: 'Last price', change: '24h change', perp: 'Perp',
      products: 'Products', soon: 'Not open yet', up: '{n} up', down: '{n} down', live: 'Live', none: 'No data yet',
    },
  },
})
const { t: gt } = useI18n({ useScope: 'global' })
const market = useMarketStore()
const futures = useFuturesMarketStore()
const board = useFuturesBoard()
const router = useRouter()

interface Row { key: string; base: string; quote: string; tag: string; last: string; rose: string; amount: string; change: PercentView; open: () => void }
interface Sector { id: string; name: string; note: string; unit: 'coins' | 'contracts'; rows: Row[]; average: PercentView; mean: number; leader: Row | undefined }

/** Mean of the rows' 24h change ratios, for the sector headline only. */
function average(rows: Row[]): PercentView {
  const values = rows.map((row) => row.rose).filter(isSignedDecimalString)
  if (values.length === 0) return { text: '--', direction: 'flat' }
  const mean = values.reduce((sum, value) => sum + Number(value), 0) / values.length // float-ok: display-only sector average
  return percentView(mean.toFixed(6))
}
/** The same mean as a number (ratio), for the heat map's colour depth. */
function meanOf(rows: Row[]): number {
  const values = rows.map((row) => row.rose).filter(isSignedDecimalString)
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + Number(value), 0) / values.length // float-ok: display-only colour depth
}
function leaderOf(rows: Row[]): Row | undefined {
  return [...rows].filter((row) => isSignedDecimalString(row.rose)).sort((a, b) => Number(b.rose) - Number(a.rose))[0] // float-ok: ordering for display
}
function spotRow(entry: MarketSymbol): Row {
  const tick = market.tickers[entry.symbol.toLowerCase()]
  const rose = tick?.rose ?? ''
  return {
    key: entry.symbol, base: entry.base, quote: entry.quote, tag: '', amount: tick?.amount ?? '',
    last: tick !== undefined && isDecimalString(tick.close) ? groupDigits(tick.close, Math.min(entry.pricePrecision, 8)) : '--',
    rose, change: rose === '' ? { text: '--', direction: 'flat' } : percentView(rose),
    open: () => { market.selectPair(entry.pair); void router.push('/trade') },
  }
}

const sectors = computed<Sector[]>(() => {
  const labels = market.publicInfo?.market?.coinTagLangs?.[apiLanguage(locale.value)] ?? {}
  const groups = new Map<string, Row[]>()
  market.symbols.forEach((entry) => {
    const tag = coinTagOf(entry)
    if (tag === '' || typeof labels[tag] !== 'string') return
    groups.set(tag, [...(groups.get(tag) ?? []), spotRow(entry)])
  })
  const out: Sector[] = [...groups.entries()].map(([tag, rows]) => ({ id: `tag:${tag}`, name: String(labels[tag]), note: '', unit: 'coins', rows, average: average(rows), mean: meanOf(rows), leader: leaderOf(rows) }))
  // Perpetual quotes by kind: listed on the futures board, viewable whether or not futures trading is open.
  const perp = (kind: 'stock' | 'gold', name: string): void => {
    const rows = board.rows.value.filter((row) => row.kind === kind).map((row): Row => ({
      key: row.contract.contractName, base: row.base, quote: 'USDT', tag: t('perp'), last: row.last, amount: '',
      rose: row.change.text.replace('%', '').replace('+', '') === '--' ? '' : (Number(row.change.text.replace('%', '').replace('+', '')) / 100).toFixed(6), // float-ok: display-only
      change: row.change,
      open: () => { futures.selectContract(row.contract.contractName); void router.push('/futures') },
    }))
    if (rows.length > 0) out.push({ id: `perp:${kind}`, name, note: isFeatureEnabled('futuresTrading') ? '' : t('quoteOnly'), unit: 'contracts', rows, average: average(rows), mean: meanOf(rows), leader: leaderOf(rows) })
  }
  perp('stock', t('stocks'))
  perp('gold', t('gold'))
  // Largest sectors first; single-coin sectors last.
  return out.sort((a, b) => b.rows.length - a.rows.length)
})
const picked = ref('')
const current = computed(() => sectors.value.find((sector) => sector.id === picked.value) ?? sectors.value[0])
/* ------------------------------------------------------------------ sector heat map (owner 2026-11-17)
   A treemap: each sector's area follows its 24h turnover (square-rooted so small sectors stay readable), its colour
   depth follows the average change. The layout is computed once per sector set — live ticks recolour, never reflow. */
interface Tile { id: string; x: number; y: number; w: number; h: number; size: 'lg' | 'md' | 'sm' }
const MAP_W = 100
const MAP_H = 78
function squarify(areas: number[]): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = []
  const worst = (row: number[], side: number): number => {
    const total = row.reduce((a, b) => a + b, 0)
    return Math.max((side * side * Math.max(...row)) / (total * total), (total * total) / (side * side * Math.min(...row)))
  }
  let x = 0, y = 0, w = MAP_W, h = MAP_H, i = 0
  while (i < areas.length) {
    const side = Math.min(w, h)
    const row = [areas[i] as number]
    let j = i + 1
    while (j < areas.length && worst([...row, areas[j] as number], side) <= worst(row, side)) { row.push(areas[j] as number); j += 1 }
    const total = row.reduce((a, b) => a + b, 0)
    if (w >= h) {
      const rw = total / h
      let cy = y
      row.forEach((area) => { out.push({ x, y: cy, w: rw, h: area / rw }); cy += area / rw })
      x += rw; w -= rw
    } else {
      const rh = total / w
      let cx = x
      row.forEach((area) => { out.push({ x: cx, y, w: area / rh, h: rh }); cx += area / rh })
      y += rh; h -= rh
    }
    i = j
  }
  return out
}
const tiles = ref<Tile[]>([])
function layoutTiles(): void {
  const list = sectors.value
  if (list.length === 0) { tiles.value = []; return }
  const raw = list.map((sector) => Math.sqrt(sector.rows.reduce((sum, row) => sum + (isDecimalString(row.amount) ? Number(row.amount) : 0), 0))) // float-ok: layout weight only
  const known = raw.filter((value) => value > 0).sort((a, b) => a - b)
  const fallback = known.length === 0 ? 1 : (known[Math.floor(known.length / 2)] as number)
  const filled = raw.map((value) => (value > 0 ? value : fallback * 0.7))
  const floor = filled.reduce((a, b) => a + b, 0) * 0.07
  const weighted = list.map((sector, index) => ({ id: sector.id, weight: Math.max(filled[index] as number, floor) })).sort((a, b) => b.weight - a.weight)
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  const rects = squarify(weighted.map((entry) => (entry.weight / total) * MAP_W * MAP_H))
  tiles.value = weighted.map((entry, index) => {
    const rect = rects[index] as { x: number; y: number; w: number; h: number }
    return { id: entry.id, ...rect, size: rect.w >= 36 && rect.h >= 30 ? 'lg' : rect.w >= 22 && rect.h >= 17 ? 'md' : 'sm' }
  })
}
const layoutKey = computed(() => `${sectors.value.map((sector) => sector.id).join(',')}|${sectors.value.some((sector) => sector.rows.some((row) => isDecimalString(row.amount))) ? 1 : 0}`)
watch(layoutKey, layoutTiles, { immediate: true })
const heat = computed(() => tiles.value.flatMap((tile) => {
  const sector = sectors.value.find((entry) => entry.id === tile.id)
  if (sector === undefined) return []
  const depth = Math.min(1, Math.abs(sector.mean) / 0.04) // 4% average move = full colour
  return [{ tile, sector, style: { left: `${tile.x}%`, top: `${(tile.y / MAP_H) * 100}%`, width: `${tile.w}%`, height: `${(tile.h / MAP_H) * 100}%`, '--depth': `${Math.round(34 + depth * 46)}%` } }]
}))

/** Rising / falling counts of the selected sector, for its breadth bar. */
const breadth = computed(() => {
  const rows = current.value?.rows ?? []
  const up = rows.filter((row) => row.change.direction === 'up').length
  const down = rows.filter((row) => row.change.direction === 'down').length
  return { up, down, ratio: up + down === 0 ? 50 : Math.round((up / (up + down)) * 100) }
})
const loading = computed(() => market.publicInfo === null && market.publicInfoError === null)

/* ------------------------------------------------------------------ products (finance menu + copy trading) */
const ART: Record<string, string | undefined> = { '/earn': 'earn', '/loans': 'loans', '/launchpad': 'launchpad', '/launchpool': 'launchpool', '/vesting': 'vesting', '/predict': 'predict', '/copy-trading': 'copy' }
const FLAG: Record<string, FeatureFlagKey | undefined> = { '/earn': 'earn', '/loans': 'loans', '/launchpad': 'launchpad', '/launchpool': 'launchpool', '/vesting': 'vesting', '/copy-trading': 'copyTrading' }
const products = computed(() => {
  const finance = (OKX_NAV.find((entry) => entry.key === 'finance')?.columns ?? []).flatMap((column) => column.items)
  const copy = (OKX_NAV.find((entry) => entry.key === 'trade')?.columns ?? []).flatMap((column) => column.items).filter((item) => item.to === '/copy-trading')
  return [...[...finance, ...copy].filter((item: NavItemDef) => item.flag === undefined || isFeatureEnabled(item.flag)), PREDICT_ENTRY]
    .map((item) => ({ item, open: item.to !== PREDICT_ENTRY.to && (FLAG[item.to] === undefined || isFeatureEnabled(FLAG[item.to] as FeatureFlagKey)) }))
})

let stopStream: (() => void) | null = null
onMounted(() => {
  stopStream = market.start('overview')
  if (market.publicInfo === null) void market.loadPublicInfo().catch(() => { /* the page shows its empty state */ })
})
onBeforeUnmount(() => { stopStream?.(); stopStream = null })
</script>

<template>
  <section class="explore">
    <p class="ex-sub">{{ t('sub') }}</p>

    <section class="ex-sec">
      <h2>{{ t('sectors') }}</h2>
      <i v-if="loading" class="sk sk-map" aria-hidden="true"></i>
      <div v-else class="ex-map" role="tablist">
        <button v-for="cell in heat" :key="cell.sector.id" type="button" role="tab" class="ex-cell" :class="[cell.sector.average.direction, cell.tile.size, { active: current?.id === cell.sector.id }]" :style="cell.style" :aria-selected="current?.id === cell.sector.id" :data-testid="`explore-sector-${cell.sector.id}`" @click="picked = cell.sector.id">
          <span class="ex-cell-in">
            <span class="ex-cell-top"><strong>{{ cell.sector.name }}</strong><em v-if="cell.sector.note !== '' && cell.tile.size === 'lg'">{{ cell.sector.note }}</em></span>
            <b class="num">{{ cell.sector.average.text }}</b>
            <small v-if="cell.tile.size === 'lg' && cell.tile.h >= 44 && cell.sector.leader !== undefined">{{ t('lead') }} {{ cell.sector.leader.base }} {{ cell.sector.leader.change.text }}</small>
            <span v-if="(cell.tile.size === 'lg' && cell.tile.h >= 38) || (cell.tile.size === 'md' && cell.tile.h >= 27)" class="ex-cell-coins"><CoinMark v-for="row in cell.sector.rows.slice(0, cell.tile.size === 'lg' ? 4 : 2)" :key="row.key" :symbol="row.base" :size="cell.tile.size === 'lg' ? 22 : 18" /></span>
          </span>
        </button>
      </div>
    </section>

    <section v-if="current !== undefined" class="ex-list">
      <header class="ex-hero">
        <div class="ex-hero-row">
          <span class="ex-hero-name"><strong>{{ current.name }}</strong><em v-if="current.note !== ''">{{ current.note }}</em></span>
          <button v-if="current.leader !== undefined" type="button" class="ex-lead" @click="current.leader.open()">
            <small>{{ t('lead') }}</small><CoinMark :symbol="current.leader.base" :size="18" /><strong>{{ current.leader.base }}</strong>
            <i class="num" :class="current.leader.change.direction">{{ current.leader.change.text }}</i>
          </button>
        </div>
        <div class="ex-breadth">
          <span class="up">{{ t('up', { n: breadth.up }) }}</span>
          <span class="ex-bar"><i :style="{ width: `${breadth.ratio}%` }"></i></span>
          <span class="down">{{ t('down', { n: breadth.down }) }}</span>
        </div>
      </header>
      <div class="ex-list-head"><span>{{ t('name') }}</span><span>{{ t('last') }}</span><span>{{ t('change') }}</span></div>
      <ul>
        <li v-for="row in current.rows" :key="row.key">
          <button type="button" class="ex-row" @click="row.open()">
            <span class="ex-row-name"><CoinMark :symbol="row.base" :size="28" /><span><strong>{{ row.base }}</strong><small>/{{ row.quote }}</small><i v-if="row.tag !== ''">{{ row.tag }}</i></span></span>
            <span v-tick="row.last" class="ex-row-last num">{{ row.last }}</span>
            <span class="ex-row-chg num" :class="row.change.direction">{{ row.change.text }}</span>
          </button>
        </li>
      </ul>
    </section>
    <p v-else-if="!loading" class="ex-empty">{{ t('none') }}</p>

    <section class="ex-sec">
      <h2>{{ t('products') }}</h2>
      <div class="ex-grid">
        <RouterLink v-for="entry in products" :key="entry.item.to" class="ex-tile" :class="{ soon: !entry.open }" :to="entry.item.to" :data-testid="`explore-tile-${entry.item.to.slice(1)}`">
          <span class="ex-tile-top">
            <ProductArt :kind="ART[entry.item.to] ?? ''" :size="46" />
            <em v-if="!entry.open">{{ t('soon') }}</em>
          </span>
          <strong>{{ gt(entry.item.label) }}</strong>
          <small>{{ gt(entry.item.desc) }}</small>
          <ChevronRight :size="15" class="ex-tile-go" aria-hidden="true" />
        </RouterLink>
      </div>
    </section>
  </section>
</template>

<style scoped>
.explore { display: flex; flex-direction: column; gap: 20px; max-width: 720px; margin: 0 auto; padding: 14px 14px 30px; }
.ex-sub { margin: -6px 0 -4px; color: var(--color-text-secondary); font-size: 12.5px; line-height: 1.5; }
.ex-sec { display: flex; flex-direction: column; gap: 12px; }
.ex-sec h2 { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 750; }

/* Sector heat map: tiles sized by turnover, coloured by the average move; a slow sheen sweeps across. */
.ex-map { position: relative; width: 100%; aspect-ratio: 100 / 78; border-radius: 18px; overflow: hidden; background: var(--color-surface); isolation: isolate; }
.ex-map::after { content: ''; position: absolute; inset: 0; z-index: 3; pointer-events: none; background: linear-gradient(105deg, transparent 42%, rgba(255, 255, 255, .13) 50%, transparent 58%); background-size: 260% 100%; animation: ex-sheen 6s ease-in-out infinite; }
@keyframes ex-sheen { 0%, 55% { background-position: 130% 0; } 100% { background-position: -130% 0; } }
.ex-cell { --tone: #6b7280; position: absolute; padding: 1.500px; color: #fff; text-align: left; transition: left .5s ease, top .5s ease, width .5s ease, height .5s ease; }
.ex-cell.up { --tone: var(--color-up); } .ex-cell.down { --tone: var(--color-down); }
.ex-cell-in { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; padding: 10px 11px; overflow: hidden; border-radius: 12px;
  background: radial-gradient(130% 120% at 0% 0%, rgba(255, 255, 255, .2), transparent 55%), linear-gradient(160deg, color-mix(in srgb, var(--tone) var(--depth), #101012), color-mix(in srgb, var(--tone) calc(var(--depth) - 16%), #08080a));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .16), inset 0 -18px 28px -18px rgba(0, 0, 0, .5); transition: transform .18s ease, box-shadow .18s ease, background .6s ease; }
.ex-cell:active .ex-cell-in { transform: scale(.97); }
.ex-cell.active { z-index: 2; }
.ex-cell.active .ex-cell-in { box-shadow: inset 0 0 0 2px var(--color-accent), inset 0 1px 0 rgba(255, 255, 255, .16), 0 0 18px color-mix(in srgb, var(--color-accent) 60%, transparent); }
.ex-cell-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ex-cell-top strong { overflow: hidden; font-family: var(--font-display); font-size: 15px; font-weight: 750; white-space: nowrap; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0, 0, 0, .35); }
.ex-cell-top em { flex: 0 0 auto; padding: 1px 6px; border-radius: 999px; background: rgba(0, 0, 0, .28); color: #fff; font-size: 10px; font-style: normal; font-weight: 700; white-space: nowrap; }
.ex-cell b { margin-top: 2px; font-size: 16px; font-weight: 750; letter-spacing: -0.01em; text-shadow: 0 1px 2px rgba(0, 0, 0, .35); }
.ex-cell small { margin-top: 6px; color: rgba(255, 255, 255, .78); font-size: 11.500px; white-space: nowrap; }
.ex-cell-coins { display: flex; margin-top: auto; }
.ex-cell-coins > * + * { margin-left: -7px; }
.ex-cell-coins > * { border-radius: 50%; box-shadow: 0 0 0 1.500px rgba(0, 0, 0, .35); }
.ex-cell.lg .ex-cell-in { padding: 14px; }
.ex-cell.lg .ex-cell-top strong { font-size: 19px; }
.ex-cell.lg b { margin-top: 4px; font-size: 30px; letter-spacing: -0.02em; }
.ex-cell.sm .ex-cell-in { padding: 7px 8px; }
.ex-cell.sm .ex-cell-top strong { font-size: 12.500px; }
.ex-cell.sm b { font-size: 12.500px; }
.ex-hero-name em { padding: 1px 6px; border-radius: 999px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 10px; font-style: normal; font-weight: 700; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .ex-map::after { animation: none; } .ex-cell { transition: none; } }

.ex-list { overflow: hidden; border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); margin-top: -6px; }
.ex-hero { display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 12px; border-bottom: 1px solid var(--color-border); background: radial-gradient(110% 160% at 0% 0%, color-mix(in srgb, var(--color-accent) 16%, transparent), transparent 62%); }
.ex-hero-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ex-hero-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ex-hero-name strong { font-family: var(--font-display); font-size: 17px; font-weight: 750; white-space: nowrap; }
.ex-lead { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--color-border); border-radius: 999px; background: color-mix(in srgb, var(--color-surface-alt) 80%, transparent); color: var(--color-text); }
.ex-lead small { color: var(--color-text-muted); font-size: 11px; }
.ex-lead strong { font-size: 12.500px; font-weight: 700; }
.ex-lead i { font-size: 12px; font-style: normal; font-weight: 700; }
.ex-lead i.up, .ex-breadth .up { color: var(--color-up); } .ex-lead i.down, .ex-breadth .down { color: var(--color-down); }
.ex-breadth { display: flex; align-items: center; gap: 10px; font-size: 11.500px; font-weight: 650; white-space: nowrap; }
.ex-bar { flex: 1 1 auto; height: 5px; overflow: hidden; border-radius: 999px; background: var(--color-down); }
.ex-bar i { display: block; height: 100%; border-right: 2px solid var(--color-surface); background: var(--color-up); transition: width .4s ease; }
.ex-list ul { margin: 0; padding: 0 0 4px; list-style: none; }
.ex-list-head, .ex-row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) 80px; align-items: center; gap: 8px; }
.ex-list-head { padding: 10px 14px 4px; color: var(--color-text-muted); font-size: 11px; }
.ex-list-head span:nth-child(n + 2), .ex-row-last { text-align: right; }
.ex-row { width: 100%; padding: 10px 14px; text-align: left; }
.ex-row:active { background: var(--color-hover); }
.ex-row-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ex-row-name > span { min-width: 0; white-space: nowrap; }
.ex-row-name strong { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
.ex-row-name small { color: var(--color-text-muted); font-size: 11px; }
.ex-row-name i { display: inline-block; margin-left: 5px; padding: 1px 5px; border-radius: 4px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 10px; font-style: normal; }
.ex-row-last { font-size: 14.5px; font-weight: 650; }
.ex-row-last::after { content: none !important; }
.ex-row-chg { display: inline-flex; align-items: center; justify-content: center; justify-self: end; width: 78px; height: 30px; border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13px; font-weight: 700; }
.ex-row-chg.up { background: var(--color-up); color: #fff; } .ex-row-chg.down { background: var(--color-down); color: #fff; }
.ex-empty { margin: 0; padding: 24px 0; color: var(--color-text-muted); font-size: 13px; text-align: center; }

.ex-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ex-tile { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 14px; border: 1px solid var(--color-border); border-radius: 16px; background: radial-gradient(90% 70% at 0% 0%, color-mix(in srgb, var(--color-accent) 13%, transparent), transparent 70%), var(--color-surface); color: var(--color-text); text-decoration: none; }
.ex-tile:last-child:nth-child(odd) { grid-column: 1 / -1; }
.ex-tile:active { background: var(--color-hover); }
.ex-tile-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px; }
.ex-tile-top em { display: inline-flex; align-items: center; padding: 2px 8px; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text-muted); font-size: 10.5px; font-style: normal; font-weight: 700; }
.ex-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 13px; color: var(--color-accent-text);
  border: 1px solid color-mix(in srgb, var(--color-accent) 34%, var(--color-border));
  background: radial-gradient(120% 90% at 22% 12%, color-mix(in srgb, var(--color-accent) 30%, transparent), transparent 62%), linear-gradient(160deg, var(--color-surface-alt), var(--color-surface));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 6px 14px -10px color-mix(in srgb, var(--color-accent) 80%, transparent);
}
.ex-tile strong { font-size: 15px; font-weight: 700; }
.ex-tile > small { padding-right: 14px; color: var(--color-text-muted); font-size: 11.5px; line-height: 1.4; }
.ex-tile-go { position: absolute; right: 10px; bottom: 14px; color: var(--color-text-muted); }

.sk-map { aspect-ratio: 100 / 78; border-radius: 18px; }
.sk { display: block; background: linear-gradient(90deg, var(--color-surface-alt) 25%, color-mix(in srgb, var(--color-text) 9%, var(--color-surface-alt)) 50%, var(--color-surface-alt) 75%); background-size: 200% 100%; animation: sk-move 1.3s linear infinite; }
@keyframes sk-move { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.ex-row-last.fx-tk-up1 { animation: ex-up-a .9s ease-out; } .ex-row-last.fx-tk-up2 { animation: ex-up-b .9s ease-out; }
.ex-row-last.fx-tk-dn1 { animation: ex-dn-a .9s ease-out; } .ex-row-last.fx-tk-dn2 { animation: ex-dn-b .9s ease-out; }
@keyframes ex-up-a { from { color: var(--color-up); } } @keyframes ex-up-b { from { color: var(--color-up); } }
@keyframes ex-dn-a { from { color: var(--color-down); } } @keyframes ex-dn-b { from { color: var(--color-down); } }
@media (prefers-reduced-motion: reduce) { .sk, .ex-row-last { animation: none !important; } }
</style>
