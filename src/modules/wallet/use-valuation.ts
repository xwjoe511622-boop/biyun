import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import {
  btcUsdtPrice,
  readAmountsHidden,
  readValuationUnit,
  writeAmountsHidden,
  writeValuationUnit,
  type ValuationUnit,
} from './valuation'

/** Shared across the home card and the assets overview (one choice per user, remembered in localStorage). */
/** Phones default to USDT like the large exchanges' apps (owner 2026-11-17); a saved choice always wins. */
const DEFAULT_UNIT: ValuationUnit = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches ? 'USDT' : 'BTC'
const unit = ref<ValuationUnit>(DEFAULT_UNIT)
const hidden = ref(false)
let loadedFor: string | null = null

export interface ValuationPrefs {
  unit: Ref<ValuationUnit>
  hidden: Ref<boolean>
  /** Last BTC/USDT price from the review stream (`''` until one arrived). */
  btcPrice: ComputedRef<string>
  setUnit: (next: ValuationUnit) => void
  toggleHidden: () => void
}

export function useValuationPrefs(): ValuationPrefs {
  const session = useSessionStore()
  const market = useMarketStore()
  const userId = computed(() => {
    const id = session.user?.id
    return typeof id === 'number' || typeof id === 'string' ? String(id) : ''
  })
  watch(userId, (id) => {
    if (loadedFor === id) return
    loadedFor = id
    unit.value = readValuationUnit(id, DEFAULT_UNIT)
    hidden.value = readAmountsHidden(id)
  }, { immediate: true })
  return {
    unit,
    hidden,
    btcPrice: computed(() => btcUsdtPrice(market.tickers)),
    setUnit: (next) => {
      unit.value = next
      writeValuationUnit(userId.value, next)
    },
    toggleHidden: () => {
      hidden.value = !hidden.value
      writeAmountsHidden(userId.value, hidden.value)
    },
  }
}
