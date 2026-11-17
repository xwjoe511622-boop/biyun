<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Crown, Gift, HandCoins, Percent, PiggyBank, Rocket, Users, Wallet } from '@lucide/vue'

/**
 * Products: a compact grid of every product (owner 10-22: the pinned horizontal rail was 大块空白、滚动半天) — icon,
 * name, one-line description and links to the real pages. Four columns on desktop, two on tablets and phones.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      title: '一个账户，覆盖完整的交易与理财',
      sub: '从现货到永续合约，从跟单到理财和新币发行，所有产品共用同一个账户与资产。',
    },
    'en-US': {
      title: 'One account for trading and earning',
      sub: 'From spot to perpetuals, from copy trading to Earn and token launches — every product shares the same account and balances.',
    },
  },
})

const { t: productText } = useI18n({ useScope: 'global' })

interface Tile { to: string; icon: Component; title: string; desc: string; links?: { to: string; label: string }[] }
const tiles = computed<Tile[]>(() => {
  return [
    { to: '/copy-trading', icon: Users, title: productText('productTile.copyTrading'), desc: productText('productTile.pickALeadTraderAndMirrorTheirFuturesOrders') },
    { to: '/earn', icon: PiggyBank, title: productText('productTile.earn'), desc: productText('productTile.putIdleAssetsIntoFlexibleOrFixedPlansThat') },
    {
      to: '/launchpad', icon: Rocket, title: productText('productTile.tokenLaunches'),
      desc: productText('productTile.subscribeToNewTokenSalesOrStakeToFarm'),
      links: [{ to: '/launchpad', label: 'Launchpad' }, { to: '/launchpool', label: 'Launchpool' }, { to: '/vesting', label: productText('productTile.vesting') }],
    },
    { to: '/loans', icon: HandCoins, title: productText('productTile.loans'), desc: productText('productTile.borrowAgainstYourHoldingsAndRepayOnTheLoans') },
    { to: '/margin', icon: Percent, title: productText('productTile.margin'), desc: productText('productTile.borrowOnSpotMarketsWithIsolatedRiskPerPair') },
    { to: '/otc', icon: Wallet, title: productText('productTile.otc'), desc: productText('productTile.buyAndSellUsdtDirectlyWithMerchants') },
    {
      to: '/vip', icon: Crown, title: productText('productTile.vipAffiliates'),
      desc: productText('productTile.feeBenefitsByTierAffiliatesEarnRebates'),
      links: [{ to: '/vip', label: 'VIP' }, { to: '/affiliate', label: productText('productTile.affiliate') }],
    },
    {
      to: '/invite', icon: Gift, title: productText('productTile.referralRedPackets'),
      desc: productText('productTile.inviteFriendsToShareRebatesOrSendCryptoRed'),
      links: [{ to: '/invite', label: productText('productTile.invite') }, { to: '/redpacket/send', label: productText('productTile.send') }],
    },
  ]
})
</script>

<template>
  <section class="bn-section products" data-fx>
    <div class="bn-section-inner">
      <header class="bn-section-head">
        <div>
          <h2>{{ t('title') }}</h2>
          <p>{{ t('sub') }}</p>
        </div>
      </header>
      <ul class="fx-prod-grid">
        <li v-for="tile in tiles" :key="tile.title" class="fx-prod glass">
          <RouterLink class="fx-prod-main" :to="tile.to">
            <span class="fx-prod-icon"><component :is="tile.icon" :size="20" :stroke-width="1.75" /></span>
            <h3>{{ tile.title }}<ChevronRight class="fx-prod-arrow" :size="16" /></h3>
            <p>{{ tile.desc }}</p>
          </RouterLink>
          <nav v-if="tile.links" class="fx-prod-links">
            <RouterLink v-for="link in tile.links" :key="link.to" :to="link.to">{{ link.label }}</RouterLink>
          </nav>
        </li>
      </ul>
    </div>
  </section>
</template>
