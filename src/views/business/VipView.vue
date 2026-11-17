<script setup lang="ts">
/** 会员等级 (VIP), modelled on Binance Fee Rate / VIP: my level and the gap to the next one, and the full tier table. */
import { computed, onMounted, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Crown } from '@lucide/vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import { useBizContext, useBizQuery } from '@/components/business/ui/useBiz'
import { rowOf, valueAt } from '@/modules/business/client'
import { amount, dateOnly, feeRate, field, positive } from '@/modules/business/format'
import { vScrollFade } from '@/core/scroll-fade'

const { lang, authed, t } = useBizContext()
const levels = useBizQuery(() => '/sapi/v1/vip/levels', () => ({}), 'levels')
const info = useBizQuery(() => (authed.value ? '/sapi/v1/vip/info' : null), () => ({}), '')
function reload() { void levels.load(); void info.load() }
onMounted(reload)
watch(authed, reload)

const me = computed(() => info.rows.value[0] ?? rowOf(null))
const myLevel = computed(() => field(me.value, 'vipLevel') || '0')
const next = computed(() => rowOf(valueAt(me.value, 'next')))
const enabled = computed(() => valueAt(rowOf(levels.raw.value), 'enabled') !== false)
const metrics = computed(() => rowOf(valueAt(me.value, 'metrics')))
const gaps = computed(() => [
  { label: t('vipUi.value30dSpotVolume'), need: field(next.value, 'spotVolumeNeeded'), have: field(metrics.value, 'spotVolume30d') },
  { label: t('vipUi.value30dFuturesVolume'), need: field(next.value, 'futuresVolumeNeeded'), have: field(metrics.value, 'futuresVolume30d') },
  { label: t('vipUi.assetBalance'), need: field(next.value, 'assetNeeded'), have: field(metrics.value, 'assetAvg30d') },
].filter(g => g.need !== ''))
</script>

<template>
  <BizPage :eyebrow="t('vipUi.vipProgram')" :title="t('vipUi.tradeMorePayLess')"
    :subtitle="t('vipUi.yourTierIsReviewedDailyFrom30DayTrading')">
    <template #aside>
      <div class="biz-aside-card vip-card">
        <template v-if="authed">
          <span class="vip-badge"><Crown :size="18" /> VIP {{ myLevel }}</span>
          <template v-if="field(next, 'level') !== ''">
            <p class="biz-muted vip-next">{{ field(next, 'rule') === 'AND' ? t('vipUi.reachVipByMeetingAllOf', { fieldnextlevel: field(next, 'level') }) : t('vipUi.reachVipByMeetingAnyOf', { fieldnextlevel: field(next, 'level') }) }}</p>
            <div v-for="g in gaps" :key="g.label" class="biz-kv"><span>{{ g.label }}</span><span class="num">{{ positive(g.need) ? `${t('vipUi.need')} ${amount(g.need, 2)} USDT` : t('vipUi.met') }}</span></div>
          </template>
          <p v-else class="biz-muted vip-next">{{ t('vipUi.youAreAtTheTopTierThankYou') }}</p>
          <p class="biz-muted vip-update">{{ t('vipUi.nextReview') }} {{ dateOnly(field(me, 'nextUpdateTime')) }}</p>
        </template>
        <template v-else>
          <h3>{{ t('vipUi.logInToSeeYourVipTier') }}</h3>
          <RouterLink class="btn btn-primary" to="/login">{{ t('vipUi.logIn') }}</RouterLink>
        </template>
      </div>
    </template>

    <p v-if="!enabled" class="biz-notice">{{ t('vipUi.vipReviewIsNotActiveYetStandardFeesApply') }}</p>
    <section class="biz-card">
      <header class="biz-card-head"><h2>{{ t('vipUi.tiersAndFees') }}</h2></header>
      <div v-scroll-fade class="vip-scroll x-scroll">
        <table class="table vip-table table-cards">
          <thead>
            <tr>
              <th class="left">{{ t('vipUi.tier') }}</th>
              <th>{{ t('vipUi.value30dSpotVolumeUsdt') }}</th>
              <th>{{ t('vipUi.value30dFuturesVolumeUsdt') }}</th>
              <th>{{ t('vipUi.assetsUsdt') }}</th>
              <th>{{ t('vipUi.qualifyingRule') }}</th>
              <th>{{ t('vipUi.spotMakerTaker') }}</th>
              <th>{{ t('vipUi.futuresMakerTaker') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in levels.rows.value" :key="field(l, 'level')" :class="{ mine: authed && field(l, 'level') === myLevel }">
              <td class="left card-title" :data-label="t('vipUi.tier')"><span class="vip-tier">VIP {{ field(l, 'level') }}</span><span v-if="authed && field(l, 'level') === myLevel" class="vip-me">{{ t('vipUi.current') }}</span></td>
              <td class="num" :data-label="t('vipUi.value30dSpotVolumeUsdt')">{{ positive(field(l, 'spotVolume30d')) ? `≥ ${amount(field(l, 'spotVolume30d'), 0)}` : '—' }}</td>
              <td class="num" :data-label="t('vipUi.value30dFuturesVolumeUsdt')">{{ positive(field(l, 'futuresVolume30d')) ? `≥ ${amount(field(l, 'futuresVolume30d'), 0)}` : '—' }}</td>
              <td class="num" :data-label="t('vipUi.assetsUsdt')">{{ positive(field(l, 'assetUsdt')) ? `≥ ${amount(field(l, 'assetUsdt'), 0)}` : '—' }}</td>
              <td :data-label="t('vipUi.qualifyingRule')">{{ field(l, 'combine') === 'AND' ? t('vipUi.meetAll') : t('vipUi.meetAny') }}</td>
              <td class="num" :data-label="t('vipUi.spotMakerTaker')">{{ feeRate(field(l, 'spotMaker')) }} / {{ feeRate(field(l, 'spotTaker')) }}</td>
              <td class="num" :data-label="t('vipUi.futuresMakerTaker')">{{ feeRate(field(l, 'futuresMaker')) }} / {{ feeRate(field(l, 'futuresTaker')) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!levels.rows.value.length" class="biz-empty" :class="{ err: levels.error.value }">{{ levels.loading.value ? t('vipUi.loading') : levels.error.value || t('vipUi.noTiersConfigured') }}</p>
      </div>
    </section>
    <p class="biz-notice">{{ t('vipUi.tiersAreReviewedDailyOn30DayDataUsing') }}</p>
  </BizPage>
</template>

<style scoped>
.vip-card { min-width: 320px; }
@media (max-width: 860px) { .vip-card { min-width: 0; } }
.vip-badge { display: inline-flex; align-items: center; gap: 8px; justify-self: start; padding: 6px 14px; border-radius: var(--radius-pill); background: linear-gradient(135deg, #f5c86a, #e8900c); color: #2a1a00; font-weight: 800; font-size: 18px; }
.vip-next, .vip-update { margin: 0; font-size: var(--font-size-xs); }
.vip-table { table-layout: auto; min-width: 760px; }
.vip-table th:first-child, .vip-table td:first-child { padding-left: 20px; }
.vip-table th:last-child, .vip-table td:last-child { padding-right: 20px; }
.vip-table .left { text-align: left; }
.vip-table tr.mine { background: var(--color-accent-soft); }
.vip-tier { font-weight: 700; }
.vip-me { margin-left: 8px; padding: 1px 6px; border-radius: var(--radius-pill); background: var(--color-accent); color: var(--color-on-accent); font-size: 10px; font-weight: 700; }
</style>
