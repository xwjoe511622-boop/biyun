<script setup lang="ts">
import { computed } from 'vue'
import { CheckCircle2 } from '@lucide/vue'
import { useAuthI18n } from '@/modules/auth/i18n'
import type { CaptchaPlan } from '@/modules/auth/captcha'
import type { CaptchaProof } from '@/modules/api/onboarding.api'
import AliyunNcCaptcha from './AliyunNcCaptcha.vue'
import GeetestCaptcha from './GeetestCaptcha.vue'

// Provider-aware slider field. It renders the official Aliyun or Geetest widget when that is what
// the server selected and it can be produced honestly; otherwise it explains why submitting is
// blocked. A blocked plan must be treated as "cannot submit" by the parent — this component never
// fabricates a proof.
const props = withDefaults(
  defineProps<{
    plan: CaptchaPlan
    appkey: string
    purpose: string
    solved?: boolean
    /** `publicInfo.nc.nc_prefix`; the Aliyun widget is initialised with `prefix + 'login'`. */
    prefix?: string
    /** Aliyun NC language (`publicInfo.nc.nc_lang` or an app-locale mapping). */
    language?: string
    /** Geetest `lang` value (see `geetestLanguage`). */
    geetestLang?: string
    /** Change to force a fresh challenge (account/purpose change, or an explicit retry). */
    resetKey?: string
  }>(),
  { solved: false, prefix: '', language: 'en', geetestLang: 'en', resetKey: '' },
)

const emit = defineEmits<{
  (event: 'solved', proof: CaptchaProof): void
  (event: 'failed', messageKey: string): void
}>()

const { t } = useAuthI18n()

const blockedMessageKey = computed(() => {
  if (props.plan.reason === 'unconfigured') {
    return 'auth.captcha.misconfigured'
  }
  if (props.plan.reason === 'sdk-disabled') {
    return 'auth.captcha.sdkDisabled'
  }
  if (props.plan.reason === 'unsupported-provider') {
    return 'auth.captcha.providerUnsupported'
  }
  return ''
})
</script>

<template>
  <div class="captcha-field">
    <AliyunNcCaptcha
      v-if="plan.widget === 'aliyun'"
      :appkey="appkey"
      :prefix="prefix"
      :language="language"
      :purpose="purpose"
      :reset-key="resetKey"
      @solved="emit('solved', $event)"
      @failed="emit('failed', $event)"
    />
    <GeetestCaptcha
      v-else-if="plan.widget === 'geetest'"
      :purpose="purpose"
      :lang="geetestLang"
      :reset-key="resetKey"
      @solved="emit('solved', $event)"
      @failed="emit('failed', $event)"
    />
    <p v-else-if="blockedMessageKey !== ''" class="notice wrap-anywhere">{{ t(blockedMessageKey) }}</p>

    <p v-if="plan.widget !== 'none' && solved" class="solved">
      <CheckCircle2 :size="14" aria-hidden="true" />{{ t('auth.captcha.solved') }}
    </p>
    <p v-else-if="plan.widget !== 'none'" class="field-hint">{{ t('auth.captcha.hint') }}</p>
  </div>
</template>

<style scoped>
.captcha-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.solved {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--color-up);
  font-size: var(--font-size-xs);
}
</style>
