<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import {
  cumulativeRealized,
  fetchBonusRate,
  fetchFollowers,
  fetchTrader,
  fetchTraderHistory,
  fetchTraderPositions,
  followersAum,
  type Trader,
  type TraderClosedPosition,
  type TraderFollower,
  type TraderPosition,
} from '@/modules/copytrading/copytrading.api'
import { formatDateTime } from '@/modules/futures/format'
import { amountText, plainPercent, signedAmount, signedPercent } from '@/modules/copytrading/format'
import { errorMessage } from '@/modules/content/api-helpers'
import { useCopyI18n } from '@/modules/copytrading/i18n'
import { useSizeFormat } from '@/modules/futures/use-size-format'
import { useFuturesMarketStore } from '@/stores/futures-market'

/**
 * Trader detail, Binance Copy Trading style (2026-09-30): profile + bio, stats, copy AUM (Σ copiers' margin from
 * `traderUser/follower`), the profit-share rate, a cumulative realized-PnL curve of closed lead positions, and tabs for
 * current (`trader_position_list` status 1) and closed (status 0) lead positions. Only server data is shown: a daily
 * PnL / ROI curve needs backend work; bios come back in list / query since 2026-10-01 (see docs/03-reference/copy-trading.md).
 */
const props = defineProps<{ uid: string }>()
const emit = defineEmits<{ (event: 'close'): void; (event: 'follow', trader: Trader): void }>()
const { t } = useCopyI18n()

const trader = ref<Trader | null>(null)
const positions = ref<TraderPosition[]>([])
const history = ref<TraderClosedPosition[]>([])
const followers = ref<TraderFollower[] | null>(null)
const bonusRate = ref<number | null>(null)
const tab = ref<'current' | 'history'>('current')
const aum = computed(() => (followers.value === null ? '' : followersAum(followers.value)))
const curve = computed(() => cumulativeRealized(history.value))
/** SVG path of the curve in a 300×80 box (with a zero line), `''` with fewer than two points. */
const curvePath = computed(() => {
  const points = curve.value.map((point) => Number(point.total)) // float-ok: SVG curve coordinates, display only
  if (points.length < 2) return { line: '', zero: -1, up: true }
  const min = Math.min(0, ...points)
  const max = Math.max(0, ...points)
  const span = max - min || 1
  const y = (value: number): number => 76 - ((value - min) / span) * 72
  const line = points.map((value, index) => `${index === 0 ? 'M' : 'L'}${((index / (points.length - 1)) * 300).toFixed(1)},${y(value).toFixed(1)}`).join(' ')
  return { line, zero: y(0), up: points[points.length - 1] >= 0 }
})
function contractLabel(id: number | null): string {
  const own = futuresMarket.contracts.find((entry) => entry.id === id)
  return own?.displayName ?? (id === null ? '--' : `#${id}`)
}
const loading = ref(true)
const error = ref('')
const positionsError = ref('')
const missing = ref(false)
const controller = new AbortController()

const futuresMarket = useFuturesMarketStore()
const sizes = useSizeFormat()
/** Position size in the futures size unit (USDT at the entry price); contract face value from futures public_info. */
function positionSize(row: TraderPosition): string {
  const key = (row.contractName || row.symbol || '').toUpperCase()
  const contract = futuresMarket.contracts.find((entry) => entry.contractName.toUpperCase() === key || entry.symbol.toUpperCase() === key || entry.displayName === key.replace(/^E-/, '').replace(/-/g, ''))
  return sizes.sizeWithUnit(String(row.positionVolume ?? ''), contract, String(row.openAvgPrice ?? ''))
}

