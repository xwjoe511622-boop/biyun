import { i18n } from '@/i18n/composer'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { request } from '@/modules/api/http'
import { fetchFapiAccount } from '@/modules/futures/fapi'
import { fetchAssets } from '@/modules/futures/api'
import { isNotOpenedError } from '@/modules/futures/open-account'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { futuresEquityHoldings, marginEquityHoldings, portfolioBreakdownUsd, type EquityHolding, type FuturesEquityHolding } from './overview-equity'
import type { ValuationRow } from './valuation'

export const PORTFOLIO_MESSAGES = {
  'zh-CN': {
    portfolioTotal: '折合总资产（含合约浮盈）',
    portfolioScope: '现货 + 合约权益 + 杠杆净资产（已扣借款与利息），按行情估值。',
    portfolioLoading: '正在读取各账户估值…',
    portfolioRefreshing: '正在刷新，当前显示上次完整账户快照的估值。',
    portfolioFailed: '部分账户估值读取失败，总估值暂不可用，请刷新重试。',
  },
  'en-US': {
    portfolioTotal: 'Estimated total (including futures unrealized PnL)',
    portfolioScope: 'Spot + futures equity + margin net assets, less loans and interest, at market prices.',
    portfolioLoading: 'Loading account valuations…',
    portfolioRefreshing: 'Refreshing. Showing the previous complete account snapshot.',
    portfolioFailed: 'Some account values are unavailable. Refresh to retry the total valuation.',
  },
} as const

/** One complete read per reload, shared by home skins and assets; never price a missing account as zero. */
export function usePortfolioOverview() {
  const account = useAccountStore()
  const market = useMarketStore()
  const session = useSessionStore()
  const snapshot = ref<{ spot: ValuationRow[]; futures: FuturesEquityHolding[]; margin: EquityHolding[]; readAtMs: number } | null>(null)
  const loading = ref(false)
  const failed = ref(false)
  // Keep this token/UID identity key in memory only. A refreshed profile under the same token must also
  // invalidate another user's read; never expose the key in logs or persistent storage.
  const identity = computed(() => JSON.stringify([session.token, session.user?.id ?? null]))
  const spotKnown = computed(() => account.allCoinMap !== undefined && account.allCoinMap !== null
    && typeof account.allCoinMap === 'object' && !Array.isArray(account.allCoinMap))
  const owner = ref<string | null>(null)
  const spotOwner = ref<string | null>(null)
  const spotReady = computed(() => session.isAuthenticated && spotOwner.value === identity.value && spotKnown.value)
  let generation = 0
  let active = true
  const values = computed(() => !session.isAuthenticated || owner.value !== identity.value || snapshot.value === null
    ? { total: '', balance: '', unrealized: '' } : portfolioBreakdownUsd(snapshot.value.spot, snapshot.value.futures, snapshot.value.margin, market.tickers))
  const total = computed(() => values.value.total)
  const balance = computed(() => values.value.balance)
  const unrealized = computed(() => values.value.unrealized)
  const readAtMs = computed(() => owner.value === identity.value ? snapshot.value?.readAtMs ?? null : null)
  const unavailable = computed(() => failed.value || (!loading.value && snapshot.value !== null && total.value === ''))

  async function futuresEquity(current: () => boolean): Promise<FuturesEquityHolding[]> {
    let data: unknown
    try {
      data = await fetchFapiAccount()
    } catch (error: unknown) {
      if (!current()) throw error
      // Only the server's explicit unopened-account response represents zero; transport/auth failures stay unknown.
      try { await fetchAssets() } catch (fallback: unknown) { if (isNotOpenedError(fallback)) return [] }
      throw error
    }
    // A successful but malformed financial response is unknown, never an unopened-account zero fallback.
    const holdings = futuresEquityHoldings(data)
    if (holdings === null) throw new Error(i18n.global.t('clientFailure.futuresAccountValuesAreIncompleteOrInconsistent'))
    return holdings
  }

  async function reload(): Promise<void> {
    const mine = ++generation
    const selected = identity.value
    const current = () => active && mine === generation && selected === identity.value
    failed.value = false
    if (!session.isAuthenticated) { snapshot.value = null; owner.value = null; spotOwner.value = null; loading.value = false; return }
    loading.value = true
    if (market.publicInfo === null) {
      try { await market.loadPublicInfo() } catch { /* Market errors stay unknown; the balance reads are independent. */ }
      if (!current()) return
    }
    const spotRead = account.refresh().then(() => {
      // load() can be superseded by another reader and resolve without a commit. Its still-loading snapshot
      // must not be mixed with newly refreshed futures/margin balances (QA-072).
      if (!current()) return null
      spotOwner.value = !account.loading && spotKnown.value && account.error === null ? selected : null
      // Capture this read immediately; another reader may replace the global store before the other legs finish.
      return spotOwner.value === selected ? { source: account.data, rows: account.coinRows.map(row => ({ ...row })) } : null
    })
    const [spot, futures, margin] = await Promise.allSettled([
      spotRead, futuresEquity(current), request<unknown>('lever/finance/balance', { body: {} }),
    ])
    if (!current()) return
    const holdings = margin.status === 'fulfilled' ? marginEquityHoldings(margin.value) : null
    if (spot.status === 'fulfilled' && spot.value !== null && futures.status === 'fulfilled' && holdings !== null && !account.loading && account.error === null && spotReady.value) {
      // An external read landed during this group. Discard it and request one complete trailing group.
      if (account.data !== spot.value.source) { await reload(); return }
      // Replace one complete account group. During refresh the previous group's
      // quantities stay together; a live/new spot read never mixes with old futures.
      snapshot.value = { spot: spot.value.rows, futures: futures.value, margin: holdings, readAtMs: Date.now() }
      owner.value = selected
    } else { snapshot.value = null; owner.value = null; failed.value = true }
    loading.value = false
  }

  watch(identity, () => { snapshot.value = null; owner.value = null; spotOwner.value = null; void reload() }, { immediate: true })
  // A separate trade/stream/wallet refresh invalidates the group, not just its
  // spot leg. Own reads happen while loading and do not trigger a refresh loop.
  watch(() => account.data, () => {
    if (!active || loading.value || !session.isAuthenticated || owner.value !== identity.value) return
    if (!spotKnown.value || account.error !== null) { snapshot.value = null; owner.value = null; failed.value = true; return }
    void reload()
  })
  onScopeDispose(() => { active = false; generation += 1; snapshot.value = null; owner.value = null; spotOwner.value = null })
  return { total, balance, unrealized, readAtMs, loading, unavailable, reload, spotReady }
}
