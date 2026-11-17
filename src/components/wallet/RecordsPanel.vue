<script setup lang="ts">
import { i18n } from '@/i18n/composer'
import { toastError, toastSuccess } from '@/core/toast'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, RotateCw } from '@lucide/vue'
import CopyButton from './CopyButton.vue'
import StatusChip from './StatusChip.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { isWalletGatewayConfigured } from '@/config/endpoints'
import { groupDigits } from '@/modules/finance/decimal'
import { cancelWithdrawal, fetchDepositHistory, fetchWithdrawHistory } from '@/modules/api/wallet.api'
import type { CoinRow } from '@/modules/wallet/coins'
import { shortAddress } from '@/modules/wallet/evm'
import { useWalletI18n } from '@/modules/wallet/i18n'
import { coinNetworkMap } from '@/modules/wallet/networks'
import { recordTxUrl, statusCode, statusKey, statusLabel as nativeStatusLabel, statusTone } from '@/modules/wallet/records'
import type { HistoryEntry, HistoryKind, HistoryPage } from '@/modules/wallet/types'
import { useWalletNetworks } from '@/modules/wallet/useWalletNetworks'
import { useAccountStore } from '@/stores/account'

const props = withDefaults(defineProps<{ coins: CoinRow[]; initialKind?: HistoryKind }>(), { initialKind: 'deposit' })
const { t } = useWalletI18n()
const account = useAccountStore()
const { networks } = useWalletNetworks()

const PAGE_SIZE = 10

const kind = ref<HistoryKind>(props.initialKind)
const coin = ref('')
const page = ref(1)
const data = ref<HistoryPage>({ count: 0, list: [] })
const loading = ref(false)
const error = ref<string | null>(null)
const cancelTarget = ref('')
const cancelPending = ref(false)

let version = 0
let invalidation = 0
const stopSession = session.onInvalidate(snapshot => {
  if (snapshot.token === sessionToken) return
  sessionToken = snapshot.token
  reset()
  if (snapshot.token) void load()
})
let sessionToken = session.getToken()

function reset(): void {
  invalidation += 1
  version += 1
  data.value = { count: 0, list: [] }
  cancelTarget.value = ''
  cancelPending.value = false
  loading.value = false
  error.value = null
  page.value = 1
}

const pageCount = computed(() => Math.max(1, Math.ceil(data.value.count / PAGE_SIZE)))
const networkByCoin = computed(() => coinNetworkMap(networks.value))

function describe(error_: unknown): string {
  return isApiError(error_) ? error_.message : error_ instanceof Error ? error_.message : String(error_)
}

async function load(): Promise<void> {
  const current = ++version
  data.value = { count: 0, list: [] }
  cancelTarget.value = ''
  if (!session.isAuthenticated()) return
  loading.value = true
  error.value = null
  try {
    const query = { coin: coin.value, page: page.value, pageSize: PAGE_SIZE }
    const next = kind.value === 'deposit'
      ? await fetchDepositHistory(query)
      : await fetchWithdrawHistory(query)
    if (current !== version) {
      return
    }
    data.value = next
  } catch (error_) {
    if (current !== version) {
      return
    }
    data.value = { count: 0, list: [] }
    error.value = describe(error_)
  } finally {
    if (current === version) {
      loading.value = false
    }
  }
}

function selectKind(next: HistoryKind): void {
  if (next === kind.value) {
    return
  }
  kind.value = next
  invalidation += 1
  cancelPending.value = false
  page.value = 1
  cancelTarget.value = ''
  void load()
}

function selectCoin(value: string): void {
  invalidation += 1
  cancelPending.value = false
  coin.value = value
  page.value = 1
  void load()
}

function changePage(next: number): void {
  if (next < 1 || next > pageCount.value || next === page.value) {
    return
  }
  page.value = next
  invalidation += 1
  cancelPending.value = false
  void load()
}

