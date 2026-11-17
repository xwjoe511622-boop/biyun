<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Bell, CheckCheck, Inbox, RefreshCw, Trash2 } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import PageHead from '@/components/content/PageHead.vue'
import ContentPager from '@/components/content/ContentPager.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import MessageRow from '@/components/messages/MessageRow.vue'
import {
  deleteMessages,
  fetchMessages,
  markAllMessagesRead,
  markMessageRead,
  MESSAGE_TYPE_ALL,
  type MessageItem,
  type MessageType,
} from '@/modules/messages/messages.api'
import { applyRead, applyReadAll, removeIds, toggleSelection, unreadAfterDelete, unreadAfterRead } from '@/modules/messages/messages-state'
import { refreshUnreadCount, setUnreadCount, useUnreadMessages } from '@/modules/messages/useUnreadMessages'
import { errorMessage, isUnauthorized, pageCount } from '@/modules/content/api-helpers'
import { useMessagesI18n } from '@/modules/messages/i18n'
import { messageTypeLabel } from '@/modules/messages/message-type-label'
import { useSessionStore } from '@/stores/session'

/**
 * Message center — `modules/messages/messages.api.ts` documents the `UserMessageAct` contract.
 * Tabs: all (type 0), unread, then the server's own `typeList` (system, deposit/withdrawal, …).
 * The server has no unread filter, so the unread tab scans the newest messages (bounded) and pages
 * locally. Local state changes only after the server confirms each action.
 */
const PAGE_SIZE = 10
const UNREAD_SCAN_PAGE = 50
const UNREAD_SCAN_MAX_PAGES = 4

type TabKey = 'all' | 'unread' | `type-${number}`

const { t, locale } = useMessagesI18n()
const sessionStore = useSessionStore()
const unread = useUnreadMessages()

const tab = ref<TabKey>('all')
const page = ref(1)
const items = ref<MessageItem[]>([])
const unreadPool = ref<MessageItem[]>([])
const unreadTruncated = ref(false)
const total = ref(0)
const types = ref<MessageType[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const actionError = ref('')
const selected = ref<string[]>([])
const confirming = ref(false)
let controller: AbortController | null = null

const authenticated = computed(() => sessionStore.isAuthenticated)
const namedTypes = computed(() => types.value.map(type => ({ ...type, title: messageTypeLabel(type, (key, values) => t(key, values)) })))
const typeTabs = computed(() => namedTypes.value.filter((type) => type.id !== MESSAGE_TYPE_ALL))
const typeNames = computed(() => new Map(namedTypes.value.map((type) => [type.id, type.title])))
const pages = computed(() => pageCount(total.value, PAGE_SIZE))
const unreadTotal = computed(() => unread.count.value ?? 0)
const visible = computed(() => (tab.value === 'unread' ? unreadPool.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE) : items.value))
const allSelected = computed(() => visible.value.length > 0 && visible.value.every((item) => selected.value.includes(item.id)))

function typeLabel(item: MessageItem): string {
  return typeNames.value.get(item.type) ?? messageTypeLabel({ id: item.type, title: '' }, (key, values) => t(key, values))
}

async function loadUnreadPool(signal: AbortSignal): Promise<{ pool: MessageItem[]; truncated: boolean; types: MessageType[] }> {
  const pool: MessageItem[] = []
  let serverTypes: MessageType[] = []
  let scanned = 0
  let serverTotal = 0
  for (let index = 1; index <= UNREAD_SCAN_MAX_PAGES; index += 1) {
    const result = await fetchMessages({ page: index, pageSize: UNREAD_SCAN_PAGE, type: MESSAGE_TYPE_ALL }, signal)
    if (index === 1) serverTypes = result.types
    serverTotal = result.count
    scanned += result.items.length
    pool.push(...result.items.filter((item) => !item.read))
    if (result.items.length < UNREAD_SCAN_PAGE || scanned >= serverTotal) break
  }
  return { pool, truncated: scanned < serverTotal, types: serverTypes }
}

