import { computed, onScopeDispose, readonly, ref } from 'vue'
import { session } from '@/core/session'
import { fetchUnreadCount } from './messages.api'

/**
 * Shared unread-message counter (`message/get_no_read_message_count`, `UserMessageAct.java:281`).
 *
 * Module-level state so the header badge and the message center stay in sync. The count is
 * cleared whenever the session token changes, and requests started under an old token are ignored.
 * Callers may start polling; the interval stops automatically when the calling scope is disposed.
 */
const count = ref<number | null>(null)
const loading = ref(false)
let generation = 0
let unsubscribe: (() => void) | null = null

function ensureSessionListener(): void {
  if (unsubscribe !== null) return
  let lastToken = session.getToken()
  unsubscribe = session.onInvalidate((snapshot) => {
    if (snapshot.token !== lastToken) {
      lastToken = snapshot.token
      generation += 1
      count.value = null
      loading.value = false
    }
  })
}

export async function refreshUnreadCount(): Promise<number | null> {
  ensureSessionListener()
  if (!session.isAuthenticated()) {
    count.value = null
    return null
  }
  const token = session.getToken()
  const current = ++generation
  loading.value = true
  try {
    const value = await fetchUnreadCount()
    if (current !== generation || session.getToken() !== token) return count.value
    count.value = value
    return value
  } catch {
    // Keep the previous value; a badge must never show a made-up number.
    return count.value
  } finally {
    if (current === generation) loading.value = false
  }
}

/** Set by the message center after a confirmed server change (read / read-all / delete). */
export function setUnreadCount(value: number): void {
  ensureSessionListener()
  if (session.isAuthenticated()) count.value = Math.max(0, value)
}

export function useUnreadMessages(options: { pollMs?: number } = {}) {
  ensureSessionListener()
  let timer: ReturnType<typeof setInterval> | null = null
  if (options.pollMs !== undefined && options.pollMs >= 10_000) {
    timer = setInterval(() => {
      void refreshUnreadCount()
    }, options.pollMs)
  }
  onScopeDispose(() => {
    if (timer !== null) clearInterval(timer)
  })
  return {
    count: readonly(count),
    loading: readonly(loading),
    /** Badge text: '' when unknown or zero, `99+` above 99. */
    badge: computed(() => (count.value === null || count.value <= 0 ? '' : count.value > 99 ? '99+' : String(count.value))),
    refresh: refreshUnreadCount,
  }
}

/** Test hook. */
export function resetUnreadForTests(): void {
  generation += 1
  count.value = null
  loading.value = false
}
