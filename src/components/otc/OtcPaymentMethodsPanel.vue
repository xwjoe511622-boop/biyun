<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { toastSuccess } from '@/core/toast'
import { CreditCard, Pencil, Plus, Trash2 } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import OtcDialog from './OtcDialog.vue'
import {
  deletePaymentMethod,
  requestPaymentSms,
  savePaymentMethod,
  togglePaymentMethod,
  type UserPaymentMethod,
} from '@/modules/otc/api'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { readFactorState } from '@/modules/security/security-state'
import { useOtcStore } from '@/stores/otc'
import { useSessionStore } from '@/stores/session'

/**
 * Receiving methods: `otc/payment/find|add|update|v4/payment/delete|open` (PersonalPageAct.java:1465/976/
 * 1154/1387/1562). Add/update need the SMS (op type 28, legacy SetUp.js) and/or authenticator code the
 * server checks; at most 3 methods can be enabled (server code 2058).
 */
const { t } = useOtcI18n()
const otc = useOtcStore()
const sessionStore = useSessionStore()

const BANK = 'otc.payment.domestic.bank.transfer'
const WESTERN_UNION = 'otc.payment.western.union'

const editorOpen = ref(false)
const saving = ref(false)
const saveError = ref('')
const notice = ref('')
const busyId = ref('')
const listError = ref('')
const deleting = ref<UserPaymentMethod | null>(null)
const smsSending = ref(false)
const smsCooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

const draft = reactive({ id: '', payment: '', userName: '', account: '', bankName: '', bankOfDeposit: '', ifscCode: '', sms: '', google: '' })

const googleOn = computed(() => readFactorState(sessionStore.user?.googleStatus) === 'enabled')
const smsOn = computed(() => readFactorState(sessionStore.user?.isOpenMobileCheck) === 'enabled')
/** Show SMS when enabled, or when no factor is known to be on (the server needs at least one code). */
const showSms = computed(() => smsOn.value || !googleOn.value)
const types = computed(() => otc.publicInfo?.payments ?? [])
const isBank = computed(() => draft.payment === BANK)
const needsAccount = computed(() => draft.payment !== WESTERN_UNION)
const draftValid = computed(() => {
  if (draft.payment === '' || draft.userName.trim() === '') return false
  if (needsAccount.value && draft.account.trim() === '') return false
  if (isBank.value && (draft.bankName.trim() === '' || draft.bankOfDeposit.trim() === '')) return false
  const codeOk = (value: string): boolean => /^\d{6}$/.test(value)
  if (googleOn.value && !codeOk(draft.google)) return false
  if (showSms.value && !codeOk(draft.sms)) return false
  return true
})

function openEditor(item?: UserPaymentMethod): void {
  Object.assign(draft, {
    id: item?.id ?? '',
    payment: item?.payment ?? types.value[0]?.key ?? '',
    userName: item?.userName ?? '',
    account: item?.account ?? '',
    bankName: item?.bankName ?? '',
    bankOfDeposit: item?.bankOfDeposit ?? '',
    ifscCode: item?.ifscCode ?? '',
    sms: '',
    google: '',
  })
  saveError.value = ''
  editorOpen.value = true
}

async function sendSms(): Promise<void> {
  if (smsSending.value || smsCooldown.value > 0) return
  smsSending.value = true
  saveError.value = ''
  try {
    await requestPaymentSms()
    smsCooldown.value = 60
    cooldownTimer = setInterval(() => {
      smsCooldown.value -= 1
      if (smsCooldown.value <= 0 && cooldownTimer !== null) {
        clearInterval(cooldownTimer)
        cooldownTimer = null
      }
    }, 1000)
  } catch (err) {
    saveError.value = describeOtcError(t, err)
  } finally {
    smsSending.value = false
  }
}

async function save(): Promise<void> {
  if (!draftValid.value || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    await savePaymentMethod({
      id: draft.id,
      payment: draft.payment,
      userName: draft.userName.trim(),
      account: draft.account.trim(),
      bankName: draft.bankName.trim(),
      bankOfDeposit: draft.bankOfDeposit.trim(),
      ifscCode: draft.ifscCode.trim(),
      smsAuthCode: showSms.value ? draft.sms : undefined,
      googleCode: googleOn.value ? draft.google : undefined,
    })
    editorOpen.value = false
    notice.value = t('otc.paymentMethods.saved')
    await otc.loadPaymentMethods()
  } catch (err) {
    saveError.value = describeOtcError(t, err)
  } finally {
    saving.value = false
  }
}

