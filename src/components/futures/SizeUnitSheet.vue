<script setup lang="ts">
import { ref } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import { useFuturesI18n } from '@/modules/futures/i18n'
import type { QuoteMode } from '@/modules/futures/order-entry'
import type { SizeUnit } from '@/modules/futures/size-unit'
import TicketPopover from './TicketPopover.vue'

/**
 * 「货币单位」 sheet (Binance style): the base coin, or USDT read as 订单金额 (notional) or
 * 初始保证金 (initial margin). Both choices are app-wide and remembered per browser by the caller's refs.
 */
const props = defineProps<{ baseCoin: string; quoteCoin: string; disabled?: boolean }>()
const unit = defineModel<SizeUnit>('unit', { required: true })
const quoteMode = defineModel<QuoteMode>('quoteMode', { required: true })
const { t } = useFuturesI18n()
const open = ref(false)

function chooseBase(): void {
  unit.value = 'base'
  open.value = false
}

function chooseQuote(mode?: QuoteMode): void {
  unit.value = 'quote'
  if (mode !== undefined) quoteMode.value = mode
}
</script>

<template>
  <TicketPopover v-model:open="open" align="right" :label="t('fut.unitSheet')">
    <template #trigger="{ toggle }">
      <button type="button" class="uss-trigger" data-testid="fut-unit-sheet" :disabled="disabled" :aria-label="t('fut.unitSheet')" :aria-expanded="open" aria-haspopup="dialog" @click.prevent="toggle">
        {{ unit === 'base' ? props.baseCoin : props.quoteCoin }}<ChevronDown :size="12" />
      </button>
    </template>
    <div class="uss">
      <p class="uss-title">{{ t('fut.unitSheet') }}</p>
      <button type="button" class="uss-option" :class="{ active: unit === 'base' }" data-testid="fut-unit-base" :aria-pressed="unit === 'base'" @click="chooseBase">
        <span class="uss-text"><b>{{ props.baseCoin }}</b><span>{{ t('fut.unitBaseDesc', { coin: props.baseCoin }) }}</span></span>
        <Check v-if="unit === 'base'" :size="14" class="uss-check" />
      </button>
      <div class="uss-option" :class="{ active: unit === 'quote' }">
        <button type="button" class="uss-head" data-testid="fut-unit-quote" :aria-pressed="unit === 'quote'" @click="chooseQuote()">
          <span class="uss-text"><b>{{ props.quoteCoin }}</b><span>{{ t('fut.unitQuoteDesc', { coin: props.quoteCoin }) }}</span></span>
          <Check v-if="unit === 'quote'" :size="14" class="uss-check" />
        </button>
        <div class="uss-radios" role="radiogroup" :aria-label="props.quoteCoin">
          <label class="uss-radio" data-testid="fut-quote-notional">
            <input type="radio" name="fut-quote-mode" value="notional" :checked="quoteMode === 'notional'" @change="chooseQuote('notional')" />{{ t('fut.quoteNotional') }}
          </label>
          <label class="uss-radio" data-testid="fut-quote-margin">
            <input type="radio" name="fut-quote-mode" value="margin" :checked="quoteMode === 'margin'" @change="chooseQuote('margin')" />{{ t('fut.quoteMargin') }}
          </label>
        </div>
        <p class="uss-note">{{ quoteMode === 'margin' ? t('fut.quoteMarginDesc', { coin: props.quoteCoin }) : t('fut.quoteNotionalDesc', { coin: props.quoteCoin }) }}</p>
      </div>
      <button type="button" class="btn btn-primary uss-confirm" @click="open = false">{{ t('fut.confirm2') }}</button>
    </div>
  </TicketPopover>
</template>

<style scoped>
.uss-trigger { display: inline-flex; align-items: center; gap: 3px; height: 26px; padding: 0 6px; border: 1px solid var(--color-border-strong); border-radius: 6px; background: var(--color-elevated); color: var(--color-text); font-size: 12px; font-weight: 650; white-space: nowrap; }
.uss-trigger:hover:not(:disabled) { border-color: var(--color-accent); }
.uss { display: grid; gap: 6px; width: 280px; max-width: 100%; padding: 4px; }
.uss-title { margin: 2px 4px 4px; font-size: 13px; font-weight: 700; }
.uss-option { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--color-border); border-radius: 10px; text-align: left; }
button.uss-option { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; }
.uss-option.active { border-color: var(--color-accent); }
.uss-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; }
.uss-text { display: grid; gap: 2px; }
.uss-text b { font-size: 13px; color: var(--color-text); }
.uss-text span { font-size: 11px; line-height: 15px; color: var(--color-text-muted); }
.uss-check { flex: 0 0 auto; color: var(--color-accent-text); }
.uss-radios { display: flex; gap: 14px; }
.uss-radio { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--color-text-secondary); cursor: pointer; }
.uss-radio input { accent-color: var(--color-accent); }
.uss-note { margin: 0; font-size: 11px; line-height: 15px; color: var(--color-text-muted); }
.uss-confirm { height: 32px; margin-top: 2px; font-size: 12px; }
@media (max-width: 640px) {
  .uss { width: 100%; box-sizing: border-box; }
  .uss-title { display: none; } /* TicketPopover supplies the mobile sheet heading. */
}
</style>
