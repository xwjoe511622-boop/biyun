<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Megaphone } from '@lucide/vue'
import { fetchNotices, type NoticeSummary } from '@/modules/content/content.api'
import { formatDateTime } from '@/modules/content/api-helpers'

/**
 * Home latest-announcements strip (`notice/notice_info_list`, first 3). Renders nothing when the API
 * returns no notices or fails — the home page never shows placeholder news.
 */
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { label: '最新公告', all: '全部公告' },
    'en-US': { label: 'Latest', all: 'All announcements' },
  },
})
const items = ref<NoticeSummary[]>([])
let controller: AbortController | null = null

async function load(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    const result = await fetchNotices({ page: 1, pageSize: 3 }, current.signal)
    if (controller === current) items.value = result.items
  } catch {
    if (controller === current) items.value = []
  }
}

onMounted(() => void load())
watch(locale, () => void load())
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div v-if="items.length > 0" class="notice-strip">
    <div class="strip-inner">
      <span class="strip-label"><Megaphone :size="15" aria-hidden="true" />{{ t('label') }}</span>
      <ul class="strip-items">
        <li v-for="item in items" :key="item.id">
          <RouterLink :to="{ name: 'notice', params: { id: item.id } }">
            <span class="strip-title ellipsis">{{ item.title }}</span>
            <span class="strip-date num">{{ formatDateTime(item.time, locale, false) }}</span>
          </RouterLink>
        </li>
      </ul>
      <RouterLink class="strip-all" :to="{ name: 'notices' }">{{ t('all') }}<ArrowRight :size="14" aria-hidden="true" /></RouterLink>
    </div>
  </div>
</template>

<style scoped>
.notice-strip { border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
.strip-inner { display: flex; align-items: center; gap: 20px; max-width: 1280px; min-height: 52px; margin: 0 auto; padding: 8px 24px; }
.strip-label { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; color: var(--color-accent-text); font-size: 13px; font-weight: 700; }
.strip-items { display: flex; flex: 1 1 auto; gap: 28px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.strip-items li { flex: 1 1 0; min-width: 0; }
.strip-items a { display: flex; align-items: baseline; gap: 10px; min-width: 0; color: var(--color-text-secondary); font-size: 13px; }
.strip-items a:hover .strip-title { color: var(--color-text); }
.strip-title { min-width: 0; transition: color .15s; }
.strip-date { flex: 0 0 auto; color: var(--color-text-muted); font-size: 11.5px; }
.strip-all { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; color: var(--color-text-muted); font-size: 12.5px; font-weight: 600; }
.strip-all:hover { color: var(--color-accent-text); }
@media (max-width: 900px) {
  .strip-items li:nth-child(n + 2) { display: none; }
}
@media (max-width: 560px) {
  .strip-inner { gap: 12px; padding: 8px 16px; }
  .strip-all { display: none; }
  .strip-date { display: none; }
}
</style>
