<script setup lang="ts">
/**
 * C2C 红包 · 明细 / 领取。读取 route.params.sn（或旧链接 route.params.id）。金额只显示、不运算，仅 `groupDigits`
 * 千分位，不改变小数值。领取资格：进行中、剩余>0、本人不是发送方且未领过；`claiming` 只表示处理中，**绝不显示成功到账**。
 *
 * 主开关关闭只影响发送；本页明细/领取不因 `config.open` 阻断。所有结果以原红包状态为准，未知领取结果按 SN 安全查询。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { isApiError } from '@/core/errors'
import { groupDigits } from '@/modules/finance/decimal'
import { claimRedPacket, fetchRedPacketDetail, type RedPacketDetail } from '@/modules/redpacket/api'
import { redPacketErrorMessage, useRedPacketI18n } from '@/modules/redpacket/i18n'
import GuestGate from '@/components/common/GuestGate.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { useAccountStore } from '@/stores/account'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const { t } = useRedPacketI18n()
const sessionStore = useSessionStore()
const account = useAccountStore()

/** 单一红包编号：route.params.sn 优先，兼容旧链接 route.params.id。 */
const sn = computed<string>(() => {
  const raw = route.params.sn ?? route.params.id
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
})

const detail = ref<RedPacketDetail | null>(null)
const loading = ref(false)
const loadError = ref('')
const notFound = ref(false)

const claimState = ref<'idle' | 'busy' | 'claiming' | 'claimed' | 'unknown' | 'error'>('idle')
const claimMessage = ref('')
const claimAmount = ref('')
const copied = ref(false)
const copyFailed = ref(false)

const myUid = computed(() => String(sessionStore.user?.id ?? ''))
const isSender = computed(() => detail.value !== null && String(detail.value.senderUid) === myUid.value)
const alreadyMine = computed(() =>
  detail.value !== null
  && myUid.value !== ''
  && detail.value.shares.some((s) => String(s.uid ?? '') === myUid.value && (s.status === 'claimed' || s.status === 'claiming')),
)
const canClaim = computed(() =>
  detail.value !== null
  && sessionStore.isAuthenticated
  && myUid.value !== ''
  && !loading.value && loadError.value === ''
  && detail.value.status === 'active'
  && detail.value.remainingCount > 0
  && !isSender.value
  && !alreadyMine.value
  && claimState.value === 'idle',
)

const KNOWN_STATUS = ['creating', 'active', 'open', 'claiming', 'claimed', 'claimed_out', 'expiring', 'expired', 'refunded', 'failed']
function statusLabel(status: string): string {
  return t(`rp.status.${KNOWN_STATUS.includes(status) ? status : 'unknown'}`)
}

function formatTime(ms: number | null): string {
  if (ms === null || !Number.isSafeInteger(ms) || ms <= 0) return '—'
  const d = new Date(ms) // Time only, not a monetary value.
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

let generation = 0
let detailVersion = 0
let controller: AbortController | null = null

function abort(): void {
  controller?.abort()
  controller = null
}

async function loadDetail(): Promise<void> {
  if (!sessionStore.isAuthenticated) return
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sn.value)) {
    detail.value = null
    notFound.value = false
    loadError.value = t('rp.detail.invalidSn')
    return
  }
  const current = generation
  const version = ++detailVersion
  const token = sessionStore.token
  const expectedSn = sn.value
  abort()
  const active = new AbortController()
  controller = active
  loading.value = true
  loadError.value = ''
  notFound.value = false
  try {
    const next = await fetchRedPacketDetail({ sn: expectedSn }, active.signal)
    if (current !== generation || version !== detailVersion || sessionStore.token !== token) return
    if (next.sn !== expectedSn) throw new Error(t('rp.detail.invalidSn'))
    detail.value = next
    const mine = next.shares.find(s => myUid.value !== '' && String(s.uid ?? '') === myUid.value && (s.status === 'claimed' || s.status === 'claiming'))
    if (mine) {
      claimState.value = mine.status === 'claimed' ? 'claimed' : 'claiming'
      claimAmount.value = mine.amount
    } else if (claimState.value === 'error') claimState.value = 'idle'
  } catch (e) {
    if (current !== generation || version !== detailVersion || sessionStore.token !== token) return
    if (isApiError(e) && e.kind === 'aborted' && active.signal.aborted) return
    const code = isApiError(e) ? e.code.trim() : ''
    if (code === '2105') {
      detail.value = null
      notFound.value = true
    } else {
      loadError.value = redPacketErrorMessage(code, t, isApiError(e) ? e.message : String(e))
    }
  } finally {
    if (current === generation && version === detailVersion) loading.value = false
  }
}

async function copySn(): Promise<void> {
  const text = detail.value?.sn ?? sn.value
  if (text === '') return
  copied.value = false
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
  } catch {
    copyFailed.value = true
  }
}

