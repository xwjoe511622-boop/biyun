<script setup lang="ts">
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { onBeforeUnmount, ref } from 'vue'
import { CheckCircle2, ImagePlus, Loader2, RefreshCw, X } from '@lucide/vue'
import { uploadKycImage } from '@/modules/kyc/kyc.api'
import { validateImageFile, type PhotoSlot } from '@/modules/kyc/kyc-form'
import { errorMessage } from '@/modules/content/api-helpers'
import { useKycI18n } from '@/modules/kyc/i18n'

/**
 * One document-photo slot. The file goes straight to `common/upload_img`; only the returned key is
 * emitted. The preview is an in-memory object URL that is revoked on replace/remove/unmount — no image
 * is written to any browser storage.
 */
const props = defineProps<{ photoSlot: PhotoSlot; modelValue: string; invalid?: boolean; disabled?: boolean; uploadBase?: string }>()
const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()
const { t } = useKycI18n()

const preview = ref('')
const uploading = ref(false)
const { text: error, set: setError } = useLocalizedNotice()
const input = ref<HTMLInputElement | null>(null)
let controller: AbortController | null = null

function revoke(): void {
  if (preview.value !== '') URL.revokeObjectURL(preview.value)
  preview.value = ''
}

async function onPick(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (file === undefined) return
  const problem = validateImageFile(file)
  if (problem !== null) {
    setError(() => t(`kyc.err.${problem}`))
    return
  }
  controller?.abort()
  const current = new AbortController()
  controller = current
  error.value = ''
  revoke()
  emit('update:modelValue', '')
  preview.value = URL.createObjectURL(file)
  uploading.value = true
  try {
    const result = await uploadKycImage(file, props.photoSlot, { uploadBase: props.uploadBase, signal: current.signal })
    if (controller !== current) return
    emit('update:modelValue', result.key)
  } catch (failure) {
    if (controller !== current) return
    revoke()
    error.value = errorMessage(failure)
  } finally {
    if (controller === current) uploading.value = false
  }
}

function clear(): void {
  controller?.abort()
  uploading.value = false
  revoke()
  error.value = ''
  emit('update:modelValue', '')
}

onBeforeUnmount(() => {
  controller?.abort()
  revoke()
})
</script>

<template>
  <div class="photo-field" :class="{ invalid: invalid && modelValue === '' && !uploading, done: modelValue !== '' }">
    <div class="drop">
      <img v-if="preview !== ''" class="preview" :src="preview" :alt="t(`kyc.photos.${photoSlot}`)" />
      <button v-else class="pick" type="button" :disabled="disabled || uploading" @click="input?.click()">
        <ImagePlus :size="26" aria-hidden="true" />
        <span>{{ t('kyc.upload') }}</span>
        <small>{{ t('kyc.uploadRule') }}</small>
      </button>
      <span v-if="uploading" class="overlay"><Loader2 class="spin" :size="22" aria-hidden="true" />{{ t('kyc.uploading') }}</span>
      <span v-else-if="modelValue !== ''" class="ok"><CheckCircle2 :size="14" aria-hidden="true" />{{ t('kyc.uploaded') }}</span>
      <div v-if="preview !== '' && !uploading" class="tools">
        <button class="tool" type="button" :disabled="disabled" @click="input?.click()"><RefreshCw :size="13" aria-hidden="true" />{{ t('kyc.replace') }}</button>
        <button class="tool" type="button" :disabled="disabled" :aria-label="t('kyc.removePhoto')" @click="clear"><X :size="13" aria-hidden="true" /></button>
      </div>
    </div>
    <input ref="input" class="file" type="file" accept="image/jpeg,image/png,image/bmp" :disabled="disabled || uploading" :aria-label="t(`kyc.photos.${photoSlot}`)" @change="onPick" />
    <div class="caption">
      <strong>{{ t(`kyc.photos.${photoSlot}`) }}</strong>
      <small>{{ t(`kyc.photos.${photoSlot}Hint`) }}</small>
      <small v-if="error !== ''" class="field-error wrap-anywhere" role="alert">{{ error }}</small>
      <small v-else-if="invalid && modelValue === '' && !uploading" class="field-error">{{ t('kyc.err.photoRequired') }}</small>
    </div>
  </div>
</template>

<style scoped>
.photo-field { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.drop { position: relative; aspect-ratio: 16 / 10; overflow: hidden; border: 1.5px dashed var(--color-border-strong); border-radius: 14px; background: var(--color-surface-alt); transition: border-color .15s; }
.photo-field.done .drop { border-style: solid; border-color: var(--color-up); }
.photo-field.invalid .drop { border-color: var(--color-down); }
.drop:hover { border-color: var(--color-accent); }
.pick { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 100%; color: var(--color-text-secondary); }
.pick svg { color: var(--color-accent-text); }
.pick span { font-size: 13px; font-weight: 600; }
.pick small { color: var(--color-text-muted); font-size: 11px; }
.preview { width: 100%; height: 100%; object-fit: cover; }
.overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; background: color-mix(in srgb, var(--color-bg) 70%, transparent); color: var(--color-text); font-size: 13px; font-weight: 600; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.ok { position: absolute; left: 8px; top: 8px; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 12px; background: var(--color-up); color: #fff; font-size: 11px; font-weight: 700; }
.tools { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 6px; }
.tool { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 14px; background: rgba(8, 10, 14, .72); color: #fff; font-size: 12px; font-weight: 600; backdrop-filter: blur(6px); }
.file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.caption { display: flex; flex-direction: column; gap: 2px; }
.caption strong { font-size: 13px; }
.caption small { color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.caption .field-error { color: var(--color-down); }
</style>
