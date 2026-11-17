<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Ban, CreditCard, List, Megaphone, PlusCircle, Settings2 } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import OtcAdvertForm from '@/components/otc/OtcAdvertForm.vue'
import OtcBlacklistPanel from '@/components/otc/OtcBlacklistPanel.vue'
import OtcMyAdvertsPanel from '@/components/otc/OtcMyAdvertsPanel.vue'
import OtcPaymentMethodsPanel from '@/components/otc/OtcPaymentMethodsPanel.vue'
import OtcSettingsPanel from '@/components/otc/OtcSettingsPanel.vue'
import OtcSubnav from '@/components/otc/OtcSubnav.vue'
import type { AdvertFormState } from '@/modules/otc/advert-form'
import { useOtcI18n } from '@/modules/otc/i18n'
import { useOtcStore } from '@/stores/otc'
import { useSessionStore } from '@/stores/session'

/**
 * `/otc/adverts`: my adverts, publish, receiving methods, C2C settings and blacklist as sub-tabs
 * (`?tab=`), since the module cannot add routes.
 */
type TabId = 'list' | 'publish' | 'payments' | 'settings' | 'blacklist'
const TABS: TabId[] = ['list', 'publish', 'payments', 'settings', 'blacklist']
const ICONS = { list: List, publish: PlusCircle, payments: CreditCard, settings: Settings2, blacklist: Ban } as const

const { t } = useOtcI18n()
const route = useRoute()
const router = useRouter()
const otc = useOtcStore()
const sessionStore = useSessionStore()

const tab = computed<TabId>(() => {
  const value = route.query.tab
  return typeof value === 'string' && (TABS as string[]).includes(value) ? value as TabId : 'list'
})
const prefill = ref<Partial<AdvertFormState> | null>(null)
const uid = computed(() => (sessionStore.user?.id === undefined || sessionStore.user?.id === null ? '' : String(sessionStore.user.id)))

function select(next: TabId): void {
  void router.replace({ query: { ...route.query, tab: next } })
}

function onDuplicate(value: Partial<AdvertFormState>): void {
  prefill.value = { ...value }
  select('publish')
}

watch(() => sessionStore.isAuthenticated, (authed) => {
  if (!authed) return
  if (sessionStore.user === null) void sessionStore.loadUserInfo()
  if (otc.accounts === null) void otc.loadAccounts()
}, { immediate: true })

onMounted(() => {
  void otc.ensureMarketInfo()
  void otc.loadPublicInfo()
})
</script>

<template>
  <div class="page adverts-page">
    <header class="page-head">
      <div>
        <h1>{{ t('otc.adverts.title') }}</h1>
        <p>{{ t('otc.adverts.subtitle') }}</p>
      </div>
      <OtcSubnav />
    </header>

    <GuestGate v-if="!sessionStore.isAuthenticated" :message="t('otc.adverts.login')" :icon="Megaphone" />
    <section v-else class="panel adverts-panel">
      <div class="sub-tabs" role="tablist">
        <button
          v-for="id in TABS"
          :id="`otc-tab-${id}`"
          :key="id"
          class="sub-tab"
          :class="{ active: tab === id }"
          type="button"
          role="tab"
          :aria-selected="tab === id"
          :aria-controls="`otc-panel-${id}`"
          @click="select(id)"
        >
          <component :is="ICONS[id]" :size="15" aria-hidden="true" />{{ t(`otc.adverts.tabs.${id}`) }}
        </button>
      </div>

      <div :id="`otc-panel-${tab}`" class="tab-body" role="tabpanel" :aria-labelledby="`otc-tab-${tab}`">
        <OtcMyAdvertsPanel v-if="tab === 'list'" :uid="uid" @duplicate="onDuplicate" />
        <OtcAdvertForm v-else-if="tab === 'publish'" :prefill="prefill" @published="prefill = null" />
        <OtcPaymentMethodsPanel v-else-if="tab === 'payments'" />
        <OtcSettingsPanel v-else-if="tab === 'settings'" />
        <OtcBlacklistPanel v-else />
      </div>
    </section>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
.page-head h1 { margin: 0; font-size: 30px; font-weight: 750; }
.page-head p { margin: 6px 0 0; color: var(--color-text-secondary); font-size: 14px; }
.adverts-panel { padding: 6px 22px 22px; }
.sub-tabs { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--color-border); margin-bottom: 20px; }
.sub-tab {
  display: inline-flex; align-items: center; gap: 6px; height: 46px; padding: 0 16px; border-bottom: 2px solid transparent;
  color: var(--color-text-muted); font-size: 14px; font-weight: 600; white-space: nowrap; transition: color 0.15s, border-color 0.15s;
}
.sub-tab:hover { color: var(--color-text); }
.sub-tab.active { color: var(--color-text); border-bottom-color: var(--color-accent); }
.sub-tab.active svg { color: var(--color-accent-text); }
@media (max-width: 640px) {
  .page-head h1 { font-size: 24px; }
  .adverts-panel { padding: 4px 14px 16px; }
  .sub-tab { padding: 0 12px; font-size: 13px; }
}
</style>