function isUnknownOutcome(error: unknown): boolean {
  if (!isApiError(error)) return true
  if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'parse') return true
  if (error.kind === 'http') return (error.status ?? 0) >= 500
  if (error.kind === 'api') return error.code.trim() === '3'
  return false
}

async function claim(): Promise<void> {
  if (!canClaim.value || sn.value === '') return
  const current = generation
  const token = sessionStore.token
  const expectedSn = sn.value
  claimState.value = 'busy'
  claimMessage.value = ''
  claimAmount.value = ''
  try {
    const res = await claimRedPacket(expectedSn)
    if (current !== generation || sessionStore.token !== token) return
    claimAmount.value = res.amount
    if (res.status === 'claiming') {
      // 处理中：不显示成功到账，只刷新原红包确认。
      claimState.value = 'claiming'
      await loadDetail()
      return
    }
    // 已领取：刷新原红包与余额；刷新失败不改写领取结果。
    claimState.value = 'claimed'
    await loadDetail()
    if (current !== generation || sessionStore.token !== token) return
    try {
      await account.load()
      if (current !== generation || sessionStore.token !== token) return
      if (account.error !== null) claimMessage.value = t('rp.detail.refreshAfterClaimFailed')
    } catch {
      claimMessage.value = t('rp.detail.refreshAfterClaimFailed')
    }
  } catch (e) {
    if (current !== generation || sessionStore.token !== token) return
    if (isUnknownOutcome(e)) {
      // 未知结果：按 SN 安全查询原红包，绝不跳成功。
      claimState.value = 'unknown'
      claimMessage.value = t('rp.detail.claimUnknownBody')
      await loadDetail()
    } else {
      claimState.value = 'error'
      claimMessage.value = redPacketErrorMessage(isApiError(e) ? e.code : '', t, isApiError(e) ? e.message : String(e))
    }
  }
}

onMounted(() => {
  if (sessionStore.isAuthenticated) {
    void sessionStore.loadUserInfo()
    void loadDetail()
  }
})

onBeforeUnmount(() => {
  generation += 1
  abort()
})

watch(() => sessionStore.token, () => {
  generation += 1
  abort()
  detail.value = null
  claimState.value = 'idle'
  claimAmount.value = ''
  claimMessage.value = ''
  copied.value = false
  copyFailed.value = false
  loading.value = false
  loadError.value = ''
  notFound.value = false
  if (sessionStore.isAuthenticated) void loadDetail()
})
watch(sn, () => {
  generation += 1
  abort()
  detail.value = null
  loading.value = false
  loadError.value = ''
  notFound.value = false
  claimState.value = 'idle'
  claimAmount.value = ''
  claimMessage.value = ''
  void loadDetail()
})
</script>

