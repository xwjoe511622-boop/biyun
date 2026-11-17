<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import CoinMark from '@/components/common/CoinMark.vue'
import { vTick } from './fx'

/**
 * Perpetuals, as a compact contracts board (owner 10-22 replaced the pinned orbit): a short header with the
 * platform's top leverage, then one tile per listed contract — BTC, ETH, XAUT, NVDA, TSLA, SOL first when listed,
 * the rest after, nine at most. Every price, change and leverage cap is the server's value or `--`.
 */
export interface ContractItem {
  key: string
  base: string
  label: string
  kind: 'crypto' | 'gold' | 'stock'
  last: string
  change: { text: string; direction: string }
  /** Leverage cap as the server sent it (`'125'`), `''` when unknown. */
  lever: string
}

const props = defineProps<{ items: ContractItem[]; maxLever: string }>()
const emit = defineEmits<{ pick: [key: string] }>()

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: 'U 本位永续合约',
      body: '一份 USDT 保证金交易加密货币、黄金与美股合约，全仓或逐仓，支持止盈止损。',
      lever: '合约最高杠杆',
      cta: '交易合约',
      data: '资金费率',
      upTo: '最高 {n}x',
      crypto: '加密', gold: '黄金', stock: '美股',
      trade: '交易 {name} 永续',
      empty: '合约列表加载中',
    },
    'en-US': {
      title: 'USDⓈ-M perpetuals',
      body: 'One USDT margin balance for crypto, gold and US-stock contracts — cross or isolated, with TP/SL.',
      lever: 'Max futures leverage',
      cta: 'Trade futures',
      data: 'Funding rates',
      upTo: 'Up to {n}x',
      crypto: 'Crypto', gold: 'Gold', stock: 'US stock',
      trade: 'Trade {name} perpetual',
      empty: 'Loading contracts',
    },
  },
})

const PREFERRED = ['BTC', 'ETH', 'XAUT', 'NVDA', 'TSLA', 'SOL']
const LIMIT = 9

const tiles = computed<ContractItem[]>(() => {
  const byBase = new Map(props.items.map((item) => [item.base.toUpperCase(), item]))
  const picked: ContractItem[] = []
  for (const base of PREFERRED) {
    const item = byBase.get(base)
    if (item !== undefined) picked.push(item)
  }
  for (const item of props.items) {
    if (picked.length >= LIMIT) break
    if (!picked.includes(item)) picked.push(item)
  }
  return picked.slice(0, LIMIT)
})
</script>

<template>
  <section class="fx-contracts">
    <div class="fx-wrap">
      <header class="fx-contracts-head">
        <div class="fx-contracts-copy">
          <h2>{{ t('title') }}</h2>
          <p>{{ t('body') }}</p>
        </div>
        <dl class="fx-contracts-stat">
          <dt>{{ t('lever') }}</dt>
          <dd class="num">{{ maxLever }}</dd>
        </dl>
        <div class="fx-contracts-actions">
          <slot name="actions">
            <RouterLink class="btn btn-primary" to="/futures">{{ t('cta') }}</RouterLink>
            <RouterLink class="btn btn-quiet" to="/futures/data">{{ t('data') }}</RouterLink>
          </slot>
        </div>
      </header>
      <ul v-if="tiles.length > 0" class="fx-contracts-grid">
        <li v-for="item in tiles" :key="item.key">
          <button type="button" class="fx-contract glass" :aria-label="t('trade', { name: item.base })" @click="emit('pick', item.key)">
            <span class="fx-contract-top">
              <CoinMark :symbol="item.base" :size="24" />
              <strong>{{ item.label }}</strong>
              <em :class="item.kind">{{ t(item.kind) }}</em>
            </span>
            <span class="fx-contract-mid">
              <span v-tick="item.last" class="num fx-contract-px">{{ item.last }}</span>
              <span class="num fx-contract-chg" :class="item.change.direction">{{ item.change.text }}</span>
            </span>
            <span v-if="item.lever !== ''" class="num fx-contract-x">{{ t('upTo', { n: item.lever }) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="fx-contracts-empty">{{ t('empty') }}</p>
    </div>
  </section>
</template>
