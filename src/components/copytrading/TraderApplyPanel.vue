<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BadgeCheck, Clock3, UserPlus, CircleX } from '@lucide/vue'
import { applyBecomeTrader, fetchApplyStatus, type ApplyStatus } from '@/modules/copytrading/copytrading.api'
import { errorMessage, isUnauthorized } from '@/modules/content/api-helpers'
import { useCopyI18n } from '@/modules/copytrading/i18n'
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'

/**
 * "Become a lead trader" strip on /copy-trading: `traderUser/currentStatus` + `traderUser/applyBecomeTrader`.
 * Approval happens in the admin console; this only submits and shows the review state.
 */
const emit = defineEmits<{ (event: 'profile', uid: string): void; (event: 'submitted'): void; (event: 'state', status: ApplyStatus, uid: string): void }>()
const { t } = useCopyI18n()

const status = ref<ApplyStatus | null>(null)
const uid = ref('')
const { text: loadError, set: setLoadError } = useLocalizedNotice()
const confirming = ref(false)
const busy = ref(false)
const actionError = ref('')
let controller: AbortController | null = null

const tone = computed(() => (status.value === 1 ? 'on' : status.value === 0 ? 'wait' : status.value === 2 ? 'off' : ''))
const message = computed(() => {
  if (status.value === 0) return t('copy.apply.pendingMsg')
  if (status.value === 1) return t('copy.apply.approvedMsg')
  if (status.value === 2) return t('copy.apply.rejectedMsg')
  return t('copy.apply.lead')
})

async function load(): Promise<void> {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loadError.value = ''
  try {
    const value = await fetchApplyStatus(current.signal)
    if (controller !== current) return
    status.value = value.status
    uid.value = value.uid
    emit('state', value.status, value.uid)
  } catch (failure) {
    if (controller !== current || isUnauthorized(failure)) return
    const msg = errorMessage(failure)
    setLoadError(() => t('copy.apply.statusError', { msg }))
  }
}

async function submit(): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    await applyBecomeTrader()
    confirming.value = false
    emit('submitted')
    await load()
  } catch (failure) {
    // Also a rejected session: say so (10-01 audit: follow/unfollow failed silently on 401).
    actionError.value = errorMessage(failure)
  } finally {
    busy.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => controller?.abort())
defineExpose({ reload: load })
</script>

<template>
  <section class="apply panel" :aria-busy="status === null && loadError === ''">
    <span class="icon" :class="tone" aria-hidden="true">
      <BadgeCheck v-if="status === 1" :size="20" />
      <Clock3 v-else-if="status === 0" :size="20" />
      <CircleX v-else-if="status === 2" :size="20" />
      <UserPlus v-else :size="20" />
    </span>
    <div class="body">
      <strong class="title">
        {{ t('copy.apply.title') }}
        <span v-if="status === 0" class="state wait">{{ t('copy.apply.pending') }}</span>
        <span v-else-if="status === 1" class="state on">{{ t('copy.apply.approved') }}</span>
        <span v-else-if="status === 2" class="state off">{{ t('copy.apply.rejected') }}</span>
      </strong>
      <p class="msg">{{ loadError !== '' ? loadError : message }}</p>
      <p v-if="actionError !== ''" class="err" role="alert">{{ actionError }}</p>
    </div>
    <div class="act">
      <button v-if="loadError !== ''" class="btn small" type="button" @click="load">↻</button>
      <button v-else-if="status === 1 && uid !== ''" class="btn small" type="button" @click="emit('profile', uid)">{{ t('copy.apply.viewProfile') }}</button>
      <template v-else-if="status === -1 || status === 2">
        <span v-if="confirming" class="confirm">
          <span class="muted hint">{{ t('copy.apply.confirm') }}</span>
          <button class="btn small btn-primary" type="button" :disabled="busy" @click="submit">{{ busy ? t('copy.apply.submitting') : t('copy.apply.submit') }}</button>
          <button class="btn small" type="button" :disabled="busy" @click="confirming = false">{{ t('copy.cancel') }}</button>
        </span>
        <button v-else class="btn small btn-primary" type="button" @click="confirming = true">{{ status === 2 ? t('copy.apply.reapply') : t('copy.apply.button') }}</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.apply { display: flex; align-items: center; gap: 14px; margin: 0 0 18px; padding: 14px 18px; }
.icon { display: inline-flex; flex: 0 0 40px; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--color-accent-soft); color: var(--color-accent-text); }
.icon.on { color: var(--color-up); }
.icon.wait { color: var(--color-warning); background: var(--color-warning-soft); }
.icon.off { color: var(--color-text-muted); background: var(--color-surface-alt); }
.body { flex: 1 1 auto; min-width: 0; }
.title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 14px; font-weight: 700; }
.msg { margin: 3px 0 0; color: var(--color-text-muted); font-size: 12.5px; line-height: 1.55; }
.err { margin: 4px 0 0; color: var(--color-down); font-size: 12.5px; }
.state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
.state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.state.on { color: var(--color-up); }
.state.wait { color: var(--color-warning); }
.state.off { color: var(--color-text-muted); }
.act { flex: 0 0 auto; }
.confirm { display: inline-flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.hint { font-size: 12px; }
.btn.small { height: 32px; padding: 0 12px; font-size: 12.5px; }
/* Phones: one compact row so the trader list starts on the first screen (owner 2026-11-17). */
@media (max-width: 720px) {
  .apply { gap: 10px; margin-bottom: 12px; padding: 10px 12px; }
  .icon { flex-basis: 34px; width: 34px; height: 34px; }
  .msg { display: none; }
  .act { flex: 0 0 auto; }
}
</style>
