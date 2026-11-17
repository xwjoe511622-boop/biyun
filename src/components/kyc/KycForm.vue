<script setup lang="ts">
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { translateForLocale } from '@/i18n/composer'
import { computed, reactive, ref, watch } from 'vue'
import { Lock, Send } from '@lucide/vue'
import KycPhotoField from './KycPhotoField.vue'
import { KYC_COUNTRIES } from '@/modules/kyc/countries'
import {
  buildRealNamePayload,
  certificateOptions,
  isChina,
  PHOTO_SLOTS,
  validateKycDraft,
  type CertificateType,
  type KycDraft,
  type KycField,
} from '@/modules/kyc/kyc-form'
import { KYC_ERROR, submitRealName } from '@/modules/kyc/kyc.api'
import { errorMessage, isUnauthorized } from '@/modules/content/api-helpers'
import { isApiError } from '@/core/errors'
import { useKycI18n } from '@/modules/kyc/i18n'

const props = defineProps<{ defaultCountryIso: string; uploadBase?: string }>()
const emit = defineEmits<{ (event: 'submitted'): void }>()
const { t, locale } = useKycI18n()

const draft = reactive<KycDraft>({
  countryIso: props.defaultCountryIso,
  fullName: '',
  familyName: '',
  givenName: '',
  certificateType: certificateOptions(props.defaultCountryIso)[0] ?? '',
  certificateNumber: '',
  photos: {},
})
const consent = ref(false)
const attempted = ref(false)
const submitting = ref(false)
const { text: submitError, set: setSubmitError } = useLocalizedNotice()

