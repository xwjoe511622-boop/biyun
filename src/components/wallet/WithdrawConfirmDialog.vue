<script setup lang="ts">
import { computed } from 'vue'
import { BookUser, ShieldCheck, TriangleAlert } from '@lucide/vue'
import CodeField from './CodeField.vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { groupDigits } from '@/modules/finance/decimal'
import { useWalletI18n } from '@/modules/wallet/i18n'
import type { SecurityRequirement, WithdrawFieldError } from '@/modules/wallet/withdraw'
import type { ApprovalHint, WalletBackendShape, WithdrawMode } from '@/modules/wallet/withdrawMode'

/**
 * Withdrawal confirmation: summary + only the codes the selected mode needs. Emits `confirm`; the
 * parent owns every gate (`canSubmit`) and is the only place the request is built and sent.
 */
const props = defineProps<{
  open: boolean
  coin: string
  networkLabel: string
  address: string
  savedLabel: string
  mode: WithdrawMode
  shape: WalletBackendShape
  amount: string
  fee: string
  receive: string
  approval: ApprovalHint
  approvalText: string
  requirement: SecurityRequirement
  canSave: boolean
  pending: boolean
  canSubmit: boolean
  cooldown: number
  codeChannel: 'sms' | 'email' | ''
  codePending: boolean
  codeErrors: WithdrawFieldError[]
  saveLabelMissing: boolean
  error: string | null
  notice: string | null
}>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'confirm'): void
  (event: 'send', channel: 'sms' | 'email'): void
}>()
const googleCode = defineModel<string>('googleCode', { required: true })
const emailCode = defineModel<string>('emailCode', { required: true })
const smsCode = defineModel<string>('smsCode', { required: true })
const saveToBook = defineModel<boolean>('saveToBook', { required: true })
const saveLabel = defineModel<string>('saveLabel', { required: true })
const { t } = useWalletI18n()

function money(value: string): string {
  return value === '' ? '--' : groupDigits(value)
}

function sendLabel(channel: 'sms' | 'email'): string {
  return props.cooldown > 0 && props.codeChannel === channel
    ? t('wallet.withdraw.resendIn', { seconds: props.cooldown })
    : t('wallet.withdraw.sendCode')
}

const codesIntro = computed(() => {
  if (props.mode === 'saved' && props.shape === 'network') return t('wallet.wd.codesSaved')
  if (props.requirement.email || props.requirement.sms) {
    return t('wallet.wd.codesDirect', { channel: props.requirement.sms ? t('wallet.wd.channelSms') : t('wallet.wd.channelEmail') })
  }
  return t('wallet.withdraw.securityHint')
})

const firstCodeError = computed(() => {
  const first = props.codeErrors[0]
  return first === undefined ? '' : t(first.key)
})
</script>

