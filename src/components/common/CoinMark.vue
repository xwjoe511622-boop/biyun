<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bitcoin } from '@lucide/vue'
import { safeWebUrl } from '@/core/urls'
import { useMarketStore } from '@/stores/market'
import { readCoinList } from '@/modules/wallet/coins'

/**
 * Coin marker. The exchange's own icon is used when `market.coinList[COIN].icon` returns a URL (passed in, or
 * looked up from public_info when the caller did not pass one); otherwise a text tile with the symbol is
 * rendered (no external/branded assets are bundled).
 */
const props = withDefaults(defineProps<{ symbol: string; iconUrl?: string; size?: number }>(), {
  iconUrl: '',
  size: 18,
})

const failed = ref(false)
const market = useMarketStore()
const resolvedIcon = computed(() => {
  if (props.iconUrl !== '') return props.iconUrl
  const entry = readCoinList(market.publicInfo)[props.symbol.toUpperCase()] as Record<string, unknown> | undefined
  return typeof entry?.icon === 'string' ? entry.icon : ''
})

/** Recognisable colour + glyph for common coins; any other coin gets a stable hue from its symbol. */
const KNOWN: Record<string, { bg: string; glyph: string }> = {
  USDT: { bg: '#26a17b', glyph: '₮' },
  USDC: { bg: '#2775ca', glyph: '$' },
  ETH: { bg: '#627eea', glyph: 'Ξ' },
  BNB: { bg: '#f3ba2f', glyph: 'B' },
  SOL: { bg: '#8b5cf6', glyph: 'S' },
  TRX: { bg: '#e5312f', glyph: 'T' },
  XAUT: { bg: '#c9a227', glyph: 'Au' },
  PAXG: { bg: '#c9a227', glyph: 'Au' },
  NVDA: { bg: '#76b900', glyph: 'N' },
  TSLA: { bg: '#cc0000', glyph: 'T' },
}

const code = computed(() => props.symbol.toUpperCase())
const initial = computed(() => KNOWN[code.value]?.glyph ?? code.value.slice(0, 1))
const tint = computed(() => {
  const known = KNOWN[code.value]
  if (known !== undefined) return known.bg
  let hash = 0
  for (const char of code.value) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `hsl(${hash} 55% 46%)`
})

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.max(9, Math.round(props.size * (initial.value.length > 1 ? 0.42 : 0.5)))}px`,
  '--coin-tint': tint.value,
}))

// Demo mode ships its coin icons inline (data: URLs from demo/icons.json); real servers always send https URLs.
const showImage = computed(() => (safeWebUrl(resolvedIcon.value, true) !== '' || (import.meta.env.VITE_DEMO === '1' && resolvedIcon.value.startsWith('data:image/'))) && !failed.value)
</script>

<template>
  <span class="coin-mark" :class="{ bitcoin: symbol.toUpperCase() === 'BTC' }" :style="style" :title="symbol">
    <img v-if="showImage" :src="resolvedIcon" :alt="symbol" @error="failed = true" />
    <Bitcoin v-else-if="symbol.toUpperCase() === 'BTC'" :size="size * 0.7" :stroke-width="2.5" />
    <span v-else class="coin-mark-text">{{ initial }}</span>
  </span>
</template>

<style scoped>
.coin-mark {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  background: var(--color-surface-alt);
  color: var(--color-text-secondary);
  font-weight: 600;
  letter-spacing: 0;
}
.coin-mark.bitcoin { background: #f7931a; color: white; }
.coin-mark:not(.bitcoin) { background: var(--coin-tint); color: #ffffff; font-weight: 700; }

.coin-mark img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.coin-mark-text {
  line-height: 1;
}
</style>
