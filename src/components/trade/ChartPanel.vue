<script setup lang="ts">
import { translateForLocale } from '@/i18n/composer'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Maximize2, PencilRuler } from '@lucide/vue'
import { SKIN } from '@/core/skin'
import { fetchCoinIntro } from '@/modules/api/public.api'
import type { CoinIntroItem } from '@/modules/api/types'
import { useMarketStore } from '@/stores/market'
import CoinInfoPane from './CoinInfoPane.vue'
import DepthChart from './DepthChart.vue'
import ModernChart from './ModernChart.vue'
import { useMarketSource } from './market-source'

/**
 * Chart area of every terminal (spot, margin, futures), laid out like Binance's: a toolbar with the interval strip (short labels 1m / 15m / 1H / 4H / 1D / 1W, the rest behind a "more" menu) and the
 * K-line / Depth view switch on the right. The chart widgets read the market through `MARKET_SOURCE` as before;
 * this component only owns the view switch. `scales` are the server's K-line scales (`1min`, `60min`, `1day`, …).
 *
 * OKX skin: OKX's chart panel instead — a tab row 图表 / 信息 (信息 = the coin profile, shown only when the coin has one),
 * then one bar with the intervals in OKX's words (1分 / 5分 / 15分 / 1小时 / 4小时 / 1日), a drawing-tools toggle (the chart's
 * tool strip is folded away by default, as on OKX) and 原生版 / 深度图 plus full screen on the right.
 */
const props = defineProps<{ scales: string[]; scale: string }>()
const emit = defineEmits<{ scale: [value: string] }>()

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { time: '时间', more: '更多周期', kline: 'K线', depth: '深度', chart: '图表', info: '信息', native: '原生版', depthChart: '深度图', tools: '画线工具', fullscreen: '全屏' },
    'en-US': { time: 'Time', more: 'More intervals', kline: 'Original', depth: 'Depth', chart: 'Chart', info: 'Info', native: 'Original', depthChart: 'Depth', tools: 'Drawing tools', fullscreen: 'Full screen' },
  },
})

const view = ref<'kline' | 'depth'>('kline')

const LABELS: Record<string, string> = {
  '1min': '1m', '3min': '3m', '5min': '5m', '15min': '15m', '30min': '30m', '60min': '1H', '1h': '1H', '2h': '2H',
  '4h': '4H', '6h': '6H', '12h': '12H', '1day': '1D', '3day': '3D', '1week': '1W', '1month': '1M', '1mon': '1M',
}
/** Binance shows these on the strip; any other server scale goes into the menu. */
const PRIMARY = new Set(['1min', '5min', '15min', '60min', '4h', '1day', '1week'])

/** OKX's own interval words (zh); other locales keep the short labels. */
const INTERVAL_KEYS: Record<string, string> = {
  '1min': 'chartInterval.value1m', '3min': 'chartInterval.value3m', '5min': 'chartInterval.value5m', '15min': 'chartInterval.value15m', '30min': 'chartInterval.value30m', '60min': 'chartInterval.value1h', '1h': 'chartInterval.value1h', '2h': 'chartInterval.value2h',
  '4h': 'chartInterval.value4h', '6h': 'chartInterval.value6h', '12h': 'chartInterval.value12h', '1day': 'chartInterval.value1d', '3day': 'chartInterval.value3d', '1week': 'chartInterval.value1w', '1month': 'chartInterval.value1m2', '1mon': 'chartInterval.value1m2',
}
/** OKX's strip: 1分 / 5分 / 15分 / 1小时 / 4小时 / 1日 (no 1-second data here, so no 1秒). */
const PRIMARY_OKX = new Set(['1min', '5min', '15min', '60min', '4h', '1day'])
const { locale } = useI18n()

function label(scale: string): string {
  if (SKIN === 'okx' && INTERVAL_KEYS[scale]) return translateForLocale(locale.value, INTERVAL_KEYS[scale])
  return LABELS[scale] ?? scale
}

const primary = computed(() => {
  const set = SKIN === 'okx' ? PRIMARY_OKX : PRIMARY
  const strip = props.scales.filter((scale) => set.has(scale))
  // The chosen scale stays visible even when it lives in the menu.
  if (props.scale !== '' && !strip.includes(props.scale) && props.scales.includes(props.scale)) strip.push(props.scale)
  return strip.length > 0 ? strip : props.scales.slice(0, 6)
})
const extra = computed(() => props.scales.filter((scale) => !primary.value.includes(scale)))

const menuOpen = ref(false)
const menuRoot = ref<HTMLElement>()
function choose(scale: string): void {
  menuOpen.value = false
  emit('scale', scale)
}
function onDocument(event: MouseEvent): void {
  if (menuOpen.value && menuRoot.value !== undefined && !menuRoot.value.contains(event.target as Node)) menuOpen.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocument))

