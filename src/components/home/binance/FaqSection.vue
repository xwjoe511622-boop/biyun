<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { BRAND_NAME } from '@/core/brand'

/** FAQ accordion (one open at a time), heading beside the list on desktop. Answers describe this platform's shipped products only. */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '常见问题',
      q1: '{brand} 提供哪些产品？',
      a1: '现货交易、杠杆交易、U 本位永续合约（包括黄金 XAUT 以及英伟达 NVDA、特斯拉 TSLA 等美股合约）、跟单交易、理财、Launchpad 新币申购、Launchpool 质押挖矿、锁仓释放、借币和 OTC 买币，全部使用同一个账户。',
      q2: '如何开始交易？',
      a2: '用邮箱或手机号注册账户，在账户安全页绑定 TOTP 验证器，然后在资产页充值。资产到账后即可在现货或合约页面下单。',
      q3: '什么是 U 本位永续合约？',
      a3: '以 USDT 作为保证金和结算币种、没有到期日的合约。持仓按资金费率定期在多空之间结算，可选择全仓或逐仓保证金模式；各合约的最高杠杆以交易页面显示为准。',
      q4: '如何交易黄金和美股？',
      a4: '在合约页面选择 XAUT、NVDA 或 TSLA 等 USDT 永续合约即可，和其他合约共用保证金账户；部分资产也有对应的现货交易对。',
      q5: '如何保护我的账户？',
      a5: '在账户安全页绑定 TOTP 验证器、定期查看登录与安全记录，并只为需要的程序创建 API 密钥。退出登录时会清除本地会话。',
      q6: '手续费是多少？',
      a6: '各市场的交易与提现费率见「费率标准」页面；VIP 等级可享受相应的手续费权益。',
      q7: '有手机 App 吗？',
      a7: 'App 正在开发中，发布后会在首页提供下载。现在用手机浏览器访问网站即可使用全部功能。',
    },
    'en-US': {
      title: 'Frequently asked questions',
      q1: 'What products does {brand} offer?',
      a1: 'Spot, margin, USDT-margined perpetuals (including gold XAUT and US-stock contracts such as NVIDIA NVDA and Tesla TSLA), copy trading, Earn, Launchpad subscriptions, Launchpool staking, vesting, loans and OTC — all in one account.',
      q2: 'How do I start trading?',
      a2: 'Sign up with your email or phone number, bind a TOTP authenticator on the security page, then deposit on the assets page. Once funds arrive you can place orders on spot or futures.',
      q3: 'What are USDT-margined perpetuals?',
      a3: 'Contracts with no expiry that use USDT for margin and settlement. Positions exchange funding between longs and shorts at regular intervals, with cross or isolated margin; each contract’s leverage cap is shown on the trading page.',
      q4: 'How do I trade gold and US stocks?',
      a4: 'Choose the XAUT, NVDA or TSLA USDT perpetual on the futures page — it shares the margin account with every other contract. Some of these assets also have spot pairs.',
      q5: 'How do I keep my account safe?',
      a5: 'Bind a TOTP authenticator on the security page, review your sign-in and security records, and create API keys only for programs that need them. Signing out clears the local session.',
      q6: 'What are the fees?',
      a6: 'Trading and withdrawal fees for every market are on the Fees page; VIP tiers come with fee benefits.',
      q7: 'Is there a mobile app?',
      a7: 'The app is in development and will be downloadable from the home page once released. Meanwhile the full site works in your phone’s browser.',
    },
  },
})
const keys = ['1', '2', '3', '4', '5', '6', '7'] as const
const openKey = ref<string | null>('1')
function toggle(key: string): void {
  openKey.value = openKey.value === key ? null : key
}
</script>

<template>
  <section class="bn-section faq" data-fx>
    <div class="bn-section-inner faq-inner">
      <h2>{{ t('title') }}</h2>
      <ul class="faq-list glass">
        <li v-for="key in keys" :key="key" class="faq-item" :class="{ 'is-open': openKey === key }">
          <button :id="`faq-q${key}`" type="button" class="faq-q" :aria-expanded="openKey === key" :aria-controls="`faq-a${key}`" @click="toggle(key)">
            <span>{{ t(`q${key}`, { brand: BRAND_NAME }) }}</span><Plus class="faq-icon" :size="20" />
          </button>
          <div v-show="openKey === key" :id="`faq-a${key}`" class="faq-a" role="region" :aria-labelledby="`faq-q${key}`">
            <p>{{ t(`a${key}`) }}</p>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.faq-inner { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); gap: 48px; align-items: start; }
.faq-inner h2 { margin: 8px 0 0; color: var(--color-text); font-size: 32px; font-weight: 700; line-height: 1.2; }
.faq-list { display: flex; flex-direction: column; margin: 0; padding: 4px; list-style: none; }
.faq-item { border-radius: 10px; transition: background-color 0.2s; }
.faq-item + .faq-item { border-top: 1px solid var(--color-border); }
.faq-item.is-open { background: color-mix(in srgb, var(--color-text) 5%, transparent); }
.faq-item.is-open + .faq-item { border-top-color: transparent; }
.faq-q {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; min-height: 56px; padding: 14px 20px;
  color: var(--color-text); font-size: 16px; font-weight: 500; text-align: left;
}
.faq-icon { flex: 0 0 auto; color: var(--color-text-secondary); transition: transform 0.2s var(--ease-out); }
.faq-item.is-open .faq-icon { transform: rotate(45deg); }
.faq-a p { max-width: 72ch; margin: 0; padding: 0 20px 18px; color: var(--color-text-secondary); font-size: 15px; line-height: 1.7; }
@media (prefers-reduced-motion: reduce) { .faq-icon { transition: none; } }
@media (max-width: 600px) {
  .faq-inner { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .faq-inner h2 { font-size: 26px; margin: 0; }
  .faq-q { padding: 14px 16px; font-size: 15px; min-height: 56px; }
  .faq-a p { padding: 0 16px 16px; font-size: 14px; }
}
</style>
