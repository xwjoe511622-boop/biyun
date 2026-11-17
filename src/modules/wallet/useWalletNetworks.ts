import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { session } from '@/core/session'
import { fetchWalletNetworks } from '@/modules/api/wallet.api'
import type { WalletNetwork } from './networks'
import type { WalletBackendShape } from './withdrawMode'

export interface WalletNetworksState {
  /** `null` until known, or when the server has no `addr/networks` (historical backend). */
  networks: Ref<WalletNetwork[] | null>
  /** True once the probe finished (either way). */
  ready: Ref<boolean>
  /** `network` when `addr/networks` answered, otherwise `legacy`. */
  shape: ComputedRef<WalletBackendShape>
  reload: () => Promise<void>
}

/**
 * Per-panel compatibility probe. Re-runs on every token change so a late answer for a previous
 * account can never decide the mode for the next one.
 */
export function useWalletNetworks(onChange?: () => void): WalletNetworksState {
  const networks = ref<WalletNetwork[] | null>(null)
  const ready = ref(false)
  let generation = 0
  let controller: AbortController | null = null
  let stop: (() => void) | null = null

  async function reload(): Promise<void> {
    controller?.abort()
    const current = ++generation
    if (!session.isAuthenticated()) {
      networks.value = null
      ready.value = false
      return
    }
    const active = new AbortController()
    controller = active
    try {
      const next = await fetchWalletNetworks({ signal: active.signal })
      if (current !== generation) return
      networks.value = next
    } catch {
      if (current !== generation) return
      networks.value = null
    } finally {
      if (current === generation) {
        ready.value = true
        onChange?.()
      }
    }
  }

  onMounted(() => {
    void reload()
    let token = session.getToken()
    stop = session.onInvalidate((snapshot) => {
      if (snapshot.token === token) return
      token = snapshot.token
      networks.value = null
      ready.value = false
      void reload()
    })
  })

  onBeforeUnmount(() => {
    generation += 1
    controller?.abort()
    stop?.()
  })

  const shape = computed<WalletBackendShape>(() => (networks.value !== null && networks.value.length > 0 ? 'network' : 'legacy'))
  return { networks, ready, shape, reload }
}