async function load(): Promise<void> {
  if (!authenticated.value) return
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = ''
  selected.value = []
  confirming.value = false
  try {
    if (tab.value === 'unread') {
      const result = await loadUnreadPool(current.signal)
      if (controller !== current) return
      unreadPool.value = result.pool
      unreadTruncated.value = result.truncated
      types.value = result.types
      total.value = result.pool.length
    } else {
      const type = tab.value === 'all' ? MESSAGE_TYPE_ALL : Number(tab.value.slice(5)) // float-ok: message type id
      const result = await fetchMessages({ page: page.value, pageSize: PAGE_SIZE, type }, current.signal)
      if (controller !== current) return
      items.value = result.items
      total.value = result.count
      types.value = result.types
    }
    void refreshUnreadCount()
  } catch (failure) {
    if (controller !== current || isUnauthorized(failure)) return
    error.value = errorMessage(failure)
  } finally {
    if (controller === current) loading.value = false
  }
}

function selectTab(key: TabKey): void {
  if (tab.value === key) return
  tab.value = key
  page.value = 1
  void load()
}

function goPage(target: number): void {
  page.value = target
  if (tab.value === 'unread') selected.value = []
  else void load()
}

async function act(action: () => Promise<void>): Promise<boolean> {
  busy.value = true
  actionError.value = ''
  try {
    await action()
    return true
  } catch (failure) {
    // Also a rejected session: say so (10-01 audit: follow/unfollow failed silently on 401).
    actionError.value = errorMessage(failure)
    return false
  } finally {
    busy.value = false
  }
}

async function markRead(id: string): Promise<void> {
  const before = [...items.value, ...unreadPool.value]
  if (await act(() => markMessageRead(id))) {
    setUnreadCount(unreadAfterRead(unreadTotal.value, before, id))
    items.value = applyRead(items.value, id)
    unreadPool.value = applyRead(unreadPool.value, id)
  }
}

async function markAll(): Promise<void> {
  if (await act(markAllMessagesRead)) {
    setUnreadCount(0)
    items.value = applyReadAll(items.value)
    unreadPool.value = applyReadAll(unreadPool.value)
  }
}

async function remove(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const before = tab.value === 'unread' ? unreadPool.value : items.value
  if (await act(() => deleteMessages(ids))) {
    setUnreadCount(unreadAfterDelete(unreadTotal.value, before, ids))
    confirming.value = false
    selected.value = []
    if (tab.value === 'unread') {
      unreadPool.value = removeIds(unreadPool.value, ids)
      total.value = unreadPool.value.length
      if (page.value > pageCount(total.value, PAGE_SIZE)) page.value = pageCount(total.value, PAGE_SIZE)
    } else {
      // Reload so the page refills from the server (and step back when the page emptied).
      if (ids.length >= items.value.length && page.value > 1) page.value -= 1
      await load()
    }
  }
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : visible.value.map((item) => item.id)
}

