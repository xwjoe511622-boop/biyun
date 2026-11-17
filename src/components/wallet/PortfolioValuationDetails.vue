<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useValuationPrefs } from '@/modules/wallet/use-valuation'
import { formatValuation, HIDDEN_MASK } from '@/modules/wallet/valuation'

const props = defineProps<{ balance: string; unrealized: string; readAtMs: number | null }>()
const { t, locale } = useI18n({ useScope: 'local', messages: {
  'zh-CN': {
    balance: '余额估值（不含合约浮盈）', pnl: '合约未实现盈亏',
    updated: '账户数据更新于 {time}',
  },
  'en-US': {
    balance: 'Balance valuation excluding futures unrealized PnL', pnl: 'Futures unrealized PnL',
    updated: 'Account data updated {time}',
  },
} })
const prefs = useValuationPrefs()
function amount(value: string): string {
  if (prefs.hidden.value) return HIDDEN_MASK
  const negative = value.startsWith('-')
  const formatted = formatValuation(negative ? value.slice(1) : value, 'USDT')
  return negative && formatted !== '--' ? `-${formatted}` : formatted
}
/** Sign of the futures PnL, for the up / down colour. */
const pnlTone = computed(() => /^-?0*(\.0*)?$/.test(props.unrealized) || props.unrealized === '' ? '' : props.unrealized.startsWith('-') ? 'down' : 'up')
const iso = computed(() => props.readAtMs === null ? '' : new Date(props.readAtMs).toISOString())
// Time zones are used only for this human-facing presentation. The stored/HTML instant remains UTC.
const displayedTime = computed(() => props.readAtMs === null ? '' : new Intl.DateTimeFormat(locale.value, {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(props.readAtMs)))
</script>

<template>
  <div class="portfolio-details">
    <dl>
      <div><dt>{{ t('balance') }}</dt><dd class="num" data-testid="portfolio-balance-value">{{ amount(balance) }} USDT</dd></div>
      <div><dt>{{ t('pnl') }}</dt><dd class="num" :class="pnlTone" data-testid="portfolio-futures-pnl">{{ amount(unrealized) }} USDT</dd></div>
    </dl>
    <time v-if="readAtMs !== null" :datetime="iso" data-testid="portfolio-read-time">{{ t('updated', { time: displayedTime }) }}</time>
  </div>
</template>

<style scoped>
.portfolio-details { display: grid; gap: 5px; margin-top: 10px; font-size: 12px; color: var(--color-text-muted); }
dl { display: grid; gap: 6px; margin: 0; }
dl > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 4px 16px; }
dt { overflow-wrap: anywhere; }
dd { margin: 0; text-align: right; color: var(--color-text-secondary); overflow-wrap: anywhere; }
time { font-size: 11px; line-height: 1.5; }
dd.up { color: var(--color-up); }
dd.down { color: var(--color-down); }
/* Phones: the two figures as side-by-side tiles under a hairline. */
@media (max-width: 720px) {
  .portfolio-details { gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); }
  dl { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  dt { font-size: 11px; line-height: 1.35; }
  dd { text-align: left; font-size: 14px; font-weight: 600; color: var(--color-text); }
  time { font-size: 10.5px; }
}
</style>