async function confirmCancel(): Promise<void> {
  const id = cancelTarget.value
  if (id === '' || cancelPending.value) return
  // Every other refusal says why (10-01 audit: the confirm strip just stayed).
  if (!session.isAuthenticated() || !isWalletGatewayConfigured() || kind.value !== 'withdraw') {
    toastError(t('wallet.records.cancelUnavailable'), 'wallet-cancel')
    return
  }
  if (!data.value.list.some(row => row.id === id && cancellable(row))) {
    cancelTarget.value = ''
    toastError(t('wallet.records.cancelGone'), 'wallet-cancel')
    void load()
    return
  }
  cancelPending.value = true
  const generation = invalidation
  error.value = null
  try {
    await cancelWithdrawal(id)
    toastSuccess(t('wallet.records.cancelDone'), 'wallet-cancel')
    if (generation !== invalidation) return
    cancelTarget.value = ''
    await Promise.all([load(), account.load()])
  } catch (error_) {
    if (generation === invalidation) error.value = describe(error_)
  } finally {
    if (generation === invalidation) cancelPending.value = false
  }
}

watch(() => props.coins.length, () => {
  if (coin.value !== '' && !props.coins.some(row => row.coin === coin.value)) {
    coin.value = ''
    page.value = 1
    void load()
  }
})

watch(() => props.initialKind, (next) => {
  selectKind(next)
})

onMounted(() => {
  void load()
})

onBeforeUnmount(() => { stopSession(); reset() })

function format(value: string): string {
  return value === '' ? '--' : groupDigits(value)
}

function rowNetwork(entry: HistoryEntry): string {
  return entry.network ?? networkByCoin.value[entry.coin] ?? ''
}

/** Explorer: server `txidAddr` (http/https only) first, else a BscScan link for a BSC row. */
function txUrl(entry: HistoryEntry): string {
  return recordTxUrl(entry, rowNetwork(entry))
}

/** Cancellable while the native state is `PENDING_APPROVAL` (funds still under review) or the legacy code `"0"`. */
function cancellable(entry: HistoryEntry): boolean {
  const code = statusCode(entry)
  return entry.canCancel !== false && (code === '0' || code === 'PENDING_APPROVAL')
}

function statusLabel(entry: HistoryEntry): string {
  // Native Rust states carry their own Chinese label and take priority over the server text.
  const native = nativeStatusLabel(kind.value, entry)
  if (native !== '') return native
  if (entry.statusText !== '') return entry.statusText
  const key = statusKey(kind.value, entry)
  return key === '' ? (entry.rawStatus ?? '--') : t(key)
}

function confirmations(entry: HistoryEntry): string {
  if (entry.confirmations !== undefined) {
    return entry.requiredConfirmations === undefined ? String(entry.confirmations) : `${entry.confirmations}/${entry.requiredConfirmations}`
  }
  return entry.confirmDesc === '' ? '--' : entry.confirmDesc
}
</script>

