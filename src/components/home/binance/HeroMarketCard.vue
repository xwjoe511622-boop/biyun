<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import { byDecimalDesc, useOpenMarket, type HomeMarketRow } from './use-home-markets'
import { vTick } from '@/components/home/fx/fx'

/** Hero market card (Binance "Popular / New Listing"): four live views of the same rows, five each. */
const props = defineProps<{ spot: HomeMarketRow[]; futures: HomeMarketRow[] }>()

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { hot: '热门', gainers: '涨幅榜', fresh: '新币', volume: '成交额', all: '查看全部', perp: '永续', noNew: '暂无新上线币种', waiting: '等待行情推送', empty: '暂无交易对' },
    'en-US': { hot: 'Popular', gainers: 'Top gainers', fresh: 'New listing', volume: 'Top volume', all: 'View all', perp: 'Perp', noNew: 'No new listings right now', waiting: 'Awaiting live prices', empty: 'No markets yet' },
  },
})

type Tab = 'hot' | 'gainers' | 'fresh' | 'volume'
const tabs: Tab[] = ['hot', 'gainers', 'fresh', 'volume']
const tab = ref<Tab>('hot')
const open = useOpenMarket()

const all = computed(() => [...props.spot, ...props.futures])
const rows = computed<HomeMarketRow[]>(() => {
  switch (tab.value) {
    case 'gainers': return [...all.value].filter((row) => row.rose !== '').sort(byDecimalDesc((row) => row.rose)).slice(0, 5)
    case 'fresh': return props.spot.filter((row) => row.isNew).slice(0, 5)
    case 'volume': return [...all.value].filter((row) => row.turnover !== '').sort(byDecimalDesc((row) => row.turnover)).slice(0, 5)
    default: return props.spot.slice(0, 5)
  }
})
const emptyText = computed(() => (tab.value === 'fresh' ? t('noNew') : tab.value === 'hot' ? t('empty') : t('waiting')))
</script>

<template>
  <section class="bn-card hero-markets">
    <header class="card-head">
      <div class="card-tabs" role="tablist">
        <button v-for="key in tabs" :key="key" type="button" role="tab" class="card-tab" :class="{ 'is-active': tab === key }" :aria-selected="tab === key" @click="tab = key">{{ t(key) }}</button>
      </div>
      <RouterLink class="card-more" to="/markets">{{ t('all') }}<ChevronRight :size="14" /></RouterLink>
    </header>
    <ul v-if="rows.length > 0" class="rows">
      <li v-for="row in rows" :key="row.key">
        <button type="button" class="row" @click="open(row)">
          <CoinMark :symbol="row.base" :icon-url="row.icon" :size="24" />
          <span class="row-name">
            <strong>{{ row.base }}</strong>
            <small v-if="row.kind === 'futures'" class="tag">{{ t('perp') }}</small>
            <small v-else class="ellipsis">{{ row.name }}</small>
          </span>
          <span v-tick="row.last" class="num row-price">{{ row.last }}</span>
          <span class="num row-change" :class="row.change.direction">{{ row.change.text }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="card-empty">{{ emptyText }}</p>
  </section>
</template>

<style scoped>
.hero-markets { padding: 20px 8px 12px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px 8px; }
.card-tabs { display: flex; gap: 20px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.card-tab {
  position: relative; padding: 4px 0 10px; color: var(--color-text-secondary); font-size: 15px; font-weight: 600; white-space: nowrap;
  transition: color 0.15s;
}
.card-tab:hover { color: var(--color-text); }
.card-tab.is-active { color: var(--color-text); }
.card-tab.is-active::after { content: ''; position: absolute; left: 50%; bottom: 0; width: 16px; height: 3px; margin-left: -8px; border-radius: 2px; background: var(--color-accent); }
.card-more { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; color: var(--color-text-secondary); font-size: 13px; }
.card-more:hover { color: var(--color-text); }
.rows { margin: 0; padding: 0; list-style: none; }
.row {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 76px; align-items: center; gap: 12px; width: 100%;
  min-height: 48px; padding: 0 16px; border-radius: 8px; text-align: left; transition: background-color 0.12s;
}
.row:hover { background: var(--color-hover); }
.row-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.row-name strong { color: var(--color-text); font-size: 15px; font-weight: 600; }
.row-name small { color: var(--color-text-secondary); font-size: 13px; }
.tag { padding: 1px 5px; border-radius: 4px; background: var(--color-surface-alt); font-size: 11px !important; }
.row-price { color: var(--color-text); font-size: 15px; font-weight: 500; text-align: right; }
.row-change { font-size: 15px; font-weight: 500; text-align: right; }
.row-change.up { color: var(--color-up); }
.row-change.down { color: var(--color-down); }
.row-change.flat { color: var(--color-text-secondary); }
.card-empty { display: flex; align-items: center; justify-content: center; min-height: 240px; margin: 0; color: var(--color-text-secondary); font-size: 14px; }
@media (max-width: 600px) {
  .row { grid-template-columns: 22px minmax(0, 1fr) auto 64px; gap: 10px; padding: 0 12px; }
  .row-name small.ellipsis { display: none; }
  .row-price, .row-change { font-size: 14px; }
  .card-head { padding: 0 12px 8px; }
  .card-tab { padding-block: 7px; font-size: 14px; }
  .card-tabs { gap: 16px; }
}
</style>
