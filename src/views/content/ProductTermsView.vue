<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BusinessAgreement from '@/components/business/ui/BusinessAgreement.vue'
import type { AgreementKind } from '@/modules/business/agreement'
import type { Lang } from '@/modules/business/format'
const props = defineProps<{ kind: AgreementKind }>()
const { t, locale } = useI18n()
const lang = computed<Lang>(() => String(locale.value).toLowerCase().startsWith('zh') ? 'zh' : 'en')
const title = computed(() => props.kind === 'earn' ? (t('productTerms.simpleEarnAgreement')) : (t('productTerms.cryptoLoanAgreement')))
</script>
<template>
  <main class="product-terms">
    <h1>{{ title }}</h1>
    <p class="subtitle">{{ t('productTerms.productRulesAndRiskDisclosure') }}</p>
    <BusinessAgreement :kind="kind" :lang="lang" expanded />
  </main>
</template>
<style scoped>
.product-terms { width: min(920px, 100%); min-width: 0; margin: 0 auto; padding: 28px 20px 56px; overflow-wrap: anywhere; }
h1 { margin: 0 0 8px; font-size: 28px; }
.subtitle { margin: 0 0 24px; color: var(--color-text-secondary); }
</style>
