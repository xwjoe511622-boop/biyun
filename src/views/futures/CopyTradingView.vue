<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Copy, Trophy, TriangleAlert, Users } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import PageHead from '@/components/content/PageHead.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import TraderCard from '@/components/copytrading/TraderCard.vue'
import FollowDialog from '@/components/copytrading/FollowDialog.vue'
import TraderDrawer from '@/components/copytrading/TraderDrawer.vue'
import TraderApplyPanel from '@/components/copytrading/TraderApplyPanel.vue'
import TraderSelfPanel from '@/components/copytrading/TraderSelfPanel.vue'
import {
  fetchCopiedPositions,
  fetchMyStatistics,
  fetchMyTraders,
  fetchTraders,
  TRADER_SORTS,
  unfollowTrader,
  type ApplyStatus,
  type CopiedPosition,
  type FollowRecord,
  type FollowStats,
  type Trader,
  type TraderSort,
} from '@/modules/copytrading/copytrading.api'
import { amountText, isUnset, plainPercent, signedAmount } from '@/modules/copytrading/format'
import { errorMessage, isUnauthorized } from '@/modules/content/api-helpers'
import { useCopyI18n } from '@/modules/copytrading/i18n'
import { useSessionStore } from '@/stores/session'

/**
 * Copy trading — contracts in `modules/copytrading/copytrading.api.ts` (`TraderUserAct` + futures
 * `TraderController`). The ranking endpoint returns a bare page without a total, so paging is
 * previous/next (next is enabled while a full page comes back).
 */
const PAGE_SIZE = 12
const { t } = useCopyI18n()
const sessionStore = useSessionStore()
const authenticated = computed(() => sessionStore.isAuthenticated)

const tab = ref<'traders' | 'mine'>('traders')
const sort = ref<TraderSort>('all')
const page = ref(1)
const traders = ref<Trader[]>([])
const tradersLoading = ref(false)
const tradersError = ref('')
const mine = ref<FollowRecord[]>([])
/** Positions opened by copy trading (futures assets rows tagged with `traderName`). */
const copied = ref<CopiedPosition[]>([])
/** Approved lead trader: show 我的带单. */
const selfUid = ref('')
function onApplyState(status: ApplyStatus, uid: string): void {
  selfUid.value = status === 1 ? uid : ''
}
const stats = ref<FollowStats | null>(null)
const mineLoading = ref(false)
const mineError = ref('')
const statsError = ref('')
const drawerUid = ref<string | null>(null)
const dialog = ref<{ uid: string; name: string; existing: FollowRecord | null } | null>(null)
const confirmUid = ref<string | null>(null)
const actionBusy = ref(false)
const actionError = ref('')
const toast = ref('')
let tradersController: AbortController | null = null
let mineController: AbortController | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

async function loadTraders(): Promise<void> {
  if (!authenticated.value) return
  tradersController?.abort()
  const current = new AbortController()
  tradersController = current
  tradersLoading.value = true
  tradersError.value = ''
  try {
    const rows = await fetchTraders(page.value, PAGE_SIZE, sort.value, current.signal)
    if (tradersController !== current) return
    traders.value = rows
  } catch (failure) {
    if (tradersController !== current || isUnauthorized(failure)) return
    traders.value = []
    tradersError.value = errorMessage(failure)
  } finally {
    if (tradersController === current) tradersLoading.value = false
  }
}

async function loadMine(): Promise<void> {
  if (!authenticated.value) return
  mineController?.abort()
  const current = new AbortController()
  mineController = current
  mineLoading.value = true
  mineError.value = ''
  statsError.value = ''
  const [list, summary, positions] = await Promise.allSettled([fetchMyTraders(current.signal), fetchMyStatistics(current.signal), fetchCopiedPositions(current.signal)])
  if (positions.status === 'fulfilled' && mineController === current) copied.value = positions.value
  if (mineController !== current) return
  if (list.status === 'fulfilled') mine.value = list.value
  else if (!isUnauthorized(list.reason)) mineError.value = errorMessage(list.reason)
  if (summary.status === 'fulfilled') stats.value = summary.value
  else if (!isUnauthorized(summary.reason)) statsError.value = errorMessage(summary.reason)
  mineLoading.value = false
}

function setSort(value: TraderSort): void {
  if (sort.value === value) return
  sort.value = value
  page.value = 1
  void loadTraders()
}

function go(delta: number): void {
  page.value = Math.max(1, page.value + delta)
  void loadTraders()
}

function nameOf(uid: string, nickname: string): string {
  return nickname.trim() || t('copy.anonymous', { uid })
}

