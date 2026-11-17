<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { fetchNotices, type NoticeSummary } from '@/modules/content/content.api'
import { formatDateTime } from '@/modules/content/api-helpers'

/** Hero news card: the four latest CMS announcements (`notice/notice_info_list`). Never shows placeholder news. */
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { title: '公告', all: '查看全部公告', empty: '暂无公告', failed: '公告暂时无法加载' },
    'en-US': { title: 'Announcements', all: 'View all', empty: 'No announcements yet', failed: 'Announcements are unavailable right now' },
  },
})
const items = ref<NoticeSummary[]>([])
const state = ref<'loading' | 'ready' | 'failed'>('loading')
let controller: AbortController | null = null

async function load(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    const result = await fetchNotices({ page: 1, pageSize: 4 }, current.signal)
    if (controller !== current) return
    items.value = result.items
    state.value = 'ready'
  } catch {
    if (controller !== current) return
    items.value = []
    state.value = 'failed'
  }
}

onMounted(() => void load())
watch(locale, () => void load())
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <section class="bn-card hero-news">
    <header class="card-head">
      <h2>{{ t('title') }}</h2>
      <RouterLink class="card-more" :to="{ name: 'notices' }">{{ t('all') }}<ChevronRight :size="14" /></RouterLink>
    </header>
    <ul v-if="items.length > 0" class="news">
      <li v-for="item in items" :key="item.id">
        <RouterLink :to="{ name: 'notice', params: { id: item.id } }">
          <span class="news-title">{{ item.title }}</span>
          <span class="news-date num">{{ formatDateTime(item.time, locale, false) }}</span>
        </RouterLink>
      </li>
    </ul>
    <template v-else-if="state === 'loading'">
      <div v-for="index in 3" :key="index" class="skeleton"></div>
    </template>
    <p v-else class="card-empty">{{ state === 'failed' ? t('failed') : t('empty') }}</p>
  </section>
</template>

<style scoped>
.hero-news { padding: 20px 24px 14px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.card-head h2 { margin: 0; color: var(--color-text); font-size: 15px; font-weight: 600; }
.card-more { display: inline-flex; align-items: center; gap: 2px; color: var(--color-text-secondary); font-size: 13px; }
.card-more:hover { color: var(--color-text); }
.news { margin: 0; padding: 0; list-style: none; }
.news a { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 9px 0; }
.news-title {
  min-width: 0; color: var(--color-text); font-size: 15px; line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.news a:hover .news-title { color: var(--color-accent-text); }
.news-date { flex: 0 0 auto; color: var(--color-text-muted); font-size: 12px; }
.skeleton { height: 18px; margin: 14px 0; border-radius: 4px; background: var(--color-surface-alt); }
.skeleton:nth-child(odd) { width: 80%; }
.card-empty { margin: 8px 0; color: var(--color-text-secondary); font-size: 14px; }
@media (max-width: 600px) {
  .hero-news { padding: 16px 16px 10px; }
  .news-title { font-size: 14px; }
}
</style>
