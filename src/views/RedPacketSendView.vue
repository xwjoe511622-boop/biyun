<script setup lang="ts">
/**
 * C2C 红包 · 发送（原订单双方单人红包）。
 *
 * 仅向 route.query.sequence（或可选 prop sequence）指定的原订单另一方发送单人单份红包；不能自由填写收款方，
 * 无多人/随机红包。发送前读取原订单核对买卖双方，本人不在双方内禁发。金额与币种限额最终以服务端为准。
 *
 * 金额精度：输入 type=text/inputmode=decimal，显示仅 `groupDigits` 不舍入；校验用 Decimal（`isDecimalString` /
 * `decimalPlaces` / `cmp` / `isPositive`），最多 16 位小数，不自动修正、不清洗多余小数。发送只调 API，不在前端
 * 生成余额或核心流水；`requestId` 生成一次并在失败/超时后复用，绝不重复创建。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { isApiError } from '@/core/errors'
import { groupDigits, cmp, decimalPlaces, isDecimalString, isPositive } from '@/modules/finance/decimal'
import { fetchOrderDetail, type OtcOrderDetail, type OrderParty } from '@/modules/otc/api'
import {
  fetchRedPacketConfig,
  fetchRedPacketDetail,
  sendRedPacket,
  type RedPacketConfig,
  type SendRedPacketResult,
} from '@/modules/redpacket/api'
import { redPacketErrorMessage, useRedPacketI18n } from '@/modules/redpacket/i18n'
import GuestGate from '@/components/common/GuestGate.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import CodeField from '@/components/wallet/CodeField.vue'
import { useAccountStore } from '@/stores/account'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{ sequence?: string }>()
const route = useRoute()
const { t } = useRedPacketI18n()
const sessionStore = useSessionStore()
const account = useAccountStore()

/** 单一订单号：可选 prop 优先，否则 route.query.sequence（只取单个字符串）。 */
const sequence = computed<string>(() => {
  const fromProp = typeof props.sequence === 'string' ? props.sequence : ''
  const fromQuery = route.query.sequence
  return (fromProp !== '' ? fromProp : typeof fromQuery === 'string' ? fromQuery : '').trim()
})
const sequenceValid = computed(() => /^\d{1,32}$/.test(sequence.value))

const order = ref<OtcOrderDetail | null>(null)
const orderLoading = ref(false)
const orderError = ref('')
const config = ref<RedPacketConfig | null>(null)
const configLoading = ref(false)
const configError = ref('')

const coin = ref('')
const total = ref('')
const greeting = ref('')
const capitalPword = ref('')
const googleCode = ref('')

const step = ref<'edit' | 'review' | 'submitted' | 'unknown'>('edit')
const busy = ref(false)
const formError = ref('')
const result = ref<SendRedPacketResult | null>(null)
const requestId = ref<string | null>(null)
const queriedSn = ref('')
const querying = ref(false)
const queryNote = ref('')

const enabledCoins = computed(() => (config.value?.coins ?? []).filter((c) => c.enabled))
const selectedRule = computed(() => enabledCoins.value.find((c) => c.coin === coin.value) ?? null)
const available = computed<string>(() => account.coinRows.find((row) => row.coin === coin.value)?.available ?? '')
const counterparty = computed<OrderParty | null>(() => {
  const o = order.value
  const me = String(sessionStore.user?.id ?? '')
  if (o === null || me === '') return null
  if (o.buyer.uid === me) return o.seller
  if (o.seller.uid === me) return o.buyer
  return null
})
const isMember = computed(() => counterparty.value !== null)
const security = computed(() => config.value?.security)
const securityUnknown = computed(() => {
  const s = security.value
  return s === undefined || s.capitalPasswordRequired === undefined || s.googleRequired === undefined
})
const capitalRequired = computed(() => security.value?.capitalPasswordRequired === true)
const googleRequired = computed(() => security.value?.googleRequired === true)

