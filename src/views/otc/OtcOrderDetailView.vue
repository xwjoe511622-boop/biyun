<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft, Check, Clock, Copy, FileText, RefreshCw, ShieldAlert, UserRound } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import OtcChatPanel from '@/components/otc/OtcChatPanel.vue'
import OtcDialog from '@/components/otc/OtcDialog.vue'
import OtcStatusBadge from '@/components/otc/OtcStatusBadge.vue'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import {
  appealOrder,
  cancelAppeal,
  cancelOrder,
  fetchOrderDetail,
  markOrderPaid,
  releaseOrder,
  type OrderPaymentAccount,
  type OtcOrderDetail,
} from '@/modules/otc/api'
import { coinDpFor, fiatDpFor } from '@/modules/otc/coins'
import { deadlineFromRemaining, formatCountdown, remainingMs } from '@/modules/otc/countdown'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { RP_MESSAGES } from '@/modules/redpacket/i18n'
import { availableActions, isTerminal, resolveRole } from '@/modules/otc/order-state'
import { useOtcStore } from '@/stores/otc'
import { useSessionStore } from '@/stores/session'

const { t: uiLabel } = useI18n({ useScope: 'global' })

/**
 * C2C order page. Detail: exchange-otc-api `v4/otc/order_detail` (OrderActV4.java:133), polled every
 * 10 s with `exchange-auto: 1` until the order is terminal. Actions follow `modules/otc/order-state`.
 */
const POLL_MS = 10_000
type DialogKind = 'markPaid' | 'cancel' | 'release' | 'appeal' | 'cancelAppeal' | null

const otcI18n = useOtcI18n()
otcI18n.mergeLocaleMessage('zh-CN', RP_MESSAGES['zh-CN'])
otcI18n.mergeLocaleMessage('en-US', RP_MESSAGES['en-US'])
const { t } = otcI18n
const route = useRoute()
const otc = useOtcStore()
const sessionStore = useSessionStore()

const order = ref<OtcOrderDetail | null>(null)
const loading = ref(false)
const error = ref('')
const deadline = ref<number | null>(null)
const now = ref(Date.now())
const selectedPayment = ref('')
const dialog = ref<DialogKind>(null)
const acting = ref(false)
const actionError = ref('')
const notice = ref('')
const confirmCheck = ref(false)
const fundPassword = ref('')
const appealReason = ref('')
const copied = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let generation = 0
let expiredReloaded = false

const sequence = computed(() => String(route.params.id ?? ''))
const authed = computed(() => sessionStore.isAuthenticated)
const myUid = computed(() => {
  const id = sessionStore.user?.id
  return id === undefined || id === null ? '' : String(id)
})
const role = computed(() => order.value === null ? null : resolveRole(myUid.value, order.value.seller.uid, order.value.buyer.uid))
const counterparty = computed(() => order.value === null || role.value === null ? null : role.value === 'buyer' ? order.value.seller : order.value.buyer)
const actions = computed(() => availableActions({
  status: order.value?.status ?? null,
  role: role.value,
  payTime: order.value?.payTime ?? null,
  now: now.value,
  isComplainUser: order.value?.isComplainUser ?? false,
}))
const left = computed(() => remainingMs(deadline.value, now.value))
const coinMeta = computed(() => otc.coinMeta(order.value?.coin ?? ''))
const fiatDp = computed(() => fiatDpFor(coinMeta.value, order.value?.payCoin ?? ''))
const coinDp = computed(() => coinDpFor(coinMeta.value))
const chosenAccount = computed<OrderPaymentAccount | undefined>(() =>
  order.value?.paymentAccounts.find(p => p.payment === selectedPayment.value))
const paidWith = computed(() => order.value?.paymentAccounts.find(p => p.payment === order.value?.payKey))

const step = computed(() => {
  const status = order.value?.status
  if (status === 3 || status === 8) return 3
  if (status === 2 || status === 5) return 2
  return 1
})

const statusLine = computed(() => {
  const o = order.value
  if (o === null) return ''
  switch (o.status) {
    case 1: return role.value === 'buyer' ? t('otc.order.payBefore') : t('otc.order.waitingPayment')
    case 2: return role.value === 'seller' ? t('otc.order.confirm.releaseBody', { amount: fmtFiat(o.totalPrice), fiat: o.payCoin }) : t('otc.order.waitingRelease')
    case 3: case 8: return role.value === 'buyer' ? t('otc.order.doneBuy') : t('otc.order.doneSell')
    case 4: case 9: return t('otc.order.cancelledNote')
    case 5: return t('otc.order.appealNote')
    default: return ''
  }
})

