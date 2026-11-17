<script setup lang="ts">
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isLeverSwitchOpen } from '@/modules/margin/symbols'
import { useMarketStore } from '@/stores/market'

/**
 * Phones (≤720px): 现货 | 杠杆 | 合约 switch above the trading terminals. The bottom navigation has one 交易 tab
 * (owner 2026-11-17, OKX app layout), so this is how a phone user moves between spot and futures.
 * Margin has its own tab when the server enables it.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { label: '交易类型', spot: '现货', margin: '杠杆', futures: '合约' },
    'en-US': { label: 'Trading type', spot: 'Spot', margin: 'Margin', futures: 'Futures' },
  },
})
const route = useRoute()
const market = useMarketStore()
/** 杠杆 appears only when the server enables margin trading (the spot ticket's own switch used the same flag). */
const leverOpen = computed(() => isLeverSwitchOpen(market.publicInfo))
</script>

<template>
  <nav class="trade-switch" :aria-label="t('label')">
    <RouterLink class="ts-tab" :class="{ active: route.name === 'trade' || (route.name === 'margin' && !leverOpen) }" to="/trade" :aria-current="route.name === 'trade' ? 'page' : undefined" data-testid="trade-switch-spot">{{ t('spot') }}</RouterLink>
    <RouterLink v-if="leverOpen" class="ts-tab" :class="{ active: route.name === 'margin' }" to="/margin" :aria-current="route.name === 'margin' ? 'page' : undefined" data-testid="trade-switch-margin">{{ t('margin') }}</RouterLink>
    <RouterLink class="ts-tab" :class="{ active: route.name === 'futures' }" to="/futures" :aria-current="route.name === 'futures' ? 'page' : undefined" data-testid="trade-switch-futures">{{ t('futures') }}</RouterLink>
  </nav>
</template>

<style scoped>
.trade-switch { display: none; }
@media (max-width: 720px) {
  .trade-switch { display: flex; align-items: center; gap: 22px; height: 42px; padding: 0 14px; border-bottom: 1px solid var(--color-border); background: var(--color-bg); }
  .ts-tab { position: relative; display: inline-flex; align-items: center; height: 100%; color: var(--color-text-muted); font-family: var(--font-display); font-size: 17px; font-weight: 700; text-decoration: none; }
  .ts-tab.active { color: var(--color-text); }
  .ts-tab.active::after { content: ''; position: absolute; left: 15%; right: 15%; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
}
</style>
