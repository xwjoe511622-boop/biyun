<script setup lang="ts">
import { computed } from 'vue'
import { Check, Info, UserRound } from '@lucide/vue'
import type { Trader } from '@/modules/copytrading/copytrading.api'
import { amountText, plainPercent, signedAmount, signedPercent } from '@/modules/copytrading/format'
import { useCopyI18n } from '@/modules/copytrading/i18n'

const props = defineProps<{ trader: Trader; rank: number }>()
const emit = defineEmits<{ (event: 'follow'): void; (event: 'details'): void }>()
const { t } = useCopyI18n()

const name = computed(() => props.trader.nickname.trim() || t('copy.anonymous', { uid: props.trader.uid }))
const initial = computed(() => name.value.slice(0, 1).toUpperCase())
const roi = computed(() => signedPercent(props.trader.profitRatio))
const pnl = computed(() => signedAmount(props.trader.profitUSDT))
const totalRoi = computed(() => signedPercent(props.trader.totalRatio))
</script>

<template>
  <article class="trader">
    <header class="head">
      <span class="avatar" aria-hidden="true">{{ initial || '' }}<UserRound v-if="!initial" :size="18" /></span>
      <div class="who">
        <strong class="name ellipsis" :title="name">{{ name }}</strong>
        <span class="sub">{{ t('copy.days', { n: trader.entryDay }) }}</span>
      </div>
      <span class="rank num" :class="{ top: rank <= 3 }">#{{ rank }}</span>
    </header>

    <div class="headline">
      <span class="label" :title="t('copy.roiDef')" data-testid="copy-roi-def">{{ t('copy.roi2w') }} <Info :size="12" aria-hidden="true" /></span>
      <strong class="roi num" :class="roi.tone">{{ roi.text }}</strong>
    </div>

    <dl class="grid">
      <div><dt>{{ t('copy.pnl2w') }}</dt><dd class="num" :class="pnl.tone">{{ pnl.text }}</dd></div>
      <div><dt :title="t('copy.winRateDef')">{{ t('copy.winRate') }}</dt><dd class="num">{{ plainPercent(trader.winRatio) }}</dd></div>
      <div><dt :title="t('copy.roiDef')">{{ t('copy.totalRoi') }}</dt><dd class="num" :class="totalRoi.tone">{{ totalRoi.text }}</dd></div>
      <div><dt>{{ t('copy.totalPnl') }}</dt><dd class="num">{{ amountText(trader.totalUSDT) }}</dd></div>
      <div><dt>{{ t('copy.orders') }}</dt><dd class="num">{{ trader.orderCount }}</dd></div>
      <div><dt>{{ t('copy.followers') }}</dt><dd class="num">{{ trader.followerCount }} <small>{{ t('copy.current', { n: trader.currentFollowCount }) }}</small></dd></div>
    </dl>

    <footer class="actions">
      <button class="btn" type="button" @click="emit('details')">{{ t('copy.details') }}</button>
      <span v-if="trader.follow === 0" class="chip self">{{ t('copy.self') }}</span>
      <button v-else-if="trader.follow === 1" class="btn following" type="button" @click="emit('follow')"><Check :size="15" aria-hidden="true" />{{ t('copy.following') }}</button>
      <button v-else class="btn btn-primary" type="button" @click="emit('follow')">{{ t('copy.follow') }}</button>
    </footer>
  </article>
</template>

<style scoped>
.trader { display: flex; flex-direction: column; gap: 16px; padding: 20px; border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); transition: border-color .2s, transform .2s var(--ease-out), box-shadow .2s; }
.trader:hover { border-color: var(--color-border-strong); transform: translateY(-2px); box-shadow: var(--shadow-pop); }
.head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.avatar { display: inline-flex; flex: 0 0 44px; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 14px; background: linear-gradient(135deg, var(--color-accent), var(--color-accent-strong)); color: var(--color-on-accent); font-family: var(--font-display); font-size: 18px; font-weight: 800; }
.who { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.name { font-size: 15px; font-weight: 700; }
.sub { color: var(--color-text-muted); font-size: 12px; }
.rank { color: var(--color-text-muted); font-size: 13px; font-weight: 700; }
.rank.top { color: var(--color-accent-text); }
.headline { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border-radius: 12px; background: var(--color-surface-alt); }
.label { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-muted); font-size: 12px; cursor: help; }
.roi { font-size: 28px; font-weight: 700; line-height: 1.2; }
.roi.flat { color: var(--color-text); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; margin: 0; }
.grid div { min-width: 0; }
.grid dt { color: var(--color-text-muted); font-size: 11.5px; }
.grid dd { margin: 2px 0 0; font-size: 14px; font-weight: 600; }
.grid dd small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; font-weight: 500; }
.actions { display: flex; gap: 8px; margin-top: auto; }
.actions .btn { flex: 1; }
.following { border-color: var(--color-up); color: var(--color-up); }
.self { flex: 1; justify-content: center; height: 38px; }
</style>
