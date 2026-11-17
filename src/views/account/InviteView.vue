<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Coins, Gift, Link2, ReceiptText, Share2, UserPlus, Users } from '@lucide/vue'
import GuestGate from '@/components/common/GuestGate.vue'
import ContentPager from '@/components/content/ContentPager.vue'
import EmptyState from '@/components/content/EmptyState.vue'
import ErrorBanner from '@/components/content/ErrorBanner.vue'
import CopyButton from '@/components/wallet/CopyButton.vue'
import InviteQr from '@/components/invite/InviteQr.vue'
import { buildInviteLink, fetchInviteInfo, fetchRebates, type InviteInfo, type RebateSummary } from '@/modules/invite/invite.api'
import { errorMessage, formatDateTime, isUnauthorized, pageCount } from '@/modules/content/api-helpers'
import { useInviteI18n } from '@/modules/invite/i18n'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { useSessionStore } from '@/stores/session'

/**
 * Referral dashboard — `return/invite_info_list` (`ReturnAndDividendAct.java:318`): invite code and
 * invitee list with total; `invite_code/bonusList` (`UserInviteCodeAct.java:178`): rebates paid to me
 * (spot and futures, per fee coin), totalled and paged locally. The invite link targets this client's
 * register page (`?inviteCode=`), and the QR is rendered locally from that link.
 */
const PAGE_SIZE = 10
const { t, locale } = useInviteI18n()
const sessionStore = useSessionStore()

const info = ref<InviteInfo | null>(null)
const page = ref(1)
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null

const authenticated = computed(() => sessionStore.isAuthenticated)
const link = computed(() => (info.value === null ? '' : buildInviteLink(window.location.origin, info.value.inviteCode, import.meta.env.BASE_URL)))
const pages = computed(() => pageCount(info.value?.invitedCount ?? 0, PAGE_SIZE))
const rebates = ref<RebateSummary | null>(null)
const rebatePage = ref(1)
const rebateError = ref('')
const rebateLoading = ref(false)
let rebateController: AbortController | null = null
const rebatePages = computed(() => pageCount(rebates.value?.records.length ?? 0, PAGE_SIZE))
const rebateRows = computed(() => (rebates.value?.records ?? []).slice((rebatePage.value - 1) * PAGE_SIZE, rebatePage.value * PAGE_SIZE))
/** Totals per coin; an account without rebates shows 0 USDT. */
const rebateTotals = computed(() => {
  if (rebates.value === null) return []
  if (rebates.value.totals.length === 0) return [{ coin: 'USDT', amount: '0' }]
  return rebates.value.totals.map((row) => ({ coin: row.coin, amount: display(row.amount) }))
})

function display(value: string): string {
  return isDecimalString(value) ? groupDigits(value) : '--'
}

async function loadRebates(): Promise<void> {
  if (!authenticated.value) return
  rebateController?.abort()
  const current = new AbortController()
  rebateController = current
  rebateLoading.value = true
  rebateError.value = ''
  try {
    const result = await fetchRebates(current.signal)
    if (rebateController !== current) return
    rebates.value = result
    if (rebatePage.value > pageCount(result.records.length, PAGE_SIZE)) rebatePage.value = 1
  } catch (failure) {
    if (rebateController !== current || isUnauthorized(failure)) return
    rebateError.value = errorMessage(failure)
  } finally {
    if (rebateController === current) rebateLoading.value = false
  }
}

async function load(): Promise<void> {
  if (!authenticated.value) return
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  error.value = ''
  try {
    const result = await fetchInviteInfo(page.value, PAGE_SIZE, current.signal)
    if (controller !== current) return
    info.value = result
  } catch (failure) {
    if (controller !== current || isUnauthorized(failure)) return
    error.value = errorMessage(failure)
  } finally {
    if (controller === current) loading.value = false
  }
}

function goPage(target: number): void {
  page.value = target
  void load()
}