<template>
  <div class="records">
    <div class="rec-toolbar">
      <div class="seg" role="tablist" :aria-label="t('wallet.tab.records')">
        <button
          v-for="option in (['deposit', 'withdraw'] as HistoryKind[])"
          :key="option"
          class="seg-btn"
          :class="{ active: kind === option }"
          type="button"
          role="tab"
          :aria-selected="kind === option"
          @click="selectKind(option)"
        >
          <ArrowDownToLine v-if="option === 'deposit'" :size="14" aria-hidden="true" />
          <ArrowUpFromLine v-else :size="14" aria-hidden="true" />
          {{ option === 'deposit' ? t('wallet.records.deposit') : t('wallet.records.withdraw') }}
        </button>
      </div>
      <label class="coin-filter">
        <span class="sr-only">{{ t('wallet.coin') }}</span>
        <select :value="coin" :aria-label="t('wallet.coin')" @change="selectCoin(($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('wallet.records.allCoins') }}</option>
          <option v-for="row in coins" :key="row.coin" :value="row.coin">{{ row.coin }}</option>
        </select>
      </label>
      <button class="btn btn-ghost reload" type="button" :disabled="loading" @click="load">
        <RotateCw :size="13" aria-hidden="true" />
        {{ loading ? t('common.loading') : t('common.refresh') }}
      </button>
    </div>

    <StateBlock v-if="error !== null" variant="error" :message="error" retryable @retry="load" />
    <StateBlock v-else-if="loading && data.list.length === 0" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="data.list.length === 0" variant="empty" :message="t('common.empty')" />
    <div v-else class="rec-table" :class="kind" role="table" :aria-label="kind === 'deposit' ? t('wallet.records.deposit') : t('wallet.records.withdraw')">
      <div class="rec-row rec-head" role="row">
        <span role="columnheader">{{ t('wallet.records.time') }}</span>
        <span role="columnheader">{{ t('wallet.records.coin') }}</span>
        <span role="columnheader">{{ t('wallet.rec.network') }}</span>
        <span role="columnheader" class="right">{{ t('wallet.records.amount') }}</span>
        <span v-if="kind === 'withdraw'" role="columnheader" class="right">{{ t('wallet.records.fee') }}</span>
        <span v-else role="columnheader" class="right">{{ t('wallet.records.confirmations') }}</span>
        <span role="columnheader">{{ t('wallet.records.address') }}</span>
        <span role="columnheader">{{ t('wallet.rec.txid') }}</span>
        <span role="columnheader">{{ t('wallet.records.status') }}</span>
        <span v-if="kind === 'withdraw'" role="columnheader" class="right">{{ t('wallet.rec.actions') }}</span>
      </div>
      <div v-for="entry in data.list" :key="`${entry.id}-${entry.createdAt}`" class="rec-row" role="row">
        <span role="cell" class="num time" :data-label="t('wallet.records.time')">{{ entry.createdAt || '--' }}</span>
        <span role="cell" class="coin" :data-label="t('wallet.records.coin')">{{ entry.coin || '--' }}</span>
        <span role="cell" :data-label="t('wallet.rec.network')">{{ rowNetwork(entry) || '--' }}</span>
        <span role="cell" class="num right amount" :data-label="t('wallet.records.amount')">
          {{ format(entry.amount) }}
          <span
            v-if="kind === 'deposit' && (entry.dustRaw ?? '') !== '' && entry.dustRaw !== '0'"
            class="dust"
            :title="i18n.global.t('walletDust.remainderBelow16DecimalPlacesItBelongsToYou')"
          >+{{ i18n.global.t('walletDust.remainder', { value: entry.dustRaw }) }}</span>
        </span>
        <span v-if="kind === 'withdraw'" role="cell" class="num right" :data-label="t('wallet.records.fee')">{{ format(entry.fee) }}</span>
        <span v-else role="cell" class="num right" :data-label="t('wallet.records.confirmations')">{{ confirmations(entry) }}</span>
        <span role="cell" class="addr" :data-label="t('wallet.records.address')">
          <template v-if="entry.address !== ''">
            <span class="num" :title="entry.address">{{ shortAddress(entry.address, 8, 6) }}{{ entry.tag !== '' ? ` / ${entry.tag}` : '' }}</span>
            <CopyButton :value="entry.address" compact />
          </template>
          <template v-else>--</template>
        </span>
        <span role="cell" :data-label="t('wallet.rec.txid')">
          <a v-if="txUrl(entry) !== ''" class="tx-link num" :href="txUrl(entry)" target="_blank" rel="noopener noreferrer" :title="entry.txid">
            {{ entry.txid !== '' ? shortAddress(entry.txid, 8, 6) : t('wallet.withdraw.txid') }}<ArrowUpRight :size="12" aria-hidden="true" />
          </a>
          <span v-else-if="entry.txid !== ''" class="num muted" :title="entry.txid">{{ shortAddress(entry.txid, 8, 6) }}</span>
          <template v-else>--</template>
        </span>
        <span role="cell" :data-label="t('wallet.records.status')"><StatusChip :label="statusLabel(entry)" :tone="statusTone(kind, entry)" /></span>
        <span v-if="kind === 'withdraw'" role="cell" class="right actions" :class="{ 'no-action': !cancellable(entry) }" :data-label="t('wallet.rec.actions')">
          <template v-if="cancellable(entry)">
            <template v-if="cancelTarget === entry.id">
              <button class="link-btn danger" type="button" :disabled="cancelPending" @click="confirmCancel">{{ t('wallet.withdraw.cancelYes') }}</button>
              <button class="link-btn" type="button" :disabled="cancelPending" @click="cancelTarget = ''">{{ t('wallet.withdraw.cancelNo') }}</button>
            </template>
            <button v-else class="link-btn danger" type="button" :title="t('wallet.withdraw.cancelConfirm')" @click="cancelTarget = entry.id">
              {{ t('wallet.withdraw.cancel') }}
            </button>
          </template>
          <span v-else class="muted">--</span>
        </span>
      </div>
    </div>
    <div v-if="data.count > PAGE_SIZE" class="pager">
      <button class="btn btn-ghost" type="button" :disabled="page <= 1 || loading" @click="changePage(page - 1)">{{ t('wallet.prev') }}</button>
      <span class="muted">{{ t('wallet.pageInfo', { page, pages: pageCount, total: data.count }) }}</span>
      <button class="btn btn-ghost" type="button" :disabled="page >= pageCount || loading" @click="changePage(page + 1)">{{ t('wallet.next') }}</button>
    </div>
  </div>