const blockedReason = computed<string>(() => {
  if (!sessionStore.isAuthenticated) return t('rp.send.loginRequired')
  if (!sequenceValid.value) return t('rp.send.orderRequired')
  if (config.value !== null && !config.value.open) return t('rp.send.closed')
  if (config.value !== null && enabledCoins.value.length === 0) return t('rp.send.noCoins')
  if (order.value !== null && !isMember.value) return t('rp.send.memberError')
  if (order.value === null && !orderLoading.value && orderError.value === '') return t('rp.send.noOrder')
  return ''
})

const amountError = computed<string>(() => {
  const value = total.value.trim()
  if (value === '') return t('rp.send.amountRequired')
  if (!isDecimalString(value)) return t('rp.send.amountFormat')
  const dp = decimalPlaces(value)
  if (dp === null || dp > 16) return t('rp.send.amountTooManyDecimals')
  if (!isPositive(value)) return t('rp.send.amountFormat')
  const rule = selectedRule.value
  if (rule === null) return ''
  if (cmp(value, rule.min_share) < 0) return t('rp.send.amountBelowMin', { min: groupDigits(rule.min_share) })
  if (cmp(value, rule.max_total) > 0) return t('rp.send.amountAboveMax', { max: groupDigits(rule.max_total) })
  if (!isDecimalString(available.value)) return t('rp.send.availableUnknownBlock')
  if (cmp(value, available.value) > 0) return t('rp.send.amountAboveAvailable', { available: groupDigits(available.value) })
  return ''
})

const canReview = computed(() => step.value === 'edit' && !busy.value && !orderLoading.value && !configLoading.value
  && config.value?.open === true && isMember.value && selectedRule.value !== null && orderError.value === ''
  && configError.value === '' && blockedReason.value === '' && isDecimalString(available.value) && amountError.value === '')
const locked = computed(() => busy.value || step.value !== 'edit')

let generation = 0
let orderVersion = 0
let configVersion = 0
let controller: AbortController | null = null
let storageKey = ''

function pendingKey(): string {
  const uid = String(sessionStore.user?.id ?? '')
  return /^\d+$/.test(uid) && sequenceValid.value ? `longbit.rp.pending.${uid}.${sequence.value}` : ''
}

function savePending(): void {
  storageKey = pendingKey()
  if (storageKey === '' || requestId.value === null) return
  try { sessionStorage.setItem(storageKey, requestId.value) } catch { /* The in-memory key stays usable. */ }
}

function removePending(): void {
  if (storageKey === '') return
  try { sessionStorage.removeItem(storageKey) } catch { /* Storage may be blocked. */ }
  storageKey = ''
}

function restorePending(): void {
  if (requestId.value !== null) return
  storageKey = pendingKey()
  try {
    const saved = storageKey === '' ? null : sessionStorage.getItem(storageKey)
    if (saved !== null && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) {
      requestId.value = saved
      step.value = 'unknown'
    }
  } catch { /* No persistent data: do not infer a result. */ }
}

function abort(): void {
  controller?.abort()
  controller = null
}

function clearSecrets(): void {
  capitalPword.value = ''
  googleCode.value = ''
}

function reset(): void {
  generation += 1
  abort()
  step.value = 'edit'
  busy.value = false
  formError.value = ''
  result.value = null
  requestId.value = null
  queriedSn.value = ''
  queryNote.value = ''
  order.value = null
  config.value = null
  coin.value = ''
  total.value = ''
  greeting.value = ''
  querying.value = false
  orderLoading.value = false
  configLoading.value = false
  orderError.value = ''
  configError.value = ''
  clearSecrets()
}

async function loadOrder(): Promise<void> {
  if (!sessionStore.isAuthenticated || !sequenceValid.value) return
  const current = generation
  const version = ++orderVersion
  const token = sessionStore.token
  const expectedSequence = sequence.value
  orderLoading.value = true
  orderError.value = ''
  try {
    const detail = await fetchOrderDetail(expectedSequence)
    if (current !== generation || version !== orderVersion || sessionStore.token !== token) return
    if (detail.sequence !== expectedSequence) throw new Error(t('rp.send.orderError'))
    order.value = detail
  } catch (e) {
    if (current !== generation || version !== orderVersion || sessionStore.token !== token) return
    order.value = null
    orderError.value = isApiError(e) ? e.message : String(e)
  } finally {
    if (current === generation && version === orderVersion) orderLoading.value = false
  }
}