<template>
  <DialogShell :open="open" :title="t('wallet.wd.confirmTitle')" width="480px" :close-label="t('wallet.flow.close')" @close="emit('close')">
    <dl class="summary">
      <div class="summary-row">
        <dt>{{ t('wallet.wd.confirmAmount') }}</dt>
        <dd class="num strong">{{ money(amount) }} {{ coin }}</dd>
      </div>
      <div class="summary-row">
        <dt>{{ t('wallet.wd.confirmNetwork') }}</dt>
        <dd>{{ networkLabel }}</dd>
      </div>
      <div class="summary-row column">
        <dt>
          {{ t('wallet.wd.confirmAddress') }}
          <span v-if="mode === 'saved'" class="tag ok"><BookUser :size="11" aria-hidden="true" />{{ savedLabel || t('wallet.wd.savedBadge') }}</span>
        </dt>
        <dd class="num address" data-testid="confirm-address">{{ address }}</dd>
      </div>
      <div class="summary-row">
        <dt>{{ t('wallet.wd.confirmFee') }}</dt>
        <dd class="num">{{ money(fee) }} {{ coin }}</dd>
      </div>
      <div class="summary-row">
        <dt>{{ t('wallet.wd.confirmReceive') }}</dt>
        <dd class="num strong accent">{{ money(receive) }} {{ coin }}</dd>
      </div>
      <div v-if="approval !== 'unknown'" class="summary-row">
        <dt>{{ t('wallet.wd.confirmReview') }}</dt>
        <dd :class="approval === 'auto' ? 'ok-text' : 'warn-text'" data-testid="confirm-approval">{{ approvalText }}</dd>
      </div>
    </dl>

    <p class="warn"><TriangleAlert :size="14" aria-hidden="true" />{{ t('wallet.wd.confirmWarn') }}</p>

    <section class="codes" :aria-label="t('wallet.wd.codesTitle')">
      <p class="codes-intro"><ShieldCheck :size="14" aria-hidden="true" />{{ codesIntro }}</p>
      <CodeField v-if="requirement.google" v-model="googleCode" :label="t('wallet.withdraw.googleCode')" :disabled="pending" />
      <CodeField
        v-if="requirement.email"
        v-model="emailCode"
        :label="t('wallet.withdraw.emailCode')"
        sendable
        :send-label="sendLabel('email')"
        :can-send="cooldown === 0 && !codePending && !pending"
        :disabled="pending"
        @send="emit('send', 'email')"
      />
      <CodeField
        v-if="requirement.sms"
        v-model="smsCode"
        :label="t('wallet.withdraw.smsCode')"
        sendable
        :send-label="sendLabel('sms')"
        :can-send="cooldown === 0 && !codePending && !pending"
        :disabled="pending"
        @send="emit('send', 'sms')"
      />
      <p v-if="firstCodeError !== ''" class="field-error">{{ firstCodeError }}</p>
    </section>

    <section v-if="canSave" class="save">
      <label class="save-check">
        <input v-model="saveToBook" type="checkbox" :disabled="pending" data-testid="save-to-book" />
        <span>{{ t('wallet.wd.saveToBook') }}</span>
      </label>
      <label v-if="saveToBook" class="field">
        <span class="field-label">{{ t('wallet.wd.saveLabel') }}</span>
        <span class="field-input" :class="{ invalid: saveLabelMissing }">
          <input v-model="saveLabel" maxlength="40" :aria-label="t('wallet.wd.saveLabel')" :placeholder="t('wallet.wd.saveLabelPlaceholder')" :disabled="pending" />
        </span>
        <span v-if="saveLabelMissing" class="field-error">{{ t('wallet.address.labelRequired') }}</span>
      </label>
    </section>

    <p v-if="error !== null" class="notice notice-error" role="alert">{{ error }}</p>
    <p v-else-if="notice !== null" class="notice notice-info" role="status">{{ notice }}</p>

    <template #footer>
      <button class="btn" type="button" :disabled="pending" @click="emit('close')">{{ t('wallet.wd.cancel') }}</button>
      <button class="btn btn-primary" type="button" :disabled="!canSubmit" data-testid="confirm-withdraw" @click="emit('confirm')">
        {{ pending ? t('wallet.withdraw.pending') : t('wallet.wd.confirm') }}
      </button>
    </template>
  </DialogShell>
</template>

<style scoped>
.summary { display: flex; flex-direction: column; margin: 0; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface-alt); }
.summary-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 10px 14px; border-bottom: 1px solid var(--color-border); font-size: 13px; }
.summary-row:last-child { border-bottom: 0; }
.summary-row.column { flex-direction: column; align-items: stretch; gap: 6px; }
.summary-row dt { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--color-text-muted); }
.summary-row dd { margin: 0; font-weight: 600; text-align: right; }
.summary-row dd.address { white-space: normal; text-align: left; font-family: var(--font-mono); font-size: 13.5px; line-height: 1.5; word-break: break-all; }
.strong { font-size: 15px; font-weight: 700 !important; }
.accent { color: var(--color-accent-text); }
.ok-text { color: var(--color-up); }
.warn-text { color: var(--color-warning); }
.tag { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; font-size: 10.5px; font-weight: 650; }
.tag.ok { background: var(--color-up-soft); color: var(--color-up); }
.warn { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: var(--color-warning); font-size: 12px; line-height: 1.5; }
.warn :deep(svg) { flex: 0 0 auto; margin-top: 2px; }
.codes { display: flex; flex-direction: column; gap: 10px; }
.codes-intro { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--color-text-secondary); font-size: 12.5px; font-weight: 600; }
.codes-intro :deep(svg) { color: var(--color-up); }
.save { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px dashed var(--color-border-strong); border-radius: 10px; }
.save-check { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.save-check input { width: 16px; height: 16px; accent-color: var(--color-accent); }
</style>
