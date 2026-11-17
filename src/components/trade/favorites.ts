import { ref, type Ref } from 'vue'

/**
 * Starred pairs shared by the terminal pair list, the pair bar star (OKX skin) and the markets page: one reactive set,
 * persisted under the markets page's storage key (`BTC/USDT` entries). Storage failure keeps the in-memory set.
 */
const FAVORITES_KEY = 'longbit.markets.favorites.v1'

function readFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

let shared: Ref<Set<string>> | null = null

export function useFavorites(): { favorites: Ref<Set<string>>; toggleFavorite: (pair: string) => void } {
  if (shared === null) shared = ref<Set<string>>(readFavorites())
  const favorites = shared
  function toggleFavorite(pair: string): void {
    const next = new Set(favorites.value)
    if (next.has(pair)) next.delete(pair)
    else next.add(pair)
    favorites.value = next
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]))
    } catch {
      /* Favorites are a convenience; storage failure keeps the in-memory set. */
    }
  }
  return { favorites, toggleFavorite }
}
