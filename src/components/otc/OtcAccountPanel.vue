<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDownUp, RefreshCw, WalletCards } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { decimalPlaces, groupDigits, gt, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { sanitizeDecimalInput } from '@/modules/otc/amounts'
import { transferOtc, type AccountKind } from '@/modules/otc/api'
import { DraftRequestId } from '@/modules/api/draft-request-id'
import { coinDpFor } from '@/modules/otc/coins'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { useOtcStore } from '@/stores/otc'
import { useSessionStore } from '@/stores/session'

/**
 * OTC balance of the selected coin plus a spot ↔ OTC transfer
 * (`finance/v4/otc_account_list`, `finance/otc_transfer` — exchange-web-api AccountAct.java:1141/1188).
 */
const props = defineProps<{ coin: string }>()
const { t } = useOtcI18n()
const otc = useOtcStore()
const sessionStore = useSessionStore()

const from = ref<AccountKind>('spot')
const amount = ref('')
const submitting = ref(false)
const message = ref('')
const error = ref('')

const balance = computed(() => otc.balanceOf(props.coin))
const dp = computed(() => coinDpFor(otc.coinMeta(props.coin)))
const sourceAvailable = computed(() => (from.value === 'spot' ? balance.value?.spotNormal : balance.value?.normal) ?? '')

const amountError = computed(() => {
  const value = amount.value.trim()
  if (value === '') return ''
  if (!isDecimalString(value)) return t('otc.amountError.invalid')
  if (!isPositive(value)) return t('otc.amountError.zero')
  const places = decimalPlaces(value)
  if (places !== null && places > dp.value) return t('otc.amountError.precision')
  if (isDecimalString(sourceAvailable.value) && gt(value, sourceAvailable.value)) return t('otc.account.aboveTransferable', { available: groupDigits(sourceAvailable.value), coin: props.coin })
  return ''
})
const canSubmit = computed(() => amount.value.trim() !== '' && amountError.value === '' && !submitting.value && props.coin !== '')

function fmt(value: string | undefined): string {
  return value === undefined || value === '' ? '--' : groupDigits(value, dp.value)
}

function onAmount(event: Event): void {
  amount.value = sanitizeDecimalInput((event.target as HTMLInputElement).value, dp.value)
}

function fillMax(): void {
  if (isDecimalString(sourceAvailable.value)) amount.value = sanitizeDecimalInput(sourceAvailable.value, dp.value)
}

/** One client requestId per submitted transfer draft (reused after an uncertain outcome; draft-request-id.ts). */
const transferIds = new DraftRequestId()

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  message.value = ''
  error.value = ''
  const draft = { from: from.value, to: from.value === 'spot' ? 'otc' as const : 'spot' as const, amount: amount.value.trim(), coin: props.coin }
  try {
    const requestId = transferIds.forDraft(JSON.stringify([draft.from, draft.to, draft.amount, draft.coin]))
    await transferOtc({ ...draft, requestId })
    transferIds.finish()
    message.value = t('otc.account.done')
    amount.value = ''
    await otc.loadAccounts()
  } catch (err) {
    transferIds.finish(err)
    error.value = describeOtcError(t, err)
  } finally {
    submitting.value = false
  }
}

watch(() => props.coin, () => {
  amount.value = ''
  message.value = ''
  error.value = ''
})

watch(() => sessionStore.isAuthenticated, (authed) => {
  if (authed && otc.accounts === null) void otc.loadAccounts()
}, { immediate: true })
</script>

