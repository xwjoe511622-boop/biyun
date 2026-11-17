<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CircleCheck, Network, RotateCw, ShieldCheck, TriangleAlert, Waypoints } from '@lucide/vue'
import CoinPicker from './CoinPicker.vue'
import CopyButton from './CopyButton.vue'
import DepositQr from './DepositQr.vue'
import NetworkPicker from './NetworkPicker.vue'
import RecentRecords from './RecentRecords.vue'
import WalletStep from './WalletStep.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isWalletGatewayConfigured } from '@/config/endpoints'
import { isApiError } from '@/core/errors'
import { groupDigits } from '@/modules/finance/decimal'
import { fetchDepositAddress } from '@/modules/api/wallet.api'
import { formatElapsed, nextPollDelayMs, provisionPhase } from '@/modules/wallet/provisionPoll'
import { coinMetaForBranch, defaultNetwork, type CoinRow } from '@/modules/wallet/coins'
import { useWalletI18n } from '@/modules/wallet/i18n'
import { coinNetworkMap, networkChoicesForCoin, supportedCoins } from '@/modules/wallet/networks'
import type { DepositAddress } from '@/modules/wallet/types'
import { useWalletNetworks } from '@/modules/wallet/useWalletNetworks'
import { findCoinBalance } from '@/modules/market/symbols'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{ coin: string; coins: CoinRow[] }>()
const emit = defineEmits<{
  (event: 'update:coin', coin: string): void
  (event: 'openRecords', kind: 'deposit' | 'withdraw'): void
}>()
const { t } = useWalletI18n()

const account = useAccountStore()
const market = useMarketStore()
const sessionStore = useSessionStore()
const { networks, ready: networksReady } = useWalletNetworks()

const choiceId = ref('')
const address = ref<DepositAddress | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
let controller: AbortController | null = null
let version = 0

/** PROVISIONING auto re-check: start time of the current wait, poll timer, 1 s elapsed ticker, "ready" flash. */
const provisionStartedAt = ref<number | null>(null)
const now = ref(Date.now())
const justGenerated = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let flashTimer: ReturnType<typeof setTimeout> | null = null
const elapsedMs = computed(() => (provisionStartedAt.value === null ? 0 : now.value - provisionStartedAt.value))
const elapsedText = computed(() => formatElapsed(elapsedMs.value))
const phase = computed(() => provisionPhase(elapsedMs.value))

/**
 * Coins offered in the picker. With the authoritative server directory the list is filtered to supported
 * coins and the currently selected coin is **not** re-added (so a stale USDC selection cannot reappear);
 * balances for every row are untouched. With `null` (historical backend) the legacy `depositOpen` filter
 * applies and the current coin stays visible.
 */
const depositCoins = computed(() => {
  const supported = supportedCoins(networks.value, 'deposit')
  if (supported !== null) {
    return props.coins.filter(row => supported.has(row.coin.toUpperCase()))
  }
  return props.coins.filter(row => row.depositOpen !== false || row.coin === props.coin)
})
const choices = computed(() => networkChoicesForCoin(market.publicInfo, props.coin, networks.value, 'deposit'))
const choice = computed(() => choices.value.find(entry => entry.id === choiceId.value))
const requestSymbol = computed(() => choice.value?.requestSymbol ?? '')
/** Contract v2 network of the selected card (e.g. `BSC`); `''` on the per-coin backend. */
const network = computed(() => choice.value?.network ?? '')

const networkName = computed(() => address.value?.networkName ?? '')
const chainId = computed(() => address.value?.chainId)
const tokenContract = computed(() => address.value?.tokenContract ?? '')
const confirmations = computed(() => address.value?.confirmations)
/** Server is still allocating the address (PROVISIONING): nothing address-like may be shown. */
const provisioning = computed(() => address.value?.status === 'PROVISIONING')
/** Network name used in the warnings: contract code (e.g. `BSC`), else the server network name. */
const warnNetwork = computed(() => {
  // A self-hosted wallet key such as `ETHEREUM-MAINNET` reads badly in a warning: use the display name then.
  if (choice.value !== undefined && choice.value.network !== '' && !choice.value.network.includes('-')) return choice.value.network
  if (networkName.value !== '') return networkName.value
  return choice.value?.label ?? ''
})
const recordNetwork = computed(() => coinNetworkMap(networks.value)[props.coin.toUpperCase()] ?? '')