async function loadConfig(): Promise<void> {
  if (!sessionStore.isAuthenticated) return
  const current = generation
  const version = ++configVersion
  const token = sessionStore.token
  configLoading.value = true
  configError.value = ''
  try {
    const next = await fetchRedPacketConfig()
    if (current !== generation || version !== configVersion || sessionStore.token !== token) return
    config.value = next
    const list = next.coins.filter((c) => c.enabled)
    if (!list.some((c) => c.coin === coin.value)) coin.value = list[0]?.coin ?? ''
  } catch (e) {
    if (current !== generation || version !== configVersion || sessionStore.token !== token) return
    config.value = null
    configError.value = isApiError(e) ? e.message : String(e)
  } finally {
    if (current === generation && version === configVersion) configLoading.value = false
  }
}

async function refresh(): Promise<void> {
  if (!sessionStore.isAuthenticated || busy.value) return
  const current = generation
  const token = sessionStore.token
  if (sessionStore.user?.id === undefined) await sessionStore.loadUserInfo()
  if (current !== generation || token !== sessionStore.token) return
  restorePending()
  await Promise.all([loadOrder(), loadConfig(), account.load()])
}

onMounted(() => {
  void refresh()
})

onBeforeUnmount(() => {
  generation += 1
  abort()
  clearSecrets()
})

watch(() => sessionStore.token, () => {
  storageKey = '' // Keep only the previous UID-bound requestId for safe recovery after signing in again.
  reset()
  if (sessionStore.isAuthenticated) void refresh()
})
watch(sequence, () => {
  reset()
  void refresh()
})

function review(): void {
  formError.value = ''
  if (!canReview.value) return
  if (coin.value === '') {
    formError.value = t('rp.send.coinRequired')
    return
  }
  if (amountError.value !== '') {
    formError.value = amountError.value
    return
  }
  if ([...greeting.value].length > 100) {
    formError.value = t('rp.send.greetingTooLong')
    return
  }
  step.value = 'review'
}

function back(): void {
  if (busy.value) return
  clearSecrets()
  step.value = 'edit'
}

/** network/timeout/http5xx/parse 与 system(3) 视为结果不明；业务拒绝可改表单重试。 */
function isUnknownOutcome(error: unknown): boolean {
  if (!isApiError(error)) return true
  if (error.kind === 'unauthorized') return false
  // Only known pre-creation refusals can release the draft. Every other outcome needs original-order lookup.
  const refused = ['10002', '4', '5', '8', '2000', '2001', '2081', '2101', '2102', '2103', '2104', '2111', '2112']
  return error.kind !== 'api' || !refused.includes(error.code.trim())
}

