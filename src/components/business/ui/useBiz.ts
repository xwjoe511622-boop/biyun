import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'
import { BusinessApiError, businessRequest, rowsOf, type BusinessParams, type BusinessRow } from '@/modules/business/client'
import { fetchSpotAccount } from '@/modules/spot/spot-api'
import type { Lang } from '@/modules/business/format'

/** Locale + sign-in state shared by every product page. */
export function useBizContext() {
  const { locale, t } = useI18n({ useScope: 'global' })
  const session = useSessionStore()
  const lang = computed<Lang>(() => (String(locale.value).toLowerCase().startsWith('zh') ? 'zh' : 'en'))
  const authed = computed(() => session.token !== null && session.token !== '')
  return { lang, authed, t }
}

/** A GET list/object loaded from a business endpoint; reloads when `deps` change. */
export function useBizQuery(path: () => string | null, params: () => BusinessParams = () => ({}), rowsPath = 'rows') {
  const rows = ref<BusinessRow[]>([]) as Ref<BusinessRow[]>
  const raw = ref<unknown>(null)
  const loading = ref(false)
  const error = ref('')
  const errorCode = ref('')
  let ctrl: AbortController | null = null
  async function load(): Promise<void> {
    const p = path()
    if (p === null) { rows.value = []; raw.value = null; return }
    ctrl?.abort()
    const mine = new AbortController()
    ctrl = mine
    loading.value = true
    error.value = ''
    errorCode.value = ''
    try {
      const data = await businessRequest(p, params(), false, mine.signal)
      if (ctrl !== mine) return
      raw.value = data
      rows.value = rowsOf(data, rowsPath, rowsPath === '')
    } catch (e) {
      if (ctrl !== mine) return
      error.value = e instanceof Error ? e.message : String(e)
      errorCode.value = e instanceof BusinessApiError ? e.code : ''
      rows.value = []
    } finally {
      if (ctrl === mine) loading.value = false
    }
  }
  onBeforeUnmount(() => ctrl?.abort())
  return { rows, raw, loading, error, errorCode, load }
}

/** Spot "free" balances by asset for the signed-in user (dialogs show "可用" and a Max button). */
export function useSpotBalances(authed: Ref<boolean>) {
  const free = ref<Record<string, string>>({})
  async function load(): Promise<void> {
    if (!authed.value) { free.value = {}; return }
    try {
      const account = await fetchSpotAccount()
      const map: Record<string, string> = {}
      for (const b of account.balances ?? []) map[b.asset.toUpperCase()] = String(b.free)
      free.value = map
    } catch {
      free.value = {}
    }
  }
  watch(authed, () => { void load() }, { immediate: true })
  const of = (asset: string) => free.value[asset.toUpperCase()] ?? '0'
  return { free, of, reload: load }
}

/** Ticking clock for countdowns (1 s). */
export function useNow() {
  const now = ref(Date.now())
  const id = window.setInterval(() => { now.value = Date.now() }, 1000)
  onBeforeUnmount(() => window.clearInterval(id))
  return now
}
