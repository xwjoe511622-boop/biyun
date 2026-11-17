<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchNotices, type NoticeSummary } from '@/modules/content/content.api'
import { formatDateTime } from '@/modules/content/api-helpers'

/** Latest CMS announcements (`notice_info_list`). Renders nothing when there are none or the call fails. */
const { t, locale } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { title: '最新公告', all: '全部公告' },
    'en-US': { title: 'Announcements', all: 'All announcements' },
  },
})

const items = ref<NoticeSummary[]>([])
let controller: AbortController | null = null

async function load(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    const result = await fetchNotices({ page: 1, pageSize: 4 }, current.signal)
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
  <section v-if="items.length > 0" class="okx-sec">
    <div class="okx-wrap">
      <header class="okx-sec-head okx-sec-head-row">
        <h2 class="okx-h2">{{ t('title') }}</h2>
        <RouterLink class="okx-link" :to="{ name: 'notices' }">{{ t('all') }}</RouterLink>
      </header>
      <ul class="okx-news">
        <li v-for="item in items" :key="item.id">
          <RouterLink :to="{ name: 'notice', params: { id: item.id } }">
            <span class="okx-news-date num">{{ formatDateTime(item.time, locale, false) }}</span>
            <span class="okx-news-title">{{ item.title }}</span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.okx-news { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; margin: 32px 0 0; padding: 0; list-style: none; }
.okx-news a {
  display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 168px; padding: 28px; border-radius: 24px;
  border: 1px solid var(--color-border); background: var(--okx-panel); transition: border-color .15s;
}
.okx-news a:hover { border-color: var(--okx-gold-line); }
.okx-news-date { color: var(--color-text-muted); font-size: 13px; }
.okx-news-title {
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  font-size: 17px; font-weight: 650; line-height: 1.45;
}
@media (max-width: 1080px) { .okx-news { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .okx-news { grid-template-columns: minmax(0, 1fr); gap: 0; margin-top: 16px; }
  .okx-news a { min-height: 0; padding: 18px 0; border: 0; border-bottom: 1px solid var(--color-border); border-radius: 0; background: transparent; gap: 6px; }
  .okx-news-title { font-size: 15.5px; }
}
</style>