/* ------------------------------------------------------------------ OKX skin: tabs, tools toggle, coin profile */
const tab = ref<'chart' | 'info'>('chart')
const toolsOpen = ref(false)
const chartRef = ref<InstanceType<typeof ModernChart>>()
const source = useMarketSource()
const spot = useMarketStore()
const base = computed(() => (source.currentSymbol?.base ?? '').toUpperCase())
const baseIcon = computed(() => {
  const coin = spot.symbols.find((entry) => entry.base.toUpperCase() === base.value)?.coin
  return coin?.icon ?? ''
})
const intros = shallowRef<CoinIntroItem[]>([])
let introLocale = ''
function loadIntros(): void {
  if (SKIN !== 'okx' || introLocale === locale.value) return
  introLocale = locale.value
  fetchCoinIntro().then((items) => { intros.value = Array.isArray(items) ? items : [] }).catch(() => { intros.value = []; introLocale = '' })
}
const intro = computed<CoinIntroItem | undefined>(() => intros.value.find((item) => (item.coinSymbol ?? '').toUpperCase() === base.value && (item.introduction ?? '') !== ''))
watch(intro, (value) => { if (value === undefined) tab.value = 'chart' })
watch(locale, loadIntros)
onMounted(loadIntros)
function fullscreen(): void {
  void chartRef.value?.toggleFullscreen()
}
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocument))
</script>

<template>
  <section v-if="SKIN === 'okx'" class="chart-panel okx-cp">
    <div class="ocp-tabs" role="tablist">
      <button class="ocp-tab" :class="{ active: tab === 'chart' }" role="tab" type="button" :aria-selected="tab === 'chart'" @click="tab = 'chart'">{{ t('chart') }}</button>
      <button v-if="intro !== undefined" class="ocp-tab" :class="{ active: tab === 'info' }" role="tab" type="button" :aria-selected="tab === 'info'" @click="tab = 'info'">{{ t('info') }}</button>
    </div>
    <div v-show="tab === 'chart'" class="ocp-bar">
      <div v-show="view === 'kline'" class="cp-scales">
        <button v-for="scale in primary" :key="scale" class="scale" :class="{ active: scale === props.scale }" type="button" :aria-pressed="scale === props.scale" @click="choose(scale)">{{ label(scale) }}</button>
        <div v-if="extra.length > 0" ref="menuRoot" class="cp-more">
          <button class="scale cp-more-btn" type="button" :aria-expanded="menuOpen" :aria-label="t('more')" :title="t('more')" @click="menuOpen = !menuOpen"><ChevronDown :size="14" /></button>
          <div v-if="menuOpen" class="cp-menu" role="menu">
            <button v-for="scale in extra" :key="scale" class="cp-menu-item" :class="{ active: scale === props.scale }" type="button" role="menuitem" @click="choose(scale)">{{ label(scale) }}</button>
          </div>
        </div>
        <span class="ocp-divider" aria-hidden="true"></span>
        <button class="ocp-icon" :class="{ on: toolsOpen }" type="button" :aria-pressed="toolsOpen" :title="t('tools')" :aria-label="t('tools')" @click="toolsOpen = !toolsOpen"><PencilRuler :size="16" /></button>
      </div>
      <div class="ocp-right">
        <div class="ocp-seg" role="tablist">
          <button class="ocp-seg-btn" :class="{ on: view === 'kline' }" role="tab" type="button" :aria-selected="view === 'kline'" @click="view = 'kline'">{{ t('native') }}</button>
          <button class="ocp-seg-btn" :class="{ on: view === 'depth' }" role="tab" type="button" :aria-selected="view === 'depth'" @click="view = 'depth'">{{ t('depthChart') }}</button>
        </div>
        <button v-show="view === 'kline'" class="ocp-icon" type="button" :title="t('fullscreen')" :aria-label="t('fullscreen')" @click="fullscreen"><Maximize2 :size="16" /></button>
      </div>
    </div>
    <div v-show="tab === 'chart'" class="chart-box">
      <div v-show="view === 'kline'" class="chart-layer"><ModernChart ref="chartRef" :tools="toolsOpen" /></div>
      <div v-if="view === 'depth'" class="chart-layer"><DepthChart /></div>
    </div>
    <div v-if="tab === 'info' && intro !== undefined" class="chart-box"><CoinInfoPane :item="intro" :base="base" :icon="baseIcon" /></div>
  </section>
  <section v-else class="chart-panel">
    <div class="cp-toolbar">
      <div v-show="view === 'kline'" class="cp-scales">
        <span class="cp-time">{{ t('time') }}</span>
        <button v-for="scale in primary" :key="scale" class="scale" :class="{ active: scale === props.scale }" type="button" :aria-pressed="scale === props.scale" @click="choose(scale)">{{ label(scale) }}</button>
        <div v-if="extra.length > 0" ref="menuRoot" class="cp-more">
          <button class="scale cp-more-btn" type="button" :aria-expanded="menuOpen" :aria-label="t('more')" :title="t('more')" @click="menuOpen = !menuOpen"><ChevronDown :size="14" /></button>
          <div v-if="menuOpen" class="cp-menu" role="menu">
            <button v-for="scale in extra" :key="scale" class="cp-menu-item" :class="{ active: scale === props.scale }" type="button" role="menuitem" @click="choose(scale)">{{ label(scale) }}</button>
          </div>
        </div>
      </div>
      <div class="cp-views" role="tablist">
        <button class="view-tab" :class="{ active: view === 'kline' }" role="tab" type="button" :aria-selected="view === 'kline'" @click="view = 'kline'">{{ t('kline') }}</button>
        <button class="view-tab" :class="{ active: view === 'depth' }" role="tab" type="button" :aria-selected="view === 'depth'" @click="view = 'depth'">{{ t('depth') }}</button>
      </div>
    </div>
    <div class="chart-box">
      <div v-show="view === 'kline'" class="chart-layer"><ModernChart /></div>
      <div v-if="view === 'depth'" class="chart-layer"><DepthChart /></div>
    </div>
  </section>
