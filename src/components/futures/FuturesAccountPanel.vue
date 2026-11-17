<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeftRight, RotateCw } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { useFuturesI18n } from '@/modules/futures/i18n'
import { pnlView, rateView } from '@/modules/futures/math'
import { accountMarginRatio } from '@/modules/futures/position-metrics'
import { signedDisplay } from '@/modules/futures/signed'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useSessionStore } from '@/stores/session'
import TransferDialog from './TransferDialog.vue'

/** Futures margin account summary + transfer entry. */
const { t } = useFuturesI18n()
const account = useFuturesAccountStore()
const market = useFuturesMarketStore()
const sessionStore = useSessionStore()
const transferOpen = ref(false)

const dp = computed(() => market.currentContract?.marginCoinPrecision ?? 4)
const coin = computed(() => account.marginCoin)
const row = computed(() => account.account)
/**
 * Binance 保证金比率 box (PC right column, 2026-09-30): 维持保证金 = Σ qty × mark × maintenance rate over the positions in
 * this margin coin, 保证金余额 = equity (incl. unrealized PnL), 保证金比率 = 维持保证金 ÷ 保证金余额. Single-asset mode only.
 */
const marginBox = computed(() => accountMarginRatio({
  positions: account.positions.map((position) => ({
    volume: position.positionVolume,
    multiplier: market.allContracts.find((entry) => entry.id === position.contractId)?.multiplier ?? '',
    // Risk uses the server snapshot's mark/rate/liquidation group; public mark still drives real-time PnL below.
    mark: position.markPrice,
    keepRate: position.keepRate,
    maintenanceMargin: position.maintenanceMargin,
  })),
  balance: row.value?.totalAmount ?? '',
  dp: 4,
}))

function money(value: string | undefined): string {
  return value === undefined || value === '' ? '--' : signedDisplay(value, dp.value, false)
}
/** Mark-based (Binance) sum of the position PnL, live with the mark price; the server total is only a fallback. */
const unrealized = computed(() => pnlView(account.unrealizedPnl !== '' ? account.unrealizedPnl : (row.value?.unRealizedAmount ?? ''), dp.value))
const realized = computed(() => pnlView(row.value?.cumulativeClosedPnl ?? '', dp.value))
</script>

