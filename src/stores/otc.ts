import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { session } from '@/core/session'
import * as otcApi from '@/modules/otc/api'
import { readOtcCoins, type OtcCoin } from '@/modules/otc/coins'
import { useMarketStore } from '@/stores/market'

/**
 * Shared C2C state: OTC public config, the OTC-enabled coin list (from the spot public info), the
 * user's OTC balances and receiving methods. Account-bound data is dropped whenever the spot session
 * changes; OTC failures never touch the spot session (http namespace `otc`).
 */
export const useOtcStore = defineStore('otc', () => {
  const market = useMarketStore()

  const publicInfo = shallowRef<otcApi.OtcPublicInfo | null>(null)
  const publicInfoError = ref<unknown>(null)
  const publicInfoLoading = ref(false)
  let publicInfoPromise: Promise<void> | null = null

  const accounts = shallowRef<otcApi.OtcBalance[] | null>(null)
  const accountsError = ref<unknown>(null)
  const accountsLoading = ref(false)

  const paymentMethods = shallowRef<otcApi.UserPaymentMethod[] | null>(null)
  const paymentMethodsError = ref<unknown>(null)

  let accountGeneration = 0
  let knownToken = session.getToken()

  onScopeDispose(session.onInvalidate((snapshot) => {
    // `setUser` also notifies; only a token change means a different (or no) account.
    if (snapshot.token === knownToken) return
    knownToken = snapshot.token
    accountGeneration += 1
    accounts.value = null
    accountsError.value = null
    paymentMethods.value = null
    paymentMethodsError.value = null
  }))

  const coins = computed<OtcCoin[]>(() => readOtcCoins(market.publicInfo))

  function coinMeta(coin: string): OtcCoin | undefined {
    return coins.value.find(item => item.coin === coin.toUpperCase())
  }

  function paymentTitle(key: string): string {
    return publicInfo.value?.payments.find(item => item.key === key)?.title ?? key.replace(/^otc\.payment\./, '')
  }

  async function ensureMarketInfo(): Promise<void> {
    if (market.publicInfo !== null) return
    try {
      await market.loadPublicInfo()
    } catch {
      // The spot market store surfaces its own error; C2C shows "no coins" in that case.
    }
  }

  function loadPublicInfo(force = false): Promise<void> {
    if (!force && publicInfo.value !== null) return Promise.resolve()
    if (publicInfoPromise !== null) return publicInfoPromise
    publicInfoLoading.value = true
    publicInfoError.value = null
    publicInfoPromise = otcApi.fetchPublicInfo()
      .then((info) => { publicInfo.value = info })
      .catch((error: unknown) => { publicInfoError.value = error })
      .finally(() => {
        publicInfoLoading.value = false
        publicInfoPromise = null
      })
    return publicInfoPromise
  }

  async function loadAccounts(): Promise<void> {
    if (!session.isAuthenticated()) return
    const generation = ++accountGeneration
    accountsLoading.value = true
    accountsError.value = null
    try {
      const rows = await otcApi.fetchOtcAccounts()
      if (generation === accountGeneration) accounts.value = rows
    } catch (error) {
      if (generation === accountGeneration) accountsError.value = error
    } finally {
      if (generation === accountGeneration) accountsLoading.value = false
    }
  }

  function balanceOf(coin: string): otcApi.OtcBalance | undefined {
    return accounts.value?.find(row => row.coin === coin.toUpperCase())
  }

  async function loadPaymentMethods(): Promise<void> {
    if (!session.isAuthenticated()) return
    const generation = accountGeneration
    paymentMethodsError.value = null
    try {
      const rows = await otcApi.fetchPaymentMethods()
      if (generation === accountGeneration) paymentMethods.value = rows
    } catch (error) {
      if (generation === accountGeneration) paymentMethodsError.value = error
    }
  }

  return {
    publicInfo,
    publicInfoError,
    publicInfoLoading,
    accounts,
    accountsError,
    accountsLoading,
    paymentMethods,
    paymentMethodsError,
    coins,
    coinMeta,
    paymentTitle,
    ensureMarketInfo,
    loadPublicInfo,
    loadAccounts,
    balanceOf,
    loadPaymentMethods,
  }
})