async function confirm(): Promise<void> {
  if (busy.value || step.value !== 'review' || selectedRule.value === null) return
  if (!isMember.value || config.value?.open !== true || amountError.value !== '' || orderError.value !== '' || configError.value !== '') return
  if (capitalRequired.value && capitalPword.value.trim() === '') {
    formError.value = t('rp.send.capitalPwordHint')
    return
  }
  if (googleRequired.value && !/^\d{6}$/.test(googleCode.value.trim())) {
    formError.value = t('rp.send.googleCodeHint')
    return
  }
  // 幂等键只生成一次：失败/超时都保留，绝不新建。
  if (requestId.value === null) {
    try { requestId.value = crypto.randomUUID() } catch {
      formError.value = t('rp.common.requestIdUnavailable')
      return
    }
  }
  savePending()
  const current = ++generation
  const token = sessionStore.token
  abort()
  const active = new AbortController()
  controller = active
  busy.value = true
  formError.value = ''
  try {
    const res = await sendRedPacket(
      {
        sequence: sequence.value,
        coin: coin.value,
        total: total.value.trim(),
        count: 1,
        type: 1,
        greeting: greeting.value,
        ...(capitalPword.value.trim() === '' ? {} : { capitalPword: capitalPword.value }),
        ...(googleCode.value.trim() === '' ? {} : { googleCode: googleCode.value }),
        requestId: requestId.value,
      },
      active.signal,
    )
    if (current !== generation || sessionStore.token !== token) return
    result.value = res
    step.value = 'submitted'
    clearSecrets()
    if (res.status !== 'creating') removePending()
    void account.load()
  } catch (e) {
    if (current !== generation || sessionStore.token !== token) return
    if (isUnknownOutcome(e)) {
      step.value = 'unknown'
      formError.value = ''
    } else {
      step.value = 'edit'
      removePending()
      requestId.value = null
      formError.value = redPacketErrorMessage(isApiError(e) ? e.code : '', t, isApiError(e) ? e.message : String(e))
    }
    clearSecrets()
  } finally {
    if (current === generation) busy.value = false
  }
}

async function queryPacket(): Promise<void> {
  if (requestId.value === null || querying.value) return
  const current = ++generation
  const token = sessionStore.token
  querying.value = true
  queryNote.value = ''
  try {
    const detail = await fetchRedPacketDetail({ requestId: requestId.value })
    if (current !== generation || sessionStore.token !== token) return
    queriedSn.value = detail.sn
    result.value = { packetId: detail.packetId, sn: detail.sn, status: detail.status, expireAt: detail.expireAt }
    step.value = 'submitted'
    if (detail.status !== 'creating' && detail.status !== 'expiring') removePending()
  } catch {
    if (current !== generation || sessionStore.token !== token) return
    queriedSn.value = ''
    queryNote.value = t('rp.send.unknownBody')
  } finally {
    if (current === generation) querying.value = false
  }
}

function sendAnother(): void {
  if (result.value === null || result.value.status === 'creating' || result.value.status === 'expiring') return
  removePending()
  reset()
  void refresh()
}
</script>

