<script setup lang="ts">
import { ClipboardList, Megaphone, Store } from '@lucide/vue'
import { useOtcI18n } from '@/modules/otc/i18n'

/** In-module navigation between the three C2C routes (the global header links only `/otc`). */
const { t } = useOtcI18n()
const links = [
  { to: '/otc', key: 'otc.title', icon: Store, exact: true },
  { to: '/otc/orders', key: 'otc.myOrders', icon: ClipboardList, exact: false },
  { to: '/otc/adverts', key: 'otc.myAdverts', icon: Megaphone, exact: false },
]
</script>

<template>
  <nav class="otc-subnav" aria-label="C2C">
    <RouterLink
      v-for="link in links"
      :key="link.to"
      :to="link.to"
      class="subnav-link"
      :exact-active-class="link.exact ? 'active' : ''"
      :active-class="link.exact ? '' : 'active'"
    >
      <component :is="link.icon" :size="15" aria-hidden="true" />{{ t(link.key) }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.otc-subnav {
  display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-pill);
  background: var(--color-surface); max-width: 100%; overflow-x: auto;
}
.subnav-link {
  display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 16px; border-radius: var(--radius-pill);
  color: var(--color-text-secondary); font-size: 13px; font-weight: 600; white-space: nowrap; transition: background-color 0.15s, color 0.15s;
}
.subnav-link:hover { color: var(--color-text); background: var(--color-hover); }
.subnav-link.active { background: var(--color-accent); color: var(--color-on-accent); }
</style>
