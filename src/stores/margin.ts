import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { isApiError } from '@/core/errors'
import { describeApiError } from '@/modules/api/error-codes'
import { requestLanguage } from '@/modules/api/http'
import { session } from '@/core/session'
import { createBalanceOverlay, type Commit, type OverlayHandle } from '@/core/swr'
import * as marginApi from '@/modules/margin/api'
import { DraftRequestId } from '@/modules/api/draft-request-id'
import { borrowTotal } from '@/modules/margin/normalize'
import { buildMarginMarkets, isLeverSwitchOpen, type MarginMarket } from '@/modules/margin/symbols'
import type { BorrowRecord, MarginAccountsOverview, MarginSymbolAccount, MarginTransferRecord } from '@/modules/margin/types'
import { useMarketStore } from './market'

export const MARGIN_PAGE_SIZE = 10

export type BorrowListKind = 'open' | 'history'

function describe(error_: unknown): string {
  // Localised by (product, code) with sub-reasons; server msg / transport text as the fallback (2026-10-01).
  return describeApiError(error_, requestLanguage())
}

/**
 * Margin account state for the selected pair (the margin page shares the spot market store's pair),
 * the all-pairs overview for the assets page, and loan / transfer records.
 * Every response is guarded against session and pair changes; nothing is synthesised on failure.
 */