<template>
  <aside class="account-panel">
    <header class="ap-head">
      <span class="ap-icon"><WalletCards :size="17" /></span>
      <h2 class="ap-title">{{ t('otc.account.title') }}</h2>
      <button
        v-if="sessionStore.isAuthenticated"
        class="icon-button ap-refresh"
        type="button"
        :aria-label="t('common.refresh')"
        :disabled="otc.accountsLoading"
        @click="otc.loadAccounts()"
      >
        <RefreshCw :size="15" :class="{ spin: otc.accountsLoading }" />
      </button>
    </header>

    <p v-if="!sessionStore.isAuthenticated" class="ap-guest">
      {{ t('otc.account.loginHint') }}
      <RouterLink class="btn btn-primary ap-login" to="/login">{{ t('nav.login') }}</RouterLink>
    </p>
    <template v-else>
      <StateBlock v-if="otc.accountsError !== null && otc.accounts === null" variant="error" :message="describeOtcError(t, otc.accountsError)" retryable @retry="otc.loadAccounts()" />
      <StateBlock v-else-if="otc.accounts === null" variant="loading" :message="t('common.loading')" />
      <template v-else>
        <dl class="ap-balances">
          <div class="ap-main">
            <dt>{{ t('otc.account.available') }} · {{ coin }}</dt>
            <dd class="num">{{ fmt(balance?.normal) }}</dd>
          </div>
          <div>
            <dt>{{ t('otc.account.locked') }}</dt>
            <dd class="num">{{ fmt(balance?.lock) }}</dd>
          </div>
          <div>
            <dt>{{ t('otc.account.spot') }}</dt>
            <dd class="num">{{ fmt(balance?.spotNormal) }}</dd>
          </div>
        </dl>

        <form class="ap-transfer" @submit.prevent="submit">
          <div class="ap-direction">
            <span>{{ from === 'spot' ? t('otc.account.fromSpot') : t('otc.account.fromOtc') }}</span>
            <button
              class="icon-button ap-swap"
              type="button"
              :aria-label="t('otc.account.transfer')"
              @click="from = from === 'spot' ? 'otc' : 'spot'"
            >
              <ArrowDownUp :size="15" />
            </button>
          </div>
          <label class="field">
            <span class="field-label">{{ t('otc.account.amount') }}</span>
            <span class="field-input" :class="{ invalid: amountError !== '' }">
              <input :value="amount" inputmode="decimal" autocomplete="off" placeholder="0" @input="onAmount" />
              <button class="ap-max" type="button" @click="fillMax">{{ t('otc.trade.max') }}</button>
              <span class="field-suffix">{{ coin }}</span>
            </span>
          </label>
          <p v-if="amountError !== ''" class="field-error">{{ amountError }}</p>
          <button class="btn btn-primary btn-block" type="submit" :disabled="!canSubmit">
            {{ submitting ? t('common.loading') : t('otc.account.submit') }}
          </button>
          <p v-if="message !== ''" class="ap-ok" role="status">{{ message }}</p>
          <p v-if="error !== ''" class="field-error wrap-anywhere" role="alert">{{ error }}</p>
          <p class="ap-note">{{ t('otc.account.lockNote') }}</p>
        </form>
      </template>
    </template>
  </aside>
</template>

<style scoped>
.account-panel {
  display: flex; flex-direction: column; gap: 14px; padding: 18px; border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-surface);
}
.ap-head { display: flex; align-items: center; gap: 10px; }
.ap-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px;
  background: var(--color-accent-soft); color: var(--color-accent-text);
}
.ap-title { flex: 1; margin: 0; font-size: 15px; font-weight: 700; }
.ap-refresh { width: 30px; height: 30px; flex-basis: 30px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.ap-guest { display: flex; flex-direction: column; gap: 12px; margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.ap-login { align-self: flex-start; }
.ap-balances { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 0; }
.ap-balances div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ap-balances .ap-main { grid-column: 1 / -1; }
.ap-balances dt { color: var(--color-text-muted); font-size: 12px; }
.ap-balances dd { margin: 0; font-size: 14px; font-weight: 600; white-space: normal; overflow-wrap: anywhere; }
.ap-balances .ap-main dd { font-size: 22px; font-weight: 650; }
.ap-transfer { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px dashed var(--color-border-strong); }
.ap-direction { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 650; }
.ap-swap { width: 32px; height: 32px; flex-basis: 32px; border: 1px solid var(--color-border-strong); }
.ap-max { color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.field-input { height: 42px; }
.ap-ok { margin: 0; color: var(--color-up); font-size: 12px; }
.ap-note { margin: 0; color: var(--color-text-muted); font-size: 11.5px; line-height: 1.5; }
</style>
