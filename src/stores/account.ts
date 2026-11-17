import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { createBalanceOverlay, type Commit, type OverlayHandle } from '@/core/swr'
import { fetchAccountBalance } from '@/modules/api/account.api'
import type { AccountBalanceData } from '@/modules/api/types'
import { availableBalance, findCoinBalance, lockedBalance, sellableBalance } from '@/modules/market/symbols'
import { useMarketStore } from './market'

/**
 * Trading-account balances for the trade page; the assets page reloads the same snapshot.
 * Stale-while-revalidate (`@/core/swr`): a refresh keeps the last snapshot on screen; `loading` is true while any
 * request is in flight, `data !== null` means there is something to show. Orders adjust the trade-page figures at once
 * through the balance overlay (`reserve`), reconciled by the next snapshot requested after the order settled.
 */
export const useAccountStore = defineStore('account', () => {
  const data = shallowRef<AccountBalanceData | null>(null)
  const overlay = createBalanceOverlay()
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loadedAt = ref<number | null>(null)
  /** User stream live: events invalidate one authoritative read; they never write balance quantities. */
  const live = ref(false)

  const market = useMarketStore()
  let requestVersion = 0
  let loadInFlight: Promise<void> | null = null
  let sessionToken = session.getToken()
  let sessionUid = session.getUser()?.id
  onScopeDispose(session.onInvalidate(snapshot => {
    // A profile identifying a different user also invalidates private snapshots and in-flight commits.
    // First identification after login (unknown → uid) is still the same cookie session.
    if (snapshot.token !== sessionToken || (sessionUid !== undefined && snapshot.user?.id !== sessionUid)) clear()
    sessionToken = snapshot.token
    sessionUid = snapshot.user?.id
  }))

  function describe(error_: unknown): string {
    if (isApiError(error_)) {
      return error_.message
    }
    return error_ instanceof Error ? error_.message : String(error_)
  }

  const allCoinMap = computed(() => data.value?.allCoinMap)
  const coinKey = (coin: string): string => coin.toUpperCase()
  const baseAvailable = computed(() => {
    const symbol = market.currentSymbol
    return symbol === undefined ? '' : overlay.adjust(`${coinKey(symbol.base)}:available`, availableBalance(findCoinBalance(allCoinMap.value, symbol.base)))
  })
  const baseSellable = computed(() => {
    const symbol = market.currentSymbol
    return symbol === undefined ? '' : overlay.adjust(`${coinKey(symbol.base)}:available`, sellableBalance(findCoinBalance(allCoinMap.value, symbol.base)))
  })
  const baseLocked = computed(() => {
    const symbol = market.currentSymbol
    return symbol === undefined ? '' : overlay.adjust(`${coinKey(symbol.base)}:locked`, lockedBalance(findCoinBalance(allCoinMap.value, symbol.base)))
  })
  const quoteAvailable = computed(() => {
    const symbol = market.currentSymbol
    return symbol === undefined ? '' : overlay.adjust(`${coinKey(symbol.quote)}:available`, availableBalance(findCoinBalance(allCoinMap.value, symbol.quote)))
  })
  const quoteLocked = computed(() => {
    const symbol = market.currentSymbol
    return symbol === undefined ? '' : overlay.adjust(`${coinKey(symbol.quote)}:locked`, lockedBalance(findCoinBalance(allCoinMap.value, symbol.quote)))
  })
  const totalBalance = computed(() => data.value?.totalBalance ?? '')
  const totalBalanceSymbol = computed(() => data.value?.totalBalanceSymbol ?? '')

  /** Coin rows for the assets page: only coins the server actually returned. */
  const coinRows = computed(() => {
    const map = allCoinMap.value
    if (map === undefined) {
      return []
    }
    return Object.keys(map)
      .map((key) => {
        const entry = map[key]
        return {
          coin: String(entry.coinName ?? key).toUpperCase(),
          available: availableBalance(entry),
          locked: lockedBalance(entry),
          total: entry.total_balance ?? '',
          btcValuation: entry.btcValuatin ?? '',
        }
      })
      .sort((left, right) => left.coin.localeCompare(right.coin))
  })

  /**
   * Fetches a snapshot and returns the commit (`@/core/swr` fetch → commit), or `null` when the answer is stale.
   * A failed refresh still drops the snapshot: a stale balance must not stay usable after an error.
   */
  async function prepare(): Promise<Commit> {
    if (!session.isAuthenticated()) {
      return clear
    }
    const version = ++requestVersion
    const token = session.getToken()
    const stamp = overlay.stamp()
    const current = (): boolean => version === requestVersion && token === session.getToken()
    loading.value = true
    error.value = null
    try {
      const next = await fetchAccountBalance()
      if (!current()) return null
      return () => {
        if (!current()) return
        data.value = next
        loadedAt.value = Date.now()
        overlay.reconcile(stamp)
        loading.value = false
      }
    } catch (error_) {
      if (!current()) return null
      const message = describe(error_)
      return () => {
        if (!current()) return
        error.value = message
        data.value = null
        loadedAt.value = null
        overlay.clear()
        loading.value = false
      }
    } finally {
      // A stale or superseded request must not leave the spinner on.
      if (version === requestVersion && token !== session.getToken()) loading.value = false
    }
  }

  function load(): Promise<void> {
    if (loadInFlight !== null) return loadInFlight
    const pending = prepare().then(commit => { commit?.() })
    loadInFlight = pending
    const finished = (): void => { if (loadInFlight === pending) loadInFlight = null }
    void pending.then(finished, finished)
    return pending
  }

  /** One trailing read after an in-flight read; concurrent notifications join that same trailing read. */
  async function refresh(): Promise<void> {
    const token = session.getToken()
    const uid = session.getUser()?.id
    if (loadInFlight !== null) await loadInFlight
    if (token !== session.getToken() || (uid !== undefined && uid !== session.getUser()?.id) || !session.isAuthenticated()) return
    return load()
  }

  /**
   * Optimistic change of the trade-page figures (`coin` upper case): `available` moves by `-amount` and `locked` by
   * `+amount` (a negative amount releases). Settle when the server accepted, roll back when it refused.
   */
  function reserve(coin: string, amount: string): OverlayHandle {
    const release = amount.startsWith('-')
    const size = release ? amount.slice(1) : amount
    const key = coinKey(coin)
    return overlay.apply({
      [`${key}:available`]: release ? size : `-${size}`,
      [`${key}:locked`]: release ? `-${size}` : size,
    })
  }

  function setLive(on: boolean): void {
    live.value = on
  }

  function clear(): void {
    loadInFlight = null
    requestVersion += 1
    overlay.clear()
    loading.value = false
    data.value = null
    error.value = null
    loadedAt.value = null
  }

  return {
    data,
    loading,
    error,
    loadedAt,
    allCoinMap,
    baseAvailable,
    baseSellable,
    baseLocked,
    quoteAvailable,
    quoteLocked,
    totalBalance,
    totalBalanceSymbol,
    coinRows,
    live,
    prepare,
    load,
    refresh,
    reserve,
    setLive,
    clear,
  }
})