<template>
  <section class="rp-page">
    <header class="rp-head">
      <h1 class="rp-title">{{ t('rp.sendTitle') }}</h1>
      <p class="rp-sub">{{ t('rp.send.subtitle') }}</p>
    </header>

    <GuestGate v-if="!sessionStore.isAuthenticated" :message="t('rp.send.loginRequired')" />

    <template v-else>
      <StateBlock v-if="step === 'edit' && orderLoading && order === null" variant="loading" :message="t('rp.send.orderLoading')" />
      <StateBlock v-else-if="step === 'edit' && orderError !== ''" variant="error" :message="orderError" retryable @retry="refresh" />
      <div v-else-if="step === 'edit' && blockedReason !== ''">
        <StateBlock variant="error" :message="blockedReason" />
        <RouterLink v-if="!sequenceValid" class="btn btn-primary" to="/otc/orders">{{ t('rp.send.chooseOrder') }}</RouterLink>
      </div>

      <article v-else class="rp-card">
        <dl class="rp-facts">
          <div class="rp-fact">
            <dt>{{ t('rp.send.counterparty') }}</dt>
            <dd class="rp-party">
              <span class="num">{{ counterparty?.nickname || '—' }}</span>
              <span class="rp-uid num">{{ t('rp.send.counterpartyUid') }}：{{ counterparty?.uid || '—' }}</span>
            </dd>
          </div>
          <div class="rp-fact">
            <dt>{{ t('rp.send.available') }}（{{ coin || '—' }}）</dt>
            <dd class="num tabular-nums">{{ available === '' ? t('rp.send.availableUnknown') : groupDigits(available) }}</dd>
          </div>
        </dl>

        <p class="rp-error" role="alert" aria-live="polite">{{ formError }}</p>

        <form class="rp-form" @submit.prevent="step === 'edit' ? review() : confirm()">
          <label class="field">
            <span class="field-label">{{ t('rp.send.coin') }}</span>
            <span class="field-input">
              <select v-model="coin" class="rp-select" :disabled="locked" :aria-label="t('rp.send.coin')">
                <option v-for="c in enabledCoins" :key="c.coin" :value="c.coin">{{ c.coin }}</option>
              </select>
            </span>
            <span v-if="selectedRule" class="rp-hint">
              {{ t('rp.send.minShare') }} {{ groupDigits(selectedRule.min_share) }}
              · {{ t('rp.send.maxTotal') }} {{ groupDigits(selectedRule.max_total) }}
              · {{ t('rp.send.dailyCount') }} {{ selectedRule.daily_count }}
              · {{ t('rp.send.expireHours') }} {{ selectedRule.expire_hours }}
            </span>
          </label>

          <label class="field">
            <span class="field-label">{{ t('rp.send.amount') }}</span>
            <span class="field-input">
              <input v-model="total" type="text" inputmode="decimal" autocomplete="off" maxlength="64" class="tabular-nums" :disabled="locked" :aria-label="t('rp.send.amount')" />
            </span>
            <span v-if="step === 'edit' && total.trim() !== '' && amountError" class="field-error" role="status">{{ amountError }}</span>
          </label>

          <label class="field">
            <span class="field-label">{{ t('rp.send.greeting') }}</span>
            <span class="field-input">
              <input v-model="greeting" type="text" maxlength="100" :placeholder="t('rp.send.greetingPlaceholder')" :disabled="locked" :aria-label="t('rp.send.greeting')" />
            </span>
          </label>

          <div v-if="step === 'edit'" class="rp-actions">
            <button class="btn btn-primary" type="submit" :disabled="!canReview" data-testid="rp-send-review">{{ t('rp.send.review') }}</button>
            <button class="btn" type="button" :disabled="busy" @click="refresh">{{ t('rp.send.refresh') }}</button>
          </div>
        </form>

        <div v-if="step === 'review'" class="rp-card rp-review">
          <h2 class="rp-h2">{{ t('rp.review.title') }}</h2>
          <dl class="rp-facts">
            <div class="rp-fact"><dt>{{ t('rp.review.counterparty') }}</dt><dd class="num">{{ counterparty?.nickname || '—' }} · {{ counterparty?.uid || '—' }}</dd></div>
            <div class="rp-fact"><dt>{{ t('rp.review.coin') }}</dt><dd class="num">{{ coin }}</dd></div>
            <div class="rp-fact"><dt>{{ t('rp.review.amount') }}</dt><dd class="num tabular-nums">{{ groupDigits(total.trim()) }}</dd></div>
            <div class="rp-fact"><dt>{{ t('rp.review.greeting') }}</dt><dd>{{ greeting || '—' }}</dd></div>
          </dl>

          <p v-if="securityUnknown" class="rp-hint">{{ t('rp.send.securityUnknownHint') }}</p>

          <label v-if="capitalRequired || security?.capitalPasswordRequired === undefined" class="field">
            <span class="field-label">{{ t('rp.send.capitalPword') }}</span>
            <span class="field-input">
              <input v-model="capitalPword" type="password" autocomplete="off" :disabled="busy" :aria-label="t('rp.send.capitalPword')" />
            </span>
            <span v-if="!capitalRequired" class="rp-hint">{{ t('rp.send.capitalPwordHint') }}</span>
          </label>

          <CodeField v-if="googleRequired || security?.googleRequired === undefined" v-model="googleCode" :label="t('rp.send.googleCode')" :disabled="busy" />
          <p v-if="!googleRequired && security?.googleRequired === undefined" class="rp-hint">{{ t('rp.send.googleCodeHint') }}</p>

          <div class="rp-actions">
            <button class="btn btn-primary" type="button" :disabled="busy" data-testid="rp-send-confirm" @click="confirm">{{ busy ? t('rp.send.sending') : t('rp.review.confirm') }}</button>
            <button class="btn" type="button" :disabled="busy" @click="back">{{ t('rp.review.back') }}</button>
          </div>
        </div>

        <div v-if="step === 'submitted' && result" class="rp-card rp-result" data-testid="rp-send-submitted">
          <p class="rp-ok">{{ result.status === 'active' ? t('rp.send.submitted') : t(`rp.status.${result.status}`) }}</p>
          <p class="rp-sn"><span class="field-label">{{ t('rp.detail.sn') }}</span> <code class="num">{{ result.sn }}</code></p>
          <RouterLink class="btn btn-primary" :to="`/redpacket/${encodeURIComponent(result.sn)}`">{{ t('rp.detailTitle') }}</RouterLink>
          <button v-if="result.status === 'creating' || result.status === 'expiring'" class="btn" type="button" :disabled="querying" @click="queryPacket">{{ t('rp.send.queryPacket') }}</button>
          <button v-else class="btn" type="button" @click="sendAnother">{{ t('rp.send.another') }}</button>
        </div>

        <div v-if="step === 'unknown'" class="rp-card rp-unknown" role="alert" aria-live="polite" data-testid="rp-send-unknown">
          <h2 class="rp-h2">{{ t('rp.send.unknownTitle') }}</h2>
          <p class="rp-warn">{{ t('rp.send.unknownBody') }}</p>
          <div class="rp-actions">
            <button class="btn btn-primary" type="button" :disabled="querying" @click="queryPacket">
              {{ querying ? t('rp.common.loading') : t('rp.send.queryPacket') }}
            </button>
            <RouterLink class="btn" to="/otc/orders">{{ t('rp.send.orders') }}</RouterLink>
          </div>
          <p v-if="requestId" class="rp-sn"><span class="field-label">{{ t('rp.common.requestId') }}</span><code class="num">{{ requestId }}</code></p>
          <p v-if="queriedSn !== ''" class="rp-sn">
            <span class="field-label">{{ t('rp.detail.sn') }}</span> <code class="num">{{ queriedSn }}</code>
            <RouterLink class="rp-link" :to="`/redpacket/${encodeURIComponent(queriedSn)}`">{{ t('rp.detailTitle') }}</RouterLink>
          </p>
          <p v-else-if="queryNote !== ''" class="rp-hint">{{ queryNote }}</p>
        </div>
      </article>

      <p v-if="configError !== ''" class="rp-hint" role="alert" aria-live="polite">{{ configError }}</p>
      <StateBlock v-if="configLoading && config === null" variant="loading" :message="t('rp.common.loading')" />
    </template>
  </section>
