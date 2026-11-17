<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowLeftRight, ChartNoAxesColumn, Compass, House, Wallet } from '@lucide/vue'

/**
 * Phone bottom navigation (2026-11-17): 首页 / 行情 / 交易 / 探索 / 资产 (futures sit inside 交易: MobileTradeSwitch), fixed to the viewport bottom at
 * ≤720px and absent above it. App.vue reserves its height (`--mobile-tabbar-h`) so nothing is covered.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { label: '主导航', home: '首页', markets: '行情', trade: '交易', futures: '合约', explore: '探索', assets: '资产' },
    'en-US': { label: 'Main navigation', home: 'Home', markets: 'Markets', trade: 'Trade', futures: 'Futures', explore: 'Explore', assets: 'Assets' },
  },
})
const route = useRoute()
const items = computed(() => [
  { key: 'home', to: '/', icon: House, names: ['home'] },
  { key: 'markets', to: '/markets', icon: ChartNoAxesColumn, names: ['markets'] },
  { key: 'trade', to: '/trade', icon: ArrowLeftRight, names: ['trade', 'margin', 'futures', 'futures-data', 'copy-trading'] },
  { key: 'explore', to: '/explore', icon: Compass, names: ['explore', 'earn', 'loans', 'launchpad', 'launchpool', 'vesting', 'predict'] },
  { key: 'assets', to: '/assets', icon: Wallet, names: ['assets'] },
])
const isActive = (names: string[]): boolean => names.includes(String(route.name ?? ''))
</script>

<template>
  <nav class="mobile-tabbar" :aria-label="t('label')">
    <RouterLink
      v-for="item in items"
      :key="item.key"
      class="mobile-tab"
      :class="{ active: isActive(item.names), primary: item.key === 'trade' }"
      :to="item.to"
      :aria-current="isActive(item.names) ? 'page' : undefined"
      :data-testid="`mobile-tab-${item.key}`"
    >
      <span class="mobile-tab-icon"><component :is="item.icon" :size="item.key === 'trade' ? 22 : 21" :stroke-width="isActive(item.names) || item.key === 'trade' ? 2.2 : 1.8" aria-hidden="true" /></span>
      <span>{{ t(item.key) }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.mobile-tabbar { display: none; }
@media (max-width: 720px) {
  .mobile-tabbar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
    display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
    height: calc(56px + env(safe-area-inset-bottom, 0px)); padding-bottom: env(safe-area-inset-bottom, 0px);
    border-top: 1px solid var(--color-border); background: var(--color-surface);
  }
  .mobile-tab {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    min-width: 0; color: var(--color-text-muted); font-size: 11px; font-weight: 600; text-decoration: none;
  }
  .mobile-tab.active { color: var(--color-accent-text); }
  /* Active tab: the icon fills with soft gold, pops once, and a small light sits under it. */
  .mobile-tab:not(.primary).active .mobile-tab-icon { animation: tab-pop .32s ease-out; filter: drop-shadow(0 0 6px color-mix(in srgb, var(--color-accent) 70%, transparent)); }
  .mobile-tab:not(.primary).active .mobile-tab-icon :deep(svg) { fill: color-mix(in srgb, var(--color-accent) 30%, transparent); }
  .mobile-tab:not(.primary) { position: relative; }
  .mobile-tab:not(.primary).active::before { content: ''; position: absolute; top: 0; left: 50%; width: 22px; height: 2px; margin-left: -11px; border-radius: 0 0 3px 3px; background: var(--color-accent); box-shadow: 0 2px 10px var(--color-accent); }
  @keyframes tab-pop { 0% { transform: scale(.8); } 60% { transform: scale(1.14); } 100% { transform: scale(1); } }
  .mobile-tab-icon { display: inline-flex; align-items: center; justify-content: center; height: 22px; transition: transform .12s ease; }
  .mobile-tab:active .mobile-tab-icon { transform: scale(.9); }
  /* 交易: the raised gold button in the middle, as on the large exchanges' apps. */
  .mobile-tabbar { overflow: visible; }
  .mobile-tab.primary { position: relative; justify-content: flex-end; padding-bottom: 7px; }
  .mobile-tab.primary .mobile-tab-icon {
    position: absolute; top: -16px; left: 50%; width: 48px; height: 48px; margin-left: -24px; border-radius: 50%; color: #1a1408;
    background: linear-gradient(145deg, #ffe9a0, #f2c64e 38%, #c08a22); border: 3px solid var(--color-surface);
    box-shadow: 0 8px 18px -8px rgba(217, 168, 90, .9), inset 0 1px 0 rgba(255, 255, 255, .5);
  }
  .mobile-tab.primary::before { content: ''; position: absolute; top: -16px; left: 50%; width: 48px; height: 48px; margin-left: -24px; border-radius: 50%; background: radial-gradient(circle, rgba(242, 198, 78, .55), transparent 70%); animation: tab-breathe 3.200s ease-in-out infinite; pointer-events: none; }
  @keyframes tab-breathe { 0%, 100% { transform: scale(1); opacity: .35; } 50% { transform: scale(1.45); opacity: .8; } }
  @media (prefers-reduced-motion: reduce) { .mobile-tab.primary::before, .mobile-tab .mobile-tab-icon { animation: none !important; } }
  .mobile-tab.primary:active .mobile-tab-icon { transform: scale(.94); }
  .mobile-tab.primary.active { color: var(--color-accent-text); }
}
</style>
