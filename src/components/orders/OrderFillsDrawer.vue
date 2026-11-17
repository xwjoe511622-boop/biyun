<script setup lang="ts">
import { vVerticalScrollBoundary } from '@/core/vertical-scroll-boundary'
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { X } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isApiError } from '@/core/errors'
import { fetchTradesByOrder } from '@/modules/api/order.api'
import type { OrderItem, TradeItem } from '@/modules/api/types'
import { canonicalDecimal, groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { fetchMarginTradesByOrder } from '@/modules/margin/api'
import { exactAmount } from '@/modules/margin/risk'
import { useOrdersI18n } from './i18n'

/**
 * Fill details of one order: POST trade/list_by_order (spot, OrderAct.java:578) or
 * lever/trade/list_by_order (margin, LeverOrderAct.java:243), both `{symbol, order_id, page, pageSize}`.
 */
const props = defineProps<{
  open: boolean
  kind: 'spot' | 'margin'
  symbol: string
  pair: string
  order: OrderItem | null
  pricePrecision: number
  volumePrecision: number
}>()
const emit = defineEmits<{ (event: 'close'): void }>()

const { t } = useOrdersI18n()
const fills = shallowRef<TradeItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let version = 0

function show(value: string | undefined, dp: number): string {
  const normalized = canonicalDecimal(value ?? '')
  return isDecimalString(normalized) ? groupDigits(normalized, dp) : '--'
}

async function load(): Promise<void> {
  const order = props.order
  const current = ++version
  fills.value = []
  error.value = null
  if (!props.open || order === null || props.symbol === '') return
  loading.value = true
  try {
    const data = props.kind === 'margin'
      ? await fetchMarginTradesByOrder(props.symbol, order.id, 1, 100)
      : await fetchTradesByOrder(props.symbol, order.id, 1, 100)
    if (current === version) fills.value = data.trade_list ?? []
  } catch (error_) {
    if (current === version) error.value = isApiError(error_) || error_ instanceof Error ? error_.message : String(error_)
  } finally {
    if (current === version) loading.value = false
  }
}

watch(() => [props.open, props.order?.id, props.symbol, props.kind], () => void load(), { immediate: true })

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) emit('close')
}
document.addEventListener('keydown', onKey)
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="fills-drawer">
      <div v-if="open" class="drawer-backdrop" @mousedown.self="emit('close')">
        <aside class="drawer" role="dialog" aria-modal="true" :aria-label="t('orders.detailTitle')" data-testid="fills-drawer">
          <header class="drawer-head">
            <div>
              <h2>{{ t('orders.detailTitle') }}</h2>
              <p class="muted">{{ pair }} · {{ t('orders.col.orderId') }} <span class="num">{{ order?.id ?? '--' }}</span></p>
            </div>
            <button class="icon-button" type="button" :aria-label="t('common.close')" @click="emit('close')"><X :size="16" /></button>
          </header>
          <dl v-if="order !== null" class="summary">
            <div><dt>{{ t('orders.col.side') }}</dt><dd :class="order.side.toUpperCase() === 'BUY' ? 'up' : 'down'">{{ order.side.toUpperCase() === 'BUY' ? t('common.buy') : t('common.sell') }}</dd></div>
            <div><dt>{{ t('orders.col.price') }}</dt><dd class="num">{{ order.type === 2 ? t('trade.marketPrice') : show(order.price, pricePrecision) }}</dd></div>
            <div><dt>{{ t('orders.col.filled') }}</dt><dd class="num">{{ exactAmount(order.deal_volume) }} / {{ show(order.volume, volumePrecision) }}</dd></div>
            <div><dt>{{ t('orders.col.avgPrice') }}</dt><dd class="num">{{ show(order.avg_price, pricePrecision) }}</dd></div>
          </dl>
          <div v-vertical-scroll-boundary class="drawer-body">
            <StateBlock v-if="loading" variant="loading" :message="t('common.loading')" />
            <StateBlock v-else-if="error !== null" variant="error" :message="error" retryable @retry="load" />
            <StateBlock v-else-if="fills.length === 0" variant="empty" :message="t('orders.detailEmpty')" />
            <table v-else class="table">
              <thead><tr><th>{{ t('orders.col.time') }}</th><th>{{ t('orders.col.price') }}</th><th>{{ t('orders.col.amount') }}</th><th>{{ t('orders.col.total') }}</th><th>{{ t('orders.col.fee') }}</th></tr></thead>
              <tbody>
                <tr v-for="fill in fills" :key="String(fill.id)">
                  <td class="num muted">{{ fill.ctime ?? '--' }}</td>
                  <td class="num">{{ show(fill.price, pricePrecision) }}</td>
                  <td class="num">{{ exactAmount(fill.volume) }}</td>
                  <td class="num">{{ exactAmount(fill.deal_price) }}</td>
                  <td class="num">{{ exactAmount(fill.fee) }} {{ (fill.feeCoin ?? '').toUpperCase() }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-backdrop { position: fixed; inset: 0; z-index: 190; display: flex; justify-content: flex-end; background: rgba(3, 5, 8, 0.5); }
.drawer {
  width: min(560px, 100%); height: 100%; display: flex; flex-direction: column; background: var(--color-elevated);
  border-left: 1px solid var(--color-border-strong); box-shadow: var(--shadow-pop);
}
.drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 16px 12px 20px; border-bottom: 1px solid var(--color-border); }
.drawer-head h2 { margin: 0; font-size: 17px; }
.drawer-head p { margin: 4px 0 0; font-size: 12px; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 14px 20px; border-bottom: 1px solid var(--color-border); }
.summary dt { color: var(--color-text-muted); font-size: 11px; }
.summary dd { margin: 3px 0 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.drawer-body { flex: 1 1 auto; overflow: auto; padding: 4px 8px 16px; }
.table { table-layout: auto; }
.table th, .table td { font-size: 12px; padding: 9px 10px; }
/* Keep the page and panel in place; the backdrop and panel fade as one layer. */
.fills-drawer-enter-active, .fills-drawer-leave-active { transition: opacity 0.16s var(--ease-out); }
.fills-drawer-enter-from, .fills-drawer-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .fills-drawer-enter-active, .fills-drawer-leave-active { transition: none; } }
@media (max-width: 520px) { .summary { grid-template-columns: 1fr 1fr; } }
</style>