function fmtFiat(value: string): string {
  return isDecimalString(value) ? groupDigits(value, fiatDp.value) : '--'
}
function fmtCoin(value: string): string {
  return isDecimalString(value) ? groupDigits(value, coinDp.value) : '--'
}
function fmtTime(value: number | null): string {
  return value === null ? '--' : new Date(value).toLocaleString()
}

async function load(auto = false): Promise<void> {
  if (!authed.value || sequence.value === '') return
  const gen = ++generation
  if (!auto) loading.value = true
  try {
    const detail = await fetchOrderDetail(sequence.value, auto)
    if (gen !== generation) return
    order.value = detail
    error.value = ''
    deadline.value = detail.status === 1 && detail.limitTime !== null ? deadlineFromRemaining(detail.limitTime, Date.now()) : null
    if (selectedPayment.value === '' || !detail.paymentAccounts.some(p => p.payment === selectedPayment.value)) {
      selectedPayment.value = detail.paymentAccounts[0]?.payment ?? ''
    }
    if (isTerminal(detail.status)) stopPolling()
  } catch (err) {
    if (gen !== generation) return
    if (!auto || order.value === null) error.value = describeOtcError(t, err)
  } finally {
    if (gen === generation) loading.value = false
  }
}

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(() => { void load(true) }, POLL_MS)
}
function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
}

function openDialog(kind: DialogKind): void {
  actionError.value = ''
  confirmCheck.value = false
  fundPassword.value = ''
  appealReason.value = ''
  dialog.value = kind
}

function closeDialog(): void {
  if (acting.value) return
  dialog.value = null
  fundPassword.value = ''
}

const dialogReady = computed(() => {
  switch (dialog.value) {
    case 'markPaid': return selectedPayment.value !== ''
    case 'cancel': return confirmCheck.value
    case 'release': return confirmCheck.value && fundPassword.value !== ''
    case 'appeal': return appealReason.value.trim() !== ''
    case 'cancelAppeal': return true
    default: return false
  }
})

async function runAction(): Promise<void> {
  const o = order.value
  if (o === null || dialog.value === null || !dialogReady.value) return
  acting.value = true
  actionError.value = ''
  try {
    switch (dialog.value) {
      case 'markPaid': await markOrderPaid(o.sequence, selectedPayment.value); break
      case 'cancel': await cancelOrder(o.sequence); break
      case 'release': await releaseOrder(o.sequence, fundPassword.value); break
      case 'appeal': await appealOrder(o.sequence, role.value === 'seller' ? 'seller' : 'buyer', appealReason.value.trim()); break
      case 'cancelAppeal': await cancelAppeal(o.sequence); break
    }
    notice.value = t('otc.order.success')
    fundPassword.value = ''
    dialog.value = null
    await load()
    if (!isTerminal(order.value?.status ?? null)) startPolling()
  } catch (err) {
    actionError.value = describeOtcError(t, err)
  } finally {
    acting.value = false
  }
}

async function copy(value: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = key
    setTimeout(() => { if (copied.value === key) copied.value = '' }, 1500)
  } catch {
    // Clipboard unavailable (permissions / insecure context) — the value stays selectable.
  }
}

watch(left, (value) => {
  // When the payment window closes, re-read once: the server auto-cancels on the next detail call.
  if (value === 0 && deadline.value !== null && !expiredReloaded) {
    expiredReloaded = true
    void load(true)
  }
})

watch([authed, sequence], ([isAuthed]) => {
  order.value = null
  error.value = ''
  expiredReloaded = false
  if (!isAuthed) {
    stopPolling()
    return
  }
  if (sessionStore.user === null) void sessionStore.loadUserInfo()
  void load().then(() => { if (!isTerminal(order.value?.status ?? null)) startPolling() })
}, { immediate: true })

onMounted(() => {
  void otc.ensureMarketInfo()
  void otc.loadPublicInfo()
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  generation += 1
  stopPolling()
  if (tickTimer !== null) clearInterval(tickTimer)
})
</script>

