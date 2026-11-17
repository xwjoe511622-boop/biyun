<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { BRAND_NAME } from '@/core/brand'

/** Plain answers about the products this site actually offers; links go to the real pages. */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '常见问题',
      q1: '{brand} 提供哪些产品？',
      a1: '现货交易、U 本位永续合约（加密货币、黄金 XAUT、英伟达与特斯拉等美股永续）、跟单交易、理财、Launchpad 与 Launchpool、借币、OTC 买币，以及 VIP 和代理商计划。',
      q2: '如何开始交易？',
      a2: '用邮箱或手机号注册，在安全中心绑定验证器 App，然后在资产页充值，即可在现货或合约页下单。',
      q3: '黄金和美股永续合约是什么？',
      a3: '它们是以 USDT 作保证金和结算的永续合约，跟踪标的价格的涨跌，可做多也可做空；交易合约并不持有对应的黄金或股票。合约存在杠杆和强平风险。',
      q4: '手续费是多少？',
      a4: '现货与合约的费率在费率页公布，VIP 等级越高费率越低。',
      q5: '如何保护我的账户？',
      a5: '开启 TOTP 双重验证，定期查看登录与安全记录；API 密钥只授予需要的权限，不用时删除。',
      fees: '查看费率',
    },
    'en-US': {
      title: 'Questions, answered',
      q1: 'What products does {brand} offer?',
      a1: 'Spot trading, USDT-margined perpetuals (crypto, gold XAUT and US stocks such as NVIDIA and Tesla), copy trading, Earn, Launchpad and Launchpool, loans, OTC, and the VIP and affiliate programmes.',
      q2: 'How do I start trading?',
      a2: 'Sign up with email or mobile, bind an authenticator app in Security, deposit on the Assets page and place orders on spot or futures.',
      q3: 'What are gold and US-stock perpetuals?',
      a3: 'They are perpetual contracts margined and settled in USDT that track the underlying price, long or short. Trading them does not give you the gold or shares. Leverage and liquidation risk apply.',
      q4: 'What are the fees?',
      a4: 'Spot and futures fees are published on the fees page; higher VIP levels pay lower fees.',
      q5: 'How do I protect my account?',
      a5: 'Turn on TOTP two-factor authentication and review your login and security logs. Give API keys only the permissions they need and delete unused ones.',
      fees: 'View fees',
    },
  },
})

const items = ['1', '2', '3', '4', '5'] as const
</script>

<template>
  <section class="okx-sec">
    <div class="okx-wrap okx-narrow">
      <header class="okx-sec-head okx-center">
        <h2 class="okx-h2">{{ t('title') }}</h2>
      </header>
      <div class="okx-faq glass">
        <details v-for="id in items" :key="id">
          <summary>
            <span>{{ t(`q${id}`, { brand: BRAND_NAME }) }}</span>
            <Plus class="okx-faq-ico" :size="22" aria-hidden="true" />
          </summary>
          <p>
            {{ t(`a${id}`) }}
            <RouterLink v-if="id === '4'" class="okx-link" to="/fees">{{ t('fees') }}</RouterLink>
          </p>
        </details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.okx-faq { margin-top: 24px; padding: 0 28px; }
.okx-faq details + details { border-top: 1px solid var(--color-border-strong); }
.okx-faq summary {
  display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 0; cursor: pointer; list-style: none;
  font-family: var(--okx-font); font-size: 17px; font-weight: 650; letter-spacing: -0.01em;
}
.okx-faq summary::-webkit-details-marker { display: none; }
.okx-faq-ico { flex: 0 0 auto; padding: 4px; border: 1.5px solid var(--color-text-secondary); border-radius: 50%; width: 26px; height: 26px; transition: transform .25s var(--ease-out); }
.okx-faq details[open] .okx-faq-ico { transform: rotate(45deg); border-color: var(--color-accent); color: var(--okx-gold-ink); }
.okx-faq p { max-width: 760px; margin: -4px 0 20px; color: var(--color-text-secondary); font-size: 15px; line-height: 1.75; }
.okx-faq p .okx-link { margin-left: 6px; }
@media (max-width: 720px) {
  .okx-faq { padding: 0 18px; }
  .okx-faq summary { padding: 16px 0; font-size: 15.5px; }
  .okx-faq p { font-size: 14.5px; margin-bottom: 22px; }
}
</style>
