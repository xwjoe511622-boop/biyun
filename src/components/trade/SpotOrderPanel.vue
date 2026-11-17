<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TicketSelect from '@/components/futures/TicketSelect.vue'
import { SKIN } from '@/core/skin'
import { isLeverSwitchOpen } from '@/modules/margin/symbols'
import { useMarketStore } from '@/stores/market'
import type { OrderType } from '@/modules/finance/precision'
import { SPOT_TIFS, type SpotTimeInForce } from '@/modules/spot/spot-order'
import type { PriceSuggestion } from '@/modules/trade/book-fill'
import { useOrdersStore } from '@/stores/orders'
import OrderForm from './OrderForm.vue'

const { t } = useI18n()
/** OKX skin wording: 交易 tab, 限价委托 / 市价委托. */
const { t: tl } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { trade: '交易', limit: '限价委托', market: '市价委托', lever: '杠杆', buy: '买入', sell: '卖出', side: '买卖方向' },
    'en-US': { trade: 'Trade', limit: 'Limit', market: 'Market', lever: 'Margin', buy: 'Buy', sell: 'Sell', side: 'Side' },
  },
})
const props = defineProps<{ priceSuggestion?: PriceSuggestion; marginTitle?: string; sideRequest?: { side: 'BUY' | 'SELL'; at: number } }>()
const orders = useOrdersStore()
/** OKX skin: the 杠杆 switch beside the 交易 tab opens the margin terminal when margin trading is enabled. */
const spotMarket = useMarketStore()
const leverOpen = computed(() => SKIN === 'okx' && isLeverSwitchOpen(spotMarket.publicInfo))
const orderType = ref<OrderType>('1')
/** Phones show one ticket at a time, chosen with the 买入 / 卖出 switch (wider screens show both side by side). */
const side = ref<'BUY' | 'SELL'>('BUY')
// The phone chart view's 买入 / 卖出 buttons open the ticket on that side.
watch(() => props.sideRequest, (request) => { if (request !== undefined) side.value = request.side })
/** 成交方式 of limit orders (Binance GTC / IOC / FOK); IOC and FOK need `/api/v3`, so the selector exists only then. */
const tif = ref<SpotTimeInForce>('GTC')
const tifOptions = computed(() => SPOT_TIFS.map((value) => ({ value, label: t(`trade.tif.${value}`), desc: t(`trade.tif.${value}Desc`) })))
const showTif = computed(() => orders.v3Available)
watch(showTif, (on) => { if (!on) tif.value = 'GTC' })
const formTif = computed<SpotTimeInForce | undefined>(() => (orderType.value === '1' && showTif.value ? tif.value : undefined))
</script>

<template>
  <section class="spot-orders" :class="{ 'okx-spot': SKIN === 'okx' }">
    <template v-if="SKIN === 'okx'">
      <header class="okx-head">
        <span class="okx-head-tab">{{ tl('trade') }}</span>
        <RouterLink v-if="leverOpen" class="okx-lever" to="/margin" role="switch" aria-checked="false" data-testid="spot-lever-switch"><span>{{ tl('lever') }}</span><i aria-hidden="true"></i></RouterLink>
      </header>
      <div class="okx-types">
        <div class="type-tabs" role="group" :aria-label="t('trade.type')">
          <button class="type-tab" :class="{ active: orderType === '1' }" :aria-pressed="orderType === '1'" @click="orderType = '1'">{{ tl('limit') }}</button>
          <button class="type-tab" :class="{ active: orderType === '2' }" :aria-pressed="orderType === '2'" @click="orderType = '2'">{{ tl('market') }}</button>
        </div>
        <span v-if="!marginTitle" class="tif" :class="{ idle: !showTif || orderType !== '1' }" :title="t('trade.tif.title')">
          <TicketSelect v-model="tif" :options="tifOptions" :label="t('trade.tif.title')" testid="spot-tif" :disabled="!showTif || orderType !== '1'" />
        </span>
      </div>
    </template>
    <header v-else class="spot-head">
      <span class="spot-title">{{ marginTitle ?? t('trade.placeOrder') }}</span>
      <div class="type-tabs" role="group" :aria-label="t('trade.type')">
        <button class="type-tab" :class="{ active: orderType === '1' }" :aria-pressed="orderType === '1'" @click="orderType = '1'">{{ t('trade.limitPrice') }}</button>
        <button class="type-tab" :class="{ active: orderType === '2' }" :aria-pressed="orderType === '2'" @click="orderType = '2'">{{ t('trade.marketPrice') }}</button>
      </div>
      <!-- Always in the layout (visibility only): switching 限价 / 市价 never moves anything. -->
      <span v-if="!marginTitle" class="tif" :class="{ idle: !showTif || orderType !== '1' }" :title="t('trade.tif.title')">
        <TicketSelect v-model="tif" :options="tifOptions" :label="t('trade.tif.title')" testid="spot-tif" :disabled="!showTif || orderType !== '1'" />
      </span>
    </header>
    <div class="side-switch" role="group" :aria-label="tl('side')">
      <button class="side-btn buy" :class="{ active: side === 'BUY' }" type="button" :aria-pressed="side === 'BUY'" data-testid="spot-side-buy" @click="side = 'BUY'">{{ tl('buy') }}</button>
      <button class="side-btn sell" :class="{ active: side === 'SELL' }" type="button" :aria-pressed="side === 'SELL'" data-testid="spot-side-sell" @click="side = 'SELL'">{{ tl('sell') }}</button>
    </div>
    <div class="tickets" :class="side === 'BUY' ? 'show-buy' : 'show-sell'">
      <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
      <slot name="buy" :order-type="orderType"><OrderForm side="BUY" :order-type="orderType" :time-in-force="formTif" :price-suggestion="priceSuggestion" /></slot>
      <!-- float-ok: not money (kebab-case prop name price-suggestion) -->
      <slot name="sell" :order-type="orderType"><OrderForm side="SELL" :order-type="orderType" :time-in-force="formTif" :price-suggestion="priceSuggestion" /></slot>
    </div>
  </section>
