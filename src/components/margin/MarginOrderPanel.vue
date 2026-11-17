<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SKIN } from '@/core/skin'
import type { OrderType } from '@/modules/finance/precision'
import { useMarginI18n } from '@/modules/margin/i18n'
import SpotOrderPanel from '@/components/trade/SpotOrderPanel.vue'
import MarginOrderForm from './MarginOrderForm.vue'

defineProps<{ compact?: boolean; priceSuggestion?: { price: string; sequence: number } }>()
const { t } = useMarginI18n()
const orderType = ref<OrderType>('1')
/** OKX skin wording: 交易 tab, 杠杆 switch, 限价委托 / 市价委托. */
const { t: tl } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { trade: '交易', lever: '杠杆', limit: '限价委托', market: '市价委托' },
    'en-US': { trade: 'Trade', lever: 'Margin', limit: 'Limit', market: 'Market' },
  },
})
</script>

<template>
  <!-- float-ok: hyphenated Vue prop names, no arithmetic -->
  <SpotOrderPanel v-if="compact" :margin-title="t('margin.form.title')">
    <!-- float-ok: order and price props pass through unchanged -->
    <template #buy="{ orderType: type }"><MarginOrderForm side="BUY" :order-type="type" :price-suggestion="priceSuggestion" /></template>
    <!-- float-ok: order and price props pass through unchanged -->
    <template #sell="{ orderType: type }"><MarginOrderForm side="SELL" :order-type="type" :price-suggestion="priceSuggestion" /></template>
  </SpotOrderPanel>
  <section v-else class="margin-orders" :class="{ 'okx-margin': SKIN === 'okx' }">
    <!-- OKX skin: 交易 tab with the 杠杆 switch on (back to spot), order types on their own row. -->
    <template v-if="SKIN === 'okx'">
      <header class="okx-head">
        <span class="okx-head-tab">{{ tl('trade') }}</span>
        <RouterLink class="okx-lever on" to="/trade" role="switch" aria-checked="true" data-testid="margin-lever-switch"><span>{{ tl('lever') }}</span><i aria-hidden="true"></i></RouterLink>
      </header>
      <div class="okx-types">
        <div class="type-tabs" role="group" :aria-label="t('trade.type')">
          <button class="type-tab" type="button" :class="{ active: orderType === '1' }" :aria-pressed="orderType === '1'" @click="orderType = '1'">{{ tl('limit') }}</button>
          <button class="type-tab" type="button" :class="{ active: orderType === '2' }" :aria-pressed="orderType === '2'" @click="orderType = '2'">{{ tl('market') }}</button>
        </div>
      </div>
    </template>
    <header v-else class="head">
      <span class="title">{{ t('margin.form.title') }}</span>
      <div class="type-tabs" role="group" :aria-label="t('trade.type')">
        <button class="type-tab" type="button" :class="{ active: orderType === '1' }" :aria-pressed="orderType === '1'" @click="orderType = '1'">{{ t('trade.limitPrice') }}</button>
        <button class="type-tab" type="button" :class="{ active: orderType === '2' }" :aria-pressed="orderType === '2'" @click="orderType = '2'">{{ t('trade.marketPrice') }}</button>
      </div>
    </header>
    <div class="tickets">
      <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
      <MarginOrderForm side="BUY" :order-type="orderType" :price-suggestion="priceSuggestion" />
      <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
      <MarginOrderForm side="SELL" :order-type="orderType" :price-suggestion="priceSuggestion" />
    </div>
  </section>
</template>

<style scoped>
.margin-orders { min-width: 0; background: var(--color-surface); }
.head { display: flex; align-items: center; gap: 18px; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--color-border); }
.title { font-family: var(--font-display); font-size: 14px; font-weight: 650; }
.type-tabs { display: flex; gap: 4px; height: 100%; }
.type-tab { position: relative; height: 100%; padding: 0 10px; color: var(--color-text-muted); font-size: 13px; font-weight: 600; }
.type-tab:hover, .type-tab.active { color: var(--color-text); }
.type-tab.active::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.okx-head { display: flex; align-items: center; height: 44px; padding: 0 20px; border-bottom: 1px solid var(--color-border); }
.okx-head-tab { position: relative; display: inline-flex; align-items: center; height: 44px; font-size: 15px; font-weight: 700; }
.okx-head-tab::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-text); }
.okx-types { display: flex; align-items: center; height: 40px; margin: 0 20px; border-bottom: 1px solid var(--color-border); }
.okx-types .type-tabs { gap: 20px; }
.okx-types .type-tab { padding: 0; font-size: 13px; }
.okx-margin .tickets > :last-child { border-left: 0; }
.tickets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.tickets > :last-child { border-left: 1px solid var(--color-border); }
@media (max-width: 600px) {
  .tickets { grid-template-columns: minmax(0, 1fr); }
  .tickets > :last-child { border-left: 0; border-top: 1px solid var(--color-border); }
}
</style>
