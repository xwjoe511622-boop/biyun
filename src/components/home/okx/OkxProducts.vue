<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Banknote, Crown, HandCoins, PiggyBank, Rocket, Users } from '@lucide/vue'
import { useProductFacts } from './use-product-facts'

/**
 * The product line-up as a compact three-column grid (owner 10-22 replaced the pinned horizontal rail): copy
 * trading, Earn, Launchpad/Launchpool, loans, OTC, VIP & affiliate — each with its live figure from the public
 * business endpoints (`--` when an endpoint is empty) and a link to the product. Perpetuals have their own board.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '一个账户，完整的产品线',
      sub: '从现货到永续合约，从理财到借币，资金在账户之间自由划转。',
      copyTitle: '跟单交易',
      copyBody: '选择带单交易员，按固定比例或固定金额跟随开平仓，可设置止盈止损，随时停止跟单。',
      copyCta: '浏览交易员',
      copyModes: '跟单方式', copyModesV: '固定比例 / 固定金额',
      earnTitle: '理财',
      earnBody: '活期随存随取，定期锁定更高参考年化，到期自动结算到现货账户。',
      earnCta: '查看理财产品',
      earnApr: '当前最高参考年化',
      launchTitle: '新币申购与质押挖矿',
      launchBody: '用报价币参与新项目申购，或质押资产获得新币奖励。',
      launchpad: 'Launchpad 项目', launchpool: 'Launchpool 矿池',
      loanTitle: '借币',
      loanBody: '以持有的资产作抵押借入，按小时计息，随时还款。',
      loanRate: '{coin} 年化借款利率',
      otcTitle: 'OTC 买币',
      otcBody: '与认证用户点对点买卖数字资产，平台托管卖方资产直至放币。',
      vipTitle: 'VIP 与代理商',
      vipBody: '按 30 日交易量或资产升级 VIP 享受更低费率；成为代理商，邀请好友获得返佣。',
      vipLevels: 'VIP 等级', vipMaker: '合约挂单费率低至',
      more: '了解更多',
    },
    'en-US': {
      title: 'One account. The full line-up.',
      sub: 'From spot to perpetuals, from Earn to loans — move funds between accounts freely.',
      copyTitle: 'Copy trading',
      copyBody: 'Pick a lead trader and mirror their opens and closes by a fixed ratio or fixed amount, with optional TP/SL. Stop copying any time.',
      copyCta: 'Browse traders',
      copyModes: 'Copy modes', copyModesV: 'Ratio / fixed amount',
      earnTitle: 'Earn',
      earnBody: 'Flexible products redeem any time; locked products pay a higher indicative APR and settle back to spot at maturity.',
      earnCta: 'View Earn products',
      earnApr: 'Top indicative APR now',
      launchTitle: 'Launchpad and Launchpool',
      launchBody: 'Commit quote assets to new token sales, or stake to earn new tokens.',
      launchpad: 'Launchpad projects', launchpool: 'Launchpool pools',
      loanTitle: 'Loans',
      loanBody: 'Borrow against the assets you hold. Interest accrues hourly; repay any time.',
      loanRate: '{coin} annual borrow rate',
      otcTitle: 'Buy crypto (OTC)',
      otcBody: 'Buy and sell peer to peer with verified users; the seller\'s assets stay in escrow until released.',
      vipTitle: 'VIP and affiliates',
      vipBody: 'Reach a VIP level by 30-day volume or assets for lower fees. Become an affiliate and earn commission from referrals.',
      vipLevels: 'VIP levels', vipMaker: 'Futures maker fee from',
      more: 'Learn more',
    },
  },
})

const facts = useProductFacts()
</script>

<template>
  <section class="okx-sec">
    <div class="okx-wrap">
      <header class="okx-sec-head">
        <h2 class="okx-h2">{{ t('title') }}</h2>
        <p class="okx-sub">{{ t('sub') }}</p>
      </header>
      <ul class="fx-prod-grid fx-prod-grid-3">
        <li class="fx-prod glass">
          <RouterLink class="fx-prod-main" to="/copy-trading">
            <span class="fx-prod-icon"><Users :size="20" :stroke-width="1.75" /></span>
            <h3>{{ t('copyTitle') }}</h3>
            <p>{{ t('copyBody') }}</p>
            <dl class="fx-prod-facts"><div><dt>{{ t('copyModes') }}</dt><dd>{{ t('copyModesV') }}</dd></div></dl>
            <span class="fx-prod-more">{{ t('copyCta') }}</span>
          </RouterLink>
        </li>
        <li class="fx-prod glass">
          <RouterLink class="fx-prod-main" to="/earn">
            <span class="fx-prod-icon"><PiggyBank :size="20" :stroke-width="1.75" /></span>
            <h3>{{ t('earnTitle') }}</h3>
            <p>{{ t('earnBody') }}</p>
            <dl class="fx-prod-facts">
              <div><dt>{{ t('earnApr') }}<template v-if="facts.earnAsset !== ''"> {{ facts.earnAsset }}</template></dt><dd class="num">{{ facts.earnTopApr }}</dd></div>
            </dl>
            <span class="fx-prod-more">{{ t('earnCta') }}</span>
          </RouterLink>
        </li>
        <li class="fx-prod glass">
          <RouterLink class="fx-prod-main" to="/launchpad">
            <span class="fx-prod-icon"><Rocket :size="20" :stroke-width="1.75" /></span>
            <h3>{{ t('launchTitle') }}</h3>
            <p>{{ t('launchBody') }}</p>
            <dl class="fx-prod-facts">
              <div><dt>{{ t('launchpad') }}</dt><dd class="num">{{ facts.launchProjects }}</dd></div>
              <div><dt>{{ t('launchpool') }}</dt><dd class="num">{{ facts.launchPools }}</dd></div>
            </dl>
            <span class="fx-prod-more">{{ t('more') }}</span>
          </RouterLink>
        </li>
        <li class="fx-prod glass">
          <RouterLink class="fx-prod-main" to="/loans">
            <span class="fx-prod-icon"><HandCoins :size="20" :stroke-width="1.75" /></span>
            <h3>{{ t('loanTitle') }}</h3>
            <p>{{ t('loanBody') }}</p>
            <dl class="fx-prod-facts"><div><dt>{{ t('loanRate', { coin: facts.loanCoin || 'USDT' }) }}</dt><dd class="num">{{ facts.loanApr }}</dd></div></dl>
            <span class="fx-prod-more">{{ t('more') }}</span>
          </RouterLink>
        </li>
        <li class="fx-prod glass">
          <RouterLink class="fx-prod-main" to="/otc">
            <span class="fx-prod-icon"><Banknote :size="20" :stroke-width="1.75" /></span>
            <h3>{{ t('otcTitle') }}</h3>
            <p>{{ t('otcBody') }}</p>
            <span class="fx-prod-more">{{ t('more') }}</span>
          </RouterLink>
        </li>
        <li class="fx-prod glass">
          <RouterLink class="fx-prod-main" to="/vip">
            <span class="fx-prod-icon"><Crown :size="20" :stroke-width="1.75" /></span>
            <h3>{{ t('vipTitle') }}</h3>
            <p>{{ t('vipBody') }}</p>
            <dl class="fx-prod-facts">
              <div><dt>{{ t('vipLevels') }}</dt><dd class="num">{{ facts.vipLevels }}</dd></div>
              <div><dt>{{ t('vipMaker') }}</dt><dd class="num">{{ facts.vipBestMaker }}</dd></div>
            </dl>
            <span class="fx-prod-more">{{ t('more') }}</span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </section>
</template>