</template>

<style scoped>
.spot-orders { min-width: 0; background: var(--color-surface); }
.spot-head { display: flex; align-items: center; gap: 18px; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--color-border); }
.spot-title { font-family: var(--font-display); font-size: 14px; font-weight: 650; }
.type-tabs { display: flex; gap: 4px; height: 100%; }
.type-tab { position: relative; height: 100%; padding: 0 10px; color: var(--color-text-muted); font-size: 13px; font-weight: 600; }
.type-tab:hover { color: var(--color-text); }
.type-tab.active { color: var(--color-text); }
.type-tab.active::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-accent); }
.tif { margin-left: auto; display: inline-flex; align-items: center; }
.tif.idle { visibility: hidden; }
.okx-head { display: flex; align-items: center; height: 44px; padding: 0 20px; border-bottom: 1px solid var(--color-border); }
.okx-head-tab { position: relative; display: inline-flex; align-items: center; height: 44px; font-size: 15px; font-weight: 700; }
.okx-head-tab::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--color-text); }
.okx-types { display: flex; align-items: center; height: 40px; margin: 0 20px; border-bottom: 1px solid var(--color-border); }
.okx-types .type-tabs { gap: 20px; }
.okx-types .type-tab { padding: 0; font-size: 13px; }
.okx-spot .tickets > :last-child { border-left: 0; }
.tickets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.tickets > :last-child { border-left: 1px solid var(--color-border); }
.side-switch { display: none; }
/* Phones: the 现货 | 杠杆 | 合约 bar above the terminal replaces this title row. */
@media (max-width: 720px) { .okx-head { display: none; } }
@media (max-width: 600px) {
  .tickets { grid-template-columns: minmax(0, 1fr); }
  .tickets > :last-child { border-left: 0; }
  .tickets.show-buy > :last-child, .tickets.show-sell > :first-child { display: none; }
  .side-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin: 10px 12px 0; padding: 3px; border-radius: 10px; background: var(--color-surface-alt); }
  .side-btn { height: 32px; border-radius: 8px; color: var(--color-text-muted); font-size: 14px; font-weight: 700; }
  .side-switch { padding: 4px; border-radius: 12px; }
  .side-btn { height: 34px; border-radius: 9px; transition: background-color .18s ease, color .18s ease, box-shadow .18s ease; }
  .side-btn.buy.active { background: linear-gradient(180deg, color-mix(in srgb, var(--color-up) 86%, #fff), var(--color-up)); color: #fff; box-shadow: 0 6px 14px -8px var(--color-up); }
  .side-btn.sell.active { background: linear-gradient(180deg, color-mix(in srgb, var(--color-down) 86%, #fff), var(--color-down)); color: #fff; box-shadow: 0 6px 14px -8px var(--color-down); }
}
/* H5 (≤768px, ticket at ~55% width beside the book): keep the header on one line. */
@media (max-width: 768px) {
  .spot-head { gap: 8px; white-space: nowrap; }
  .spot-title { font-size: 13px; }
  .type-tab { white-space: nowrap; padding: 0 6px; }
}
/* 320–400 px phones: 现货下单 / Spot order pushed 市价 / Market off the ticket; the tabs say enough. */
@media (max-width: 400px) {
  .spot-title { display: none; }
  /* OKX ticket: tighter gutters so the 有效方式 picker is not cut off at the column edge (mobile audit 10-22). */
  .okx-types { margin: 0 12px; gap: 8px; }
  .okx-types .type-tabs { gap: 12px; }
  .okx-types .type-tab { padding: 0; }
}
@media (max-width: 340px) {
  .okx-types { flex-wrap: wrap; height: auto; min-height: 40px; }
  .okx-types .type-tabs { height: 36px; }
  .okx-types .tif { margin-left: 0; padding-bottom: 4px; }
}
</style>