watch(authenticated, (value) => {
  info.value = null
  rebates.value = null
  page.value = 1
  rebatePage.value = 1
  if (value) {
    void load()
    void loadRebates()
  }
}, { immediate: true })
onBeforeUnmount(() => {
  controller?.abort()
  rebateController?.abort()
})
</script>

<template>
  <div class="page invite-page">
    <section class="hero">
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="hero-copy">
        <span class="eyebrow"><Gift :size="14" aria-hidden="true" />{{ t('invite.eyebrow') }}</span>
        <h1>{{ t('invite.title') }}</h1>
        <p>{{ t('invite.lead') }}</p>
      </div>

      <div v-if="authenticated" class="share-card" :aria-busy="loading">
        <template v-if="info !== null && link !== ''">
          <div class="share-fields">
            <div class="share-field">
              <span class="share-label">{{ t('invite.code') }}</span>
              <div class="share-value code"><strong class="num">{{ info.inviteCode }}</strong><CopyButton :value="info.inviteCode" /></div>
            </div>
            <div class="share-field">
              <span class="share-label"><Link2 :size="13" aria-hidden="true" />{{ t('invite.link') }}</span>
              <div class="share-value"><span class="link ellipsis" :title="link">{{ link }}</span><CopyButton :value="link" /></div>
            </div>
          </div>
          <figure class="qr">
            <InviteQr :value="link" :alt="t('invite.qrAlt')" />
            <figcaption>{{ t('invite.qr') }}</figcaption>
          </figure>
        </template>
        <p v-else-if="info !== null" class="notice">{{ t('invite.noCode') }}</p>
        <div v-else-if="loading" class="share-sk"><span></span><span></span></div>
        <ErrorBanner v-else-if="error !== ''" :message="error" retryable @retry="load" />
      </div>
    </section>

    <GuestGate v-if="!authenticated" :message="t('invite.loginRequired')" :icon="UserPlus" />

    <template v-else>
      <div class="stats">
        <div class="stat panel">
          <span class="stat-icon"><Users :size="20" aria-hidden="true" /></span>
          <div><span class="stat-label">{{ t('invite.invited') }}</span><strong class="stat-value num">{{ info === null ? '--' : info.invitedCount }}<small>{{ t('invite.people') }}</small></strong></div>
        </div>
        <div class="stat panel">
          <span class="stat-icon"><Coins :size="20" aria-hidden="true" /></span>
          <div class="stat-body">
            <span class="stat-label">{{ t('invite.rebate') }}</span>
            <div v-if="rebateTotals.length > 0" class="stat-totals">
              <strong v-for="row in rebateTotals" :key="row.coin" class="stat-value num">{{ row.amount }}<small>{{ row.coin }}</small></strong>
            </div>
            <strong v-else class="stat-value num">--</strong>
          </div>
        </div>
        <p class="stat-note">{{ t('invite.rebateNote') }}</p>
      </div>

      <div class="lower">
        <section class="panel records">
          <header class="records-head"><h2>{{ t('invite.invitees') }}</h2></header>
          <ErrorBanner v-if="error !== '' && info !== null" :message="error" retryable @retry="load" />
          <div v-if="info !== null && info.invitees.length > 0" class="table-wrap">
            <table class="table">
              <thead><tr><th>{{ t('invite.account') }}</th><th>{{ t('invite.registered') }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, index) in info.invitees" :key="`${row.account}-${index}`">
                  <td class="num">{{ row.account || '--' }}</td>
                  <td class="num muted">{{ formatDateTime(row.registeredAt, locale) }}</td>
                </tr>
              </tbody>
            </table>
            <div class="pager-wrap"><ContentPager :page="page" :pages="pages" :total="info.invitedCount" :disabled="loading" @change="goPage" /></div>
          </div>
          <div v-else-if="loading" class="rows-sk"><span v-for="n in 4" :key="n"></span></div>
          <EmptyState v-else-if="info !== null" :icon="Users" :title="t('invite.emptyTitle')" :message="t('invite.emptyMessage')" />
        </section>

        <section class="panel records rebate-records">
          <header class="records-head"><h2><ReceiptText :size="15" aria-hidden="true" />{{ t('invite.rebateRecords') }}</h2></header>
          <ErrorBanner v-if="rebateError !== ''" :message="rebateError" retryable @retry="loadRebates" />
          <div v-if="rebates !== null && rebates.records.length > 0" class="table-wrap">
            <table class="table table-cards">
              <thead>
                <tr>
                  <th>{{ t('invite.time') }}</th><th>{{ t('invite.market') }}</th><th>{{ t('invite.account') }}</th>
                  <th class="right">{{ t('invite.fee') }}</th><th class="right">{{ t('invite.rate') }}</th><th class="right">{{ t('invite.amount') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rebateRows" :key="row.id">
                  <td class="num muted card-title" data-label="">{{ formatDateTime(row.time, locale) }}</td>
                  <td :data-label="t('invite.market')"><span class="tag" :class="row.market">{{ t(row.market === 'futures' ? 'invite.futures' : 'invite.spot') }}</span></td>
                  <td class="num" :data-label="t('invite.account')">{{ row.invitee }}</td>
                  <td class="num right muted" :data-label="t('invite.fee')">{{ display(row.fee) }} {{ row.coin }}</td>
                  <td class="num right muted" :data-label="t('invite.rate')">{{ isDecimalString(row.ratePct) ? `${groupDigits(row.ratePct)}%` : '--' }}</td>
                  <td class="num right strong" :data-label="t('invite.amount')">+{{ display(row.amount) }} {{ row.coin }}</td>
                </tr>
              </tbody>
            </table>
            <div class="pager-wrap"><ContentPager :page="rebatePage" :pages="rebatePages" :total="rebates.records.length" :disabled="rebateLoading" @change="(target: number) => (rebatePage = target)" /></div>
          </div>
          <div v-else-if="rebateLoading" class="rows-sk"><span v-for="n in 3" :key="n"></span></div>
          <EmptyState v-else-if="rebates !== null" :icon="Coins" :title="t('invite.rebateEmptyTitle')" :message="t('invite.rebateEmptyMessage')" />
        </section>

        <aside class="panel steps">
          <h2>{{ t('invite.steps') }}</h2>
          <ol>
            <li><span class="step-icon"><Share2 :size="16" /></span><div><strong>{{ t('invite.s1') }}</strong><p>{{ t('invite.s1d') }}</p></div></li>
            <li><span class="step-icon"><UserPlus :size="16" /></span><div><strong>{{ t('invite.s2') }}</strong><p>{{ t('invite.s2d') }}</p></div></li>
            <li><span class="step-icon"><Coins :size="16" /></span><div><strong>{{ t('invite.s3') }}</strong><p>{{ t('invite.s3d') }}</p></div></li>
          </ol>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.invite-page { max-width: 1180px; }
.hero {
  position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 560px); gap: 32px; align-items: center;
  overflow: hidden; padding: 36px 36px; border: 1px solid var(--color-border); border-radius: 22px;
  background: linear-gradient(135deg, var(--color-surface) 0%, var(--color-bg-deep) 100%);
}
.hero-glow { position: absolute; right: -120px; top: -160px; width: 460px; height: 460px; border-radius: 50%; background: radial-gradient(circle, var(--color-accent-soft), transparent 65%); pointer-events: none; }
.hero-copy { position: relative; min-width: 0; }
.eyebrow { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: 14px; color: var(--color-accent-text); font-size: 12px; font-weight: 700; }
.hero-copy h1 { margin: 16px 0 10px; font-size: clamp(28px, 3.4vw, 40px); line-height: 1.15; font-weight: 750; letter-spacing: -.03em; }
.hero-copy p { margin: 0; max-width: 460px; color: var(--color-text-secondary); font-size: 15px; line-height: 1.7; }
.share-card { position: relative; display: flex; gap: 20px; align-items: center; padding: 20px; border: 1px solid var(--color-border-strong); border-radius: 18px; background: color-mix(in srgb, var(--color-surface) 88%, transparent); backdrop-filter: blur(8px); min-width: 0; }
.share-fields { display: flex; flex: 1 1 auto; flex-direction: column; gap: 14px; min-width: 0; }
.share-label { display: inline-flex; align-items: center; gap: 5px; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.share-value { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 44px; margin-top: 6px; padding: 0 6px 0 14px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface-alt); min-width: 0; }
.share-value.code strong { color: var(--color-accent-text); font-size: 20px; letter-spacing: .08em; }
.link { min-width: 0; color: var(--color-text-secondary); font-size: 13px; }
.qr { display: flex; flex: 0 0 auto; flex-direction: column; align-items: center; gap: 6px; margin: 0; }
.qr figcaption { color: var(--color-text-muted); font-size: 12px; }
.share-sk { display: flex; flex: 1; flex-direction: column; gap: 14px; }
.share-sk span { height: 64px; border-radius: 10px; background: var(--color-surface-alt); }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
.stat { display: flex; align-items: center; gap: 16px; padding: 20px 22px; }
.stat-icon { display: inline-flex; flex: 0 0 44px; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; background: var(--color-accent-soft); color: var(--color-accent-text); }
.stat-label { display: block; color: var(--color-text-muted); font-size: 12.5px; }
.stat-value { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; font-size: 26px; }
.stat-value small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 13px; font-weight: 600; }
.stat-body { min-width: 0; }
.stat-totals { display: flex; flex-wrap: wrap; gap: 4px 18px; }
.stat-note { grid-column: 1 / -1; margin: 0; color: var(--color-text-muted); font-size: 12px; }
.lower { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 18px; align-items: start; margin-top: 18px; }
.records { overflow: hidden; }
.records-head { display: flex; align-items: center; min-height: 54px; padding: 0 20px; border-bottom: 1px solid var(--color-border); }
.records-head h2 { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 15px; }
.rebate-records { grid-column: 1; }
.table .right { text-align: right; }
.table .strong { color: var(--color-up, var(--color-accent-text)); font-weight: 650; }
.tag { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 12px; font-weight: 600; background: var(--color-surface-alt); color: var(--color-text-secondary); }
.tag.futures { background: var(--color-accent-soft); color: var(--color-accent-text); }
.table th, .table td { padding-left: 20px; padding-right: 20px; }
.table td { height: 50px; }
.pager-wrap { padding: 0 20px 16px; }
.rows-sk { padding: 8px 20px; }
.rows-sk span { display: block; height: 18px; margin: 18px 0; border-radius: 6px; background: var(--color-surface-alt); }
.steps { grid-column: 2; grid-row: 1 / span 2; padding: 20px 22px; }
.steps h2 { margin: 0 0 14px; font-size: 15px; }
.steps ol { display: flex; flex-direction: column; gap: 16px; margin: 0; padding: 0; list-style: none; }
.steps li { display: flex; gap: 12px; }
.step-icon { display: inline-flex; flex: 0 0 34px; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--color-border-strong); color: var(--color-accent-text); }
.steps strong { font-size: 13.5px; }
.steps p { margin: 2px 0 0; color: var(--color-text-secondary); font-size: 12.5px; line-height: 1.6; }
@media (max-width: 1000px) {
  .hero { grid-template-columns: minmax(0, 1fr); }
  .lower { grid-template-columns: minmax(0, 1fr); }
  .steps, .rebate-records { grid-column: auto; grid-row: auto; }
}
@media (max-width: 640px) {
  .hero { padding: 22px 16px; border-radius: 18px; }
  .share-card { flex-direction: column; align-items: stretch; padding: 14px; }
  .qr { align-self: center; }
  .stats { grid-template-columns: minmax(0, 1fr); }
  .stat-value { font-size: 22px; }
}
</style>
