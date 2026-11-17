<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff } from '@lucide/vue'
import { useValuationPrefs } from '@/modules/wallet/use-valuation'
import { useMarketStore } from '@/stores/market'
import { HIDDEN_MASK, VALUATION_UNITS, formatValuation, totalUsdValue, usdLine, valuationIn, type ValuationRow, type ValuationUnit } from '@/modules/wallet/valuation'

/**
 * Total asset valuation, Binance style: label + eye toggle, the total in the chosen unit with a unit
 * selector (BTC / USDT / USD, remembered per user), and a `≈ $x,xxx.xx` line. The number shrinks with
 * its container (container query units), so it never overflows the card from 390 px to 1920 px.
 * `total` is denominated in `symbol` (`finance/account_balance.totalBalanceSymbol`, BTC here). `rows` (the account's
 * holdings) make the USDT / USD figure a per-coin sum, USDT 1:1 (QA-001); without them the BTC total is converted.
 */
const props = withDefaults(
  defineProps<{ label: string; total: string; symbol: string; rows?: readonly ValuationRow[]; maxFont?: number }>(),
  { maxFont: 34, rows: () => [] },
)

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { hide: '隐藏金额', show: '显示金额', unit: '计价单位' },
    'en-US': { hide: 'Hide amounts', show: 'Show amounts', unit: 'Valuation unit' },
  },
})

const prefs = useValuationPrefs()
const market = useMarketStore()
const unit = prefs.unit
const hidden = prefs.hidden

const sourceSymbol = computed(() => (props.symbol === '' ? 'BTC' : props.symbol))
const negativeTotal = computed(() => props.rows.length === 0 && /^-\d+(\.\d+)?$/.test(props.total))
const totalMagnitude = computed(() => negativeTotal.value ? props.total.slice(1) : props.total)
const usdTotal = computed(() => (props.rows.length === 0 ? '' : totalUsdValue(props.rows, market.tickers)))
const value = computed(() => valuationIn(unit.value, totalMagnitude.value, sourceSymbol.value, usdTotal.value, prefs.btcPrice.value))
const text = computed(() => {
  if (hidden.value) return HIDDEN_MASK
  const formatted = formatValuation(value.value, unit.value)
  return negativeTotal.value && formatted !== '--' ? `-${formatted}` : formatted
})
const usd = computed(() => {
  if (hidden.value) return `≈ $${HIDDEN_MASK}`
  const formatted = usdLine(valuationIn('USD', totalMagnitude.value, sourceSymbol.value, usdTotal.value, prefs.btcPrice.value))
  return negativeTotal.value && formatted !== '' ? formatted.replace('$', '$-') : formatted
})
/** Characters the number line has to fit (drives the font size). */
const chars = computed(() => Math.max(text.value.length, 6))

/**
 * BTC→USDT needs the last BTC/USDT price: hold the market `review` stream (all-pair 24h tickers, no
 * K-line/book) while shown. On the home page it is already held; the shared socket is reused.
 */
let stopStream: (() => void) | null = null
onMounted(() => {
  stopStream = market.start('overview')
})
onBeforeUnmount(() => {
  stopStream?.()
  stopStream = null
})

function onUnit(event: Event): void {
  const next = VALUATION_UNITS.find((entry) => entry === (event.target as HTMLSelectElement).value)
  if (next !== undefined) prefs.setUnit(next as ValuationUnit)
}
/** The bracketed qualifier of the label (e.g. “（含合约浮盈）”) is dropped on phones (owner 2026-11-17). */
const labelParts = computed(() => {
  const at = props.label.search(/\s*[（(]/)
  return at <= 0 ? [props.label, ''] : [props.label.slice(0, at), props.label.slice(at)]
})
</script>

<template>
  <div class="valuation" :class="{ 'same-unit': unit !== 'BTC' }" :style="{ '--val-max': `${maxFont}px`, '--val-chars': chars }">
    <div class="val-head">
      <span class="val-label">{{ labelParts[0] }}<span class="val-label-note">{{ labelParts[1] }}</span></span>
      <button class="val-eye" type="button" :aria-label="hidden ? t('show') : t('hide')" :aria-pressed="hidden" :title="hidden ? t('show') : t('hide')" @click="prefs.toggleHidden()">
        <EyeOff v-if="hidden" :size="15" />
        <Eye v-else :size="15" />
      </button>
    </div>
    <div class="val-line">
      <strong class="val-num num" data-testid="valuation-total">{{ text }}</strong>
      <select class="val-unit" :value="unit" :aria-label="t('unit')" data-testid="valuation-unit" @change="onUnit">
        <option v-for="entry in VALUATION_UNITS" :key="entry" :value="entry">{{ entry }}</option>
      </select>
    </div>
    <span v-if="usd !== ''" class="val-usd num" data-testid="valuation-usd">{{ usd }}</span>
  </div>
</template>

<style scoped>
.valuation { display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; }
.val-head { display: flex; align-items: flex-start; gap: 6px; }
.val-label { min-width: 0; color: var(--color-text-muted); font-size: 13px; line-height: 24px; }
.val-eye {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: 0 0 24px;
  border-radius: var(--radius-sm); color: var(--color-text-muted); transition: color 0.15s, background-color 0.15s;
}
.val-eye:hover { color: var(--color-text); background: var(--color-hover); }
/* The line is a size container: the number's font follows the card width, not the viewport. */
.val-line { container-type: inline-size; display: block; min-width: 0; white-space: nowrap; line-height: 1.15; }
.val-num {
  font-size: min(var(--val-max), 7vw);
  font-size: clamp(16px, calc((100cqi - 70px) / (var(--val-chars) * 0.62)), var(--val-max));
  font-weight: 650; letter-spacing: -0.02em; vertical-align: baseline;
}
.val-unit {
  margin-left: 8px; padding: 2px 18px 2px 6px; border: 0; border-radius: var(--radius-sm);
  background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none' stroke='%23888' stroke-width='1.6'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 4px center;
  color: var(--color-text-secondary); font-family: var(--font-sans); font-size: 14px; font-weight: 600;
  cursor: pointer; appearance: none; -webkit-appearance: none; vertical-align: baseline;
}
.val-unit:hover, .val-unit:focus-visible { color: var(--color-text); background-color: var(--color-hover); outline: none; }
.val-usd { color: var(--color-text-muted); font-size: 13px; }
/* Phones: a calmer card — smaller total, tighter rhythm. */
@media (max-width: 720px) {
  .valuation { gap: 8px; }
  .val-label { font-size: 13.5px; line-height: 22px; }
  .val-label-note { display: none; }
  .val-num { font-size: clamp(16px, calc((100cqi - 70px) / (var(--val-chars) * 0.62)), min(var(--val-max), 42px)); font-weight: 700; }
  .val-unit { margin-left: 4px; font-size: 13px; }
  .val-usd { font-size: 14px; color: var(--color-text-secondary); }
}
</style>