// With the authoritative server directory, a coin is deposit-open iff it has at least one server network —
// the old `account.depositOpen` flag no longer overrides the new Fable support set. With `null` (historical
// backend) the legacy account deposit flag is kept. The server still enforces the real
// `depositEnabled` on every request.
const coinOpen = computed<boolean | null>(() => {
  if (networks.value !== null) {
    return choices.value.length > 0
  }
  const entry = findCoinBalance(account.allCoinMap, props.coin)
  if (entry === undefined || entry.depositOpen === undefined) {
    return null
  }
  const raw = String(entry.depositOpen).trim()
  return raw === '0' ? false : raw === '1' ? true : null
})

const blockedReason = computed<string>(() => {
  if (!isWalletGatewayConfigured()) {
    // The native Fable wallet has no configured same-origin gateway.
    return t('wallet.deposit.unavailable')
  }
  if (coinOpen.value === false) {
    return t('wallet.state.depositClosed')
  }
  if (coinOpen.value === null) return t('wallet.deposit.flagUnknown')
  return ''
})

const tagRequired = computed(() => {
  // Branch entries live in `market.followCoinList[coin][chain]`, not in `coinList`.
  const branch = choice.value !== undefined && choice.value.requestSymbol !== props.coin ? choice.value.requestSymbol : ''
  const meta = coinMetaForBranch(market.publicInfo, props.coin, branch)
  return meta.tagType > 0
})

const networkDetails = computed<Record<string, string[]>>(() => {
  const id = choice.value?.id
  if (id === undefined || confirmations.value === undefined) return {}
  return { [id]: [t('wallet.flow.confirmations', { n: confirmations.value })] }
})

function describe(error_: unknown): string {
  return isApiError(error_) ? error_.message : error_ instanceof Error ? error_.message : String(error_)
}

function abort(): void {
  controller?.abort()
  controller = null
}

async function load(options: { silent?: boolean } = {}): Promise<void> {
  abort()
  const current = ++version
  const silent = options.silent === true && provisioning.value
  if (!silent) {
    stopPolling()
    provisionStartedAt.value = null
    justGenerated.value = false
  }
  // Never display a stale address: only a freshly READY address from the server may be shown. A silent
  // re-check keeps the PROVISIONING card, which carries no address.
  if (!silent) address.value = null
  error.value = null
  loading.value = false
  const symbol = requestSymbol.value
  if (!networksReady.value || !sessionStore.isAuthenticated || blockedReason.value !== '' || props.coin === '' || symbol === '') return
  const active = new AbortController()
  controller = active
  loading.value = true
  error.value = null
  try {
    const next = await fetchDepositAddress(symbol, { signal: active.signal, network: network.value })
    if (current !== version) {
      return
    }
    if (next.status !== 'PROVISIONING' && tagRequired.value && next.tag === '') throw new Error(t('wallet.deposit.noAddress'))
    const wasProvisioning = provisioning.value
    address.value = next
    if (next.status === 'PROVISIONING') {
      if (provisionStartedAt.value === null) provisionStartedAt.value = Date.now()
      schedulePoll()
    } else {
      stopPolling()
      if (wasProvisioning && next.address !== '') flashGenerated()
      provisionStartedAt.value = null
    }
  } catch (error_) {
    if (current !== version || (isApiError(error_) && (error_.kind === 'aborted' || error_.kind === 'timeout') && active.signal.aborted)) {
      return
    }
    stopPolling()
    address.value = null
    error.value = describe(error_)
  } finally {
    if (current === version) {
      loading.value = false
    }
  }
}

function stopPolling(): void {
  if (pollTimer !== null) clearTimeout(pollTimer)
  if (tickTimer !== null) clearInterval(tickTimer)
  pollTimer = null
  tickTimer = null
}

/** Next silent re-check on the backoff schedule; paused while the tab is hidden (resumed by visibilitychange). */
function schedulePoll(): void {
  if (pollTimer !== null) clearTimeout(pollTimer)
  pollTimer = null
  if (typeof document !== 'undefined' && document.hidden) return
  now.value = Date.now()
  if (tickTimer === null) tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
  pollTimer = setTimeout(() => {
    pollTimer = null
    void load({ silent: true })
  }, nextPollDelayMs(elapsedMs.value))
}

function flashGenerated(): void {
  justGenerated.value = true
  if (flashTimer !== null) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { justGenerated.value = false }, 4000)
}

function onVisibility(): void {
  if (document.hidden) {
    stopPolling()
  } else if (provisioning.value) {
    void load({ silent: true })
  }
}