<template>
  <section class="rp-page">
    <header class="rp-head">
      <h1 class="rp-title">{{ t('rp.detailTitle') }}</h1>
    </header>

    <GuestGate v-if="!sessionStore.isAuthenticated" :message="t('rp.detail.loginRequired')" />

    <template v-else>
      <StateBlock v-if="loading && detail === null" variant="loading" :message="t('rp.detail.loading')" />
      <StateBlock v-else-if="notFound" variant="error" :message="t('rp.detail.notFound')" />
      <StateBlock v-else-if="loadError !== ''" variant="error" :message="loadError" retryable @retry="loadDetail" />

      <article v-if="detail && !notFound" class="rp-card" data-testid="rp-detail">
        <div class="rp-main">
          <span class="field-label">{{ t('rp.detail.amount') }}</span>
          <p class="rp-amount num tabular-nums">{{ groupDigits(detail.total) }} <span class="rp-coin">{{ detail.coin }}</span></p>
          <span class="rp-badge">{{ statusLabel(detail.status) }}</span>
        </div>

        <dl class="rp-facts">
          <div class="rp-fact"><dt>{{ t('rp.detail.sender') }}</dt><dd class="num">{{ detail.senderUid }}</dd></div>
          <div class="rp-fact"><dt>{{ t('rp.detail.remaining') }}</dt><dd class="num">{{ detail.remainingCount }} / {{ detail.count }}</dd></div>
          <div class="rp-fact"><dt>{{ t('rp.detail.expireAt') }}</dt><dd class="num">{{ formatTime(detail.expireAt) }}</dd></div>
          <div class="rp-fact">
            <dt>{{ t('rp.detail.sn') }}</dt>
            <dd class="rp-sn">
              <code class="num">{{ detail.sn }}</code>
              <button class="btn btn-ghost rp-copy" type="button" @click="copySn">{{ t('rp.common.copySn') }}</button>
            </dd>
          </div>
        </dl>

        <p v-if="copied" class="rp-ok" aria-live="polite">{{ t('rp.common.snCopied') }}</p>
        <p v-if="copyFailed" class="rp-hint" aria-live="polite">{{ t('rp.common.copyFailed') }}</p>

        <p v-if="detail.greeting !== ''" class="rp-greeting">{{ detail.greeting }}</p>

        <div class="rp-claim">
          <button v-if="canClaim" class="btn btn-primary" type="button" :disabled="claimState !== 'idle'" data-testid="rp-claim" @click="claim">
            {{ t('rp.detail.claim') }}
          </button>
          <p v-else-if="isSender" class="rp-hint">{{ t('rp.detail.claimSelf') }}</p>
          <p v-else-if="detail.status === 'active' && detail.remainingCount === 0" class="rp-hint">{{ t('rp.detail.claimUnavailable') }}</p>
        </div>

        <p v-if="claimState === 'busy'" class="rp-hint" aria-live="polite">{{ t('rp.common.loading') }}</p>
        <p v-else-if="claimState === 'claiming'" class="rp-warn" aria-live="polite" data-testid="rp-claim-processing">{{ t('rp.detail.claiming') }}</p>
        <p v-else-if="claimState === 'claimed'" class="rp-ok" aria-live="polite" data-testid="rp-claim-claimed">
          {{ t('rp.detail.claimed') }}<span v-if="claimAmount !== ''"> · <span class="num tabular-nums">{{ groupDigits(claimAmount) }}</span> {{ detail.coin }}</span>
        </p>
        <p v-else-if="claimState === 'unknown'" class="rp-warn" aria-live="polite" data-testid="rp-claim-unknown">{{ claimMessage }}</p>
        <p v-else-if="claimState === 'error'" class="rp-error" aria-live="polite">{{ claimMessage }}</p>
        <p v-if="claimState === 'claimed' && claimMessage !== ''" class="rp-hint">{{ claimMessage }}</p>

        <h2 class="rp-h2">{{ t('rp.detail.shares') }}</h2>
        <div class="rp-scroll">
          <table class="rp-table">
            <thead>
              <tr>
                <th>{{ t('rp.detail.idx') }}</th>
                <th>{{ t('rp.detail.shareAmount') }}</th>
                <th>{{ t('rp.detail.shareStatus') }}</th>
                <th>{{ t('rp.detail.shareUid') }}</th>
                <th>{{ t('rp.detail.claimedAt') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="share in detail.shares" :key="share.idx">
                <td class="num">{{ share.idx }}</td>
                <td class="num tabular-nums">{{ groupDigits(share.amount) }}</td>
                <td>{{ statusLabel(share.status) }}</td>
                <td class="num">{{ share.uid ?? '—' }}</td>
                <td class="num">{{ formatTime(share.claimedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="rp-actions">
          <button class="btn" type="button" :disabled="loading || claimState === 'busy'" @click="loadDetail">{{ t('rp.detail.refresh') }}</button>
        </div>
      </article>
    </template>
  </section>
</template>

<style scoped>
.rp-page { max-width: 760px; margin: 0 auto; padding: 20px 16px 48px; }
.rp-head { margin-bottom: 16px; }
.rp-title { margin: 0; font-size: 22px; }
.rp-card { padding: 18px; border: 1px solid var(--color-border-strong); border-radius: 14px; background: var(--color-surface); }
.rp-main { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.rp-amount { margin: 0; font-size: 26px; font-weight: 700; }
.rp-coin { font-size: 15px; color: var(--color-text-muted); }
.rp-badge { align-self: flex-start; padding: 2px 8px; border-radius: 999px; background: var(--color-accent-soft); color: var(--color-accent-text); font-size: 12px; }
.rp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 18px; margin: 0 0 12px; }
.rp-fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rp-fact dt { color: var(--color-text-muted); font-size: 12px; }
.rp-fact dd { margin: 0; font-weight: 600; }
.rp-sn { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rp-sn code { font-family: var(--font-mono); word-break: break-all; }
.rp-copy { height: 26px; padding: 0 8px; font-size: 12px; }
.rp-greeting { margin: 0 0 12px; color: var(--color-text-secondary); }
.rp-claim { margin: 12px 0; }
.rp-actions { display: flex; gap: 10px; margin-top: 12px; }
.rp-scroll { overflow-x: auto; }
.rp-table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 13px; }
.rp-table th, .rp-table td { padding: 6px 10px; border-bottom: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
.rp-hint { color: var(--color-text-muted); font-size: 12px; }
.rp-error { color: var(--color-down); font-size: 13px; }
.rp-warn { color: var(--color-warning, var(--color-down)); font-size: 13px; }
.rp-ok { color: var(--color-up); font-weight: 650; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.num { font-family: var(--font-mono); }
</style>
