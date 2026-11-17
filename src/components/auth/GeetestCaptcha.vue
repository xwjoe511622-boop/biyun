<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ShieldCheck } from '@lucide/vue'
import { useAuthI18n } from '@/modules/auth/i18n'
import { startTartCaptcha, type CaptchaProof } from '@/modules/api/onboarding.api'
import {
  loadGeetestSdk,
  geetestProof,
  type GeetestInstance,
  type GeetestInitOptions,
} from '@/modules/auth/geetest'

// Official Geetest v3 widget, wired exactly like the legacy
// `PC/components/verify/geetest.vue`: `POST common/tartCaptcha` -> `window.initGeetest({ gt,
// challenge, offline, new_captcha, product:'popup', width:'100%', lang }, cb)` -> `appendTo`.
//
// Guarantees:
// - the SDK is fetched only from the allowlisted official loader (`modules/auth/geetest.ts`);
// - a load/CSP/timeout failure, a malformed `tartCaptcha` response, or an **offline** challenge
//   (`success: 0`) fails closed — no stub, no `offline: true` fallback, no fixed challenge tuple;
// - the widget is destroyed and a *fresh* challenge is requested whenever `resetKey` changes
//   (account or flow change), on retry, and on unmount, so a solved proof can never be reused.
const props = withDefaults(
  defineProps<{
    /** Flow the challenge belongs to (`login` / `register` / `recover`). */
    purpose: string
    /** Geetest `lang` value (see `geetestLanguage`). */
    lang?: string
    /** Change this (e.g. `purpose:account`) to force a fresh challenge. */
    resetKey?: string
  }>(),
  { lang: 'en', resetKey: '' },
)

const emit = defineEmits<{
  (event: 'solved', proof: CaptchaProof): void
  (event: 'failed', messageKey: string): void
}>()

const { t } = useAuthI18n()

const slot = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'failed'>('loading')
const errorKey = ref('')

let generation = 0
let instance: GeetestInstance | null = null
let inFlight: AbortController | null = null

function destroyInstance(): void {
  const current = instance
  instance = null
  if (current === null) {
    return
  }
  try {
    current.destroy?.()
  } catch {
    // A vendor teardown error must never break the form.
  }
}

function fail(key: string): void {
  status.value = 'failed'
  errorKey.value = key
  emit('failed', key)
}

function messageKeyOf(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('auth.')) {
    // A malformed `common/tartCaptcha` payload means the widget cannot be configured.
    return error.message === 'auth.error.malformed' ? 'auth.captcha.misconfigured' : error.message
  }
  return 'auth.captcha.loadFailed'
}

async function mount(): Promise<void> {
  const gen = ++generation
  inFlight?.abort()
  inFlight = new AbortController()
  const { signal } = inFlight
  destroyInstance()
  status.value = 'loading'
  errorKey.value = ''

  try {
    const init = await loadGeetestSdk(undefined, undefined, signal)
    if (gen !== generation || signal.aborted) {
      return
    }
    const challenge = await startTartCaptcha({ signal })
    if (gen !== generation || signal.aborted) {
      return
    }
    if (!challenge.success) {
      // Offline failback: the backend only ever validates online, so this can never pass.
      fail('auth.captcha.offline')
      return
    }
    const container = slot.value
    if (container === null) {
      fail('auth.captcha.loadFailed')
      return
    }
    const options: GeetestInitOptions = {
      gt: challenge.gt,
      challenge: challenge.challenge,
      offline: false,
      new_captcha: true,
      product: 'popup',
      width: '100%',
      lang: props.lang,
    }
    init(options, (captcha) => {
      if (gen !== generation) {
        // A superseded generation: tear the stale widget down instead of leaking it.
        try {
          captcha.destroy?.()
        } catch {
          // ignore
        }
        return
      }
      instance = captcha
      captcha.appendTo(container)
      captcha.onReady(() => {
        if (gen === generation) {
          status.value = 'ready'
        }
      })
      captcha.onError(() => {
        if (gen === generation) {
          fail('auth.captcha.loadFailed')
        }
      })
      captcha.onSuccess(() => {
        if (gen !== generation) {
          return
        }
        const proof = geetestProof(captcha.getValidate())
        if (proof === null) {
          // The vendor reported success without a usable tuple: never submit empty fields.
          fail('auth.captcha.loadFailed')
          return
        }
        emit('solved', proof)
      })
    })
  } catch (error) {
    if (gen !== generation) {
      return
    }
    fail(messageKeyOf(error))
  }
}

onMounted(() => {
  void mount()
})

onBeforeUnmount(() => {
  generation += 1
  inFlight?.abort()
  inFlight = null
  destroyInstance()
})

watch(
  () => [props.resetKey, props.purpose, props.lang],
  () => {
    void mount()
  },
)
</script>

<template>
  <div class="geetest-captcha">
    <p class="geetest-head"><ShieldCheck :size="14" aria-hidden="true" />{{ t('auth.captcha.title') }}</p>
    <div ref="slot" class="geetest-slot" />
    <p v-if="status === 'loading'" class="field-hint">{{ t('auth.captcha.loading') }}</p>
    <template v-else-if="status === 'failed'">
      <p class="notice notice-error wrap-anywhere">{{ t(errorKey) }}</p>
      <button class="btn" type="button" @click="mount">{{ t('auth.captcha.retry') }}</button>
    </template>
  </div>
</template>

<style scoped>
.geetest-captcha {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.geetest-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.geetest-slot {
  min-height: 40px;
}

.geetest-captcha .btn {
  align-self: flex-start;
}
</style>