async function toggle(item: UserPaymentMethod): Promise<void> {
  busyId.value = item.id
  listError.value = ''
  try {
    await togglePaymentMethod(item.id, !item.open)
    await otc.loadPaymentMethods()
  } catch (err) {
    listError.value = describeOtcError(t, err)
  } finally {
    busyId.value = ''
  }
}

async function confirmDelete(): Promise<void> {
  // Re-entry guard: a double click sent two deletes (10-01 audit).
  if (deleting.value === null || busyId.value !== '') return
  busyId.value = deleting.value.id
  listError.value = ''
  try {
    await deletePaymentMethod(deleting.value.id)
    deleting.value = null
    toastSuccess(t('otc.paymentMethods.deleted'), 'otc-payment')
    await otc.loadPaymentMethods()
  } catch (err) {
    listError.value = describeOtcError(t, err)
    deleting.value = null
  } finally {
    busyId.value = ''
  }
}

watch(() => sessionStore.isAuthenticated, (authed) => {
  if (authed) void otc.loadPaymentMethods()
}, { immediate: true })
onBeforeUnmount(() => { if (cooldownTimer !== null) clearInterval(cooldownTimer) })
</script>

<template>
  <section class="pm-panel">
    <div class="pm-head">
      <p class="pm-note">{{ t('otc.paymentMethods.maxOpen') }}</p>
      <button class="btn btn-primary" type="button" :disabled="types.length === 0" @click="openEditor()"><Plus :size="15" />{{ t('otc.paymentMethods.add') }}</button>
    </div>
    <p v-if="notice !== ''" class="ok-note" role="status">{{ notice }}</p>
    <p v-if="listError !== ''" class="notice notice-error" role="alert">{{ listError }}</p>

    <StateBlock v-if="otc.paymentMethodsError !== null && otc.paymentMethods === null" variant="error" :message="describeOtcError(t, otc.paymentMethodsError)" retryable @retry="otc.loadPaymentMethods()" />
    <StateBlock v-else-if="otc.paymentMethods === null" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="otc.paymentMethods.length === 0" variant="empty" :message="t('otc.paymentMethods.empty')" />
    <ul v-else class="pm-list">
      <li v-for="item in otc.paymentMethods" :key="item.id" class="pm-card" :class="{ off: !item.open }">
        <span class="pm-icon"><CreditCard :size="18" /></span>
        <div class="pm-text">
          <strong>{{ item.title || otc.paymentTitle(item.payment) }}</strong>
          <span class="muted">{{ item.userName }} · <span class="num">{{ item.account || '--' }}</span></span>
          <span v-if="item.bankName !== ''" class="muted small">{{ item.bankName }} {{ item.bankOfDeposit }}</span>
        </div>
        <label class="switch" :title="item.open ? t('otc.paymentMethods.disable') : t('otc.paymentMethods.enable')">
          <input type="checkbox" :checked="item.open" :disabled="busyId === item.id" @change="toggle(item)" />
          <span class="switch-track" aria-hidden="true" />
          <span class="switch-label">{{ item.open ? t('otc.paymentMethods.enabled') : t('otc.paymentMethods.disabled') }}</span>
        </label>
        <div class="pm-actions">
          <button class="icon-button" type="button" :aria-label="t('otc.paymentMethods.edit')" @click="openEditor(item)"><Pencil :size="15" /></button>
          <button class="icon-button danger" type="button" :aria-label="t('otc.paymentMethods.delete')" :disabled="busyId === item.id" @click="deleting = item"><Trash2 :size="15" /></button>
        </div>
      </li>
    </ul>

    <OtcDialog :open="editorOpen" :busy="saving" :title="draft.id === '' ? t('otc.paymentMethods.add') : t('otc.paymentMethods.edit')" width="500px" @close="editorOpen = false">
      <form id="otc-pm-form" class="pm-form" @submit.prevent="save">
        <label class="field">
          <span class="field-label">{{ t('otc.paymentMethods.type') }}</span>
          <span class="field-input">
            <select v-model="draft.payment" :disabled="draft.id !== ''">
              <option v-for="p in types" :key="p.key" :value="p.key">{{ p.title }}</option>
            </select>
          </span>
        </label>
        <label class="field">
          <span class="field-label">{{ t('otc.paymentMethods.name') }}</span>
          <span class="field-input"><input v-model="draft.userName" maxlength="64" autocomplete="name" /></span>
        </label>
        <label v-if="needsAccount" class="field">
          <span class="field-label">{{ t('otc.paymentMethods.account') }}</span>
          <span class="field-input"><input v-model="draft.account" maxlength="128" autocomplete="off" /></span>
        </label>
        <template v-if="isBank">
          <label class="field">
            <span class="field-label">{{ t('otc.paymentMethods.bank') }}</span>
            <span class="field-input"><input v-model="draft.bankName" maxlength="128" /></span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('otc.paymentMethods.branch') }}</span>
            <span class="field-input"><input v-model="draft.bankOfDeposit" maxlength="128" /></span>
          </label>
        </template>
        <p class="field-hint">{{ t('otc.paymentMethods.qrNote') }}</p>
        <p class="field-hint">{{ t('otc.paymentMethods.codeHint') }}</p>
        <label v-if="showSms" class="field">
          <span class="field-label">{{ t('otc.paymentMethods.smsCode') }}</span>
          <span class="field-input">
            <input v-model="draft.sms" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
            <button class="code-btn" type="button" :disabled="smsSending || smsCooldown > 0" @click="sendSms">
              {{ smsSending ? t('otc.paymentMethods.sending') : smsCooldown > 0 ? t('otc.paymentMethods.resend', { n: smsCooldown }) : t('otc.paymentMethods.sendCode') }}
            </button>
          </span>
        </label>
        <label v-if="googleOn" class="field">
          <span class="field-label">{{ t('otc.paymentMethods.googleCode') }}</span>
          <span class="field-input"><input v-model="draft.google" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></span>
        </label>
        <p v-if="saveError !== ''" class="notice notice-error" role="alert">{{ saveError }}</p>
      </form>
      <template #footer>
        <button class="btn" type="button" :disabled="saving" @click="editorOpen = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="submit" form="otc-pm-form" :disabled="!draftValid || saving">{{ saving ? t('common.loading') : t('otc.paymentMethods.save') }}</button>
      </template>
    </OtcDialog>

    <OtcDialog :open="deleting !== null" :title="t('otc.paymentMethods.delete')" @close="deleting = null">
      <p class="dialog-copy">{{ t('otc.paymentMethods.deleteConfirm') }}</p>
      <template #footer>
        <button class="btn" type="button" @click="deleting = null">{{ t('common.cancel') }}</button>
        <button class="btn btn-sell" type="button" data-testid="otc-payment-delete-confirm" :disabled="busyId !== ''" @click="confirmDelete">{{ busyId !== '' ? t('otc.paymentMethods.deleting') : t('otc.paymentMethods.delete') }}</button>
      </template>
    </OtcDialog>
  </section>
