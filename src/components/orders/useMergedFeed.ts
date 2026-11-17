import { computed, ref, shallowRef } from 'vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { emptyFeed, hasMore, loadNextPages, totalCount, type FeedFetcher, type MergedFeed } from './model'

/**
 * Reactive wrapper around the merged per-pair feed. Every load is versioned and bound to the session
 * token so a late answer after a filter/tab/session change is dropped instead of mixing data.
 */
export function useMergedFeed<T>(options: { fetcher: FeedFetcher<T>; timeOf: (item: T) => number | null; pageSize?: number }) {
  const feed = shallowRef<MergedFeed<T>>(emptyFeed<T>([]))
  const loading = ref(false)
  const error = ref<string | null>(null)
  let version = 0

  const more = computed(() => hasMore(feed.value))
  const total = computed(() => totalCount(feed.value))
  const failedSymbols = computed(() => feed.value.cursors.filter(cursor => cursor.error !== null))

  async function loadMore(): Promise<void> {
    if (!session.isAuthenticated()) return
    const current = ++version
    const token = session.getToken()
    loading.value = true
    error.value = null
    try {
      const next = await loadNextPages(feed.value, options.fetcher, { pageSize: options.pageSize ?? 50, timeOf: options.timeOf })
      if (current !== version || token !== session.getToken()) return
      feed.value = next
      const failures = next.cursors.filter(cursor => cursor.error !== null)
      if (failures.length > 0 && failures.length === next.cursors.length) error.value = failures[0].error
    } catch (error_) {
      if (current !== version || token !== session.getToken()) return
      error.value = isApiError(error_) || error_ instanceof Error ? error_.message : String(error_)
    } finally {
      if (current === version) loading.value = false
    }
  }

  /** Starts over for a new set of pairs (or a new filter) and loads the first page of each. */
  async function reset(symbols: string[]): Promise<void> {
    version += 1
    feed.value = emptyFeed<T>(symbols)
    error.value = null
    loading.value = false
    if (symbols.length > 0) await loadMore()
  }

  function clear(): void {
    version += 1
    feed.value = emptyFeed<T>([])
    loading.value = false
    error.value = null
  }

  return { feed, loading, error, more, total, failedSymbols, loadMore, reset, clear }
}