<template>
  <div class="page detail-page">
    <RouterLink class="back-link" to="/otc/orders"><ArrowLeft :size="15" />{{ t('otc.order.back') }}</RouterLink>

    <GuestGate v-if="!authed" :message="t('otc.ordersPage.login')" :icon="FileText" />
    <StateBlock v-else-if="loading && order === null" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="error !== '' && order === null" variant="error" :message="error" retryable @retry="load()" />
    <template v-else-if="order !== null">
      <header class="detail-head">
        <div class="head-title">
          <CoinMark :symbol="order.coin" :icon-url="coinMeta?.icon ?? ''" :size="34" />
          <div>
            <h1>
              <span :class="role === 'buyer' ? 'up' : role === 'seller' ? 'down' : ''">
                {{ role === 'seller' ? t('otc.order.sellTitle', { coin: order.coin }) : t('otc.order.buyTitle', { coin: order.coin }) }}
              </span>
              <OtcStatusBadge :status="order.status" />
            </h1>
            <p class="head-meta">
              {{ t('otc.order.sequence') }} <span class="num">{{ order.sequence }}</span>
              <button class="copy-btn" type="button" :aria-label="t('otc.order.sequence')" @click="copy(order.sequence, 'seq')">
                <Check v-if="copied === 'seq'" :size="13" /><Copy v-else :size="13" />
              </button>
              · {{ t('otc.order.createdAt') }} {{ fmtTime(order.createdAt) }}
            </p>
          </div>
        </div>
        <div v-if="actions.countdown" class="countdown" :class="{ urgent: left > 0 && left < 3 * 60_000, over: left === 0 }">
          <Clock :size="16" />
          <span>{{ left === 0 ? t('otc.order.expired') : t('otc.order.timeLeft') }}</span>
          <strong v-if="left > 0" class="num">{{ formatCountdown(left) }}</strong>
        </div>
      </header>

      <ol class="steps" :aria-label="uiLabel('accessibility.progress')">
        <li :class="{ done: step >= 1 }"><i>1</i>{{ t('otc.order.steps.created') }}</li>
        <li :class="{ done: step >= 2 }"><i>2</i>{{ t('otc.order.steps.paid') }}</li>
        <li :class="{ done: step >= 3 }"><i>3</i>{{ t('otc.order.steps.done') }}</li>
      </ol>

      <div class="detail-grid">
        <div class="detail-main">
          <section class="card">
            <p v-if="statusLine !== ''" class="status-line">{{ statusLine }}</p>
            <dl class="figures">
              <div><dt>{{ t('otc.order.total') }}</dt><dd class="num big">{{ fmtFiat(order.totalPrice) }} <small>{{ order.payCoin }}</small></dd></div>
              <div><dt>{{ t('otc.order.price') }}</dt><dd class="num">{{ fmtFiat(order.price) }} <small>{{ order.payCoin }}</small></dd></div>
              <div><dt>{{ t('otc.order.volume') }}</dt><dd class="num">{{ fmtCoin(order.volume) }} <small>{{ order.coin }}</small></dd></div>
            </dl>
          </section>

          <section class="card">
            <h2 class="card-title">{{ t('otc.order.paymentInfo') }}</h2>
            <template v-if="actions.showPaymentAccounts && order.paymentAccounts.length > 0">
              <p v-if="role === 'buyer' && order.status === 1" class="notice notice-info">{{ t('otc.order.paymentInfoHint') }}</p>
              <p v-if="role === 'buyer' && actions.markPaid" class="field-label pick-label">{{ t('otc.order.selectPayment') }}</p>
              <div class="pay-accounts" role="radiogroup">
                <label
                  v-for="acc in order.paymentAccounts"
                  :key="acc.payment"
                  class="pay-account"
                  :class="{ selected: acc.payment === selectedPayment && actions.markPaid }"
                >
                  <input
                    v-if="actions.markPaid"
                    v-model="selectedPayment"
                    class="pay-radio"
                    type="radio"
                    name="otc-payment"
                    :value="acc.payment"
                  />
                  <span class="pay-name">{{ otc.paymentTitle(acc.payment) }}</span>
                  <dl class="pay-fields">
                    <div v-if="acc.userName !== ''"><dt>{{ t('otc.order.accountName') }}</dt><dd>{{ acc.userName }}</dd></div>
                    <div v-if="acc.account !== ''">
                      <dt>{{ t('otc.order.accountNo') }}</dt>
                      <dd class="num">
                        {{ acc.account }}
                        <button class="copy-btn" type="button" :aria-label="t('otc.order.accountNo')" @click.prevent="copy(acc.account, acc.payment)">
                          <Check v-if="copied === acc.payment" :size="13" /><Copy v-else :size="13" />
                        </button>
                      </dd>
                    </div>
                    <div v-if="acc.bankName !== ''"><dt>{{ t('otc.order.bank') }}</dt><dd>{{ acc.bankName }}</dd></div>
                    <div v-if="acc.bankOfDeposit !== ''"><dt>{{ t('otc.order.branch') }}</dt><dd>{{ acc.bankOfDeposit }}</dd></div>
                    <div v-if="acc.ifscCode !== ''"><dt>{{ t('otc.order.ifsc') }}</dt><dd class="num">{{ acc.ifscCode }}</dd></div>
                  </dl>
                  <img v-if="acc.qrcodeImg !== ''" class="pay-qr" :src="acc.qrcodeImg" :alt="t('otc.order.qrcode')" />
                </label>
              </div>
            </template>
            <p v-else-if="paidWith !== undefined" class="muted small">{{ t('otc.order.paidWith') }}: {{ otc.paymentTitle(paidWith.payment) }}</p>
            <p v-else class="muted small">{{ t('otc.order.paymentHidden') }}</p>
          </section>

          <section v-if="order.description !== ''" class="card">
            <h2 class="card-title">{{ t('otc.order.remarks') }}</h2>
            <p class="remarks wrap-anywhere">{{ order.description }}</p>
          </section>

          <section class="card actions-card">
            <p v-if="notice !== ''" class="ok-note" role="status">{{ notice }}</p>
            <div class="action-row">
              <button v-if="actions.markPaid" class="btn btn-buy" type="button" @click="openDialog('markPaid')">{{ t('otc.order.actions.markPaid') }}</button>
              <button v-if="actions.release" class="btn btn-sell" type="button" @click="openDialog('release')">{{ t('otc.order.actions.release') }}</button>
              <button v-if="actions.appeal" class="btn" type="button" @click="openDialog('appeal')"><ShieldAlert :size="15" />{{ t('otc.order.actions.appeal') }}</button>
              <span v-else-if="actions.appealLockedUntil !== null" class="lock-note">
                <ShieldAlert :size="14" />{{ t('otc.order.appealLocked', { time: formatCountdown(actions.appealLockedUntil - now) }) }}
              </span>
              <button v-if="actions.cancelAppeal" class="btn" type="button" @click="openDialog('cancelAppeal')">{{ t('otc.order.actions.cancelAppeal') }}</button>
              <button v-if="actions.cancel" class="btn btn-ghost" type="button" @click="openDialog('cancel')">{{ t('otc.order.actions.cancel') }}</button>
              <button class="btn btn-ghost refresh" type="button" :disabled="loading" @click="load()">
                <RefreshCw :size="15" />{{ t('otc.order.actions.refresh') }}
              </button>
            </div>
            <p v-if="error !== ''" class="field-error">{{ error }}</p>
          </section>
        </div>

        <aside class="detail-side">
          <section v-if="counterparty !== null" class="card party">
            <span class="party-avatar"><UserRound :size="18" /></span>
            <div class="party-text">
              <span class="muted small">{{ t('otc.order.counterparty') }} · {{ role === 'buyer' ? t('otc.order.seller') : t('otc.order.buyer') }}</span>
              <strong class="wrap-anywhere">{{ counterparty.nickname || '--' }}</strong>
              <RouterLink
                v-if="authed && role !== null && counterparty.uid !== ''"
                class="rp-send-link"
                :to="{ path: '/redpacket/send', query: { sequence: order.sequence } }"
              >{{ t('rp.sendTitle') }}</RouterLink>
              <span class="muted small">
                <template v-if="counterparty.realName !== ''">{{ t('otc.order.realName') }} {{ counterparty.realName }} · </template>
                {{ t('otc.order.completeOrders', { n: counterparty.completeOrders || '--' }) }}
              </span>
            </div>
            <span class="presence" :class="{ on: counterparty.online }">{{ counterparty.online ? t('otc.online') : t('otc.offline') }}</span>
          </section>
          <OtcChatPanel
            v-if="counterparty !== null && myUid !== ''"
            :sequence="order.sequence"
            :my-uid="myUid"
            :peer-uid="counterparty.uid"
            :peer-name="counterparty.nickname"
            :ws-url="otc.publicInfo?.chatWsUrl ?? ''"
          />
        </aside>
      </div>
    </template>
    <StateBlock v-else variant="empty" :message="t('otc.order.notFound')" />

    <OtcDialog
      :open="dialog !== null"
      :busy="acting"
      :title="dialog === null ? '' : t(`otc.order.confirm.${dialog}Title`)"
      @close="closeDialog"
    >
      <form v-if="order !== null" id="otc-action-form" class="action-form" @submit.prevent="runAction">
        <p v-if="dialog === 'markPaid'" class="dialog-copy">
          {{ t('otc.order.confirm.markPaidBody', { payment: chosenAccount ? otc.paymentTitle(chosenAccount.payment) : '--', amount: fmtFiat(order.totalPrice), fiat: order.payCoin }) }}
        </p>
        <template v-else-if="dialog === 'cancel'">
          <p class="dialog-copy">{{ t('otc.order.confirm.cancelBody') }}</p>
          <label class="check"><input v-model="confirmCheck" type="checkbox" />{{ t('otc.order.confirm.cancelCheck') }}</label>
        </template>
        <template v-else-if="dialog === 'release'">
          <p class="dialog-copy">{{ t('otc.order.confirm.releaseBody', { amount: fmtFiat(order.totalPrice), fiat: order.payCoin }) }}</p>
          <label class="field">
            <span class="field-label">{{ t('otc.trade.fundPassword') }}</span>
            <span class="field-input"><input v-model="fundPassword" type="password" autocomplete="off" maxlength="64" /></span>
          </label>
          <label class="check"><input v-model="confirmCheck" type="checkbox" />{{ t('otc.order.confirm.releaseCheck') }}</label>
        </template>
        <template v-else-if="dialog === 'appeal'">
          <p class="dialog-copy">{{ t('otc.order.confirm.appealBody') }}</p>
          <textarea v-model="appealReason" class="textarea" rows="4" maxlength="500" :placeholder="t('otc.order.confirm.appealPlaceholder')" />
        </template>
        <p v-else-if="dialog === 'cancelAppeal'" class="dialog-copy">{{ t('otc.order.confirm.cancelAppealBody') }}</p>
        <p v-if="actionError !== ''" class="notice notice-error" role="alert">{{ actionError }}</p>
      </form>
      <template #footer>
        <button class="btn" type="button" :disabled="acting" @click="closeDialog">{{ t('common.cancel') }}</button>
        <button
          class="btn"
          :class="dialog === 'release' ? 'btn-sell' : dialog === 'markPaid' ? 'btn-buy' : 'btn-primary'"
          type="submit"
          form="otc-action-form"
          :disabled="!dialogReady || acting"
        >
          {{ acting ? t('common.loading') : t('common.confirm') }}
        </button>
      </template>
    </OtcDialog>
  </div>