</template>

<style scoped>
.chart-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--color-surface); }
.cp-toolbar { display: flex; flex: 0 0 40px; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid var(--color-border); overflow-x: auto; scrollbar-width: none; }
.cp-scales { display: flex; align-items: center; gap: 2px; }
.cp-time { margin-right: 6px; color: var(--color-text-muted); font-size: 12px; }
.scale { height: 24px; padding: 0 7px; border-radius: var(--radius-sm); color: var(--color-text-secondary); font-size: 12px; font-weight: 500; white-space: nowrap; }
.scale:hover { color: var(--color-text); }
.scale.active { color: var(--color-text); font-weight: 650; background: var(--color-hover); }
.cp-more { position: relative; }
.cp-more-btn { display: inline-flex; align-items: center; }
.cp-menu {
  position: fixed; z-index: 60; display: grid; grid-template-columns: repeat(3, 52px); gap: 2px; margin-top: 4px; padding: 6px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-elevated); box-shadow: var(--shadow-pop);
}
.cp-menu-item { height: 26px; border-radius: var(--radius-sm); color: var(--color-text-secondary); font-size: 12px; }
.cp-menu-item:hover { background: var(--color-hover); color: var(--color-text); }
.cp-menu-item.active { color: var(--color-accent-text); }
.cp-views { display: flex; gap: 14px; margin-left: auto; }
.view-tab { height: 34px; padding: 0; color: var(--color-text-muted); font-size: 12px; font-weight: 500; white-space: nowrap; }
.view-tab:hover { color: var(--color-text); }
.view-tab.active { color: var(--color-text); font-weight: 650; }
/* OKX skin */
.ocp-tabs { display: flex; flex: 0 0 48px; align-items: center; gap: 28px; padding: 0 20px; border-bottom: 1px solid var(--color-border); }
.ocp-tab { position: relative; height: 48px; padding: 0; color: var(--color-text-muted); font-size: 15px; font-weight: 600; white-space: nowrap; }
.ocp-tab:hover { color: var(--color-text); }
.ocp-tab.active { color: var(--color-text); font-weight: 700; }
.ocp-tab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-text); }
.ocp-bar { display: flex; flex: 0 0 44px; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid var(--color-border); overflow-x: auto; scrollbar-width: none; }
.okx-cp .scale { height: 28px; padding: 0 8px; border-radius: 6px; font-size: 13px; }
.okx-cp .scale.active { background: var(--color-surface-alt); color: var(--color-text); font-weight: 700; }
.ocp-divider { width: 1px; height: 16px; margin: 0 6px; background: var(--color-border-strong); }
.ocp-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; color: var(--color-text-secondary); }
.ocp-icon:hover, .ocp-icon.on { background: var(--color-surface-alt); color: var(--color-text); }
.ocp-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.ocp-seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--color-surface-alt); }
.ocp-seg-btn { height: 26px; padding: 0 10px; border-radius: 6px; color: var(--color-text-muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.ocp-seg-btn:hover { color: var(--color-text); }
.ocp-seg-btn.on { background: var(--okx-canvas, var(--color-surface)); color: var(--color-text); }
.chart-box { position: relative; flex: 1 1 auto; min-height: 0; }
.chart-layer { position: absolute; inset: 0; }
</style>
