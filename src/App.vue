<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppHeader from '@/components/layout/AppHeader.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'
import NavProgress from '@/components/layout/NavProgress.vue'
import MobileTabBar from '@/components/layout/MobileTabBar.vue'
import MobileTradeSwitch from '@/components/layout/MobileTradeSwitch.vue'
import ToastHost from '@/components/common/ToastHost.vue'
import { useMarketStore } from '@/stores/market'
import { useFuturesQuizStore } from '@/stores/futures-quiz'

// The futures risk quiz lives with the futures widgets; load it only once a page asks for it, so every page
// does not download the futures terminal chunk up front.
const RiskQuizDialog = defineAsyncComponent(() => import('@/components/futures/RiskQuizDialog.vue'))
const futuresQuiz = useFuturesQuizStore()

const { t } = useI18n()
const route = useRoute()
const market = useMarketStore()
/** The trading terminal is full-bleed with a status bar; every other page gets the site footer. */
const terminal = computed(() => route.name === 'trade')
/** Phone bottom navigation: everywhere except the sign-in / sign-up flow. */
const tabBar = computed(() => !['login', 'register', 'recover-password'].includes(String(route.name ?? '')))
</script>

<template>
  <div class="app-shell" :class="{ 'is-terminal': terminal, 'has-tabbar': tabBar, 'route-home': route.name === 'home' || route.name === 'explore' }">
    <NavProgress />
    <AppHeader />
    <main class="app-main" :class="{ 'is-internal-transfer': route.name === 'internal-transfer' }">
      <MobileTradeSwitch v-if="route.name === 'trade' || route.name === 'margin' || route.name === 'futures'" />
      <RouterView />
    </main>
    <footer v-if="terminal" class="terminal-footer">
      <span class="connection" :class="market.connectionState">
        <i></i>{{ market.connectionState === 'open' ? t('status.connected') : market.connectionState === 'connecting' ? t('status.connecting') : t('status.closed') }}
      </span>
      <span>{{ t('brand.test') }}</span>
      <span class="num">{{ market.currentSymbol?.showPair ?? market.selectedPair }}</span>
    </footer>
    <SiteFooter v-else />
    <MobileTabBar v-if="tabBar" />
    <ToastHost />
    <RiskQuizDialog v-if="futuresQuiz.visible" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* Phones: reserve the bottom navigation's height so it never covers content or the terminal status bar. */
@media (max-width: 720px) {
  .app-shell.has-tabbar { --mobile-tabbar-h: calc(56px + env(safe-area-inset-bottom, 0px)); padding-bottom: var(--mobile-tabbar-h); }
  /* Each page fades and rises a few pixels as it opens (owner 2026-11-17: app-like, never slower than 0.22 s). */
  .app-main > :not(.trade-switch) { animation: page-in .22s cubic-bezier(.2, .7, .2, 1); }
  @media (prefers-reduced-motion: reduce) { .app-main > :not(.trade-switch) { animation: none; } }
  /* The connection strip is desktop chrome; the terminals show their own notice when the feed drops. */
  .app-shell.has-tabbar .terminal-footer { display: none; }
  /* Phone home is app-style: its own short risk note replaces the site footer. */
  /* Phones are app-style: no desktop site footer on any page with the bottom navigation; its legal links
     live in 个人中心 (/me). The sign-in / sign-up pages keep it. */
  .app-shell.has-tabbar :deep(.site-footer) { display: none; }
}

.app-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* Internal-transfer panel: a constrained reading column on a themed surface (mobile keeps it edge-safe). */
.app-main.is-internal-transfer {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 20px 40px;
  box-sizing: border-box;
}
.app-main.is-internal-transfer :deep(.internal-transfer) {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  padding: 20px 22px;
}
@media (max-width: 720px) {
  .app-main.is-internal-transfer { padding: 16px 12px 28px; }
  .app-main.is-internal-transfer :deep(.internal-transfer) { padding: 16px 14px; border-radius: 14px; }
}

.terminal-footer {
  /* Pinned to the viewport bottom like other exchanges' terminals (owner 10-21), not only at the end of the page. */
  position: sticky;
  bottom: 0;
  z-index: 30;
  min-height: 28px;
  border-top: 1px solid var(--color-border);
  display: flex;
  gap: 20px;
  align-items: center;
  padding: 4px 16px;
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: 11px;
}
.terminal-footer > :last-child { margin-left: auto; }
.connection { display: flex; align-items: center; gap: 7px; }
.connection i { width: 7px; height: 7px; border-radius: 50%; background: var(--color-text-muted); }
.connection.open { color: var(--color-up); }
.connection.open i { background: var(--color-up); color: var(--color-up); animation: pulse-dot 2s infinite; }
.connection.connecting { color: var(--color-warning); }
.connection.connecting i { background: var(--color-warning); }
@keyframes page-in { from { opacity: 0; transform: translateY(8px); } }
</style>
