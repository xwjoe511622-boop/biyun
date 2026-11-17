<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CandlestickChart, Calculator, Layers, ShieldCheck } from '@lucide/vue'

/**
 * "Why Bitwinex": only features that ship in this client (security page, decimal maths, depth feed, charts,
 * API keys), as a plain four-up grid (owner 10-22 replaced the pinned peel).
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '为认真交易的人而建',
      sub: '我们不展示无法核实的数字。下面每一项都是你登录后就能用到的功能。',
      a: '双重验证与 API 密钥', ad: '绑定 TOTP 验证器后，登录与安全操作都需要动态验证码；登录与安全记录随时可查，API 密钥在安全页创建与删除。',
      b: '精确到最小单位的账务', bd: '价格、数量和金额全程以十进制字符串计算，按交易对精度校验，不使用浮点数；下单冻结、撤单返还逐笔可对账。',
      c: '逐档实时深度', cd: '订单簿逐档推送并可切换价格精度聚合，配合累计深度与深度图，点击价格即可填入委托。',
      d: '专业图表与画线', dd: 'KLineCharts 引擎，多周期 K 线，MA / EMA / BOLL / MACD / RSI 指标，趋势线、通道、斐波那契画线按交易对保存。',
    },
    'en-US': {
      title: 'Built for people who trade seriously',
      sub: 'No unverifiable numbers here. Each item below is something you can use as soon as you sign in.',
      a: 'Two-factor and API keys', ad: 'With a TOTP authenticator bound, every sign-in and security action needs a one-time code. Sign-in records are always available; API keys are created and deleted on the security page.',
      b: 'Accounting to the last unit', bd: 'Prices, sizes and amounts are computed as decimal strings — never floating point — and checked against each pair’s precision. Order freezes and cancel releases reconcile line by line.',
      c: 'Live level-by-level depth', cd: 'The order book streams every level with switchable price grouping, cumulative depth and a depth chart. Click a price to fill your order.',
      d: 'Pro charts and drawing tools', dd: 'KLineCharts engine with multi-interval candles, MA / EMA / BOLL / MACD / RSI, and trend lines, channels and Fibonacci tools saved per pair.',
    },
  },
})
const items = [
  { icon: ShieldCheck, title: 'a', desc: 'ad' },
  { icon: Calculator, title: 'b', desc: 'bd' },
  { icon: Layers, title: 'c', desc: 'cd' },
  { icon: CandlestickChart, title: 'd', desc: 'dd' },
] as const
</script>

<template>
  <section class="bn-section why" data-fx>
    <div class="bn-section-inner">
      <header class="bn-section-head">
        <div>
          <h2>{{ t('title') }}</h2>
          <p>{{ t('sub') }}</p>
        </div>
      </header>
      <ul class="fx-trust-grid">
        <li v-for="item in items" :key="item.title" class="fx-trust glass">
          <span class="fx-trust-icon"><component :is="item.icon" :size="20" :stroke-width="1.75" /></span>
          <h3>{{ t(item.title) }}</h3>
          <p>{{ t(item.desc) }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>
