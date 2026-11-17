<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { BookOpen, ChevronRight, FileText, LifeBuoy, Scale, Search, X } from '@lucide/vue'
import PageHead from '@/components/content/PageHead.vue'
import RichText from '@/components/content/RichText.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import {
  CMS_ARTICLE_NOT_FOUND,
  fetchCmsArticle,
  fetchFooterArticles,
  fetchHelpTree,
  searchHelp,
  type CmsArticle,
  type CmsLink,
  type HelpCategory,
} from '@/modules/content/content.api'
import { errorMessage, formatDateTime } from '@/modules/content/api-helpers'
import { useContentI18n } from '@/modules/content/i18n'
import { isApiError } from '@/core/errors'

/**
 * Help center.
 * - Categories + article titles: `cms/list` (`CmsAct.java:58`, HelpCenter type for the request language).
 * - Terms / privacy / other policy pages: `cms/footer/list` (`CmsAct.java:155`).
 * - Article body: `cms/info {fileName}` (`CmsAct.java:104`); the route param is the article `fileName`.
 * `RqInfoAct` is the logged-in support-ticket system, not a FAQ source, so it is not used here.
 * The server has no help search endpoint: search filters the loaded titles client-side.
 */
const { t, locale } = useContentI18n()
const route = useRoute()

const categories = ref<HelpCategory[]>([])
const policies = ref<CmsLink[]>([])
const treeLoading = ref(false)
const treeError = ref('')
const notConfigured = ref(false)
const article = ref<CmsArticle | null>(null)
const articleLoading = ref(false)
const articleError = ref('')
const articleMissing = ref(false)
const keyword = ref('')
const openCategory = ref<string | null>(null)
let treeController: AbortController | null = null
let articleController: AbortController | null = null

const fileName = computed(() => (typeof route.params.id === 'string' ? route.params.id.slice(0, 200) : ''))
const hits = computed(() => searchHelp(
  [...categories.value, ...(policies.value.length > 0 ? [{ id: 'policies', name: t('content.help.policies'), articles: policies.value }] : [])],
  keyword.value,
))
const hasContent = computed(() => categories.value.some((c) => c.articles.length > 0) || policies.value.length > 0)
/** Nothing published at all: one full-width empty state instead of an empty sidebar + reader. */
const bare = computed(() => !treeLoading.value && !hasContent.value && fileName.value === '')

async function loadTree(): Promise<void> {
  treeController?.abort()
  const current = new AbortController()
  treeController = current
  treeLoading.value = true
  treeError.value = ''
  notConfigured.value = false
  const [tree, footer] = await Promise.allSettled([fetchHelpTree(current.signal), fetchFooterArticles(current.signal)])
  if (treeController !== current) return
  if (tree.status === 'fulfilled') {
    categories.value = tree.value
  } else {
    categories.value = []
    // `CmsAct.list` throws (SystemError 10001) when no HelpCenter type exists for the language.
    if (isApiError(tree.reason) && tree.reason.kind === 'api' && tree.reason.code === '10001') notConfigured.value = true
    else treeError.value = errorMessage(tree.reason)
  }
  policies.value = footer.status === 'fulfilled' ? footer.value : []
  if (openCategory.value === null) openCategory.value = findCategoryOf(fileName.value) ?? categories.value[0]?.id ?? null
  treeLoading.value = false
}

function findCategoryOf(name: string): string | null {
  if (name === '') return null
  return categories.value.find((c) => c.articles.some((a) => a.fileName === name))?.id ?? null
}

async function loadArticle(): Promise<void> {
  articleController?.abort()
  article.value = null
  articleError.value = ''
  articleMissing.value = false
  if (fileName.value === '') return
  const current = new AbortController()
  articleController = current
  articleLoading.value = true
  try {
    const result = await fetchCmsArticle(fileName.value, current.signal)
    if (articleController !== current) return
    article.value = result
  } catch (failure) {
    if (articleController !== current) return
    if (isApiError(failure) && failure.code === CMS_ARTICLE_NOT_FOUND) articleMissing.value = true
    else articleError.value = errorMessage(failure)
  } finally {
    if (articleController === current) articleLoading.value = false
  }
}

function toggle(id: string): void {
  openCategory.value = openCategory.value === id ? null : id
}