</template>

<style scoped>
.back-link { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 16px; color: var(--color-text-secondary); font-size: 13px; font-weight: 600; }
.back-link:hover { color: var(--color-text); }
.detail-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.head-title { display: flex; align-items: center; gap: 14px; min-width: 0; }
.head-title h1 { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0; font-size: 26px; font-weight: 750; }
.head-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0 0; color: var(--color-text-muted); font-size: 12.5px; }
.copy-btn { display: inline-flex; padding: 2px; color: var(--color-text-muted); border-radius: 4px; }
.copy-btn:hover { color: var(--color-accent-text); background: var(--color-hover); }
.countdown {
  display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border: 1px solid var(--color-accent);
  border-radius: 12px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 13px; font-weight: 600;
}
.countdown strong { font-size: 22px; }
.countdown.urgent { border-color: var(--color-down); background: var(--color-down-soft); color: var(--color-down); }
.countdown.over { border-color: var(--color-border-strong); background: var(--color-surface-alt); color: var(--color-text-muted); }

.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 22px 0; padding: 0; list-style: none; counter-reset: s; }
.steps li {
  position: relative; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px;
  background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text-muted); font-size: 13px; font-weight: 600;
}
.steps i {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%;
  background: var(--color-surface-alt); font-style: normal; font-size: 12px;
}
.steps li.done { color: var(--color-text); border-color: var(--color-accent); }
.steps li.done i { background: var(--color-accent); color: var(--color-on-accent); }