export const useMarginStore = defineStore('margin', () => {
  /** Client idempotency ids of the money writes (one per submitted draft; see draft-request-id.ts). */
  const borrowIds = new DraftRequestId()
  const repayIds = new DraftRequestId()
  const market = useMarketStore()

  /** Last server snapshot; `account` below is this plus the optimistic order deltas (`reserve`). */
  const serverAccount = shallowRef<MarginSymbolAccount | null>(null)
  const overlay = createBalanceOverlay()
  const account = computed<MarginSymbolAccount | null>(() => {
    const snapshot = serverAccount.value
    if (snapshot === null || overlay.entries.value.length === 0) return snapshot
    return {
      ...snapshot,
      baseNormalBalance: overlay.adjust('base:normal', snapshot.baseNormalBalance),
      baseLockBalance: overlay.adjust('base:lock', snapshot.baseLockBalance),
      quoteNormalBalance: overlay.adjust('quote:normal', snapshot.quoteNormalBalance),
      quoteLockBalance: overlay.adjust('quote:lock', snapshot.quoteLockBalance),
    }
  })
  const accountLoading = ref(false)
  const accountError = ref<string | null>(null)

  const overview = shallowRef<MarginAccountsOverview | null>(null)
  const overviewLoading = ref(false)
  const overviewError = ref<string | null>(null)

  const borrows = shallowRef<Record<BorrowListKind, BorrowRecord[]>>({ open: [], history: [] })
  const borrowCounts = ref<Record<BorrowListKind, number>>({ open: 0, history: 0 })
  const borrowPages = ref<Record<BorrowListKind, number>>({ open: 1, history: 1 })
  const borrowLoading = ref<Record<BorrowListKind, boolean>>({ open: false, history: false })
  const borrowErrors = ref<Record<BorrowListKind, string | null>>({ open: null, history: null })

  const transfers = shallowRef<MarginTransferRecord[]>([])
  const transferCount = ref(0)
  const transferPage = ref(1)
  const transferLoading = ref(false)
  const transferError = ref<string | null>(null)

  const leverOpen = computed(() => isLeverSwitchOpen(market.publicInfo))
  const markets = computed<MarginMarket[]>(() => buildMarginMarkets(market.publicInfo, market.symbols))
  const currentMarket = computed<MarginMarket | undefined>(() => markets.value.find(entry => entry.symbol.pair === market.selectedPair))
  const currentSymbol = computed(() => currentMarket.value?.symbol.symbol ?? '')

  const versions = { account: 0, overview: 0, open: 0, history: 0, transfers: 0 }
  let sessionToken = session.getToken()
  onScopeDispose(session.onInvalidate((snapshot) => {
    if (snapshot.token !== sessionToken) reset()
    sessionToken = snapshot.token
  }))
  watch(() => market.selectedPair, () => {
    versions.account += 1
    versions.open += 1
    versions.history += 1
    versions.transfers += 1
    serverAccount.value = null
    overlay.clear()
    accountError.value = null
    accountLoading.value = false
    borrows.value = { open: [], history: [] }
    borrowCounts.value = { open: 0, history: 0 }
    borrowPages.value = { open: 1, history: 1 }
    borrowLoading.value = { open: false, history: false }
    borrowErrors.value = { open: null, history: null }
    transfers.value = []
    transferCount.value = 0
    transferPage.value = 1
    transferLoading.value = false
    transferError.value = null
  }, { flush: 'sync' })

  function guard(kind: keyof typeof versions, symbol: string | null): () => boolean {
    const version = ++versions[kind]
    const token = session.getToken()
    return () => version === versions[kind] && token === session.getToken() && (symbol === null || symbol === currentSymbol.value)
  }

  /** Fetch → commit (`@/core/swr`): a refresh keeps the last snapshot on screen; a failure keeps it too, with the error. */
  async function prepareAccount(): Promise<Commit> {
    const symbol = currentSymbol.value
    if (symbol === '' || !session.isAuthenticated()) {
      return () => {
        serverAccount.value = null
        overlay.clear()
      }
    }
    const current = guard('account', symbol)
    const stamp = overlay.stamp()
    accountLoading.value = true
    try {
      const next = await marginApi.fetchMarginSymbolAccount(symbol)
      if (!current()) return null
      return () => {
        if (!current()) return
        serverAccount.value = next
        overlay.reconcile(stamp)
        accountError.value = null
        accountLoading.value = false
      }
    } catch (error_) {
      if (!current()) return null
      const message = describe(error_)
      return () => {
        if (!current()) return
        accountError.value = message
        accountLoading.value = false
      }
    }
  }

  async function loadAccount(): Promise<void> {
    ;(await prepareAccount())?.()
  }

  /**
   * Optimistic order effect on the pair account: `amount` of the base or quote coin moves from normal to locked
   * (a negative amount releases it). Settle on success, roll back on refusal.
   */
  function reserve(side: 'base' | 'quote', amount: string): OverlayHandle {
    const release = amount.startsWith('-')
    const size = release ? amount.slice(1) : amount
    return overlay.apply({ [`${side}:normal`]: release ? size : `-${size}`, [`${side}:lock`]: release ? `-${size}` : size })
  }

  async function loadOverview(): Promise<void> {
    if (!session.isAuthenticated()) {
      overview.value = null
      return
    }
    const current = guard('overview', null)
    overviewLoading.value = true
    overviewError.value = null
    try {
      const next = await marginApi.fetchMarginAccounts()
      if (!current()) return
      overview.value = next
    } catch (error_) {
      if (!current()) return
      overviewError.value = describe(error_)
      overview.value = null
    } finally {
      if (current()) overviewLoading.value = false
    }
  }

  async function loadBorrows(kind: BorrowListKind): Promise<void> {
    const symbol = currentSymbol.value
    if (symbol === '' || !session.isAuthenticated()) return
    const current = guard(kind, symbol)
    borrowLoading.value = { ...borrowLoading.value, [kind]: true }
    borrowErrors.value = { ...borrowErrors.value, [kind]: null }
    try {
      const query = { symbol, page: borrowPages.value[kind], pageSize: MARGIN_PAGE_SIZE }
      const page = kind === 'open' ? await marginApi.fetchOpenBorrows(query) : await marginApi.fetchBorrowHistory(query)
      if (!current()) return
      borrows.value = { ...borrows.value, [kind]: page.list }
      borrowCounts.value = { ...borrowCounts.value, [kind]: borrowTotal(page, query.page, MARGIN_PAGE_SIZE) }
    } catch (error_) {
      if (!current()) return
      borrowErrors.value = { ...borrowErrors.value, [kind]: describe(error_) }
    } finally {
      if (current()) borrowLoading.value = { ...borrowLoading.value, [kind]: false }
    }
  }

  async function loadTransfers(): Promise<void> {
    const symbol = currentSymbol.value
    if (symbol === '' || !session.isAuthenticated()) return
    const current = guard('transfers', symbol)
    transferLoading.value = true
    transferError.value = null
    try {
      const page = await marginApi.fetchMarginTransfers({ symbol, page: transferPage.value, pageSize: MARGIN_PAGE_SIZE })
      if (!current()) return
      transfers.value = page.list
      transferCount.value = page.count
    } catch (error_) {
      if (!current()) return
      transferError.value = describe(error_)
    } finally {
      if (current()) transferLoading.value = false
    }
  }

  function setBorrowPage(kind: BorrowListKind, page: number): void {
    borrowPages.value = { ...borrowPages.value, [kind]: Math.max(1, page) }
  }

  function setTransferPage(page: number): void {
    transferPage.value = Math.max(1, page)
  }

  /** Returns `null` on success, otherwise the server/transport message (never a fake success). */
  async function borrow(coin: string, amount: string): Promise<string | null> {
    const symbol = currentSymbol.value
    if (symbol === '' || !session.isAuthenticated()) return 'error.symbolMissing'
    // same draft re-submitted after a lost answer → same requestId → borrowed once (user-api 2026-10-16)
    try {
      const requestId = borrowIds.forDraft(JSON.stringify([symbol, coin, amount]))
      await marginApi.borrow({ symbol, coin, amount, requestId })
      borrowIds.finish()
      return null
    } catch (error_) {
      borrowIds.finish(error_)
      return describe(error_)
    }
  }

  async function repay(id: string, amount: string): Promise<string | null> {
    if (!session.isAuthenticated()) return 'common.notLoggedIn'
    try {
      const requestId = repayIds.forDraft(JSON.stringify([id, amount]))
      await marginApi.repay({ id, amount, requestId })
      repayIds.finish()
      return null
    } catch (error_) {
      repayIds.finish(error_)
      return describe(error_)
    }
  }

  function reset(): void {
    Object.keys(versions).forEach((key) => {
      versions[key as keyof typeof versions] += 1
    })
    serverAccount.value = null
    overlay.clear()
    accountLoading.value = false
    accountError.value = null
    overview.value = null
    overviewLoading.value = false
    overviewError.value = null
    borrows.value = { open: [], history: [] }
    borrowCounts.value = { open: 0, history: 0 }
    borrowPages.value = { open: 1, history: 1 }
    borrowLoading.value = { open: false, history: false }
    borrowErrors.value = { open: null, history: null }
    transfers.value = []
    transferCount.value = 0
    transferPage.value = 1
    transferLoading.value = false
    transferError.value = null
  }

  return {
    account,
    accountLoading,
    accountError,
    overview,
    overviewLoading,
    overviewError,
    borrows,
    borrowCounts,
    borrowPages,
    borrowLoading,
    borrowErrors,
    transfers,
    transferCount,
    transferPage,
    transferLoading,
    transferError,
    leverOpen,
    markets,
    currentMarket,
    currentSymbol,
    pageSize: MARGIN_PAGE_SIZE,
    loadAccount,
    prepareAccount,
    reserve,
    loadOverview,
    loadBorrows,
    loadTransfers,
    setBorrowPage,
    setTransferPage,
    borrow,
    repay,
    reset,
  }
})
