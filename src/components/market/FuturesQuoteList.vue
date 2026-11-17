<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import CoinMark from '@/components/common/CoinMark.vue'
import { useFuturesBoard } from '@/components/home/okx/use-futures-board'
import { vTick } from '@/components/home/fx/fx'
import { useFuturesMarketStore } from '@/stores/futures-market'

/** Phone markets page, 合约 tab (owner 2026-11-17): every listed perpetual with its live price and 24h change. */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { name: '合约', last: '最新价', change: '24h 涨跌', perp: '永续', lever: '最高 {n}x', none: '暂无数据' },
    'en-US': { name: 'Contract', last: 'Last price', change: '24h change', perp: 'Perp', lever: 'Up to {n}x', none: 'No data yet' },
  },
})
const board = useFuturesBoard()
const futures = useFuturesMarketStore()
const router = useRouter()
function open(name: string): void {
  futures.selectContract(name)
  void router.push('/futures')
}
</script>

<template>
  <div class="fq">
    <div class="fq-head"><span>{{ t('name') }}</span><span>{{ t('last') }}</span><span>{{ t('change') }}</span></div>
    <p v-if="board.rows.value.length === 0" class="fq-empty">{{ t('none') }}</p>
    <ul v-else>
      <li v-for="row in board.rows.value" :key="row.contract.contractName">
        <button type="button" class="fq-row" @click="open(row.contract.contractName)">
          <span class="fq-name">
            <CoinMark :symbol="row.base" :size="30" />
            <span><strong>{{ row.base }}USDT</strong><small>{{ t('perp') }}<template v-if="row.contract.maxLever > 0"> · {{ t('lever', { n: row.contract.maxLever }) }}</template></small></span>
          </span>
          <span v-tick="row.last" class="fq-last num">{{ row.last }}</span>
          <span class="fq-chg num" :class="row.change.direction">{{ row.change.text }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.fq ul { margin: 0; padding: 0; list-style: none; }
.fq-head, .fq-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) 84px; align-items: center; gap: 10px; }
.fq-head { height: 28px; padding: 0 16px; border-bottom: 1px solid var(--color-border); color: var(--color-text-muted); font-size: 11.5px; }
.fq-head span:nth-child(n + 2), .fq-last { text-align: right; }
.fq-row { position: relative; width: 100%; height: 58px; padding: 0 16px; text-align: left; }
.fq li + li .fq-row::before { content: ''; position: absolute; top: 0; left: 56px; right: 0; height: 1px; background: var(--color-border); opacity: .6; }
.fq-row:active { background: var(--color-hover); }
.fq-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fq-name > span { display: flex; flex-direction: column; min-width: 0; }
.fq-name strong { font-family: var(--font-display); font-size: 15.5px; font-weight: 700; }
.fq-name small { color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.fq-last { font-size: 15px; font-weight: 650; }
.fq-chg { display: inline-flex; align-items: center; justify-content: center; justify-self: end; width: 80px; height: 32px; border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13.5px; font-weight: 700; }
.fq-chg.up { background: var(--color-up); color: #fff; }
.fq-chg.down { background: var(--color-down); color: #fff; }
.fq-empty { margin: 0; padding: 28px 0; color: var(--color-text-muted); font-size: 13px; text-align: center; }
.fq-last.fx-tk-up1, .fq-last.fx-tk-up2 { animation: tick-up-a .9s ease-out; }
.fq-last.fx-tk-up2 { animation-name: tick-up-b; }
.fq-last.fx-tk-dn1, .fq-last.fx-tk-dn2 { animation: tick-dn-a .9s ease-out; }
.fq-last.fx-tk-dn2 { animation-name: tick-dn-b; }
@keyframes tick-up-a { from { color: var(--color-up); } }
@keyframes tick-up-b { from { color: var(--color-up); } }
@keyframes tick-dn-a { from { color: var(--color-down); } }
@keyframes tick-dn-b { from { color: var(--color-down); } }
@media (prefers-reduced-motion: reduce) { .fq-last { animation: none !important; } }
.fq-last::after { content: none !important; }
</style>