</template>

<style scoped>
.records { display: flex; flex-direction: column; gap: 14px; padding: 20px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.rec-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.seg { display: inline-flex; padding: 3px; border-radius: 10px; background: var(--color-surface-alt); border: 1px solid var(--color-border); }
.seg-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 8px; color: var(--color-text-muted); font-size: 13px; font-weight: 600; }
.seg-btn.active { background: var(--color-surface); color: var(--color-text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.coin-filter select {
  height: 38px; min-width: 130px; padding: 0 10px; border: 1px solid var(--color-border-strong); border-radius: 8px;
  background: var(--color-surface-alt); font-size: 13px;
}
.reload { margin-left: auto; height: 34px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.rec-table { display: flex; flex-direction: column; overflow-x: auto; }
.rec-row {
  display: grid; align-items: center; gap: 12px; min-width: 980px; padding: 12px 8px; border-bottom: 1px solid var(--color-border); font-size: 13px;
  grid-template-columns: 150px 64px 70px minmax(90px, 1fr) 90px minmax(170px, 1.3fr) 150px 110px;
}
.rec-table.withdraw .rec-row { grid-template-columns: 150px 64px 70px minmax(90px, 1fr) 80px minmax(170px, 1.3fr) 150px 110px 110px; }
.rec-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-row:not(.rec-head):hover { background: var(--color-hover); }
.rec-head { padding-top: 6px; padding-bottom: 8px; color: var(--color-text-muted); font-size: 12px; font-weight: 550; }
.right { text-align: right; justify-content: flex-end; }
.time { color: var(--color-text-secondary); font-size: 12px; }
.coin { font-weight: 700; }
.amount { font-weight: 650; }
.dust { margin-left: 4px; color: var(--color-warning); font-size: 11px; font-weight: 500; }
.addr { display: flex; align-items: center; gap: 4px; min-width: 0; }
.addr .num { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-link { display: inline-flex; align-items: center; gap: 2px; color: var(--color-accent-text); font-weight: 600; }
.actions { display: flex; gap: 10px; }
.link-btn { padding: 0; color: var(--color-accent-text); font-size: var(--font-size-xs); font-weight: 600; }
.link-btn.danger { color: var(--color-down); }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); font-size: var(--font-size-xs); }

@media (max-width: 760px) {
  .records { padding: 14px; }
  .reload { margin-left: 0; }
  .rec-table { overflow: visible; gap: 10px; }
  .rec-head { display: none; }
  .rec-row, .rec-table.withdraw .rec-row {
    min-width: 0; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 12px; padding: 14px;
    border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface-alt);
  }
  .rec-row > span { white-space: normal; overflow: visible; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; justify-content: flex-start; }
  .rec-row > span::before { content: attr(data-label); color: var(--color-text-muted); font-size: 11px; font-weight: 500; }
  .rec-row > .addr { flex-direction: row; flex-wrap: wrap; align-items: center; grid-column: 1 / -1; }
  .rec-row > .addr::before { width: 100%; }
  /* A finished withdrawal has nothing to act on: drop the "Actions: --" card cell on phones. */
  .rec-row > .actions.no-action { display: none; }
  .rec-row > .actions:not(.no-action) { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 12px; }
  .rec-row > .actions:not(.no-action)::before { width: 100%; }
}
</style>
