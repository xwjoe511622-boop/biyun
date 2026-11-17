<script setup lang="ts">
import { translateForLocale } from '@/i18n/composer'
import { onBeforeUnmount, ref, watch } from 'vue'
import RichText from '@/components/content/RichText.vue'
import { loadAgreement, type AgreementKind, type AgreementPublication } from '@/modules/business/agreement'
import { PRODUCT_AGREEMENT_PATHS } from '@/modules/business/agreements/metadata'
import { type Lang } from '@/modules/business/format'
const props = defineProps<{ kind: AgreementKind; lang: Lang; expanded?: boolean }>()
const emit = defineEmits<{ (event: 'ready', ready: boolean): void }>()
const article = ref<AgreementPublication | null>(null)
const loading = ref(false)
const error = ref(false)
let controller: AbortController | null = null
const uiText = (key: string, values?: Record<string, unknown>) => translateForLocale(props.lang, key, values)
async function load(): Promise<void> {
  controller?.abort()
  const mine = new AbortController(); controller = mine
  loading.value = true; error.value = false; article.value = null; emit('ready', false)
  try {
    const result = await loadAgreement(props.kind, mine.signal, props.lang)
    if (controller !== mine) return
    article.value = result
    emit('ready', result !== null)
  } catch { if (controller === mine) error.value = true }
  finally { if (controller === mine) loading.value = false }
}
watch(() => [props.kind, props.lang], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { controller?.abort(); controller = null })
</script>
<template>
  <div class="agreement" :class="{ full: expanded }" :data-source="article?.source" :data-publication-status="article?.cmsStatus">
    <p v-if="loading">{{ uiText('businessAgreement.loadingServiceAgreement') }}</p>
    <p v-else-if="error">{{ uiText('businessAgreement.theProductRulesCannotBeReadRightNowPlease') }} <button type="button" class="btn btn-ghost" @click="load">{{ uiText('businessAgreement.retry') }}</button></p>
    <p v-else-if="!article" role="status">{{ uiText('businessAgreement.theProductRulesCannotBeReadRightNowThis') }}</p>
    <template v-else>
      <p v-if="article.source === 'site'" class="agreement-source" :class="{ warning: !['missing', 'published'].includes(article.cmsStatus) }" role="status">
        <template v-if="article.cmsStatus !== 'missing'">{{ uiText('businessAgreement.onlineTermsAreTemporarilyUnavailableYouAreReadingThe') }}</template>
        <template v-else>{{ uiText('businessAgreement.youAreReadingThePublishedSiteRules') }}</template>
        v{{ article.version }}{{ uiText('businessAgreement.label') }} · {{ article.versionDate }}
      </p>
      <p v-else class="agreement-source">{{ uiText('businessAgreement.youAreReadingThePlatformSPublishedOnlineProduct') }}</p>
      <p v-if="!expanded"><a :href="PRODUCT_AGREEMENT_PATHS[kind]" target="_blank" rel="noopener">{{ uiText('businessAgreement.readInASeparatePage') }}</a></p>
      <details :open="expanded"><summary>{{ uiText('businessAgreement.read') }}《{{ article.title }}》</summary><RichText :html="article.content" /></details>
    </template>
  </div>
</template>
<style scoped>
.agreement { min-width: 0; font-size: var(--font-size-xs); line-height: 1.6; color: var(--color-text-secondary); }
.agreement p { margin: 0; }
summary { cursor: pointer; color: var(--color-accent-text); }
details[open] { max-height: 300px; overflow-y: auto; }
.full details[open] { max-height: none; overflow: visible; }
.agreement-source { margin-bottom: 8px !important; }
.agreement-source.warning { color: var(--color-warning); }
a { color: var(--color-accent-text); }
</style>
