<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CandlestickChart, KeyRound, Scale, ShieldCheck } from '@lucide/vue'

/**
 * What protects an account and an order here — only features this client and server actually ship. No user
 * counts, licences, reserves or insurance claims. A plain four-up grid (owner 10-22 replaced the pinned peel).
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '为交易者打造的安全与精度',
      a: '双重验证', ad: 'TOTP 验证器保护登录、提现和安全设置变更，登录与安全操作均有记录。',
      b: '精确到最小单位的账务', bd: '价格、数量和金额全程以十进制字符串计算，下单冻结、撤单返还逐笔可对账。',
      c: '实时深度与专业图表', cd: '逐档推送的订单簿与深度图，多周期 K 线、常用指标和画线工具。',
      d: 'API 密钥', dd: '为程序化交易创建 API 密钥，可单独管理和随时删除。',
    },
    'en-US': {
      title: 'Security and precision, built for traders',
      a: 'Two-factor authentication', ad: 'A TOTP authenticator protects logins, withdrawals and security changes, and every login and security action is logged.',
      b: 'Exact-to-the-unit accounting', bd: 'Prices, sizes and amounts are decimal strings end to end; every freeze on order and release on cancel reconciles.',
      c: 'Live depth and pro charts', cd: 'A level-by-level order book and depth chart, multi-interval candles, common indicators and drawing tools.',
      d: 'API keys', dd: 'Create API keys for automated trading, manage each one separately and delete any time.',
    },
  },
})

const items = [
  { icon: ShieldCheck, title: 'a', body: 'ad' },
  { icon: Scale, title: 'b', body: 'bd' },
  { icon: CandlestickChart, title: 'c', body: 'cd' },
  { icon: KeyRound, title: 'd', body: 'dd' },
] as const
</script>

<template>
  <section class="okx-sec">
    <div class="okx-wrap">
      <header class="okx-sec-head">
        <h2 class="okx-h2">{{ t('title') }}</h2>
      </header>
      <ul class="fx-trust-grid">
        <li v-for="item in items" :key="item.title" class="fx-trust glass">
          <span class="fx-trust-icon"><component :is="item.icon" :size="20" :stroke-width="1.75" aria-hidden="true" /></span>
          <h3>{{ t(item.title) }}</h3>
          <p>{{ t(item.body) }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