.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 18px; align-items: start; }
.detail-main, .detail-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.detail-side { position: sticky; top: calc(var(--header-h) + 24px); }
.card { padding: 18px 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
.card-title { margin: 0 0 12px; font-size: 15px; font-weight: 700; }
.status-line { margin: 0 0 14px; color: var(--color-text-secondary); font-size: 14px; }
.figures { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 16px; margin: 0; }
.figures div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.figures dt { color: var(--color-text-muted); font-size: 12px; }
.figures dd { margin: 0; font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.figures dd.big { font-size: 26px; font-weight: 700; color: var(--color-accent-text); }
.figures small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 12px; }
.pick-label { margin: 12px 0 8px; }
.pay-accounts { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.pay-account {
  position: relative; display: grid; grid-template-columns: auto 1fr auto; gap: 6px 14px; align-items: start; padding: 14px 16px;
  border: 1px solid var(--color-border); border-left: 3px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt);
}
.pay-account.selected { border-color: var(--color-accent); border-left-color: var(--color-accent); background: var(--color-accent-soft); }
.pay-radio { margin-top: 3px; accent-color: var(--color-accent); }
.pay-name { grid-column: 2; font-weight: 700; font-size: 14px; }
.pay-account:not(:has(.pay-radio)) .pay-name { grid-column: 1 / 3; }
.pay-fields { grid-column: 2; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px 16px; margin: 0; }
.pay-account:not(:has(.pay-radio)) .pay-fields { grid-column: 1 / 3; }
.pay-fields div { display: flex; flex-direction: column; min-width: 0; }
.pay-fields dt { color: var(--color-text-muted); font-size: 11.5px; }
.pay-fields dd { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.pay-qr { grid-column: 3; grid-row: 1 / span 2; width: 92px; height: 92px; border-radius: 8px; background: #fff; object-fit: contain; }
.remarks { margin: 0; color: var(--color-text-secondary); font-size: 13.5px; white-space: pre-line; }
.small { font-size: 12.5px; }
.actions-card { display: flex; flex-direction: column; gap: 10px; }
.action-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.action-row .btn { height: 42px; }
.refresh { margin-left: auto; }
.lock-note { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: 12.5px; }
.ok-note { margin: 0; color: var(--color-up); font-size: 13px; font-weight: 600; }
.party { display: flex; align-items: center; gap: 12px; }
.party-avatar {
  display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex: 0 0 40px; border-radius: 50%;
  background: var(--color-accent-soft); color: var(--color-accent-text);
}
.party-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.rp-send-link { align-self: flex-start; margin-top: 4px; color: var(--color-accent-text); font-size: 12.5px; font-weight: 650; text-decoration: underline; }
.presence { font-size: 11.5px; font-weight: 650; color: var(--color-text-muted); }
.presence.on { color: var(--color-up); }
.action-form { display: flex; flex-direction: column; gap: 14px; }
.dialog-copy { margin: 0; color: var(--color-text-secondary); font-size: 14px; line-height: 1.6; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; }
.check input { width: 16px; height: 16px; accent-color: var(--color-accent); }
.textarea {
  width: 100%; padding: 10px 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); resize: vertical;
  background: var(--color-surface-alt); color: var(--color-text); font: inherit; outline: none;
}
.textarea:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }

@media (max-width: 1080px) {
  .detail-grid { grid-template-columns: 1fr; }
  .detail-side { position: static; }
}
@media (max-width: 640px) {
  .head-title h1 { font-size: 21px; }
  .countdown { width: 100%; justify-content: center; }
  .figures { grid-template-columns: 1fr 1fr; }
  .figures div:first-child { grid-column: 1 / -1; }
  .steps li { padding: 8px; font-size: 12px; gap: 6px; }
  .pay-account { grid-template-columns: auto 1fr; }
  .pay-qr { grid-column: 1 / -1; grid-row: auto; }
  .refresh { margin-left: 0; }
  .card { padding: 16px; }
}
</style>
