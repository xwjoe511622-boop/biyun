<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronRight, Megaphone, Search, X } from '@lucide/vue'
import PageHead from '@/components/content/PageHead.vue'
import ContentPager from '@/components/content/ContentPager.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import { fetchNotices, type NoticeSummary } from '@/modules/content/content.api'
import { errorMessage, formatDateTime, pageCount } from '@/modules/content/api-helpers'
import { htmlToText } from '@/modules/content/sanitize'
import { useContentI18n } from '@/modules/content/i18n'

/**
 * Announcement list (`notice/notice_info_list`, `NoticeInfoAct.java:55`). The server orders by pin time
 * then creation time, so pinned notices already come first; it does not return an explicit pin flag.
 * Search and page live in the query string so results are shareable and survive back navigation.
 */
const PAGE_SIZE = 10
const { t, locale } = useContentI18n()
const route = useRoute()
const router = useRouter()

const items = ref<NoticeSummary[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const keywordInput = ref('')
let controller: AbortController | null = null

const page = computed(() => {
  const raw = Number(route.query.page) // float-ok: pagination
  return Number.isInteger(raw) && raw > 0 ? raw : 1
})
const keyword = computed(() => (typeof route.query.q === 'string' ? route.query.q.slice(0, 60) : ''))
const pages = computed(() => pageCount(total.value, PAGE_SIZE))

async function load(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = ''
  try {
    const result = await fetchNotices({ page: page.value, pageSize: PAGE_SIZE, keyword: keyword.value }, current.signal)
    if (controller !== current) return
    items.value = result.items
    total.value = result.count
  } catch (failure) {
    if (controller !== current) return
    items.value = []
    error.value = errorMessage(failure)
  } finally {
    if (controller === current) loading.value = false
  }
}

function submitSearch(): void {
  const q = keywordInput.value.trim()
  void router.push({ query: { ...(q === '' ? {} : { q }) } })
}

function clearSearch(): void {
  keywordInput.value = ''
  void router.push({ query: {} })
}

function goPage(target: number): void {
  void router.push({ query: { ...route.query, page: String(target) } })
}

function excerpt(item: NoticeSummary): string {
  return htmlToText(item.content, 140)
}

function dateParts(time: number | null): { day: string; month: string } {
  if (time === null) return { day: '--', month: '' }
  const date = new Date(time)
  return {
    day: String(date.getDate()).padStart(2, '0'),
    month: new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'short' }).format(date),
  }
}

watch([page, keyword], () => {
  keywordInput.value = keyword.value
  void load()
}, { immediate: true })

onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div class="page notices-page">
    <PageHead :icon="Megaphone" :eyebrow="t('content.notices.eyebrow')" :title="t('content.notices.title')" :lead="t('content.notices.lead')">
      <form class="search" role="search" @submit.prevent="submitSearch">
        <Search :size="16" aria-hidden="true" />
        <input v-model="keywordInput" type="search" maxlength="60" :placeholder="t('content.notices.search')" :aria-label="t('content.notices.search')" />
        <button v-if="keyword !== ''" class="icon-button clear" type="button" :aria-label="t('content.notices.clear')" @click="clearSearch"><X :size="15" /></button>
      </form>
    </PageHead>

    <ErrorBanner v-if="error !== ''" :message="error" retryable @retry="load" />

    <section class="panel list-panel" :aria-busy="loading">
      <ul v-if="loading && items.length === 0" class="skeleton" aria-hidden="true">
        <li v-for="n in 5" :key="n"><span class="sk sk-date"></span><span class="sk-lines"><span class="sk sk-title"></span><span class="sk sk-text"></span></span></li>
      </ul>
      <template v-else-if="items.length > 0">
        <ul class="notice-list" :class="{ dim: loading }">
          <li v-for="item in items" :key="item.id">
            <RouterLink class="notice-row" :to="{ name: 'notice', params: { id: item.id } }">
              <span class="date">
                <strong class="num">{{ dateParts(item.time).day }}</strong>
                <small>{{ dateParts(item.time).month }}</small>
              </span>
              <span class="body">
                <span class="title wrap-anywhere">{{ item.title }}</span>
                <span v-if="excerpt(item) !== ''" class="excerpt">{{ excerpt(item) }}</span>
                <span class="meta num">{{ formatDateTime(item.time, locale) }}</span>
              </span>
              <ChevronRight class="chev" :size="18" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
        <ContentPager :page="page" :pages="pages" :total="total" :disabled="loading" @change="goPage" />
      </template>
      <EmptyState
        v-else-if="error === ''"
        :icon="Megaphone"
        :title="keyword !== '' ? t('content.notices.noMatch', { q: keyword }) : t('content.notices.emptyTitle')"
        :message="keyword !== '' ? '' : t('content.notices.emptyMessage')"
      >
        <button v-if="keyword !== ''" class="btn" type="button" @click="clearSearch">{{ t('content.notices.clear') }}</button>
      </EmptyState>
    </section>
  </div>
</template>

<style scoped>
.notices-page { max-width: 1040px; }
.search {
  display: flex; align-items: center; gap: 8px; width: 320px; max-width: 100%; height: 42px; padding: 0 6px 0 14px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text-muted);
}
.search:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.search input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); }
.search .clear { width: 30px; height: 30px; flex-basis: 30px; }
.list-panel { margin-top: 16px; padding: 8px 20px 18px; }
.notice-list { margin: 0; padding: 0; list-style: none; transition: opacity .15s; }
.notice-list.dim { opacity: .55; }
.notice-list li + li { border-top: 1px solid var(--color-border); }
.notice-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 20px; align-items: center; gap: 20px; padding: 18px 4px; }
.date {
  display: flex; flex-direction: column; align-items: center; justify-content: center; height: 64px;
  border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface-alt);
}
.date strong { color: var(--color-text); font-size: 22px; line-height: 1.1; }
.date small { color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.title { color: var(--color-text); font-size: 16px; font-weight: 650; line-height: 1.45; transition: color .15s; }
.excerpt { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--color-text-secondary); font-size: 13px; line-height: 1.6; }
.meta { color: var(--color-text-muted); font-size: 12px; }
.chev { color: var(--color-text-muted); transition: transform .2s var(--ease-out), color .15s; }
.notice-row:hover .title { color: var(--color-accent-text); }
.notice-row:hover .chev { color: var(--color-accent-text); transform: translateX(3px); }
.skeleton { margin: 0; padding: 0; list-style: none; }
.skeleton li { display: flex; gap: 20px; padding: 18px 4px; }
.sk { display: block; border-radius: 8px; background: linear-gradient(90deg, var(--color-surface-alt), var(--color-hover), var(--color-surface-alt)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
.sk-date { width: 64px; height: 64px; flex: 0 0 64px; border-radius: 12px; }
.sk-lines { display: flex; flex: 1; flex-direction: column; gap: 10px; padding-top: 6px; }
.sk-title { width: 60%; height: 16px; }
.sk-text { width: 90%; height: 12px; }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (max-width: 640px) {
  .list-panel { padding: 4px 14px 14px; }
  .notice-row { grid-template-columns: 52px minmax(0, 1fr); gap: 14px; }
  .date { height: 52px; }
  .date strong { font-size: 18px; }
  .chev { display: none; }
  .search { width: 100%; }
}
</style>