/** Keeps a valid network selected: the legacy default branch, else the first server network. */
watch(
  choices,
  (list) => {
    if (list.some(entry => entry.id === choiceId.value)) return
    const preferred = defaultNetwork(market.publicInfo, props.coin)
    choiceId.value = (list.find(entry => entry.id === preferred) ?? list[0])?.id ?? ''
  },
  { immediate: true },
)

// Reload on the request symbol AND the selected network: a network switch must refetch even when the
// coin and request symbol are unchanged (multi-network coins), and a late probe that relabels the card
// re-resolves the address for the correct network instead of keeping a stale one.
watch([networksReady, () => props.coin, requestSymbol, network, blockedReason, () => sessionStore.token, () => account.data], () => {
  void load()
}, { immediate: true })

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  // Invalidate in-flight reads so a late response cannot write into a dead panel.
  version += 1
  abort()
  stopPolling()
  if (flashTimer !== null) clearTimeout(flashTimer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div class="flow">
    <div class="flow-main">
      <div class="flow-head">
        <p v-if="blockedReason !== ''" class="notice notice-error flow-block" role="alert">{{ blockedReason }}</p>
        <button class="btn btn-ghost reload" type="button" :disabled="loading || blockedReason !== ''" @click="load()">
          <RotateCw :size="13" aria-hidden="true" />
          {{ loading ? t('common.loading') : t('common.refresh') }}
        </button>
      </div>

      <WalletStep :index="1" :title="t('wallet.flow.stepCoin')" :done="coin !== ''">
        <CoinPicker :model-value="coin" :coins="depositCoins" :label="t('wallet.coin')" @update:model-value="emit('update:coin', $event)" />
      </WalletStep>

      <WalletStep :index="2" :title="t('wallet.flow.stepNetwork')" :done="choice !== undefined" :muted="coin === ''">
        <NetworkPicker v-model="choiceId" :choices="choices" :label="t('wallet.network')" :details="networkDetails" />
        <p class="step-hint"><TriangleAlert :size="13" aria-hidden="true" />{{ t('wallet.flow.networkHint') }}</p>
      </WalletStep>

      <WalletStep :index="3" :title="t('wallet.flow.stepAddress')" :done="address !== null && address.address !== ''" :muted="choice === undefined" last>
        <p v-if="blockedReason !== ''" class="step-empty">{{ blockedReason }}</p>
        <template v-else>
          <StateBlock v-if="loading && address === null" variant="loading" :message="t('wallet.deposit.generating')" />
          <StateBlock v-else-if="error !== null" variant="error" :message="error" retryable @retry="load()" />
          <div v-else-if="provisioning" class="provisioning" role="status" aria-live="polite" :data-phase="phase">
            <div class="gen-visual" aria-hidden="true">
              <span class="gen-qr"></span>
              <span class="gen-spinner"></span>
            </div>
            <div class="gen-copy">
              <p class="gen-title" data-testid="deposit-provisioning">{{ t('wallet.deposit.generating') }}<span class="gen-dots"><i></i><i></i><i></i></span></p>
              <p class="provisioning-text">{{ phase === 'slow' ? t('wallet.deposit.generatingSlow') : t('wallet.deposit.generatingHint') }}</p>
              <span class="gen-skel" aria-hidden="true"></span>
              <span class="gen-elapsed num">{{ t('wallet.deposit.generatingElapsed', { s: elapsedText }) }}</span>
              <button v-if="phase === 'slow'" class="btn" type="button" :disabled="loading" data-testid="deposit-provisioning-retry" @click="load({ silent: true })">
                <RotateCw :size="13" aria-hidden="true" />
                {{ t('wallet.deposit.generatingRecheck') }}
              </button>
            </div>
          </div>
          <StateBlock v-else-if="address === null || address.address === ''" variant="error" :message="t('wallet.deposit.noAddress')" retryable @retry="load()" />
          <div v-else class="address-card" :class="{ 'is-new': justGenerated }">
            <p v-if="justGenerated" class="generated-flash" role="status"><CircleCheck :size="14" aria-hidden="true" />{{ t('wallet.deposit.generated') }}</p>
            <div class="qr-col">
              <DepositQr :address="address.address" :remote-qr="address.qrCode" :alt="t('wallet.deposit.qrAvailable')" />
              <span class="qr-hint">{{ t('wallet.dep.scanHint') }}</span>
            </div>
            <div class="address-col">
              <span class="field-label">{{ t('wallet.deposit.address') }}</span>
              <p class="address-big num" data-testid="deposit-address">{{ address.address }}</p>
              <div class="address-actions">
                <CopyButton :value="address.address" :label="t('wallet.dep.copyAddress')" strong />
              </div>

              <div v-if="address.tag !== '' || tagRequired" class="memo-box">
                <span class="field-label">{{ t('wallet.deposit.tag') }}</span>
                <div class="memo-row">
                  <span class="num memo-value" data-testid="deposit-tag">{{ address.tag === '' ? '--' : address.tag }}</span>
                  <CopyButton v-if="address.tag !== ''" :value="address.tag" compact />
                </div>
                <p class="memo-warn">{{ t('wallet.dep.memoWarn') }}</p>
              </div>

              <div class="warn-card" role="note">
                <TriangleAlert :size="16" aria-hidden="true" />
                <div>
                  <strong>{{ t('wallet.dep.onlyNetwork', { network: warnNetwork, coin }) }}</strong>
                  <p>{{ t('wallet.dep.onlyNetworkBody', { network: warnNetwork, coin }) }}</p>
                </div>
              </div>

              <dl class="facts">
                <div v-if="address.depositMin !== undefined" class="fact">
                  <dt>{{ t('wallet.dep.minDeposit') }}</dt>
                  <dd class="num">{{ groupDigits(address.depositMin) }} {{ coin }}</dd>
                </div>
                <div v-if="confirmations !== undefined" class="fact">
                  <dt>{{ t('wallet.dep.creditAfter') }}</dt>
                  <dd class="num" data-testid="deposit-confirmations"><ShieldCheck :size="13" aria-hidden="true" /> {{ t('wallet.flow.confirmations', { n: confirmations }) }}</dd>
                </div>
                <div v-if="networkName !== ''" class="fact">
                  <dt>{{ t('wallet.network') }}</dt>
                  <dd data-testid="deposit-network"><Network :size="13" aria-hidden="true" /> {{ networkName }}</dd>
                </div>
                <div v-if="chainId !== undefined" class="fact">
                  <dt>{{ t('wallet.deposit.chainId') }}</dt>
                  <dd class="num" data-testid="deposit-chain-id"><Waypoints :size="13" aria-hidden="true" /> {{ chainId }}</dd>
                </div>
                <div v-if="tokenContract !== ''" class="fact wide">
                  <dt>{{ t('wallet.dep.contract') }}</dt>
                  <dd class="contract-row">
                    <span class="num wrap-anywhere" data-testid="deposit-token-contract">{{ tokenContract }}</span>
                    <CopyButton :value="tokenContract" compact />
                  </dd>
                </div>
              </dl>
              <p class="arrival">{{ t('wallet.dep.arrivalHint') }}</p>
            </div>
          </div>
        </template>
      </WalletStep>
    </div>

    <aside class="flow-side">
      <RecentRecords
        kind="deposit"
        :coin="coin"
        :network="recordNetwork"
        :title="t('wallet.dep.recent')"
        :empty="t('wallet.dep.recentEmpty')"
        @view-all="emit('openRecords', 'deposit')"
      />
    </aside>
  </div>
</template>

<style scoped>
.flow { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; align-items: start; }
.flow-main { min-width: 0; padding: 24px 24px 26px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.flow-side { position: sticky; top: calc(var(--header-h) + 16px); min-width: 0; padding: 18px 18px 8px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.flow-head { display: flex; align-items: flex-start; justify-content: flex-end; gap: 12px; margin: -8px -8px 8px 0; }
.flow-block { flex: 1 1 auto; margin: 0; }
.reload { height: 32px; padding: 0 10px; }
.step-hint { display: flex; align-items: flex-start; gap: 6px; margin: 10px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.step-hint :deep(svg) { flex: 0 0 auto; margin-top: 2px; color: var(--color-warning); }
.step-empty { margin: 0; color: var(--color-text-muted); font-size: 13px; }
.provisioning {
  display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 24px; align-items: center; padding: 20px;
  border: 1px solid var(--color-border-strong); border-radius: 14px; background: var(--color-surface-alt);
}
.gen-visual { position: relative; display: grid; place-items: center; width: 176px; height: 176px; margin: 0 auto; }
.gen-qr {
  position: absolute; inset: 0; border-radius: 12px;
  background: linear-gradient(100deg, var(--color-surface) 30%, var(--color-accent-soft) 50%, var(--color-surface) 70%);
  background-size: 220% 100%; animation: gen-shimmer 1.6s ease-in-out infinite;
}
.gen-spinner {
  position: relative; width: 40px; height: 40px; border-radius: 50%;
  border: 3px solid color-mix(in srgb, var(--color-accent) 22%, transparent); border-top-color: var(--color-accent);
  animation: gen-spin 0.9s linear infinite;
}
.gen-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; }
.gen-title { display: flex; align-items: baseline; margin: 0; font-size: 16px; font-weight: 650; color: var(--color-text); }
.gen-dots { display: inline-flex; gap: 3px; margin-left: 4px; }
.gen-dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--color-accent); animation: gen-dot 1.2s ease-in-out infinite; }
.gen-dots i:nth-child(2) { animation-delay: 0.2s; }
.gen-dots i:nth-child(3) { animation-delay: 0.4s; }
.provisioning-text { margin: 0; color: var(--color-text-muted); font-size: 13px; line-height: 1.55; }
.gen-skel {
  width: 100%; max-width: 420px; height: 14px; border-radius: 7px;
  background: linear-gradient(100deg, var(--color-surface) 30%, var(--color-accent-soft) 50%, var(--color-surface) 70%);
  background-size: 220% 100%; animation: gen-shimmer 1.6s ease-in-out infinite;
}
.gen-elapsed { color: var(--color-text-secondary); font-size: 12px; }
.provisioning[data-phase='slow'] .provisioning-text { color: var(--color-warning); }
.generated-flash {
  grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 6px; justify-self: start; margin: 0;
  padding: 4px 10px; border-radius: 999px; background: var(--color-success-soft, var(--color-accent-soft));
  color: var(--color-success, var(--color-accent)); font-size: 12.5px; font-weight: 600;
}
.address-card.is-new { animation: gen-in 0.45s ease-out; }
@keyframes gen-spin { to { transform: rotate(360deg); } }
@keyframes gen-shimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
@keyframes gen-dot { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
@keyframes gen-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .gen-qr, .gen-skel, .gen-spinner, .gen-dots i, .address-card.is-new { animation: none; }
}

.address-card {
  display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 24px; padding: 20px;
  border: 1px solid var(--color-border-strong); border-radius: 14px;
  background: linear-gradient(160deg, var(--color-accent-soft), transparent 42%), var(--color-surface-alt);
}
.qr-col { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.qr-col :deep(.deposit-qr) { width: 176px; height: 176px; border-radius: 12px; }
.qr-hint { color: var(--color-text-muted); font-size: 11.5px; }
.address-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.address-big {
  margin: 0; font-family: var(--font-mono); font-size: 19px; font-weight: 600; line-height: 1.45; letter-spacing: 0.01em;
  white-space: normal; overflow-wrap: anywhere; word-break: break-all; user-select: all;
}
.address-actions { display: flex; gap: 8px; }
.memo-box { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--color-warning-soft); }
.memo-row { display: flex; align-items: center; gap: 8px; }
.memo-value { font-family: var(--font-mono); font-size: 16px; font-weight: 650; }
.memo-warn { margin: 0; color: var(--color-warning); font-size: 12px; }
.warn-card {
  display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
  background: var(--color-warning-soft); color: var(--color-warning); font-size: 12.5px; line-height: 1.5;
}
.warn-card :deep(svg) { flex: 0 0 auto; margin-top: 2px; }
.warn-card strong { display: block; font-size: 13.5px; }
.warn-card p { margin: 2px 0 0; color: var(--color-text-secondary); }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin: 4px 0 0; }
.fact { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.fact.wide { grid-column: 1 / -1; }
.fact dt { color: var(--color-text-muted); font-size: 11.5px; }
.fact dd { display: flex; align-items: center; gap: 5px; margin: 0; font-size: 13px; font-weight: 600; min-width: 0; }
.contract-row .num { white-space: normal; word-break: break-all; font-size: 12px; font-weight: 500; color: var(--color-text-secondary); }
.arrival { margin: 0; color: var(--color-text-muted); font-size: 12px; }

@media (max-width: 1080px) {
  .flow { grid-template-columns: minmax(0, 1fr); }
  .flow-side { position: static; }
}
@media (max-width: 720px) {
  .flow-main { padding: 18px 14px; border-radius: 14px; }
  .address-card, .provisioning { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 16px; }
  .gen-visual { width: 148px; height: 148px; }
  .gen-copy { align-items: center; text-align: center; }
  .address-big { font-size: 16px; }
  .facts { grid-template-columns: minmax(0, 1fr); }
}
</style>
