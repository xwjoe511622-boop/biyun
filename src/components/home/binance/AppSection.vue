<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Monitor, Smartphone } from '@lucide/vue'
import BrandMark from '@/components/common/BrandMark.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { BRAND_NAME } from '@/core/brand'
import { SITE_DOMAIN } from '@/config/site'
import type { HomeMarketRow } from './use-home-markets'

/**
 * App section. The native app is not released yet, so there are no store badges or download links: the phone
 * frame shows the live markets as they look on the mobile web today. Compact two columns, no motion.
 */
const props = defineProps<{ rows: HomeMarketRow[] }>()

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '随时随地，掌握行情',
      sub: '{brand} App 正在开发中，发布后将在这里提供下载。在此之前，用手机浏览器打开 {site} 即可使用完整的交易与资产功能。',
      soon: '即将推出',
      web: '手机网页版',
      webDesc: '现已可用',
      desktop: '桌面浏览器',
      markets: '行情',
    },
    'en-US': {
      title: 'Markets in your pocket',
      sub: 'The {brand} app is in development and will be available to download here once it ships. Until then, open {site} in your phone’s browser for full trading and asset features.',
      soon: 'Coming soon',
      web: 'Mobile web',
      webDesc: 'Available now',
      desktop: 'Desktop browser',
      markets: 'Markets',
    },
  },
})
const site = `www.${SITE_DOMAIN}`
const phoneRows = computed(() => props.rows.slice(0, 5))
</script>

<template>
  <section class="bn-section app" data-fx>
    <div class="bn-section-inner">
    <div class="app-inner glass">
      <div class="phone-stage">
        <div class="phone" aria-hidden="true">
          <div class="phone-screen">
            <div class="phone-top"><BrandMark :size="18" /><strong>{{ BRAND_NAME }}</strong></div>
            <div class="phone-title">{{ t('markets') }}</div>
            <ul class="phone-rows">
              <li v-for="row in phoneRows" :key="row.key">
                <CoinMark :symbol="row.base" :icon-url="row.icon" :size="20" />
                <span class="p-name">{{ row.base }}<small>/{{ row.quote }}</small></span>
                <span class="num p-price">{{ row.last }}</span>
                <span class="num p-change" :class="row.change.direction">{{ row.change.text }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div class="app-copy">
        <h2>{{ t('title') }}</h2>
        <p>{{ t('sub', { brand: BRAND_NAME, site }) }}</p>
        <ul class="platforms">
          <li class="is-live"><Smartphone :size="22" :stroke-width="1.6" /><span><strong>{{ t('web') }}</strong><small>{{ t('webDesc') }}</small></span></li>
          <li class="is-live"><Monitor :size="22" :stroke-width="1.6" /><span><strong>{{ t('desktop') }}</strong><small>{{ t('webDesc') }}</small></span></li>
          <li><span class="os">iOS</span><span><strong>App Store</strong><small>{{ t('soon') }}</small></span></li>
          <li><span class="os">Android</span><span><strong>Android</strong><small>{{ t('soon') }}</small></span></li>
        </ul>
      </div>
    </div>
    </div>
  </section>
</template>

<style scoped>
.app-inner { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 48px; align-items: end; padding: 36px 48px 0; overflow: hidden; }
.app-copy { padding-bottom: 36px; }
.phone-stage { order: 1; justify-self: center; align-self: end; }
.app-copy { align-self: center; }
.phone {
  position: relative; width: 260px; padding: 10px 10px 0; border: 1px solid var(--color-border-strong); border-bottom: 0; border-radius: 36px 36px 0 0;
  background: var(--color-surface-alt);
}
.phone-screen { height: 330px; padding: 18px 14px 0; overflow: hidden; border-radius: 28px 28px 0 0; background: var(--color-bg); }
.phone-top { display: flex; align-items: center; gap: 8px; color: var(--color-text); font-size: 14px; }
.phone-title { margin: 16px 0 6px; color: var(--color-text); font-size: 20px; font-weight: 700; }
.phone-rows { margin: 0; padding: 0; list-style: none; }
.phone-rows li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto auto; align-items: center; gap: 5px; height: 48px; border-bottom: 1px solid var(--color-border); }
.p-name { color: var(--color-text); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.p-name small { display: block; color: var(--color-text-muted); font-weight: 400; }
.p-price { color: var(--color-text); font-size: 12px; text-align: right; }
.p-change { font-size: 12px; text-align: right; }
.p-change.up { color: var(--color-up); }
.p-change.down { color: var(--color-down); }
.p-change.flat { color: var(--color-text-secondary); }
.app-copy h2 { margin: 0; color: var(--color-text); font-size: 32px; font-weight: 700; line-height: 1.2; }
.app-copy p { max-width: 520px; margin: 16px 0 0; color: var(--color-text-secondary); font-size: 16px; line-height: 1.65; }
.platforms { display: grid; grid-template-columns: repeat(2, minmax(0, 220px)); gap: 12px; margin: 24px 0 0; padding: 0; list-style: none; }
.platforms li {
  display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--glass-edge, var(--color-border)); border-radius: 14px;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-surface) 70%, transparent);
}
.platforms li.is-live { color: var(--color-text); }
.platforms li > span:last-child { display: flex; flex-direction: column; gap: 2px; }
.platforms strong { color: inherit; font-size: 14px; font-weight: 600; }
.platforms small { color: var(--color-text-muted); font-size: 12px; }
.platforms li.is-live small { color: var(--color-up); }
.os { min-width: 22px; font-size: 11px; font-weight: 700; }
@media (max-width: 900px) {
  .app-inner { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 24px 20px 0; }
  .app-copy { padding-bottom: 0; }
  .app-copy h2 { font-size: 26px; }
  .phone { width: 240px; }
  .phone-screen { height: 280px; }
}
@media (max-width: 480px) {
  .platforms { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .platforms li { padding: 12px; gap: 8px; }
}
</style>