</template>

<style scoped>
.rp-page { max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; }
.rp-head { margin-bottom: 16px; }
.rp-title { margin: 0; font-size: 22px; }
.rp-sub { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; }
.rp-card { padding: 18px; border: 1px solid var(--color-border-strong); border-radius: 14px; background: var(--color-surface); }
.rp-card + .rp-card { margin-top: 14px; }
.rp-h2 { margin: 0 0 10px; font-size: 16px; }
.rp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 18px; margin: 0 0 12px; }
.rp-fact { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rp-fact dt { color: var(--color-text-muted); font-size: 12px; }
.rp-fact dd { margin: 0; font-weight: 600; }
.rp-party { display: flex; flex-direction: column; gap: 2px; }
.rp-uid { color: var(--color-text-muted); font-size: 12px; font-weight: 500; }
.rp-form { display: flex; flex-direction: column; gap: 12px; }
.rp-select { width: 100%; height: 36px; background: transparent; color: inherit; }
.rp-hint { color: var(--color-text-muted); font-size: 12px; }
.rp-error, .rp-warn { margin: 0 0 8px; color: var(--color-down); font-size: 13px; }
.rp-warn { color: var(--color-warning, var(--color-down)); }
.rp-actions { display: flex; gap: 10px; margin-top: 6px; }
.rp-ok { margin: 0 0 8px; color: var(--color-up); font-weight: 650; }
.rp-sn { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rp-sn code { font-family: var(--font-mono); word-break: break-all; }
.rp-link { margin-left: 8px; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.num { font-family: var(--font-mono); }
</style>
