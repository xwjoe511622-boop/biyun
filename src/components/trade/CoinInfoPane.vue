<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CoinMark from '@/components/common/CoinMark.vue'
import { safeWebUrl } from '@/core/urls'
import type { CoinIntroItem } from '@/modules/api/types'
import { toDecString } from '@/modules/finance/decimal'

/**
 * 信息 tab of the OKX-style chart panel: the coin profile from `/common/coinSymbol_introduce` (same data as the
 * coin-intro page). `item` is resolved by ChartPanel, which only shows the tab when a profile exists.
 */
const props = defineProps<{ item: CoinIntroItem; base: string; icon: string }>()
const { t } = useI18n()

function amount(value: string | number | undefined): string {
  const text = toDecString(value)
  return text === '' ? '--' : text
}
const official = computed(() => safeWebUrl(props.item.officialUrl))
const explorer = computed(() => safeWebUrl(props.item.blockchainUrl))
</script>

<template>
  <div class="coin-info scroll-y">
    <header class="ci-head">
      <CoinMark :symbol="props.base" :icon-url="props.icon" :size="32" />
      <div class="ci-names">
        <b>{{ props.base }}</b>
        <span>{{ props.item.longName ?? props.item.shortName ?? '' }}</span>
      </div>
      <div class="ci-links">
        <a v-if="official !== ''" class="ci-link" :href="official" target="_blank" rel="noopener noreferrer">{{ t('coinIntro.officialSite') }}</a>
        <a v-if="explorer !== ''" class="ci-link" :href="explorer" target="_blank" rel="noopener noreferrer">{{ t('coinIntro.explorer') }}</a>
      </div>
    </header>
    <dl class="ci-facts">
      <div><dt>{{ t('coinIntro.publishTime') }}</dt><dd class="num">{{ props.item.publishTimeStr ?? '--' }}</dd></div>
      <div><dt>{{ t('coinIntro.publishAmount') }}</dt><dd class="num">{{ amount(props.item.publishAmount) }}</dd></div>
      <div><dt>{{ t('coinIntro.currencyAmount') }}</dt><dd class="num">{{ amount(props.item.currencyAmount) }}</dd></div>
    </dl>
    <h4 class="ci-sub">{{ t('coinIntro.introduction') }}</h4>
    <p class="ci-text wrap-anywhere">{{ props.item.introduction ?? '--' }}</p>
  </div>
</template>

<style scoped>
.coin-info { height: 100%; padding: 20px 24px 24px; overflow-y: auto; }
.ci-head { display: flex; align-items: center; gap: 12px; }
.ci-names { display: flex; flex-direction: column; gap: 2px; }
.ci-names b { font-size: 18px; font-weight: 750; }
.ci-names span { color: var(--color-text-muted); font-size: 12px; }
.ci-links { display: flex; gap: 8px; margin-left: auto; }
.ci-link { display: inline-flex; align-items: center; height: 30px; padding: 0 14px; border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text); font-size: 12px; font-weight: 600; }
.ci-link:hover { background: var(--color-hover); }
.ci-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0 0; padding: 16px 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); }
.ci-facts dt { color: var(--color-text-muted); font-size: 12px; }
.ci-facts dd { margin: 4px 0 0; font-size: 15px; font-weight: 650; }
.ci-sub { margin: 18px 0 8px; font-size: 14px; font-weight: 700; }
.ci-text { max-width: 76ch; margin: 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.75; }
</style>