const countries = computed(() => {
  return [...KYC_COUNTRIES]
    .map((row) => ({ iso: row[0], dial: row[1], name: translateForLocale(locale.value, row[2]) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale.value))
})
const china = computed(() => isChina(draft.countryIso))
const certOptions = computed(() => certificateOptions(draft.countryIso))
const errors = computed(() => validateKycDraft(draft))
const shown = computed<Partial<Record<KycField, string>>>(() => {
  if (!attempted.value) return {}
  const out: Partial<Record<KycField, string>> = {}
  for (const [field, key] of Object.entries(errors.value)) out[field as KycField] = t(`kyc.err.${key}`)
  return out
})
const canSubmit = computed(() => consent.value && !submitting.value)

watch(() => draft.countryIso, (iso) => {
  if (!certificateOptions(iso).includes(draft.certificateType as CertificateType)) draft.certificateType = certificateOptions(iso)[0] ?? ''
})

async function submit(): Promise<void> {
  attempted.value = true
  submitError.value = ''
  if (Object.keys(errors.value).length > 0) {
    setSubmitError(() => t('kyc.fixErrors'))
    return
  }
  submitting.value = true
  try {
    await submitRealName(buildRealNamePayload(draft))
    emit('submitted')
  } catch (failure) {
    if (isApiError(failure) && failure.code === KYC_ERROR.duplicateCertificate) {
      setSubmitError(() => t('kyc.err.duplicate'))
    } else {
      submitError.value = errorMessage(failure)
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <form class="kyc-form" novalidate @submit.prevent="submit">
    <section class="block">
      <h3 class="block-title"><span class="step num">1</span>{{ t('kyc.step1') }}</h3>
      <div class="grid">
        <div class="field span-2">
          <label class="field-label" for="kyc-country">{{ t('kyc.country') }}</label>
          <div class="field-input" :class="{ invalid: shown.country }">
            <select id="kyc-country" v-model="draft.countryIso" :disabled="submitting">
              <option value="" disabled>{{ t('kyc.countryPlaceholder') }}</option>
              <option v-for="country in countries" :key="country.iso" :value="country.iso">{{ country.name }} ({{ country.dial }})</option>
            </select>
          </div>
          <p v-if="shown.country" class="field-error">{{ shown.country }}</p>
        </div>

        <div v-if="china" class="field span-2">
          <label class="field-label" for="kyc-fullname">{{ t('kyc.fullName') }}</label>
          <div class="field-input" :class="{ invalid: shown.fullName }">
            <input id="kyc-fullname" v-model="draft.fullName" maxlength="64" autocomplete="name" :placeholder="t('kyc.fullNamePh')" :disabled="submitting" />
          </div>
          <p v-if="shown.fullName" class="field-error">{{ shown.fullName }}</p>
        </div>
        <template v-else>
          <div class="field">
            <label class="field-label" for="kyc-family">{{ t('kyc.familyName') }}</label>
            <div class="field-input" :class="{ invalid: shown.familyName }">
              <input id="kyc-family" v-model="draft.familyName" maxlength="64" autocomplete="family-name" :disabled="submitting" />
            </div>
            <p v-if="shown.familyName" class="field-error">{{ shown.familyName }}</p>
          </div>
          <div class="field">
            <label class="field-label" for="kyc-given">{{ t('kyc.givenName') }}</label>
            <div class="field-input" :class="{ invalid: shown.givenName }">
              <input id="kyc-given" v-model="draft.givenName" maxlength="64" autocomplete="given-name" :disabled="submitting" />
            </div>
            <p v-if="shown.givenName" class="field-error">{{ shown.givenName }}</p>
          </div>
        </template>

        <div class="field span-2">
          <span class="field-label">{{ t('kyc.certType') }}</span>
          <div class="cert-types" role="radiogroup" :aria-label="t('kyc.certType')">
            <button v-for="type in certOptions" :key="type" class="cert" :class="{ active: draft.certificateType === type }" type="button" role="radio" :aria-checked="draft.certificateType === type" :disabled="submitting" @click="draft.certificateType = type">{{ t(`kyc.cert.${type}`) }}</button>
          </div>
          <p v-if="shown.certificateType" class="field-error">{{ shown.certificateType }}</p>
        </div>

        <div class="field span-2">
          <label class="field-label" for="kyc-number">{{ t('kyc.certNumber') }}</label>
          <div class="field-input" :class="{ invalid: shown.certificateNumber }">
            <input id="kyc-number" v-model="draft.certificateNumber" class="num" maxlength="32" autocomplete="off" spellcheck="false" :placeholder="t('kyc.certNumberPh')" :disabled="submitting" />
          </div>
          <p v-if="shown.certificateNumber" class="field-error">{{ shown.certificateNumber }}</p>
        </div>
      </div>
    </section>

    <section class="block">
      <h3 class="block-title"><span class="step num">2</span>{{ t('kyc.step2') }}</h3>
      <div class="photos">
        <KycPhotoField
          v-for="slot in PHOTO_SLOTS"
          :key="slot"
          :model-value="draft.photos[slot] ?? ''"
          @update:model-value="(value: string) => (draft.photos[slot] = value)"
          :photo-slot="slot"
          :invalid="attempted"
          :disabled="submitting"
          :upload-base="uploadBase"
        />
      </div>
      <p class="privacy"><Lock :size="13" aria-hidden="true" />{{ t('kyc.privacy') }}</p>
    </section>

    <label class="consent"><input v-model="consent" type="checkbox" :disabled="submitting" />{{ t('kyc.consent') }}</label>
    <p v-if="submitError !== ''" class="notice notice-error" role="alert">{{ submitError }}</p>
    <button class="btn btn-primary btn-block submit" type="submit" :disabled="!canSubmit">
      <Send :size="16" aria-hidden="true" />{{ submitting ? t('kyc.submitting') : t('kyc.submit') }}
    </button>
  </form>
</template>

<style scoped>
.kyc-form { display: flex; flex-direction: column; gap: 18px; }
.block { padding: 22px 24px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.block-title { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; font-size: 16px; font-weight: 700; }
.step { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 13px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.span-2 { grid-column: 1 / -1; }
.field-input select { appearance: auto; cursor: pointer; }
.cert-types { display: flex; flex-wrap: wrap; gap: 8px; }
.cert { height: 40px; padding: 0 18px; border: 1px solid var(--color-border-strong); border-radius: var(--radius); background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 13px; font-weight: 600; transition: border-color .15s, color .15s, background-color .15s; }
.cert:hover:not(:disabled) { border-color: var(--color-text-muted); color: var(--color-text); }
.cert.active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-text); }
.photos { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.privacy { display: flex; align-items: center; gap: 6px; margin: 16px 0 0; color: var(--color-text-muted); font-size: 12px; }
.consent { display: flex; align-items: flex-start; gap: 10px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.55; cursor: pointer; }
.consent input { width: 16px; height: 16px; margin-top: 2px; flex: 0 0 auto; accent-color: var(--color-accent); }
.submit { height: 48px; font-size: 15px; }
@media (max-width: 720px) {
  .block { padding: 18px 16px; }
  .grid { grid-template-columns: 1fr; }
  .photos { grid-template-columns: 1fr; }
}
</style>
