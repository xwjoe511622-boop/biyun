<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { DESCRIPTION_MAX, fetchFollowers, fetchMyDescription, fetchTotalIncome, followersAum, saveMyDescription, type TraderFollower } from '@/modules/copytrading/copytrading.api'
import { amountText } from '@/modules/copytrading/format'
import { errorMessage, isUnauthorized } from '@/modules/content/api-helpers'
import { useCopyI18n } from '@/modules/copytrading/i18n'

/**
 * 我的带单 (approved lead traders, Binance "Lead Trader Center" basics, 2026-09-30): total profit-share income
 * (`trader/trader_total_profit`), current copiers and their margin (`traderUser/follower?traderUid=me`), and the bio
 * (`GET/POST traderUser/description`). The bio is returned to everyone by list / detail (sanitised, <= 200 chars) since 2026-10-01.
 */
const props = defineProps<{ uid: string }>()
const emit = defineEmits<{ (event: 'saved', message: string): void }>()
const { t } = useCopyI18n()

const income = ref('')
const followers = ref<TraderFollower[] | null>(null)
const bio = ref('')
const draft = ref('')
const editing = ref(false)
const saving = ref(false)
const error = ref('')
const controller = new AbortController()

async function load(): Promise<void> {
  const [total, copiers, description] = await Promise.allSettled([
    fetchTotalIncome(controller.signal),
    fetchFollowers(props.uid, controller.signal),
    fetchMyDescription(controller.signal),
  ])
  if (controller.signal.aborted) return
  income.value = total.status === 'fulfilled' ? total.value : ''
  followers.value = copiers.status === 'fulfilled' ? copiers.value : null
  bio.value = description.status === 'fulfilled' ? description.value : ''
}

function startEdit(): void {
  draft.value = bio.value
  editing.value = true
  error.value = ''
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    await saveMyDescription(draft.value)
    bio.value = draft.value.trim().slice(0, DESCRIPTION_MAX)
    editing.value = false
    emit('saved', t('copy.p.bioSaved'))
  } catch (failure) {
    // Also a rejected session: say so (10-01 audit: follow/unfollow failed silently on 401).
    error.value = errorMessage(failure)
  } finally {
    saving.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="self panel" data-testid="copy-self">
    <h2 class="title">{{ t('copy.p.self') }}</h2>
    <dl class="stats">
      <div><dt>{{ t('copy.p.selfIncome') }}</dt><dd class="num">{{ income === '' ? '--' : `${amountText(income)} USDT` }}</dd></div>
      <div><dt>{{ t('copy.p.selfFollowers') }}</dt><dd class="num">{{ followers === null ? '--' : followers.length }}</dd></div>
      <div><dt>{{ t('copy.p.aum') }}</dt><dd class="num">{{ followers === null ? '--' : `${amountText(followersAum(followers))} USDT` }}</dd></div>
    </dl>
    <div v-if="followers !== null && followers.length > 0" class="copiers">
      <span v-for="(row, index) in followers" :key="index" class="copier">{{ row.nickname || '—' }} <b class="num">{{ amountText(row.followAmount) }}</b></span>
    </div>
    <p v-else-if="followers !== null" class="muted small">{{ t('copy.p.noFollowers') }}</p>

    <div class="bio">
      <div class="bio-head"><strong>{{ t('copy.p.bio') }}</strong><button v-if="!editing" class="btn small" type="button" data-testid="copy-bio-edit" @click="startEdit">{{ t('copy.p.editBio') }}</button></div>
      <template v-if="editing">
        <textarea v-model="draft" class="bio-input" :maxlength="DESCRIPTION_MAX" rows="3" data-testid="copy-bio-input"></textarea>
        <p class="muted small">{{ t('copy.p.bioHint', { n: DESCRIPTION_MAX }) }} {{ draft.length }}/{{ DESCRIPTION_MAX }}</p>
        <p v-if="error !== ''" class="err" role="alert">{{ error }}</p>
        <div class="bio-actions">
          <button class="btn small" type="button" :disabled="saving" @click="editing = false">{{ t('copy.cancel') }}</button>
          <button class="btn small btn-primary" type="button" data-testid="copy-bio-save" :disabled="saving" @click="save">{{ t('copy.p.saveBio') }}</button>
        </div>
      </template>
      <p v-else class="bio-text" :class="{ muted: bio === '' }">{{ bio || t('copy.p.noBio') }}</p>
    </div>
  </section>
</template>

<style scoped>
.self { margin: 0 0 18px; padding: 16px 18px; }
.title { margin: 0 0 12px; font-size: 15px; }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; }
.stats dt { color: var(--color-text-muted); font-size: 12px; }
.stats dd { margin: 3px 0 0; font-size: 17px; font-weight: 700; }
.copiers { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.copier { padding: 4px 10px; border-radius: 14px; background: var(--color-surface-alt); font-size: 12px; }
.bio { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.bio-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.bio-text { margin: 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.bio-input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--color-border-strong); border-radius: 10px; background: var(--color-surface-alt); color: var(--color-text); font: inherit; font-size: 13px; resize: vertical; }
.bio-actions { display: flex; justify-content: flex-end; gap: 8px; }
.small { font-size: 12px; margin: 4px 0 0; }
.err { margin: 4px 0 0; color: var(--color-down); font-size: 12.5px; }
.btn.small { height: 30px; padding: 0 12px; font-size: 12px; margin: 0; }
@media (max-width: 720px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
