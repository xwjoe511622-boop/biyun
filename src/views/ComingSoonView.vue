<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { BellRing, Check, Megaphone } from '@lucide/vue'
import ProductArt from '@/components/common/ProductArt.vue'
import { BRAND_NAME } from '@/core/brand'

/**
 * Preview page of a product that is announced but not open (owner 2026-11-17; `core/feature-flags.ts`).
 * It says what the product will do and that it is not available yet — no rates, quotas, projects or any other
 * figure, because none exists. The route's `meta.soon` picks the copy.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      chip: '暂未开放', note: '该功能暂未开放，开放时间与规则以平台公告为准，当前页面不展示任何收益或额度数据。', notices: '查看平台公告', back: '返回探索',
      earn: { title: '理财', lead: '让闲置资产获得收益', a: '活期产品随存随取', b: '定期产品到期自动结算', c: '收益按日计算并发放至现货账户' },
      loans: { title: '借币', lead: '抵押资产，灵活借用', a: '以持有的资产作为抵押', b: '按小时计息，随借随还', c: '清晰的质押率与风险提示' },
      launchpad: { title: 'Launchpad', lead: '参与优质新项目的代币发行', a: '持仓快照决定申购额度', b: '按比例分配，未用资金自动退回', c: '项目信息与规则提前公示' },
      launchpool: { title: 'Launchpool', lead: '质押资产，获得新币奖励', a: '质押期间本金可随时取回', b: '奖励按小时结算', c: '支持多种质押资产' },
      vesting: { title: '锁仓释放', lead: '查看锁仓计划与释放进度', a: '按计划分期释放', b: '每期释放自动到账', c: '完整的释放记录' },
      predict: { title: '云预测', lead: '预测事件结果，交易你的观点', a: '覆盖加密、财经、体育等热门事件', b: '价格即概率，随时买入卖出', c: '事件结束后按结果自动结算' },
      copyTrading: { title: '跟单交易', lead: '跟随带单交易员自动开平仓', a: '按比例或固定金额跟单', b: '可设置止盈止损', c: '随合约交易一同开放' },
    },
    'en-US': {
      chip: 'Not open yet', note: 'This product is not open yet. Opening time and rules will be announced; no rate or quota is shown here.', notices: 'Announcements', back: 'Back to Explore',
      earn: { title: 'Earn', lead: 'Put idle assets to work', a: 'Flexible products, redeem any time', b: 'Fixed terms settle at maturity', c: 'Rewards accrue daily to your spot account' },
      loans: { title: 'Loans', lead: 'Borrow against your assets', a: 'Use your holdings as collateral', b: 'Hourly interest, repay any time', c: 'Clear collateral ratios and risk notices' },
      launchpad: { title: 'Launchpad', lead: 'Join token launches of new projects', a: 'Quota from holding snapshots', b: 'Pro-rata allocation, unused funds returned', c: 'Project terms published in advance' },
      launchpool: { title: 'Launchpool', lead: 'Stake assets, earn new tokens', a: 'Unstake your principal any time', b: 'Rewards settle hourly', c: 'Several stake assets' },
      vesting: { title: 'Vesting', lead: 'Locked plans and release progress', a: 'Released in scheduled instalments', b: 'Each release arrives automatically', c: 'Full release history' },
      predict: { title: 'Cloud Predict', lead: 'Trade your view on event outcomes', a: 'Crypto, finance, sports and other events', b: 'Price is probability; buy or sell any time', c: 'Settled automatically by the outcome' },
      copyTrading: { title: 'Copy trading', lead: 'Follow lead traders automatically', a: 'Copy by ratio or fixed amount', b: 'Take-profit and stop-loss settings', c: 'Opens together with futures trading' },
    },
  },
})
const route = useRoute()
const KEYS = ['earn', 'loans', 'launchpad', 'launchpool', 'vesting', 'predict', 'copyTrading'] as const
const key = computed(() => KEYS.find((entry) => entry === route.meta.soon) ?? 'earn')
</script>

<template>
  <section class="soon">
    <div class="soon-hero">
      <span class="soon-chip"><BellRing :size="13" aria-hidden="true" />{{ t('chip') }}</span>
      <h1>{{ t(`${key}.title`) }}</h1>
      <p>{{ t(`${key}.lead`) }}</p>
      <small>{{ BRAND_NAME }}</small>
      <ProductArt class="soon-art" :kind="key === 'copyTrading' ? 'copy' : key" :size="92" />
    </div>
    <ul class="soon-list">
      <li v-for="item in ['a', 'b', 'c']" :key="item"><span><Check :size="14" aria-hidden="true" /></span>{{ t(`${key}.${item}`) }}</li>
    </ul>
    <p class="soon-note">{{ t('note') }}</p>
    <div class="soon-actions">
      <RouterLink class="btn btn-primary" :to="{ name: 'notices' }"><Megaphone :size="15" aria-hidden="true" />{{ t('notices') }}</RouterLink>
      <RouterLink class="btn" to="/explore">{{ t('back') }}</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.soon { display: flex; flex-direction: column; gap: 18px; max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
.soon-hero {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 26px 22px 24px; overflow: hidden; color: #f4efe3;
  border: 1px solid rgba(217, 168, 90, .45); border-radius: 22px;
  background: radial-gradient(130% 150% at 100% 0%, rgba(217, 168, 90, .40), transparent 58%), linear-gradient(125deg, #1a140a, #0c0c0e 72%);
}
.soon-art { position: absolute; top: 22px; right: 20px; }
.soon-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; background: rgba(217, 168, 90, .22); color: #f2c64e; font-size: 12px; font-weight: 700; }
.soon-hero h1 { margin: 10px 0 0; font-family: var(--font-display); font-size: 30px; font-weight: 750; letter-spacing: -0.02em; }
.soon-hero p { margin: 0; color: rgba(244, 239, 227, .78); font-size: 15px; }
.soon-hero small { margin-top: 14px; color: rgba(242, 198, 78, .7); font-size: 10.5px; font-weight: 700; letter-spacing: .3em; }
.soon-list { display: flex; flex-direction: column; margin: 0; padding: 0; overflow: hidden; list-style: none; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.soon-list li { display: flex; align-items: center; gap: 12px; min-height: 50px; padding: 0 16px; font-size: 14.5px; }
.soon-list li + li { border-top: 1px solid var(--color-border); }
.soon-list span { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 24px; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent-text); }
.soon-note { margin: 0; color: var(--color-text-muted); font-size: 12.5px; line-height: 1.65; }
.soon-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.soon-actions .btn { display: inline-flex; align-items: center; gap: 6px; height: 42px; padding: 0 18px; }
</style>
