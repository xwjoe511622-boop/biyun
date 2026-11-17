<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Search, X } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { percentView } from '@/modules/finance/display'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useMarketStore } from '@/stores/market'

/**
 * Phone coin search (owner 2026-11-17): a full-screen sheet with a real input. It filters the listed spot pairs
 * (and the perpetual contracts once their list is loaded) as the user types; a tap opens that market.
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { placeholder: '搜索币种，如 BTC', cancel: '取消', hot: '热门', spot: '现货', perp: '永续合约', none: '没有找到“{q}”相关的币种' },
    'en-US': { placeholder: 'Search coins, e.g. BTC', cancel: 'Cancel', hot: 'Popular', spot: 'Spot', perp: 'Perpetual', none: 'No coins match “{q}”' },
  },
})
const router = useRouter()
const market = useMarketStore()
const futures = useFuturesMarketStore()
const query = ref('')
const input = ref<HTMLInputElement | null>(null)

interface Hit { key: string; base: string; label: string; kind: string; last: string; change: { text: string; direction: string }; open: () => void }
const needle = computed(() => query.value.trim().toUpperCase())
const hits = computed<Hit[]>(() => {
  const q = needle.value
  const spot = market.symbols
    .filter((entry) => q === '' || entry.base.includes(q) || entry.pair.replace('/', '').includes(q) || (entry.coin?.showName ?? '').toUpperCase().includes(q))
    .slice(0, q === '' ? 8 : 30)
    .map((entry): Hit => {
      const tick = market.tickers[entry.symbol.toLowerCase()]
      const rose = tick?.rose ?? ''
      return {
        key: `s-${entry.symbol}`, base: entry.base, label: `${entry.base}/${entry.quote}`, kind: t('spot'),
        last: tick !== undefined && isDecimalString(tick.close) ? groupDigits(tick.close, Math.min(entry.pricePrecision, 8)) : '--',
        change: rose === '' ? { text: '--', direction: 'flat' } : percentView(rose),
        open: () => { market.selectPair(entry.pair); void router.push('/trade') },
      }
    })
  if (q === '') return spot
  const perp = futures.contracts
    .filter((contract) => contract.base.toUpperCase().includes(q) || contract.displayName.toUpperCase().includes(q))
    .slice(0, 20)
    .map((contract): Hit => ({
      key: `f-${contract.contractName}`, base: contract.base, label: contract.displayName, kind: t('perp'), last: '', change: { text: '', direction: 'flat' },
      open: () => { futures.selectContract(contract.contractName); void router.push('/futures') },
    }))
  return [...spot, ...perp]
})

function close(): void {
  emit('update:open', false)
}
function pick(hit: Hit): void {
  close()
  hit.open()
}
watch(() => props.open, (open) => {
  document.documentElement.classList.toggle('search-lock', open)
  if (!open) return
  query.value = ''
  if (market.publicInfo === null) void market.loadPublicInfo().catch(() => { /* the list stays empty */ })
  if (!futures.loaded) void futures.loadPublicInfo().catch(() => { /* spot results only */ })
  void nextTick(() => input.value?.focus())
}, { immediate: true })
onBeforeUnmount(() => document.documentElement.classList.remove('search-lock'))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="msearch" role="dialog" aria-modal="true" :aria-label="t('placeholder')">
      <div class="ms-bar">
        <label class="ms-field">
          <Search :size="16" aria-hidden="true" />
          <input ref="input" v-model="query" type="search" inputmode="search" autocomplete="off" autocapitalize="characters" :placeholder="t('placeholder')" data-testid="msearch-input" @keydown.esc="close" />
          <button v-if="query !== ''" type="button" class="ms-clear" aria-label="clear" @click="query = ''; input?.focus()"><X :size="14" /></button>
        </label>
        <button type="button" class="ms-cancel" data-testid="msearch-cancel" @click="close">{{ t('cancel') }}</button>
      </div>
      <p v-if="needle === ''" class="ms-hint">{{ t('hot') }}</p>
      <p v-if="hits.length === 0" class="ms-none">{{ t('none', { q: query.trim() }) }}</p>
      <ul v-else class="ms-list">
        <li v-for="hit in hits" :key="hit.key">
          <button type="button" class="ms-row" :data-testid="`msearch-${hit.key}`" @click="pick(hit)">
            <CoinMark :symbol="hit.base" :size="30" />
            <span class="ms-name"><strong>{{ hit.label }}</strong><small>{{ hit.kind }}</small></span>
            <span class="ms-num"><b class="num">{{ hit.last }}</b><i class="num" :class="hit.change.direction">{{ hit.change.text }}</i></span>
          </button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
.msearch { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; background: var(--color-bg); animation: ms-in .18s ease-out; }
@keyframes ms-in { from { opacity: 0; transform: translateY(6px); } }
.ms-bar { display: flex; align-items: center; gap: 10px; padding: max(10px, env(safe-area-inset-top)) 14px 10px; }
.ms-field { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid color-mix(in srgb, var(--color-accent) 55%, var(--color-border)); border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text-muted); }
.ms-field input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 15px; }
.ms-field input::-webkit-search-cancel-button { display: none; }
.ms-clear { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--color-border-strong); color: var(--color-text); }
.ms-cancel { flex: 0 0 auto; color: var(--color-text-secondary); font-size: 15px; }
.ms-hint { margin: 6px 16px 4px; color: var(--color-text-muted); font-size: 12px; }
.ms-none { margin: 0; padding: 48px 20px; color: var(--color-text-muted); font-size: 13.5px; text-align: center; }
.ms-list { flex: 1 1 auto; margin: 0; padding: 0 0 24px; overflow-y: auto; list-style: none; }
.ms-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 11px 16px; text-align: left; }
.ms-row:active { background: var(--color-hover); }
.ms-name { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.ms-name strong { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
.ms-name small { color: var(--color-text-muted); font-size: 11px; }
.ms-num { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.ms-num b { font-size: 14.5px; font-weight: 650; }
.ms-num i { font-size: 12px; font-style: normal; font-weight: 700; }
.ms-num .up { color: var(--color-up); } .ms-num .down { color: var(--color-down); } .ms-num .flat { color: var(--color-text-muted); }
</style>
