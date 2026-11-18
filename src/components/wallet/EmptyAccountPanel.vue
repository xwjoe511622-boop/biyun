<script setup lang="ts">
import { BRAND_NAME } from '@/core/brand'
import { useI18n } from 'vue-i18n'
import { Search } from '@lucide/vue'
import AssetValuation from '@/components/wallet/AssetValuation.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { WALLET_MESSAGES } from '@/modules/wallet/i18n'

/**
 * An account that exists but holds no coins yet (生态账户 / 引擎账户). It shows the same summary card and holdings
 * table as the other accounts, with a zero total and an empty list. When the backend starts returning holdings
 * for the account, replace the empty state with the account's rows.
 */
const props = defineProps<{ title: string; description: string; emptyMessage: string }>()

const { t } = useI18n({ useScope: 'local', messages: {
  'zh-CN': { ...WALLET_MESSAGES['zh-CN'] },
  'en-US': { ...WALLET_MESSAGES['en-US'] },
} })
</script>

<template>
  <div class="stack balances">
    <section class="summary" :data-brand="BRAND_NAME">
      <div class="summary-main">
        <AssetValuation :label="props.title" total="0" symbol="BTC" :max-font="34" />
        <small class="overview-scope">{{ props.description }}</small>
      </div>
    </section>

    <section class="holdings">
      <div class="wallet-toolbar">
        <label class="wallet-search">
          <Search :size="14" aria-hidden="true" />
          <input type="search" disabled :placeholder="t('wallet.searchPlaceholder')" :aria-label="t('wallet.searchPlaceholder')" />
        </label>
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th class="col-coin">{{ t('wallet.coin') }}</th>
              <th>{{ t('wallet.available') }}</th>
              <th>{{ t('wallet.locked') }}</th>
              <th>{{ t('wallet.total') }}</th>
              <th>{{ t('wallet.btcValue') }}</th>
            </tr>
          </thead>
        </table>
      </div>
      <StateBlock variant="empty" :message="props.emptyMessage" />
    </section>
  </div>
</template>

<style scoped>
.balances { gap: 16px; margin-top: 8px; }
.summary {
  position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  padding: 26px 28px; overflow: hidden; border: 1px solid var(--color-border); border-radius: 18px;
  background: radial-gradient(ellipse 50% 140% at 100% 0%, var(--color-accent-soft), transparent 60%), var(--color-surface);
}
.summary-main { flex: 1 1 320px; min-width: 0; }
.overview-scope { display: block; margin-top: 6px; font-size: 12px; color: var(--color-text-muted); line-height: 1.5; }
.holdings { border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); overflow: hidden; }
.wallet-toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 18px; border-bottom: 1px solid var(--color-border); }
.wallet-search {
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px;
  border: 1px solid var(--color-border-strong); border-radius: var(--radius-pill); background: var(--color-surface-alt); color: var(--color-text-muted);
}
.wallet-search input { width: 180px; border: none; outline: none; background: transparent; color: var(--color-text); font-size: 13px; }
.table-scroll { overflow-x: auto; }
@media (max-width: 720px) { .table-scroll { display: none; } }
.table th { padding-top: 12px; padding-bottom: 12px; }
.table th:first-child { padding-left: 18px; }
.table th:last-child { padding-right: 18px; }
@media (max-width: 720px) {
  .summary { padding: 20px 18px 18px; border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border)); border-radius: 18px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, var(--color-surface)), var(--color-surface) 62%);
    box-shadow: 0 10px 28px -18px color-mix(in srgb, var(--color-accent) 70%, transparent); }
  .wallet-toolbar { padding: 12px; }
  .wallet-search { width: 100%; }
  .wallet-search input { width: 100%; min-width: 0; }
}
/* Phones: the summary rises above the page's actions and tabs (views/AssetsView.vue orders the parts). */
@media (max-width: 720px) {
  .balances { display: contents; }
  .summary { order: 1; min-height: 168px; padding: 26px 20px 24px; align-content: center; }
  .holdings { order: 4; }
}
</style>