const name = computed(() => trader.value?.nickname.trim() || t('copy.anonymous', { uid: props.uid }))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  positionsError.value = ''
  const [detail, open, closed, copiers, rate] = await Promise.allSettled([
    fetchTrader(props.uid, controller.signal),
    fetchTraderPositions(props.uid, controller.signal),
    fetchTraderHistory(props.uid, controller.signal),
    fetchFollowers(props.uid, controller.signal),
    fetchBonusRate(controller.signal),
  ])
  if (closed.status === 'fulfilled') history.value = closed.value
  followers.value = copiers.status === 'fulfilled' ? copiers.value : null
  bonusRate.value = rate.status === 'fulfilled' ? rate.value : null
  if (controller.signal.aborted) return
  if (detail.status === 'fulfilled') {
    trader.value = detail.value
    missing.value = detail.value === null
  } else error.value = errorMessage(detail.reason)
  if (open.status === 'fulfilled') positions.value = open.value
  else positionsError.value = errorMessage(open.reason)
  loading.value = false
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => {
  if (!futuresMarket.loaded) void futuresMarket.loadPublicInfo().catch(() => undefined)
  document.addEventListener('keydown', onKey)
  void load()
})
onBeforeUnmount(() => {
  controller.abort()
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <aside class="drawer" role="dialog" aria-modal="true" :aria-label="t('copy.detailTitle')">
      <header class="drawer-head">
        <h2>{{ t('copy.detailTitle') }}</h2>
        <button class="icon-button" type="button" :aria-label="t('copy.cancel')" @click="emit('close')"><X :size="18" /></button>
      </header>
      <div class="drawer-body">
        <StateBlock v-if="loading" variant="loading" :message="t('copy.loading')" />
        <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="load" />
        <StateBlock v-else-if="missing || trader === null" variant="empty" :message="t('copy.notTrader')" />
        <template v-else>
          <div class="profile">
            <span class="avatar">{{ name.slice(0, 1).toUpperCase() }}</span>
            <div class="profile-copy"><strong class="ellipsis">{{ name }}</strong><span>{{ t('copy.days', { n: trader.entryDay }) }}</span></div>
            <button v-if="trader.follow !== 0" class="btn btn-primary" type="button" @click="emit('follow', trader)">{{ trader.follow === 1 ? t('copy.edit') : t('copy.follow') }}</button>
          </div>
          <dl class="stats">
            <div><dt :title="t('copy.roiDef')">{{ t('copy.roi2w') }}</dt><dd class="num" :class="signedPercent(trader.profitRatio).tone">{{ signedPercent(trader.profitRatio).text }}</dd></div>
            <div><dt>{{ t('copy.pnl2w') }}</dt><dd class="num" :class="signedAmount(trader.profitUSDT).tone">{{ signedAmount(trader.profitUSDT).text }}</dd></div>
            <div><dt :title="t('copy.winRateDef')">{{ t('copy.winRate') }}</dt><dd class="num">{{ plainPercent(trader.winRatio) }}</dd></div>
            <div><dt :title="t('copy.roiDef')">{{ t('copy.totalRoi') }}</dt><dd class="num" :class="signedPercent(trader.totalRatio).tone">{{ signedPercent(trader.totalRatio).text }}</dd></div>
            <div><dt>{{ t('copy.totalPnl') }}</dt><dd class="num">{{ amountText(trader.totalUSDT) }}</dd></div>
            <div><dt>{{ t('copy.orders') }}</dt><dd class="num">{{ trader.orderCount }}</dd></div>
            <div><dt>{{ t('copy.followers') }}</dt><dd class="num">{{ trader.followerCount }}</dd></div>
            <div><dt>{{ t('copy.currentFollowers') }}</dt><dd class="num">{{ trader.currentFollowCount }}</dd></div>
          </dl>
          <p class="muted small roi-def" data-testid="copy-roi-def">{{ t('copy.roiDef') }}</p>
          <dl class="stats extra">
            <div :title="t('copy.p.aumHint')"><dt>{{ t('copy.p.aum') }}</dt><dd class="num" data-testid="copy-aum">{{ aum === '' ? '--' : `${amountText(aum)} USDT` }}</dd></div>
            <div><dt>{{ t('copy.p.followers') }}</dt><dd class="num">{{ followers === null ? '--' : followers.length }}</dd></div>
          </dl>
          <p v-if="bonusRate !== null" class="share">{{ t('copy.p.shareRule', { rate: bonusRate }) }}</p>
          <h3 class="sub-title">{{ t('copy.p.bio') }}</h3>
          <p class="bio" :class="{ muted: !trader.description }" data-testid="copy-bio">{{ trader.description || t('copy.p.noBio') }}</p>
          <h3 class="sub-title" :title="t('copy.p.curveHint')">{{ t('copy.p.curve') }}</h3>
          <div v-if="curvePath.line !== ''" class="curve" data-testid="copy-curve">
            <svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" :aria-label="t('copy.p.curve')">
              <line x1="0" x2="300" :y1="curvePath.zero" :y2="curvePath.zero" class="zero" />
              <path :d="curvePath.line" :class="curvePath.up ? 'up-line' : 'down-line'" />
            </svg>
            <span class="num" :class="Number(curve[curve.length - 1].total) >= 0 ? 'up' : 'down'">{{ signedAmount(curve[curve.length - 1].total).text }} USDT</span>
          </div>
          <p v-else class="empty">{{ t('copy.p.noHistory') }}</p>
          <p class="hint muted">{{ t('copy.p.curveHint') }}</p>

          <div class="dtabs" role="tablist">
            <button class="dtab" :class="{ active: tab === 'current' }" type="button" role="tab" :aria-selected="tab === 'current'" @click="tab = 'current'">{{ t('copy.p.current') }} ({{ positions.length }})</button>
            <button class="dtab" :class="{ active: tab === 'history' }" type="button" role="tab" :aria-selected="tab === 'history'" data-testid="copy-tab-history" @click="tab = 'history'">{{ t('copy.p.history') }} ({{ history.length }})</button>
          </div>
          <template v-if="tab === 'history'">
            <p v-if="history.length === 0" class="empty">{{ t('copy.p.noHistory') }}</p>
            <div v-else class="table-wrap">
              <table class="table">
                <thead><tr><th>{{ t('copy.contract') }}</th><th>{{ t('copy.p.entry') }}</th><th>{{ t('copy.p.exit') }}</th><th>{{ t('copy.p.size') }}</th><th>{{ t('copy.p.realized') }}</th><th>{{ t('copy.p.closedAt') }}</th></tr></thead>
                <tbody>
                  <tr v-for="row in history" :key="row.id">
                    <td>{{ contractLabel(row.contractId) }} <small :class="row.side === 'BUY' ? 'up' : 'down'">{{ row.side === 'BUY' ? t('copy.p.long') : t('copy.p.short') }}</small> <small class="muted">{{ row.leverageLevel ?? '--' }}x</small></td>
                    <td class="num">{{ amountText(row.openPrice) }}</td>
                    <td class="num">{{ amountText(row.closePrice) }}</td>
                    <td class="num">{{ amountText(row.volume, 0) }}</td>
                    <td class="num" :class="signedAmount(row.historyRealizedAmount).tone">{{ signedAmount(row.historyRealizedAmount).text }}</td>
                    <td class="num muted">{{ formatDateTime(row.mtime, false) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <template v-else>
          <p v-if="positionsError !== ''" class="notice">{{ t('copy.positionsError', { msg: positionsError }) }}</p>
          <p v-else-if="positions.length === 0" class="empty">{{ t('copy.noPositions') }}</p>
          <div v-else class="table-wrap">
            <table class="table">
              <thead><tr><th>{{ t('copy.contract') }}</th><th>{{ t('copy.side') }}</th><th>{{ t('copy.size') }}</th><th>{{ t('copy.entry') }}</th><th>{{ t('copy.upnl') }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, index) in positions" :key="index">
                  <td>{{ row.contractName || row.symbol || '--' }} <small v-if="row.leverageLevel" class="muted">{{ row.leverageLevel }}x</small></td>
                  <td :class="row.orderSide === 'BUY' ? 'up' : row.orderSide === 'SELL' ? 'down' : ''">{{ row.orderSide || '--' }}</td>
                  <td class="num">{{ positionSize(row) }}</td>
                  <td class="num">{{ amountText(row.openAvgPrice, null) }}</td>
                  <td class="num" :class="signedAmount(row.unRealizedAmount).tone">{{ signedAmount(row.unRealizedAmount).text }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          </template>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: flex-end; background: rgba(3, 4, 6, .55); backdrop-filter: blur(2px); }
.drawer { display: flex; flex-direction: column; width: 520px; max-width: 100%; height: 100%; border-left: 1px solid var(--color-border-strong); background: var(--color-elevated); box-shadow: var(--shadow-pop); animation: slide .28s var(--ease-out); }
@keyframes slide { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: calc(14px + env(safe-area-inset-top, 0px)) 16px 12px 22px; border-bottom: 1px solid var(--color-border); }
.drawer-head h2 { margin: 0; font-size: 16px; }
.drawer-body { flex: 1; overflow-y: auto; padding: 20px 22px 28px; }
.profile { display: flex; align-items: center; gap: 12px; }
.avatar { display: inline-flex; flex: 0 0 52px; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: 16px; background: linear-gradient(135deg, var(--color-accent), var(--color-accent-strong)); color: var(--color-on-accent); font-family: var(--font-display); font-size: 22px; font-weight: 800; }
.profile-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.profile-copy strong { font-size: 17px; }
.profile-copy span { color: var(--color-text-muted); font-size: 12px; }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; margin: 20px 0 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-border); }
.stats div { padding: 12px 14px; background: var(--color-surface); }
.stats dt { color: var(--color-text-muted); font-size: 11.5px; }
.stats dd { margin: 3px 0 0; font-size: 16px; font-weight: 650; }
.sub-title { margin: 24px 0 10px; font-size: 14px; }
.empty { margin: 0; padding: 20px; border: 1px dashed var(--color-border-strong); border-radius: 12px; color: var(--color-text-muted); font-size: 13px; text-align: center; }
.table-wrap { overflow-x: auto; border: 1px solid var(--color-border); border-radius: 12px; }
.table { min-width: 520px; }
.table th:first-child, .table td:first-child { width: 34%; }
.table { table-layout: auto; }
.table th, .table td { overflow: visible; text-overflow: clip; }
.stats.extra { margin-top: 10px; }
.share { margin: 12px 0 0; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary); }
.roi-def { margin: 8px 0 0; font-size: 11.5px; line-height: 1.6; }
.bio { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.curve { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 12px; }
.curve svg { flex: 1; height: 80px; }
.curve path { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.curve .up-line { stroke: var(--color-up); }
.curve .down-line { stroke: var(--color-down); }
.curve .zero { stroke: var(--color-border-strong); stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
.curve span { font-size: 14px; font-weight: 700; white-space: nowrap; }
.hint { margin: 6px 0 0; font-size: 11px; line-height: 1.5; }
.dtabs { display: flex; gap: 18px; margin: 22px 0 10px; border-bottom: 1px solid var(--color-border); }
.dtab { position: relative; height: 38px; padding: 0; color: var(--color-text-muted); font-size: 14px; font-weight: 650; }
.dtab.active { color: var(--color-text); }
.dtab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
</style>
