<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCw } from '@lucide/vue'
import { canonicalDecimal, groupDigits } from '@/modules/finance/decimal'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

const { t } = useI18n()
const account = useAccountStore()
const market = useMarketStore()
const sessionStore = useSessionStore()

const symbol = computed(() => market.currentSymbol)

function display(value: string): string {
  const normalized = canonicalDecimal(value)
  return normalized === '' ? '--' : groupDigits(normalized, 8)
}
</script>

<template>
  <section class="balance">
    <header class="balance-head">
      <span class="balance-title">{{ t('assets.title') }}</span>
      <button class="icon-button refresh" type="button" :disabled="account.loading" :title="t('common.refresh')" :aria-label="t('common.refresh')" @click="account.load()">
        <RotateCw :size="14" :class="{ spin: account.loading }" aria-hidden="true" />
      </button>
    </header>
    <div class="balance-body">
      <div class="coin-line">
        <span class="coin">{{ symbol?.base ?? '--' }}</span>
        <span class="num">{{ display(account.baseAvailable) }}</span>
      </div>
      <div class="coin-line">
        <span class="coin">{{ symbol?.quote ?? '--' }}</span>
        <span class="num">{{ display(account.quoteAvailable) }}</span>
      </div>
      <div class="coin-line sub">
        <span>{{ t('common.locked') }} {{ symbol?.base ?? '' }}</span>
        <span class="num">{{ display(account.baseLocked) }}</span>
      </div>
      <p v-if="account.error !== null" class="notice notice-error wrap-anywhere">{{ account.error }}</p>
      <p v-else-if="!sessionStore.isAuthenticated" class="field-hint">{{ t('trade.loginToView') }}</p>
      <RouterLink v-else class="btn btn-block assets-link" to="/assets">{{ t('assets.title') }} →</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.balance { background: var(--color-surface); }
.balance-head { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--color-border); }
.balance-title { font-family: var(--font-display); font-size: 14px; font-weight: 650; }
.refresh { width: 30px; height: 30px; flex-basis: 30px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.balance-body { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
.coin-line { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
.coin { font-weight: 650; }
.coin-line.sub { color: var(--color-text-muted); font-size: 12px; }
.assets-link { height: 34px; margin-top: 2px; font-size: 12px; }
</style>
