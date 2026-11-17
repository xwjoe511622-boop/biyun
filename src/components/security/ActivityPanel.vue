<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Clock } from '@lucide/vue'
import SecurityRow from './SecurityRow.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import {
  fetchLoginHistory,
  fetchSettingHistory,
  type LoginHistoryItem,
  type SettingHistoryItem,
} from '@/modules/api/security-settings.api'
import { translateSecurityMessage, useSecurityI18n } from '@/modules/security/i18n'
import { readActivityResult, securityOperationKey, totalPages } from '@/modules/security/security-state'

/**
 * Login / security-settings activity. Pagination params (`page`, `pageSize`) and response fields
 * (`count`, `historyLoginList[]`, `historySettingList[]`) are the exact legacy contract from
 * `common-mixin/personal/SafetyRecord`. Reads only; no mutation is sent from this panel.
 */
const props = defineProps<{ authenticated: boolean }>()
const { t } = useSecurityI18n()

type Kind = 'login' | 'setting'

const kind = ref<Kind>('login')
const page = ref(1)
const pageSize = 10
const loginItems = ref<LoginHistoryItem[]>([])
const settingItems = ref<SettingHistoryItem[]>([])
const count = ref(0)
const loading = ref(false)
const error = ref('')

let requestVersion = 0
let sessionToken = session.getToken()
let unmounted = false
let unsubscribe: (() => void) | null = null

const pages = computed(() => totalPages(count.value, pageSize))
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < pages.value)
const pageInfo = computed(() =>
  t('security.activity.page', { page: page.value, pages: pages.value, total: count.value }),
)