</template>

<style scoped>
.pm-panel { display: flex; flex-direction: column; gap: 14px; }
.pm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pm-note { margin: 0; color: var(--color-text-muted); font-size: 12.5px; }
.ok-note { margin: 0; color: var(--color-up); font-weight: 600; font-size: 13px; }
.pm-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.pm-card {
  display: grid; grid-template-columns: auto 1fr auto; grid-template-areas: 'icon text actions' 'icon switch switch';
  gap: 8px 12px; padding: 16px; border: 1px solid var(--color-border); border-left: 3px solid var(--color-accent);
  border-radius: 12px; background: var(--color-surface-alt);
}
.pm-card.off { border-left-color: var(--color-border-strong); opacity: 0.8; }
.pm-icon {
  grid-area: icon; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px;
  background: var(--color-accent-soft); color: var(--color-accent-text);
}
.pm-text { grid-area: text; display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.pm-text strong { font-size: 14px; }
.small { font-size: 12px; }
.pm-actions { grid-area: actions; display: flex; gap: 2px; }
.danger:hover { color: var(--color-down); }
.switch { grid-area: switch; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; color: var(--color-text-secondary); }
.switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.switch-track { position: relative; width: 34px; height: 20px; border-radius: 999px; background: var(--color-border-strong); transition: background 0.15s; }
.switch-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
.switch input:checked + .switch-track { background: var(--color-up); }
.switch input:checked + .switch-track::after { transform: translateX(14px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.pm-form { display: flex; flex-direction: column; gap: 12px; }
.code-btn { color: var(--color-accent-text); font-size: 12px; font-weight: 700; white-space: nowrap; }
.code-btn:disabled { color: var(--color-text-muted); cursor: not-allowed; }
.dialog-copy { margin: 0; color: var(--color-text-secondary); font-size: 14px; }
@media (max-width: 520px) { .pm-list { grid-template-columns: 1fr; } }
</style>