watch(authenticated, (value) => {
  items.value = []
  unreadPool.value = []
  if (value) void load()
}, { immediate: true })
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div class="page messages-page">
    <PageHead :icon="Bell" :title="t('msg.title')" :lead="t('msg.lead')">
      <template v-if="authenticated">
        <button class="btn btn-ghost" type="button" :disabled="loading" @click="load"><RefreshCw :size="15" aria-hidden="true" />{{ t('msg.refresh') }}</button>
        <button class="btn" type="button" :disabled="busy || unreadTotal === 0" @click="markAll"><CheckCheck :size="15" aria-hidden="true" />{{ t('msg.markAll') }}</button>
      </template>
    </PageHead>

    <GuestGate v-if="!authenticated" :message="t('msg.loginRequired')" :icon="Bell" />

    <template v-else>
      <div class="tabs-bar" role="tablist">
        <button class="mtab" :class="{ active: tab === 'all' }" role="tab" :aria-selected="tab === 'all'" type="button" @click="selectTab('all')">{{ t('msg.all') }}</button>
        <button class="mtab" :class="{ active: tab === 'unread' }" role="tab" :aria-selected="tab === 'unread'" type="button" @click="selectTab('unread')">
          {{ t('msg.unread') }}<span v-if="unread.badge.value !== ''" class="badge num">{{ unread.badge.value }}</span>
        </button>
        <button v-for="type in typeTabs" :key="type.id" class="mtab" :class="{ active: tab === `type-${type.id}` }" role="tab" :aria-selected="tab === `type-${type.id}`" type="button" @click="selectTab(`type-${type.id}`)">{{ type.title }}</button>
      </div>

      <ErrorBanner v-if="error !== ''" :message="error" retryable @retry="load" />
      <p v-if="actionError !== ''" class="notice notice-error action-error" role="alert">{{ actionError }}</p>

      <section v-if="error === ''" class="panel list-panel" :aria-busy="loading">
        <div v-if="visible.length > 0" class="list-toolbar">
          <label class="select-all"><input type="checkbox" :checked="allSelected" :disabled="busy" @change="toggleAll" />{{ t('msg.selectAll') }}</label>
          <template v-if="selected.length > 0">
            <span v-if="confirming" class="confirm">
              <span class="confirm-text">{{ t('msg.confirmDelete', { n: selected.length }) }}</span>
              <button class="btn btn-sell small" type="button" :disabled="busy" @click="remove(selected)">{{ t('msg.confirm') }}</button>
              <button class="btn small" type="button" :disabled="busy" @click="confirming = false">{{ t('msg.cancel') }}</button>
            </span>
            <button v-else class="btn small danger" type="button" :disabled="busy" @click="confirming = true"><Trash2 :size="14" aria-hidden="true" />{{ t('msg.removeSelected', { n: selected.length }) }}</button>
          </template>
          <span v-else-if="unreadTotal > 0" class="unread-note num">{{ t('msg.unreadCount', { n: unreadTotal }) }}</span>
        </div>
        <p v-if="tab === 'unread' && unreadTruncated" class="notice truncated">{{ t('msg.unreadTruncated', { n: UNREAD_SCAN_PAGE * UNREAD_SCAN_MAX_PAGES }) }}</p>

        <div v-if="loading && visible.length === 0" class="sk"><span v-for="n in 5" :key="n"></span></div>
        <ul v-else-if="visible.length > 0" class="msg-list" :class="{ dim: loading }">
          <MessageRow
            v-for="item in visible"
            :key="item.id"
            :item="item"
            :type-label="typeLabel(item)"
            :selected="selected.includes(item.id)"
            :busy="busy"
            :locale="locale"
            :labels="{ markRead: t('msg.markRead'), remove: t('msg.remove'), new: t('msg.new') }"
            @toggle="selected = toggleSelection(selected, item.id)"
            @read="markRead(item.id)"
            @remove="remove([item.id])"
          />
        </ul>
        <EmptyState v-else :icon="Inbox" :title="tab === 'unread' ? t('msg.emptyUnread') : t('msg.emptyTitle')" :message="t('msg.emptyMessage')" />
        <div class="pager-wrap"><ContentPager :page="page" :pages="pages" :total="total" :disabled="loading || busy" @change="goPage" /></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.messages-page { max-width: 1000px; }
.tabs-bar { display: flex; gap: 4px; margin-bottom: 14px; overflow-x: auto; border-bottom: 1px solid var(--color-border); }
.mtab { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 42px; padding: 0 14px; color: var(--color-text-muted); font-size: 14px; font-weight: 600; white-space: nowrap; }
.mtab:hover { color: var(--color-text); }
.mtab.active { color: var(--color-text); }
.mtab.active::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--color-accent); color: var(--color-on-accent); font-size: 11px; font-weight: 700; }
.action-error { margin: 0 0 12px; }
.list-panel { overflow: hidden; }
.list-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; min-height: 52px; padding: 8px 18px; border-bottom: 1px solid var(--color-border); background: var(--color-surface-alt); }
.select-all { display: inline-flex; align-items: center; gap: 10px; color: var(--color-text-secondary); font-size: 13px; cursor: pointer; }
.select-all input { width: 16px; height: 16px; accent-color: var(--color-accent); }
.btn.small { height: 32px; padding: 0 12px; font-size: 12.5px; }
.btn.danger { color: var(--color-down); }
.confirm { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.confirm-text { color: var(--color-text-secondary); font-size: 12.5px; }
.unread-note { color: var(--color-accent-text); font-size: 12px; font-weight: 600; }
.truncated { margin: 12px 18px 0; }
.msg-list { margin: 0; padding: 0; list-style: none; transition: opacity .15s; }
.msg-list.dim { opacity: .55; }
.msg-list > :last-child { border-bottom: 0; }
.pager-wrap { padding: 0 18px 16px; }
.pager-wrap:empty { display: none; }
.sk { padding: 8px 18px; }
.sk span { display: block; height: 54px; margin: 12px 0; border-radius: 10px; background: var(--color-surface-alt); }
@media (max-width: 640px) {
  .list-toolbar { padding: 8px 12px; }
  .pager-wrap { padding: 0 12px 14px; }
}
</style>