function describe(cause: unknown): string {
  if (isApiError(cause)) {
    // A malformed-but-successful history response must be visible as a parse error, never as an
    // empty history. Values are never echoed (the API message carries field paths only).
    if (cause.kind === 'parse') {
      return t('security.error.historyMalformed')
    }
    return translateSecurityMessage(t, cause.message)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function clear(): void {
  requestVersion += 1
  loginItems.value = []
  settingItems.value = []
  count.value = 0
  error.value = ''
  loading.value = false
  page.value = 1
}

async function load(): Promise<void> {
  if (!props.authenticated) {
    clear()
    return
  }
  const version = ++requestVersion
  const token = session.getToken()
  sessionToken = token
  const requestedKind = kind.value
  const requestedPage = page.value
  loading.value = true
  error.value = ''
  try {
    if (requestedKind === 'login') {
      const result = await fetchLoginHistory({ page: requestedPage, pageSize })
      if (isStale(version, token)) return
      loginItems.value = result.items
      count.value = result.count
    } else {
      const result = await fetchSettingHistory({ page: requestedPage, pageSize })
      if (isStale(version, token)) return
      settingItems.value = result.items
      count.value = result.count
    }
  } catch (cause) {
    if (isStale(version, token)) return
    error.value = describe(cause)
    if (requestedKind === 'login') {
      loginItems.value = []
    } else {
      settingItems.value = []
    }
    count.value = 0
  } finally {
    if (version === requestVersion && !unmounted) {
      loading.value = false
    }
  }
}

/** A late completion for a superseded request, a replaced session or an unmounted panel is dropped. */
function isStale(version: number, token: string | null): boolean {
  return unmounted || version !== requestVersion || token !== session.getToken()
}

function selectKind(next: Kind): void {
  if (kind.value === next) {
    return
  }
  kind.value = next
  page.value = 1
  count.value = 0
  error.value = ''
  void load()
}

function go(delta: number): void {
  const target = page.value + delta
  if (target < 1 || target > pages.value) {
    return
  }
  page.value = target
  void load()
}

watch(
  () => props.authenticated,
  (authenticated) => {
    if (authenticated) {
      void load()
    } else {
      clear()
    }
  },
)

onMounted(() => {
  // A token swap without a full logout (re-login / account switch) must not leave the previous
  // account's history on screen, so clear immediately and reload for the new session.
  unsubscribe = session.onInvalidate((snapshot) => {
    if (snapshot.token === sessionToken) {
      return
    }
    sessionToken = snapshot.token
    clear()
    if (session.isAuthenticated()) {
      void load()
    }
  })
  if (props.authenticated) {
    void load()
  }
})

onBeforeUnmount(() => {
  unmounted = true
  unsubscribe?.()
  unsubscribe = null
})

function operationLabel(item: SettingHistoryItem): string {
  if (item.operation.trim() !== '') return item.operation
  const key = securityOperationKey(item.operationType)
  if (key !== null) return t(`security.activity.operations.${key}`)
  const code = item.operationType?.trim() ?? ''
  return code === '' ? '--' : t('security.activity.unknownOperation', { code })
}

const currentItems = computed<Array<{ key: string; cells: string[] }>>(() => {
  if (kind.value === 'login') {
    return loginItems.value.map((item, index) => ({
      key: `login-${String(index)}-${item.time}`,
      cells: [
        item.time,
        item.ip,
        item.platform,
        item.status === ''
          ? t('security.activity.unknown')
          : readActivityResult(item.status) === 'success'
            ? t('security.activity.success')
            : t('security.activity.failure'),
      ],
    }))
  }
  return settingItems.value.map((item, index) => ({
    key: `setting-${String(index)}-${item.time}`,
    cells: [item.time, operationLabel(item), item.ip],
  }))
})

const headers = computed(() =>
  kind.value === 'login'
    ? [
        t('security.activity.time'),
        t('security.activity.ip'),
        t('security.activity.platform'),
        t('security.activity.result'),
      ]
    : [t('security.activity.time'), t('security.activity.operation'), t('security.activity.ip')],
)
</script>

<template>
  <SecurityRow :label="t('security.activity.section')" layout="stacked">
    <template #icon><Clock :size="18" /></template>

    <template #body>
      <div class="tabs" role="tablist">
        <button
          class="tab"
          :class="{ active: kind === 'login' }"
          type="button"
          role="tab"
          :aria-selected="kind === 'login'"
          @click="selectKind('login')"
        >
          {{ t('security.activity.loginTab') }}
        </button>
        <button
          class="tab"
          :class="{ active: kind === 'setting' }"
          type="button"
          role="tab"
          :aria-selected="kind === 'setting'"
          @click="selectKind('setting')"
        >
          {{ t('security.activity.settingTab') }}
        </button>
      </div>

      <StateBlock v-if="loading && currentItems.length === 0" variant="loading" :message="t('security.loading')" />
      <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="load" />
      <StateBlock v-else-if="currentItems.length === 0" variant="empty" :message="t('security.activity.empty')" />
      <div v-else class="table-scroll">
      <table class="table activity">
        <thead>
          <tr>
            <th v-for="header in headers" :key="header">{{ header }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in currentItems" :key="item.key">
            <td v-for="(cell, index) in item.cells" :key="index" class="wrap-anywhere">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
      </div>

      <div v-if="count > 0" class="pager">
        <button class="btn btn-ghost" type="button" :disabled="!hasPrev || loading" @click="go(-1)">
          <ChevronLeft :size="14" aria-hidden="true" />{{ t('security.activity.prev') }}
        </button>
        <span class="pager-info num">{{ pageInfo }}</span>
        <button class="btn btn-ghost" type="button" :disabled="!hasNext || loading" @click="go(1)">
          {{ t('security.activity.next') }}<ChevronRight :size="14" aria-hidden="true" />
        </button>
      </div>
    </template>
  </SecurityRow>
</template>

<style scoped>
/* Four columns do not fit a 390 px card: scroll the table, never the page. */
.table-scroll { max-width: 100%; overflow-x: auto; }
.tabs {
  margin: 8px 0 4px;
}

.activity {
  table-layout: auto;
}

.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: 10px;
}

.pager-info {
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
</style>