watch(fileName, () => {
  void loadArticle()
  const owner = findCategoryOf(fileName.value)
  if (owner !== null) openCategory.value = owner
}, { immediate: true })
watch(locale, () => {
  void loadTree()
  void loadArticle()
})
onMounted(() => void loadTree())
onBeforeUnmount(() => {
  treeController?.abort()
  articleController?.abort()
})
</script>

<template>
  <div class="page help-page">
    <PageHead :icon="LifeBuoy" :eyebrow="t('content.help.eyebrow')" :title="t('content.help.title')" :lead="t('content.help.lead')">
      <label v-if="!bare" class="search">
        <Search :size="16" aria-hidden="true" />
        <input v-model="keyword" type="search" maxlength="60" :placeholder="t('content.help.search')" :aria-label="t('content.help.search')" />
        <button v-if="keyword !== ''" class="icon-button clear" type="button" :aria-label="t('content.notices.clear')" @click="keyword = ''"><X :size="15" /></button>
      </label>
    </PageHead>

    <ErrorBanner v-if="treeError !== ''" :message="treeError" retryable @retry="loadTree" />

    <div class="layout" :class="{ bare }">
      <nav v-if="!bare" class="panel sidebar" :aria-busy="treeLoading" :aria-label="t('content.help.categories')">
        <template v-if="keyword.trim() !== ''">
          <h2 class="side-label">{{ t('content.help.results') }}</h2>
          <p v-if="hits.length === 0" class="side-empty">{{ t('content.help.noResults', { q: keyword.trim() }) }}</p>
          <RouterLink v-for="hit in hits" :key="`${hit.category}-${hit.id}`" class="side-link" :to="{ name: 'help', params: { id: hit.fileName } }">
            <span class="wrap-anywhere">{{ hit.title }}</span><small>{{ hit.category }}</small>
          </RouterLink>
        </template>
        <template v-else>
          <h2 class="side-label">{{ t('content.help.categories') }}</h2>
          <div v-if="treeLoading && categories.length === 0" class="side-sk"><span v-for="n in 5" :key="n"></span></div>
          <p v-else-if="categories.length === 0" class="side-empty">{{ notConfigured ? t('content.help.notConfigured') : t('content.help.emptyMessage') }}</p>
          <div v-for="category in categories" :key="category.id" class="group">
            <button class="group-head" type="button" :aria-expanded="openCategory === category.id" @click="toggle(category.id)">
              <BookOpen :size="15" aria-hidden="true" />
              <span class="wrap-anywhere">{{ category.name }}</span>
              <small class="num">{{ category.articles.length }}</small>
              <ChevronRight class="caret" :class="{ open: openCategory === category.id }" :size="15" aria-hidden="true" />
            </button>
            <div v-show="openCategory === category.id" class="group-body">
              <p v-if="category.articles.length === 0" class="side-empty">{{ t('content.help.noArticles') }}</p>
              <RouterLink v-for="item in category.articles" :key="item.id" class="side-link" :class="{ active: item.fileName === fileName }" :to="{ name: 'help', params: { id: item.fileName } }">
                <span class="wrap-anywhere">{{ item.title }}</span>
              </RouterLink>
            </div>
          </div>
          <template v-if="policies.length > 0">
            <h2 class="side-label policies-label"><Scale :size="13" aria-hidden="true" />{{ t('content.help.policies') }}</h2>
            <RouterLink v-for="item in policies" :key="item.id" class="side-link" :class="{ active: item.fileName === fileName }" :to="{ name: 'help', params: { id: item.fileName } }">
              <span class="wrap-anywhere">{{ item.title }}</span>
            </RouterLink>
          </template>
        </template>
      </nav>

      <main class="panel reader" :aria-busy="articleLoading">
        <template v-if="fileName !== ''">
          <div v-if="articleLoading && article === null" class="reader-sk"><span class="h"></span><span v-for="n in 6" :key="n"></span></div>
          <ErrorBanner v-else-if="articleError !== ''" :message="articleError" retryable @retry="loadArticle" />
          <EmptyState v-else-if="articleMissing" :icon="FileText" :title="t('content.help.articleMissing')">
            <RouterLink class="btn" :to="{ name: 'help' }">{{ t('content.help.backToHelp') }}</RouterLink>
          </EmptyState>
          <article v-else-if="article !== null">
            <h1 class="reader-title wrap-anywhere">{{ article.title }}</h1>
            <p v-if="article.time !== null" class="reader-meta num">{{ t('content.help.updated', { time: formatDateTime(article.time, locale, false) }) }}</p>
            <RichText :html="article.content" />
          </article>
        </template>
        <template v-else>
          <div v-if="hasContent" class="overview">
            <p class="overview-hint">{{ t('content.help.pick') }}</p>
            <div class="cards">
              <section v-for="category in categories.filter((c) => c.articles.length > 0)" :key="category.id" class="card">
                <h3 class="wrap-anywhere"><BookOpen :size="16" aria-hidden="true" />{{ category.name }}</h3>
                <p class="card-count">{{ t('content.help.articles', category.articles.length) }}</p>
                <RouterLink v-for="item in category.articles.slice(0, 4)" :key="item.id" class="card-link" :to="{ name: 'help', params: { id: item.fileName } }">
                  <span class="wrap-anywhere">{{ item.title }}</span><ChevronRight :size="14" aria-hidden="true" />
                </RouterLink>
              </section>
            </div>
          </div>
          <div v-else-if="treeLoading" class="reader-sk"><span class="h"></span><span v-for="n in 4" :key="n"></span></div>
          <EmptyState
            v-else-if="treeError === ''"
            :icon="LifeBuoy"
            :title="t('content.help.emptyTitle')"
            :message="notConfigured ? t('content.help.notConfigured') : t('content.help.emptyMessage')"
          />
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.search {
  display: flex; align-items: center; gap: 8px; width: 320px; max-width: 100%; height: 42px; padding: 0 6px 0 14px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text-muted);
}
.search:focus-within { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.search input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); }
.search .clear { width: 30px; height: 30px; flex-basis: 30px; }
.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 20px; align-items: start; margin-top: 16px; }
.layout.bare { grid-template-columns: minmax(0, 1fr); }
.layout.bare .reader { min-height: 0; }
.sidebar { position: sticky; top: calc(var(--header-h) + 24px); max-height: calc(100vh - var(--header-h) - 50px); overflow-y: auto; padding: 14px 10px; }
.side-label { display: flex; align-items: center; gap: 6px; margin: 4px 10px 8px; color: var(--color-text-muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.policies-label { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--color-border); }
.side-empty { margin: 6px 10px; color: var(--color-text-muted); font-size: 13px; line-height: 1.6; }
.group-head {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px; border-radius: var(--radius);
  color: var(--color-text); font-size: 14px; font-weight: 600; text-align: left;
}
.group-head:hover { background: var(--color-hover); }
.group-head svg:first-child { flex: 0 0 auto; color: var(--color-accent-text); }
.group-head span { flex: 1 1 auto; min-width: 0; }
.group-head small { color: var(--color-text-muted); font-size: 11px; }
.caret { flex: 0 0 auto; color: var(--color-text-muted); transition: transform .2s var(--ease-out); }
.caret.open { transform: rotate(90deg); }
.group-body { padding: 2px 0 6px 18px; }
.side-link { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--radius); color: var(--color-text-secondary); font-size: 13px; line-height: 1.5; }
.side-link small { color: var(--color-text-muted); font-size: 11px; }
.side-link:hover { background: var(--color-hover); color: var(--color-text); }
.side-link.active { background: var(--color-accent-soft); color: var(--color-accent-text); font-weight: 600; }
.side-sk span { display: block; height: 34px; margin: 6px 4px; border-radius: 8px; background: var(--color-surface-alt); }
.reader { min-height: 420px; padding: 34px 40px 40px; }
.reader-title { margin: 0 0 6px; font-size: 26px; font-weight: 750; line-height: 1.3; }
.reader-meta { margin: 0 0 24px; color: var(--color-text-muted); font-size: 12px; }
.reader-sk span { display: block; height: 14px; margin-bottom: 14px; border-radius: 8px; background: var(--color-surface-alt); }
.reader-sk .h { width: 60%; height: 28px; margin-bottom: 26px; }
.overview-hint { margin: 0 0 18px; color: var(--color-text-secondary); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.card { padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-alt); }
.card h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; }
.card h3 svg { flex: 0 0 auto; color: var(--color-accent-text); }
.card-count { margin: 4px 0 10px; color: var(--color-text-muted); font-size: 12px; }
.card-link { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 0; border-top: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: 13px; }
.card-link:hover { color: var(--color-accent-text); }
.card-link svg { flex: 0 0 auto; }
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .sidebar { position: static; max-height: none; }
}
@media (max-width: 640px) {
  .reader { padding: 20px 16px 26px; }
  .reader-title { font-size: 21px; }
  .search { width: 100%; }
}
</style>