<template>
  <section class="acct" :aria-label="t('fut.account')">
    <header class="acct-head">
      <span class="acct-title">{{ t('fut.account') }}</span>
      <div v-if="account.isOpened" class="acct-tools">
        <button class="icon-btn" type="button" :title="t('fut.transfer')" :aria-label="t('fut.transfer')" @click="transferOpen = true"><ArrowLeftRight :size="14" /></button>
        <button class="icon-btn" type="button" :title="t('common.refresh')" :aria-label="t('common.refresh')" :disabled="account.assetsLoading" @click="account.loadAssets()"><RotateCw :size="14" /></button>
      </div>
    </header>

    <div v-if="!sessionStore.isAuthenticated" class="acct-guest">
      <p>{{ t('fut.signInFutures') }}</p>
      <div class="guest-actions">
        <RouterLink class="btn btn-primary" to="/login">{{ t('nav.login') }}</RouterLink>
        <RouterLink class="btn" to="/register">{{ t('nav.register') }}</RouterLink>
      </div>
    </div>
    <StateBlock v-else-if="account.open.status === 'checking' || account.open.status === 'signedOut'" variant="loading" :message="t('fut.checkingAccount')" />
    <StateBlock v-else-if="account.open.status === 'error'" variant="error" :message="account.open.initFailed ? t('fut.initFailed') : (account.open.error ?? t('fut.accountLoadFailed'))" retryable @retry="account.refresh()" />
    <StateBlock v-else-if="account.open.status === 'unopened' || account.open.status === 'opening'" variant="loading" :message="t('fut.initializingAccount')" />
    <div v-else-if="account.open.status === 'quiz'" class="quiz-gate" data-testid="futures-quiz-gate">
      <p class="muted">{{ t('fut.quizNeeded') }}</p>
      <button class="btn btn-primary" type="button" @click="account.ensureOpened()">{{ t('fut.quizStart') }}</button>
    </div>
    <template v-else>
      <StateBlock v-if="account.assetsLoading && !account.assetsLoaded" variant="loading" :message="t('common.loading')" />
      <StateBlock v-else-if="account.assetsError !== null && !account.assetsLoaded" variant="error" :message="account.assetsError" retryable @retry="account.loadAssets()" />
      <div v-else class="acct-body">
        <section class="mr-box" data-testid="fut-margin-ratio-box">
          <p class="mr-title">{{ t('fut.mr.title') }}</p>
          <dl class="mr-rows">
            <div :title="t('fut.mr.ratioHint')"><dt>{{ t('fut.mr.ratio') }}</dt><dd class="num ratio">{{ marginBox.ratio === '' ? '--' : rateView(marginBox.ratio) }}</dd></div>
            <div><dt>{{ t('fut.mr.maintenance') }}</dt><dd class="num">{{ marginBox.maintenance === '' ? '--' : `${money(marginBox.maintenance)} ${coin}` }}</dd></div>
            <div><dt>{{ t('fut.mr.balance') }}</dt><dd class="num">{{ money(row?.totalAmount) }} {{ coin }}</dd></div>
          </dl>
          <span class="mr-mode" :title="t('fut.web.singleAsset')">{{ t('fut.mr.singleAsset') }}</span>
        </section>
        <div class="equity">
          <span class="muted">{{ t('fut.equity') }} ({{ coin }})</span>
          <b class="num">{{ money(row?.totalAmount) }}</b>
        </div>
        <dl class="acct-rows">
          <div><dt>{{ t('fut.available') }}</dt><dd class="num">{{ money(account.available) }}</dd></div>
          <div :title="t('fut.transferOutHint')" data-testid="fut-acct-transferable"><dt>{{ t('fut.transferable') }}</dt><dd class="num">{{ money(account.transferable) }}</dd></div>
          <div><dt>{{ t('fut.unrealized') }}</dt><dd class="num" :class="unrealized.direction">{{ unrealized.text }}</dd></div>
          <div :title="t('fut.cumulativeClosedPnlHint')"><dt>{{ t('fut.cumulativeClosedPnl') }}</dt><dd class="num" :class="realized.direction">{{ realized.text }}</dd></div>
          <div><dt>{{ t('fut.totalMargin') }}</dt><dd class="num">{{ money(row?.totalMargin) }}</dd></div>
          <div><dt>{{ t('fut.isolateMargin') }}</dt><dd class="num">{{ money(row?.isolateMargin) }}</dd></div>
          <div><dt>{{ t('fut.frozen') }}</dt><dd class="num">{{ money(row?.lockAmount) }}</dd></div>
        </dl>
        <p v-if="account.assetsError !== null" class="field-error wrap-anywhere">{{ account.assetsError }}</p>
        <button class="btn transfer-btn" type="button" @click="transferOpen = true"><ArrowLeftRight :size="14" />{{ t('fut.transfer') }}</button>
      </div>
    </template>

    <TransferDialog
      v-if="transferOpen && market.currentContract"
      :coin="coin"
      :precision="dp"
      :fundsIn="market.currentContract.fundsIn"
      :fundsOut="market.currentContract.fundsOut"
      @close="transferOpen = false"
    />
  </section>
</template>

<style scoped>
.acct { display: flex; flex-direction: column; background: var(--color-surface); }
.acct-head { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
.acct-title { font-family: var(--font-display); font-size: 14px; font-weight: 650; }
.acct-tools { display: flex; gap: 2px; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; color: var(--color-text-muted); }
.icon-btn:hover:not(:disabled) { color: var(--color-text); background: var(--color-hover); }
.acct-guest { display: flex; flex-direction: column; gap: 12px; padding: 18px 14px; text-align: center; }
.acct-guest p { margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.guest-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.guest-actions .btn { height: 36px; }
.acct-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; }
.equity { display: flex; flex-direction: column; gap: 2px; }
.equity span { font-size: 11px; }
.equity b { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.acct-rows { display: grid; gap: 6px; margin: 0; }
.acct-rows div { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
.acct-rows dt { color: var(--color-text-muted); }
.acct-rows .ratio { font-weight: 700; color: var(--color-text); }
.acct-rows dd { margin: 0; }
.acct-rows dd.up { color: var(--color-up); }
.acct-rows dd.down { color: var(--color-down); }
.transfer-btn { height: 34px; border-radius: 9px; font-size: 12px; }
.mr-box { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--color-border); }
.mr-title { margin: 0; font-size: 13px; font-weight: 700; }
.mr-rows { display: grid; gap: 4px; margin: 0; }
.mr-rows div { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; }
.mr-rows dt { color: var(--color-text-muted); }
.mr-rows dd { margin: 0; }
.mr-mode { display: block; padding: 6px 0; border-radius: 6px; background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 12px; font-weight: 650; text-align: center; }
.quiz-gate { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px 12px; text-align: center; }
</style>
