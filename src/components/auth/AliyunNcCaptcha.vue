<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ShieldCheck } from '@lucide/vue'
import { useAuthI18n } from '@/modules/auth/i18n'
import type { CaptchaProof } from '@/modules/api/onboarding.api'
import {
  aliyunNcToken,
  loadAliyunNcSdk,
  type AliyunNcCallbackPayload,
  type AliyunNcInstance,
} from '@/modules/auth/captcha'

// Official Aliyun "NoCaptcha" (NC) PC widget, wired exactly like the legacy
// `PC/components/verify/aliyunCaptcha.vue`: `new window.noCaptcha()` + `init({ renderTo, appkey,
// scene, token, language, callback })`.
//
// Guarantees:
// - the SDK is fetched only from the allowlisted official asset (`modules/auth/captcha.ts`);
// - a load/CSP/timeout failure is surfaced as `failed` (the parent then blocks the submit) — no
//   stub, no blank proof;
// - the widget is re-created whenever `resetKey` changes (account or purpose change) so a solved
//   proof can never be reused for another account/purpose, and `token` carries the purpose.
const props = withDefaults(
  defineProps<{
    appkey: string
    /** `publicInfo.nc.nc_prefix`; the widget is initialised with `prefix + 'login'`. */
    prefix?: string
    /** `publicInfo.nc.nc_lang` or a locale mapped by `aliyunNcLanguage`. */
    language?: string
    /** Flow the challenge belongs to (`login` / `register` / `recover`). */
    purpose: string
    /** Change this (e.g. `purpose:account`) to force a fresh challenge. */
    resetKey?: string
  }>(),
  { prefix: '', language: 'en', resetKey: '' },
)

const emit = defineEmits<{
  (event: 'solved', proof: CaptchaProof): void
  (event: 'failed', messageKey: string): void
}>()

const { t } = useAuthI18n()

/** The `scene` value the server expects on the submitted proof (legacy hardcodes `login`). */
const NC_SCENE = 'login'

let instance: AliyunNcInstance | null = null
let generation = 0

const containerId = ref('')
const status = ref<'loading' | 'ready' | 'failed'>('loading')
const errorKey = ref('')

function nextContainerId(): string {
  return `nc-${Math.random().toString(36).slice(2, 12)}`
}

function messageKeyOf(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('auth.')) {
    return error.message
  }
  return 'auth.captcha.loadFailed'
}

async function mount(): Promise<void> {
  const gen = ++generation
  instance?.reset?.()
  instance = null
  // A fresh element: the vendor widget mounts into `renderTo` and cannot be re-initialised in place.
  containerId.value = nextContainerId()
  status.value = 'loading'
  errorKey.value = ''

  try {
    const Ctor = await loadAliyunNcSdk()
    if (gen !== generation) {
      return
    }
    await nextTick()
    if (gen !== generation) {
      return
    }
    const token = aliyunNcToken(props.appkey, props.purpose)
    const nc = new Ctor()
    instance = nc
    nc.init({
      renderTo: `#${containerId.value}`,
      appkey: props.appkey,
      scene: `${props.prefix}${NC_SCENE}`,
      token,
      language: props.language,
      callback: (payload: AliyunNcCallbackPayload) => {
        if (gen !== generation) {
          return
        }
        const csessionid = typeof payload.csessionid === 'string' ? payload.csessionid.trim() : ''
        const sig = typeof payload.sig === 'string' ? payload.sig.trim() : ''
        if (csessionid === '' || sig === '') {
          // The vendor reported "success" without a usable proof: never submit empty fields.
          status.value = 'failed'
          errorKey.value = 'auth.captcha.loadFailed'
          emit('failed', errorKey.value)
          return
        }
        emit('solved', { verificationType: '1', csessionid, sig, token, scene: NC_SCENE })
      },
      error: () => {
        if (gen !== generation) {
          return
        }
        status.value = 'failed'
        errorKey.value = 'auth.captcha.loadFailed'
        emit('failed', errorKey.value)
      },
    })
    if (gen !== generation) {
      return
    }
    status.value = 'ready'
  } catch (error) {
    if (gen !== generation) {
      return
    }
    status.value = 'failed'
    errorKey.value = messageKeyOf(error)
    emit('failed', errorKey.value)
  }
}

onMounted(() => {
  void mount()
})

onBeforeUnmount(() => {
  generation += 1
  instance?.reset?.()
  instance = null
})

watch(
  () => [props.resetKey, props.appkey, props.prefix, props.language],
  () => {
    void mount()
  },
)
</script>

<template>
  <div class="nc-captcha">
    <p class="nc-head"><ShieldCheck :size="14" aria-hidden="true" />{{ t('auth.captcha.title') }}</p>
    <div :id="containerId" :key="containerId" class="nc-slot" />
    <p v-if="status === 'loading'" class="field-hint">{{ t('auth.captcha.loading') }}</p>
    <template v-else-if="status === 'failed'">
      <p class="notice notice-error wrap-anywhere">{{ t(errorKey) }}</p>
      <button class="btn" type="button" @click="mount">{{ t('auth.captcha.retry') }}</button>
    </template>
  </div>
</template>

<style scoped>
.nc-captcha {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.nc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.nc-slot {
  min-height: 40px;
}

.nc-captcha .btn {
  align-self: flex-start;
}
</style>
