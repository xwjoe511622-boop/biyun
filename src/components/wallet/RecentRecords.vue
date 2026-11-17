<script setup lang="ts">
import { i18n } from '@/i18n/composer'
import { onBeforeUnmount, ref, watch } from 'vue'
import { ArrowUpRight, RotateCw } from '@lucide/vue'
import StatusChip from './StatusChip.vue'
import { isApiError } from '@/core/errors'
import { session } from '@/core/session'
import { groupDigits } from '@/modules/finance/decimal'
import { fetchDepositHistory, fetchWithdrawHistory } from '@/modules/api/wallet.api'
import { shortAddress } from '@/modules/wallet/evm'
import { useWalletI18n } from '@/modules/wallet/i18n'
import { recordTxUrl, statusKey, statusLabel, statusTone } from '@/modules/wallet/records'
import type { HistoryEntry, HistoryKind } from '@/modules/wallet/types'

/** Compact "recent deposits / withdrawals" list for the side column of the flows. */
const props = withDefaults(defineProps<{ kind: HistoryKind; coin: string; network?: string; title: string; empty: string; refreshKey?: number }>(), {
  network: '',
  refreshKey: 0,
})
const emit = defineEmits<{ (event: 'viewAll'): void }>()
const { t } = useWalletI18n()

const rows = ref<HistoryEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
let version = 0

async function load(): Promise<void> {
  const current = ++version
  rows.value = []
  error.value = null
  if (!session.isAuthenticated() || props.coin === '') {
    loading.value = false
    return
  }
  loading.value = true
  const token = session.getToken()
  try {
    const query = { coin: props.coin, page: 1, pageSize: 5 }
    const page = props.kind === 'deposit' ? await fetchDepositHistory(query) : await fetchWithdrawHistory(query)
    if (current !== version || token !== session.getToken()) return
    rows.value = page.list.slice(0, 5)
  } catch (error_) {
    if (current !== version || token !== session.getToken()) return
    error.value = isApiError(error_) ? error_.message : error_ instanceof Error ? error_.message : String(error_)
  } finally {
    if (current === version) loading.value = false
  }
}

function label(entry: HistoryEntry): string {
  if (entry.statusText !== '') return entry.statusText
  // Native string states carry their own Chinese label; numeric codes fall back to i18n.
  const known = statusLabel(props.kind, entry)
  if (known !== '') return known
  const key = statusKey(props.kind, entry)
  return key === '' ? (entry.rawStatus ?? '--') : t(key)
}

function confirmationsText(entry: HistoryEntry): string {
  if (entry.confirmations === undefined) return ''
  return entry.requiredConfirmations === undefined ? `${entry.confirmations}` : `${entry.confirmations}/${entry.requiredConfirmations}`
}

watch(() => [props.coin, props.kind, props.refreshKey] as const, () => { void load() }, { immediate: true })
const stop = session.onInvalidate(() => { void load() })
onBeforeUnmount(() => { version += 1; stop() })
</script>

<template>
  <section class="recent" :aria-label="title">
    <header class="recent-head">
      <h3 class="recent-title">{{ title }}</h3>
      <span class="recent-actions">
        <button class="icon-button recent-refresh" type="button" :aria-label="t('common.refresh')" :title="t('common.refresh')" :disabled="loading" @click="load">
          <RotateCw :size="14" :class="{ spinning: loading }" aria-hidden="true" />
        </button>
        <button class="link-more" type="button" @click="emit('viewAll')">{{ t('wallet.flow.viewAll') }}</button>
      </span>
    </header>
    <p v-if="error !== null" class="recent-error">{{ error }}</p>
    <p v-else-if="!loading && rows.length === 0" class="recent-empty">{{ empty }}</p>
    <ul v-else class="recent-list">
      <li v-for="entry in rows" :key="`${entry.id}-${entry.createdAt}`" class="recent-row">
        <div class="recent-line">
          <span class="num recent-amount">{{ entry.amount === '' ? '--' : groupDigits(entry.amount) }} <span class="muted">{{ entry.coin || coin }}</span></span>
          <StatusChip :label="label(entry)" :tone="statusTone(kind, entry)" />
        </div>
        <div class="recent-line sub">
          <span class="num">{{ entry.createdAt || '--' }}</span>
          <span v-if="kind === 'deposit' && confirmationsText(entry) !== ''" class="num">{{ confirmationsText(entry) }}</span>
          <span v-else-if="entry.address !== ''" class="num" :title="entry.address">{{ shortAddress(entry.address) }}</span>
          <span
            v-if="kind === 'deposit' && (entry.dustRaw ?? '') !== '' && entry.dustRaw !== '0'"
            class="num recent-dust"
            :title="i18n.global.t('walletDust.remainderBelow16DecimalPlacesItBelongsToYou')"
          >{{ i18n.global.t('walletDust.remainder', { value: entry.dustRaw }) }}</span>
          <a
            v-if="recordTxUrl(entry, entry.network ?? network) !== ''"
            class="recent-tx"
            :href="recordTxUrl(entry, entry.network ?? network)"
            target="_blank"
            rel="noopener noreferrer"
          >{{ t('wallet.rec.txid') }}<ArrowUpRight :size="12" aria-hidden="true" /></a>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.recent { display: flex; flex-direction: column; gap: 6px; }
.recent-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.recent-title { margin: 0; font-size: 14px; font-weight: 700; }
.recent-actions { display: inline-flex; align-items: center; gap: 2px; }
.recent-refresh { width: 30px; height: 30px; flex-basis: 30px; }
.link-more { padding: 4px 6px; color: var(--color-accent-text); font-size: 12px; font-weight: 600; }
.recent-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.recent-row { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--color-border); }
.recent-row:last-child { border-bottom: 0; }
.recent-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.recent-line.sub { color: var(--color-text-muted); font-size: 11.5px; flex-wrap: wrap; justify-content: flex-start; gap: 10px; }
.recent-dust { color: var(--color-warning); }
.recent-amount { font-size: 13.5px; font-weight: 650; }
.recent-tx { display: inline-flex; align-items: center; gap: 2px; color: var(--color-accent-text); font-weight: 600; }
.recent-empty, .recent-error { margin: 0; padding: 18px 0; color: var(--color-text-muted); font-size: 12.5px; text-align: center; }
.recent-error { color: var(--color-down); }
.spinning { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