function openFollow(trader: Trader): void {
  drawerUid.value = null
  const existing = mine.value.find((row) => row.uid === trader.uid && row.status === 1) ?? null
  dialog.value = { uid: trader.uid, name: nameOf(trader.uid, trader.nickname), existing }
}

function editFollow(row: FollowRecord): void {
  dialog.value = { uid: row.uid, name: nameOf(row.uid, row.nickname), existing: row }
}

function flash(message: string): void {
  toast.value = message
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2600)
}

async function onSaved(): Promise<void> {
  dialog.value = null
  flash(t('copy.saved'))
  await Promise.all([loadTraders(), loadMine()])
}

async function unfollow(uid: string): Promise<void> {
  actionBusy.value = true
  actionError.value = ''
  try {
    await unfollowTrader(uid)
    confirmUid.value = null
    await Promise.all([loadMine(), loadTraders()])
  } catch (failure) {
    // Also a rejected session: say so (10-01 audit: follow/unfollow failed silently on 401).
    actionError.value = errorMessage(failure)
  } finally {
    actionBusy.value = false
  }
}

watch(authenticated, (value) => {
  traders.value = []
  mine.value = []
  stats.value = null
  dialog.value = null
  drawerUid.value = null
  if (value) {
    void loadTraders()
    void loadMine()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  tradersController?.abort()
  mineController?.abort()
  if (toastTimer !== null) clearTimeout(toastTimer)
})
</script>

<template>
  <div class="page copy-page">
    <PageHead :icon="Copy" :eyebrow="t('copy.eyebrow')" :title="t('copy.title')" :lead="t('copy.lead')" />

    <GuestGate v-if="!authenticated" :message="t('copy.loginRequired')" :icon="Users" />

    <template v-else>
      <p class="risk"><TriangleAlert :size="15" aria-hidden="true" />{{ t('copy.risk') }}</p>

      <TraderApplyPanel @profile="(uid) => (drawerUid = uid)" @submitted="flash(t('copy.apply.submitted'))" @state="onApplyState" />
      <TraderSelfPanel v-if="selfUid !== ''" :uid="selfUid" @saved="flash" />

      <div class="tabs-bar" role="tablist">
        <button class="ctab" :class="{ active: tab === 'traders' }" type="button" role="tab" :aria-selected="tab === 'traders'" @click="tab = 'traders'"><Trophy :size="15" aria-hidden="true" />{{ t('copy.tabTraders') }}</button>
        <button class="ctab" :class="{ active: tab === 'mine' }" type="button" role="tab" :aria-selected="tab === 'mine'" @click="tab = 'mine'"><Users :size="15" aria-hidden="true" />{{ t('copy.tabMine') }}<span v-if="mine.filter((r) => r.status === 1).length > 0" class="count num">{{ mine.filter((r) => r.status === 1).length }}</span></button>
      </div>

      <section v-if="tab === 'traders'">
        <div class="sorts" role="radiogroup">
          <button v-for="key in TRADER_SORTS" :key="key" class="chip sort" :class="{ active: sort === key }" type="button" role="radio" :aria-checked="sort === key" @click="setSort(key)">{{ t(`copy.sort.${key}`) }}</button>
        </div>
        <ErrorBanner v-if="tradersError !== ''" :message="tradersError" retryable @retry="loadTraders" />
        <div v-else-if="tradersLoading && traders.length === 0" class="grid"><div v-for="n in 6" :key="n" class="card-sk"></div></div>
        <div v-else-if="traders.length > 0" class="grid" :class="{ dim: tradersLoading }">
          <TraderCard v-for="(trader, index) in traders" :key="trader.uid" :trader="trader" :rank="(page - 1) * PAGE_SIZE + index + 1" @follow="openFollow(trader)" @details="drawerUid = trader.uid" />
        </div>
        <div v-else class="panel"><EmptyState :icon="Trophy" :title="t('copy.emptyTraders')" :message="page > 1 ? '' : t('copy.emptyTradersMsg')" /></div>
        <nav v-if="page > 1 || traders.length === PAGE_SIZE" class="pager">
          <button class="btn" type="button" :disabled="page <= 1 || tradersLoading" @click="go(-1)"><ChevronLeft :size="15" />{{ t('copy.prev') }}</button>
          <span class="num muted">{{ t('copy.pageN', { n: page }) }}</span>
          <button class="btn" type="button" :disabled="traders.length < PAGE_SIZE || tradersLoading" @click="go(1)">{{ t('copy.next') }}<ChevronRight :size="15" /></button>
        </nav>
      </section>

      <section v-else>
        <div class="summary">
          <div class="panel sum"><span>{{ t('copy.myTotal') }}</span><strong class="num">{{ stats ? amountText(stats.followTotalAmount) : '--' }}</strong></div>
          <div class="panel sum"><span>{{ t('copy.myProfit') }}</span><strong class="num" :class="stats ? signedAmount(stats.profit).tone : ''">{{ stats ? signedAmount(stats.profit).text : '--' }}</strong></div>
          <div class="panel sum"><span>{{ t('copy.myRate') }}</span><strong class="num">{{ stats && mine.length > 0 ? t('copy.myRankValue', { v: plainPercent(stats.rate) }) : '--' }}</strong></div>
        </div>
        <p v-if="statsError !== ''" class="notice notice-error">{{ statsError }}</p>
        <p v-if="actionError !== ''" class="notice notice-error" role="alert">{{ actionError }}</p>
        <ErrorBanner v-if="mineError !== ''" :message="mineError" retryable @retry="loadMine" />
        <div v-else class="panel mine">
          <div v-if="mineLoading && mine.length === 0" class="rows-sk"><span v-for="n in 3" :key="n"></span></div>
          <EmptyState v-else-if="mine.length === 0" :icon="Users" :title="t('copy.emptyMine')" :message="t('copy.emptyMineMsg')">
            <button class="btn btn-primary" type="button" @click="tab = 'traders'">{{ t('copy.tabTraders') }}</button>
          </EmptyState>
          <div v-else class="table-wrap">
            <table class="table mine-table">
              <thead>
                <tr><th>{{ t('copy.trader') }}</th><th>{{ t('copy.settings') }}</th><th>{{ t('copy.margin') }}</th><th>{{ t('copy.tpsl') }}</th><th>{{ t('copy.inUse') }}</th><th>{{ t('copy.pnl') }}</th><th>{{ t('copy.status') }}</th><th>{{ t('copy.actions') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in mine" :key="row.uid">
                  <td><button class="link" type="button" @click="drawerUid = row.uid">{{ nameOf(row.uid, row.nickname) }}</button></td>
                  <td class="num">{{ row.type === 1 ? `${t('copy.modeAmount')} ${amountText(row.amount)}` : `${t('copy.modeRatio')} ×${amountText(row.rate, null)}` }}</td>
                  <td class="num">{{ amountText(row.deposit) }}</td>
                  <td class="num">{{ isUnset(row.profitRatio) ? t('copy.notSet') : `${amountText(row.profitRatio, null)}%` }} / {{ isUnset(row.lossRatio) ? t('copy.notSet') : `${amountText(row.lossRatio, null)}%` }}</td>
                  <td class="num">{{ amountText(row.followAmount) }}</td>
                  <td class="num" :class="signedAmount(row.profitUSDT).tone">{{ signedAmount(row.profitUSDT).text }}</td>
                  <td><span class="state" :class="row.status === 1 ? 'on' : 'off'">{{ row.status === 1 ? t('copy.active') : t('copy.closed') }}</span></td>
                  <td><div class="actions-cell">
                    <template v-if="row.status === 1">
                      <span v-if="confirmUid === row.uid" class="confirm" :title="t('copy.p.unfollowNote')">
                        <span class="muted note">{{ t('copy.p.unfollowNote') }}</span>
                        <button class="btn small btn-sell" type="button" :disabled="actionBusy" @click="unfollow(row.uid)">{{ t('copy.confirm') }}</button>
                        <button class="btn small" type="button" :disabled="actionBusy" @click="confirmUid = null">{{ t('copy.cancel') }}</button>
                      </span>
                      <template v-else>
                        <button class="btn small" type="button" @click="editFollow(row)">{{ t('copy.edit') }}</button>
                        <button class="btn small ghost-danger" type="button" :title="t('copy.unfollowConfirm', { name: nameOf(row.uid, row.nickname) })" @click="confirmUid = row.uid">{{ t('copy.unfollow') }}</button>
                      </template>
                    </template>
                    <span v-else class="muted">--</span>
                  </div></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="panel copied" data-testid="copy-my-positions">
          <header class="copied-head"><strong>{{ t('copy.p.myPositions') }}</strong><RouterLink class="btn small" to="/futures">{{ t('copy.p.goClose') }}</RouterLink></header>
          <p class="muted hint">{{ t('copy.p.myPositionsHint') }}</p>
          <p v-if="copied.length === 0" class="muted empty-line">{{ t('copy.p.noMyPositions') }}</p>
          <div v-else class="table-wrap">
            <table class="table copied-table">
              <thead><tr><th>{{ t('copy.p.contract') }}</th><th>{{ t('copy.p.trader') }}</th><th>{{ t('copy.p.size') }}</th><th>{{ t('copy.p.entry') }}</th><th>{{ t('copy.p.leverage') }}</th><th>{{ t('copy.p.margin') }}</th><th>{{ t('copy.p.pnl') }}</th></tr></thead>
              <tbody>
                <tr v-for="row in copied" :key="row.id">
                  <td>{{ row.contractName.replace(/^E-/, '').replace(/-/g, '') }} <small :class="row.orderSide === 'BUY' ? 'up' : 'down'">{{ row.orderSide === 'BUY' ? t('copy.p.long') : t('copy.p.short') }}</small></td>
                  <td>{{ row.traderName }}</td>
                  <td class="num">{{ amountText(row.positionVolume, 0) }}</td>
                  <td class="num">{{ amountText(row.openAvgPrice) }}</td>
                  <td class="num">{{ row.leverageLevel ?? '--' }}x</td>
                  <td class="num">{{ amountText(row.holdAmount) }}</td>
                  <td class="num" :class="signedAmount(row.openRealizedAmount).tone">{{ signedAmount(row.openRealizedAmount).text }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </template>

    <TraderDrawer v-if="drawerUid !== null" :uid="drawerUid" @close="drawerUid = null" @follow="openFollow" />
    <FollowDialog v-if="dialog !== null" :trader-uid="dialog.uid" :name="dialog.name" :existing="dialog.existing" @close="dialog = null" @saved="onSaved" />
    <p v-if="toast !== ''" class="toast" role="status">{{ toast }}</p>
  </div>
</template>

<style scoped>
.risk { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 18px; padding: 12px 14px; border: 1px solid transparent; border-radius: var(--radius); background: var(--color-warning-soft); color: var(--color-warning); font-size: 12.5px; line-height: 1.6; }
.risk svg { flex: 0 0 auto; margin-top: 2px; }
.tabs-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--color-border); overflow-x: auto; }
.ctab { position: relative; display: inline-flex; align-items: center; gap: 7px; height: 44px; padding: 0 14px; color: var(--color-text-muted); font-size: 14px; font-weight: 650; white-space: nowrap; }
.ctab.active { color: var(--color-text); }
.ctab.active::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--color-accent); color: var(--color-on-accent); font-size: 11px; }
.sorts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.sort { height: 30px; padding: 0 12px; cursor: pointer; font-size: 12px; }
.sort.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; transition: opacity .15s; }
.grid.dim { opacity: .55; }
.card-sk { height: 360px; border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); }
.pager { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 20px; }
.summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.sum { display: flex; flex-direction: column; gap: 4px; padding: 18px 20px; }
.sum span { color: var(--color-text-muted); font-size: 12.5px; }
.sum strong { font-size: 24px; }
.notice { margin: 0 0 14px; }
.mine { overflow: hidden; }
.table-wrap { overflow-x: auto; }
.mine-table { min-width: 980px; }
.mine-table th, .mine-table td { padding-left: 16px; padding-right: 16px; }
.mine-table td { height: 56px; }
.link { color: var(--color-accent-text); font-weight: 650; }
.state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.state.on { color: var(--color-up); }
.state.off { color: var(--color-text-muted); }
.actions-cell { min-width: 0; max-width: 100%; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; white-space: normal; }
.actions-cell .btn.small { min-width: 0; max-width: 100%; height: auto; min-height: 30px; padding-top: 5px; padding-bottom: 5px; white-space: normal; overflow-wrap: anywhere; }
.btn.small { height: 30px; padding: 0 10px; font-size: 12px; }
.ghost-danger { color: var(--color-down); }
.confirm { display: inline-flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.note { max-width: 220px; font-size: 11.5px; line-height: 1.4; white-space: normal; text-align: right; }
.copied { margin-top: 16px; padding: 14px 16px; }
.copied-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.copied-head .btn { display: inline-flex; align-items: center; }
.hint { margin: 4px 0 10px; font-size: 12px; }
.empty-line { margin: 6px 0 2px; font-size: 13px; }
.copied-table { min-width: 680px; table-layout: auto; }
.copied-table th, .copied-table td { overflow: visible; text-overflow: clip; }
.rows-sk { padding: 10px 18px; }
.rows-sk span { display: block; height: 20px; margin: 18px 0; border-radius: 6px; background: var(--color-surface-alt); }
.toast { position: fixed; left: 50%; bottom: calc(28px + env(safe-area-inset-bottom, 0px)); z-index: 90; margin: 0; padding: 10px 18px; border-radius: 22px; background: var(--color-up); color: #fff; font-size: 13px; font-weight: 650; transform: translateX(-50%); box-shadow: var(--shadow-pop); animation: rise-in .25s var(--ease-out); }
@media (max-width: 720px) {
  .risk { margin-bottom: 12px; padding: 8px 10px; font-size: 11.5px; line-height: 1.5; }
  .summary { grid-template-columns: minmax(0, 1fr); }
  .sum strong { font-size: 20px; }
}
</style>
