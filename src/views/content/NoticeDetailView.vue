<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft, CalendarDays, FileQuestion, Megaphone } from '@lucide/vue'
import RichText from '@/components/content/RichText.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import { fetchNotice, fetchNotices, isNoticeId, type NoticeDetail, type NoticeSummary } from '@/modules/content/content.api'
import { errorMessage, formatDateTime } from '@/modules/content/api-helpers'
import { useContentI18n } from '@/modules/content/i18n'

/**
 * Announcement detail (`notice/notice_info`, `NoticeInfoAct.java:111`). The body is admin-authored HTML
 * and is rendered only through `RichText` (strict allowlist sanitizer). The sidebar lists the latest
 * notices from the list endpoint.
 */
const { t, locale } = useContentI18n()
const route = useRoute()

const notice = ref<NoticeDetail | null>(null)
const recent = ref<NoticeSummary[]>([])
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null

const id = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const validId = computed(() => isNoticeId(id.value))

async function load(): Promise<void> {
  controller?.abort()
  notice.value = null
  error.value = ''
  if (!validId.value) return
  const current = new AbortController()
  controller = current
  loading.value = true
  try {
    const [detail, list] = await Promise.allSettled([
      fetchNotice(id.value, current.signal),
      fetchNotices({ page: 1, pageSize: 6 }, current.signal),
    ])
    if (controller !== current) return
    if (detail.status === 'fulfilled') notice.value = detail.value
    else error.value = errorMessage(detail.reason)
    recent.value = list.status === 'fulfilled' ? list.value.items.filter((item) => item.id !== id.value).slice(0, 5) : []
  } finally {
    if (controller === current) loading.value = false
  }
}

watch(id, () => void load(), { immediate: true })
watch(notice, (value) => {
  if (value !== null && value.title !== '') document.title = `${value.title} · ${document.title.split(' · ').pop() ?? ''}`
})
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div class="page detail-page">
    <RouterLink class="back" :to="{ name: 'notices' }"><ArrowLeft :size="16" aria-hidden="true" />{{ t('content.notices.back') }}</RouterLink>

    <div class="layout">
      <article class="panel article" :aria-busy="loading">
        <EmptyState v-if="!validId" :icon="FileQuestion" :title="t('content.notices.invalidId')" />
        <template v-else-if="loading && notice === null">
          <div class="sk sk-h"></div><div class="sk sk-m"></div>
          <div v-for="n in 6" :key="n" class="sk sk-p"></div>
        </template>
        <ErrorBanner v-else-if="error !== ''" :message="error" retryable @retry="load" />
        <template v-else-if="notice !== null">
          <header class="article-head">
            <span class="tag"><Megaphone :size="13" aria-hidden="true" />{{ t('content.notices.eyebrow') }}</span>
            <h1 class="article-title wrap-anywhere">{{ notice.title }}</h1>
            <p class="article-meta"><CalendarDays :size="14" aria-hidden="true" /><span class="num">{{ t('content.notices.published', { time: formatDateTime(notice.time, locale) }) }}</span></p>
          </header>
          <RichText :html="notice.content" />
        </template>
        <EmptyState v-else :icon="FileQuestion" :title="t('content.notices.notFound')" />
      </article>

      <aside v-if="recent.length > 0" class="panel side">
        <h2 class="side-title">{{ t('content.notices.more') }}</h2>
        <ul>
          <li v-for="item in recent" :key="item.id">
            <RouterLink :to="{ name: 'notice', params: { id: item.id } }">
              <span class="side-item wrap-anywhere">{{ item.title }}</span>
              <span class="side-time num">{{ formatDateTime(item.time, locale, false) }}</span>
            </RouterLink>
          </li>
        </ul>
        <RouterLink class="side-all" :to="{ name: 'notices' }">{{ t('content.notices.viewAll') }}</RouterLink>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.detail-page { max-width: 1180px; }
.back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 16px; color: var(--color-text-secondary); font-size: 13px; font-weight: 600; }
.back:hover { color: var(--color-accent-text); }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.layout:has(> :only-child) { grid-template-columns: minmax(0, 1fr); max-width: 860px; }
.article { padding: 36px 44px 44px; min-height: 320px; }
.article-head { padding-bottom: 22px; margin-bottom: 26px; border-bottom: 1px solid var(--color-border); }
.tag { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 12px; font-weight: 650; }
.article-title { margin: 14px 0 10px; font-size: 30px; line-height: 1.3; font-weight: 750; letter-spacing: -.02em; }
.article-meta { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--color-text-muted); font-size: 13px; }
.side { position: sticky; top: calc(var(--header-h) + 24px); padding: 18px 18px 14px; }
.side-title { margin: 0 0 8px; font-size: 14px; font-weight: 700; }
.side ul { margin: 0; padding: 0; list-style: none; }
.side li a { display: flex; flex-direction: column; gap: 3px; padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.side-item { color: var(--color-text-secondary); font-size: 13px; line-height: 1.5; transition: color .15s; }
.side li a:hover .side-item { color: var(--color-accent-text); }
.side-time { color: var(--color-text-muted); font-size: 11px; }
.side-all { display: inline-block; margin-top: 12px; color: var(--color-accent-text); font-size: 13px; font-weight: 600; }
.sk { border-radius: 8px; background: var(--color-surface-alt); margin-bottom: 14px; }
.sk-h { width: 70%; height: 30px; }
.sk-m { width: 30%; height: 14px; margin-bottom: 30px; }
.sk-p { width: 100%; height: 14px; }
.sk-p:nth-child(3n) { width: 82%; }
@media (max-width: 960px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; }
}
@media (max-width: 640px) {
  .article { padding: 22px 18px 28px; }
  .article-title { font-size: 22px; }
}
</style>
