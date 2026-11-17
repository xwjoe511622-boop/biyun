<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, shallowRef, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, BookUser, ClipboardList, Coins, Cpu, Ellipsis, FileChartLine, Landmark, Sprout, Wallet } from '@lucide/vue'
import AddressBookPanel from '@/components/wallet/AddressBookPanel.vue'
import BalancesPanel from '@/components/wallet/BalancesPanel.vue'
import EmptyAccountPanel from '@/components/wallet/EmptyAccountPanel.vue'
import DepositPanel from '@/components/wallet/DepositPanel.vue'
import RecordsPanel from '@/components/wallet/RecordsPanel.vue'
import WalletTabs from '@/components/wallet/WalletTabs.vue'
import WithdrawPanel from '@/components/wallet/WithdrawPanel.vue'
import InternalTransferPanel from '@/components/wallet/InternalTransferPanel.vue'
import GuestGate from '@/components/common/GuestGate.vue'
import MarginAccountsPanel from '@/components/margin/MarginAccountsPanel.vue'
import TransferDialog from '@/components/transfer/TransferDialog.vue'
import { Wallet as WalletIcon } from '@lucide/vue'
import { buildCoinRows } from '@/modules/wallet/coins'
import { WALLET_MESSAGES } from '@/modules/wallet/i18n'
import { ASSETS_EXTRA_MESSAGES } from '@/modules/transfer/i18n'
import { INTERNAL_TRANSFER_MESSAGES } from '@/components/wallet/InternalTransferMessages'
import type { FuturesGate, TransferAccount } from '@/modules/transfer/transfer'
import { describeFuturesGateError } from '@/modules/transfer/errors'
import { requestLanguage } from '@/modules/api/http'
import type { WalletTab } from '@/modules/wallet/tabs'
import { useAccountStore } from '@/stores/account'
import { useMarginStore } from '@/stores/margin'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

/**
 * Spot wallet. Tabs render lazily: a panel only mounts (and only issues its reads) when it is
 * selected, and nothing here ever sends a withdrawal — that happens exclusively from the explicit
 * review confirmation inside `WithdrawPanel`.
 */
type WalletTabId = 'overview' | 'spot' | 'deposit' | 'withdraw' | 'records' | 'addressBook' | 'internalTransfer' | 'margin' | 'futures' | 'ecosystem' | 'engine'
const TAB_IDS: WalletTabId[] = ['overview', 'spot', 'deposit', 'withdraw', 'records', 'addressBook', 'internalTransfer', 'margin', 'futures', 'ecosystem', 'engine']

/** Account tabs added 2026-11-17: 现货账户 (spot holdings on their own), 生态账户 and 引擎账户 (no coins yet). */
const ACCOUNT_MESSAGES = {
  'zh-CN': { accounts: { spot: '现货账户', ecosystem: '生态账户', engine: '引擎账户', ecosystemTotal: '生态账户资产', engineTotal: '引擎账户资产', ecosystemScope: '生态账户暂不存放任何币种。', engineScope: '引擎账户暂不存放任何币种。', ecosystemEmpty: '生态账户暂无资产', engineEmpty: '引擎账户暂无资产', short: { spot: '现货', futures: '合约', margin: '杠杆', ecosystem: '生态', engine: '引擎' }, quick: '快捷操作', more: '更多' } },
  'en-US': { accounts: { spot: 'Spot', ecosystem: 'Ecosystem', engine: 'Engine', ecosystemTotal: 'Ecosystem account', engineTotal: 'Engine account', ecosystemScope: 'The ecosystem account holds no coins yet.', engineScope: 'The engine account holds no coins yet.', ecosystemEmpty: 'No assets in the ecosystem account', engineEmpty: 'No assets in the engine account', short: { spot: 'Spot', futures: 'Futures', margin: 'Margin', ecosystem: 'Eco', engine: 'Engine' }, quick: 'Quick actions', more: 'More' } },
}

/**
 * The futures account tab is contributed by the futures module. It is only offered when
 * `src/components/futures/FuturesAccountPanel.vue` exists in this build: the glob below resolves to an
 * empty map otherwise, so no dead tab or broken import can ship.
 */
const futuresPanelLoaders = import.meta.glob<{ default: Component }>('../components/futures/FuturesAccountPanel.vue')
const futuresPanelLoader = Object.values(futuresPanelLoaders)[0]
const FuturesAccountPanel = futuresPanelLoader === undefined ? null : defineAsyncComponent(futuresPanelLoader)
const futuresShipped = FuturesAccountPanel !== null

/**
 * The futures panel reads the futures stores that the futures page normally bootstraps. On the assets
 * page they are loaded lazily through the same kind of glob (no static dependency on the futures
 * module): contracts first (public info), then the account config/assets.
 */
interface FuturesMarketLike { loaded: boolean; loadPublicInfo: () => Promise<void> }
interface FuturesAccountLike {
  available: string
  /** futures→spot transferable (server rule, unrealized profit excluded; 2026-09-29) */
  transferable: string
  assetsError: string | null
  open: { status: FuturesGate['status']; error: string | null; initFailed: boolean }
  ensureOpened: (force?: boolean) => Promise<boolean>
  refresh: () => Promise<void>
}
const futuresStoreLoaders = import.meta.glob<Record<string, unknown>>(['../stores/futures-market.ts', '../stores/futures-account.ts'])
const futuresAccountStore = shallowRef<FuturesAccountLike | null>(null)
const futuresMarketStore = shallowRef<FuturesMarketLike | null>(null)
const futuresBootError = ref<string | null>(null)
let futuresBooted = false

async function bootFutures(): Promise<void> {
  if (!futuresShipped) return
  if (futuresBooted) {
    await refreshFutures()
    return
  }
  const marketModule = await futuresStoreLoaders['../stores/futures-market.ts']?.()
  const accountModule = await futuresStoreLoaders['../stores/futures-account.ts']?.()
  const useFuturesMarket = marketModule?.useFuturesMarketStore
  const useFuturesAccount = accountModule?.useFuturesAccountStore
  if (typeof useFuturesMarket !== 'function' || typeof useFuturesAccount !== 'function') return
  futuresBooted = true
  const futuresMarket = (useFuturesMarket as () => FuturesMarketLike)()
  const futuresAccount = (useFuturesAccount as () => FuturesAccountLike)()
  futuresAccountStore.value = futuresAccount
  futuresMarketStore.value = futuresMarket
  await refreshFutures()
}

/** Contracts first (the account check needs one), then the account; a failure blocks transfers (fail closed). */
async function refreshFutures(): Promise<void> {
  const futuresMarket = futuresMarketStore.value
  const futuresAccount = futuresAccountStore.value
  if (futuresMarket === null || futuresAccount === null) return
  futuresBootError.value = null
  try {
    if (!futuresMarket.loaded) await futuresMarket.loadPublicInfo()
    if (!futuresMarket.loaded) throw new Error('futures contracts unavailable')
    await futuresAccount.refresh()
  } catch (error_) {
    // The futures panel renders its own error state from the store; the transfer gate shows this one.
    // Plain words (futures restarting, contract list unavailable …), never a raw code such as「接口返回错误码 -1」.
    futuresBootError.value = describeFuturesGateError(error_, requestLanguage(), sessionStore.isAuthenticated).text
  }
}

/** Futures open state for the transfer dialog; undefined (= blocked, fail closed) until the store is loaded. */
const futuresGate = computed<FuturesGate | undefined>(() => {
  const store = futuresAccountStore.value
  if (store === null) return undefined
  const bootFailed = futuresBootError.value !== null && store.open.status !== 'opened'
  return {
    status: bootFailed ? 'error' : store.open.status,
    error: bootFailed ? futuresBootError.value : store.open.error,
    initFailed: !bootFailed && store.open.initFailed,
    balanceError: store.assetsError,
    ensureOpened: (force?: boolean) => store.ensureOpened(force),
    refresh: () => refreshFutures(),
  }
})

const futuresBalance = computed(() => {
  const store = futuresAccountStore.value
  // futures→spot: the server's transferable amount (unrealized profit excluded), not 可用 (2026-09-29)
  return store === null || store.transferable === '' ? undefined : store.transferable
})

const { t } = useI18n({
  messages: {
    'zh-CN': { ...WALLET_MESSAGES['zh-CN'], ...ASSETS_EXTRA_MESSAGES['zh-CN'], ...INTERNAL_TRANSFER_MESSAGES['zh-CN'], ...ACCOUNT_MESSAGES['zh-CN'] },
    'en-US': { ...WALLET_MESSAGES['en-US'], ...ASSETS_EXTRA_MESSAGES['en-US'], ...INTERNAL_TRANSFER_MESSAGES['en-US'], ...ACCOUNT_MESSAGES['en-US'] },
  },
})
// Page title is the global nav key; the local scope would warn on every lookup.
const { t: gt } = useI18n({ useScope: 'global' })
const account = useAccountStore()
const margin = useMarginStore()
const market = useMarketStore()
const sessionStore = useSessionStore()

const active = ref<WalletTabId>('overview')
const coin = ref('')
/** Records tab opened from a flow shortcut lands on that kind. */
const recordsKind = ref<'deposit' | 'withdraw'>('deposit')
/** Address picked in the address book ("withdraw to this address"). */
const withdrawPrefill = ref('')
const transferOpen = ref(false)
const balancesPanel = ref<InstanceType<typeof BalancesPanel> | null>(null)
const transferSetup = ref<{ from: TransferAccount; to: TransferAccount; coin: string; symbol: string }>({ from: 'spot', to: 'margin', coin: 'USDT', symbol: '' })

const tabs = computed<WalletTab[]>(() => [
  { id: 'overview', label: t('wallet.tab.overview'), icon: Wallet },
  { id: 'spot', label: t('accounts.spot'), shortLabel: t('accounts.short.spot'), icon: Coins },
  ...(futuresShipped ? [{ id: 'futures', label: t('assetsExtra.tab.futures'), shortLabel: t('accounts.short.futures'), icon: FileChartLine }] : []),
  { id: 'margin', label: t('assetsExtra.tab.margin'), shortLabel: t('accounts.short.margin'), icon: Landmark },
  { id: 'ecosystem', label: t('accounts.ecosystem'), shortLabel: t('accounts.short.ecosystem'), icon: Sprout },
  { id: 'engine', label: t('accounts.engine'), shortLabel: t('accounts.short.engine'), icon: Cpu },
  { id: 'deposit', label: t('wallet.tab.deposit'), icon: ArrowDownToLine, action: true },
  { id: 'withdraw', label: t('wallet.tab.withdraw'), icon: ArrowUpFromLine, action: true },
  { id: 'records', label: t('wallet.tab.records'), icon: ClipboardList, action: true },
  { id: 'addressBook', label: t('wallet.tab.addressBook'), icon: BookUser, action: true },
  { id: 'internalTransfer', label: t('internalTransfer.title'), icon: ArrowLeftRight, action: true },
])

/** Phones: the action tabs (and 划转) as a row of icon buttons under the account tabs. */
const quickActions = computed(() => tabs.value.filter(tab => tab.id === 'deposit' || tab.id === 'withdraw'))
/** Less-used actions (records, address book, internal transfer) open from 更多. */
const moreActions = computed(() => tabs.value.filter(tab => tab.action === true && tab.id !== 'deposit' && tab.id !== 'withdraw'))
const moreOpen = ref(false)

const coins = computed(() => buildCoinRows(account.allCoinMap, market.publicInfo))

function selectTab(id: string): void {
  const next = TAB_IDS.find(entry => entry === id)
  if (next !== undefined && (next !== 'futures' || futuresShipped)) {
    active.value = next
    if (next === 'futures') void bootFutures()
  }
}

function openTransfer(setup: Partial<{ from: TransferAccount; to: TransferAccount; coin: string; symbol: string }> = {}): void {
  transferSetup.value = {
    from: setup.from ?? 'spot',
    to: setup.to ?? (active.value === 'futures' ? 'futures' : 'margin'),
    coin: setup.coin ?? 'USDT',
    symbol: setup.symbol ?? '',
  }
  transferOpen.value = true
  // The dialog offers the futures account whenever the futures module ships; load its balance for the max.
  void bootFutures()
}

function afterTransfer(): void {
  // The overview total includes futures and margin; reload them with spot, not spot alone (QA-072).
  if (balancesPanel.value !== null) void balancesPanel.value.reload()
  else void account.load()
  if (active.value === 'margin') void margin.loadOverview()
}

function openCoinFromOverview(next: string, action: 'deposit' | 'withdraw' = 'withdraw'): void {
  coin.value = next
  active.value = action
}

function openAddressBook(next: string): void {
  if (next !== '') coin.value = next
  active.value = 'addressBook'
}

function openRecords(kind: 'deposit' | 'withdraw'): void {
  recordsKind.value = kind
  active.value = 'records'
}

function withdrawTo(payload: { coin: string; address: string }): void {
  if (payload.coin !== '') coin.value = payload.coin
  withdrawPrefill.value = payload.address
  active.value = 'withdraw'
}

watch(active, (tab) => {
  // A prefilled address belongs to one visit of the withdraw tab only.
  if (tab !== 'withdraw') withdrawPrefill.value = ''
})

watch(coins, (rows) => {
  if (coin.value !== '' && rows.some(row => row.coin === coin.value)) {
    return
  }
  // Prefer a coin the wallet can actually move (deposit or withdraw open), funded first, so the
  // deposit/withdraw tabs do not open on a "closed" coin such as the synthetic BTC.
  const funded = (row: typeof rows[number]): boolean => row.available !== '' && row.available !== '0'
  const movable = (row: typeof rows[number]): boolean => row.depositOpen === true || row.withdrawOpen === true
  // USDT first when it can move (the coin most deposits and withdrawals use, as on Binance/OKX).
  const usdt = rows.find(row => row.coin === 'USDT' && movable(row))
  const next = (usdt ?? rows.find(row => movable(row) && funded(row)) ?? rows.find(movable) ?? rows.find(funded) ?? rows[0])?.coin ?? ''
  coin.value = next
}, { immediate: true })

onMounted(() => {
  if (market.publicInfo === null) {
    void market.loadPublicInfo().catch(() => {
      // The market store renders its own error; the wallet still works with balance data.
    })
  }
  if (sessionStore.isAuthenticated && account.data === null) {
    void account.load()
  }
})
</script>

<template>
  <section class="wallet stack">
    <header class="wallet-head">
      <div class="wallet-title-row">
        <h1 class="wallet-title">{{ gt('assets.title') }}</h1>
        <button v-if="sessionStore.isAuthenticated" class="btn transfer-action" type="button" data-testid="assets-transfer" @click="openTransfer()">
          <ArrowLeftRight :size="15" aria-hidden="true" />{{ t('assetsExtra.transfer') }}
        </button>
      </div>
      <WalletTabs :tabs="tabs" :active="active" @select="selectTab" />
      <nav v-if="sessionStore.isAuthenticated" class="quick-actions" :aria-label="t('accounts.quick')">
        <button v-for="tab in quickActions" :key="tab.id" class="quick-action" :class="{ active: tab.id === active }" type="button" :data-testid="`assets-quick-${tab.id}`" @click="selectTab(tab.id)">
          <span class="quick-icon"><component :is="tab.icon" :size="18" aria-hidden="true" /></span>
          <span class="quick-label">{{ tab.label }}</span>
        </button>
        <button class="quick-action" type="button" data-testid="assets-quick-transfer" @click="openTransfer()">
          <span class="quick-icon"><ArrowLeftRight :size="18" aria-hidden="true" /></span>
          <span class="quick-label">{{ t('assetsExtra.transfer') }}</span>
        </button>
        <button class="quick-action" :class="{ active: moreOpen }" type="button" :aria-expanded="moreOpen" data-testid="assets-quick-more" @click="moreOpen = !moreOpen">
          <span class="quick-icon"><Ellipsis :size="18" aria-hidden="true" /></span>
          <span class="quick-label">{{ t('accounts.more') }}</span>
        </button>
        <div v-if="moreOpen" class="quick-more">
          <button v-for="tab in moreActions" :key="tab.id" type="button" :class="{ active: tab.id === active }" :data-testid="`assets-quick-${tab.id}`" @click="selectTab(tab.id); moreOpen = false">
            <component :is="tab.icon" :size="15" aria-hidden="true" />{{ tab.label }}
          </button>
        </div>
      </nav>
    </header>

    <GuestGate v-if="!sessionStore.isAuthenticated" :message="t('wallet.notAuthenticated')" :icon="WalletIcon" />
    <template v-else>
      <div
        v-if="active === 'overview'"
        id="wallet-panel-overview"
        role="tabpanel"
        aria-labelledby="wallet-tab-overview"
      >
        <BalancesPanel ref="balancesPanel" @select="openCoinFromOverview" />
      </div>
      <div
        v-else-if="active === 'spot'"
        id="wallet-panel-spot"
        role="tabpanel"
        aria-labelledby="wallet-tab-spot"
      >
        <BalancesPanel ref="balancesPanel" scope="spot" @select="openCoinFromOverview" />
      </div>
      <div
        v-else-if="active === 'ecosystem'"
        id="wallet-panel-ecosystem"
        role="tabpanel"
        aria-labelledby="wallet-tab-ecosystem"
      >
        <EmptyAccountPanel :title="t('accounts.ecosystemTotal')" :description="t('accounts.ecosystemScope')" :empty-message="t('accounts.ecosystemEmpty')" />
      </div>
      <div
        v-else-if="active === 'engine'"
        id="wallet-panel-engine"
        role="tabpanel"
        aria-labelledby="wallet-tab-engine"
      >
        <EmptyAccountPanel :title="t('accounts.engineTotal')" :description="t('accounts.engineScope')" :empty-message="t('accounts.engineEmpty')" />
      </div>
      <div
        v-else-if="active === 'deposit'"
        id="wallet-panel-deposit"
        role="tabpanel"
        aria-labelledby="wallet-tab-deposit"
      >
        <DepositPanel v-model:coin="coin" :coins="coins" @open-records="openRecords" />
      </div>
      <div
        v-else-if="active === 'withdraw'"
        id="wallet-panel-withdraw"
        role="tabpanel"
        aria-labelledby="wallet-tab-withdraw"
      >
        <WithdrawPanel
          v-model:coin="coin"
          :coins="coins"
          :initial-address="withdrawPrefill"
          @open-address-book="openAddressBook"
          @open-records="openRecords"
        />
      </div>
      <div
        v-else-if="active === 'records'"
        id="wallet-panel-records"
        role="tabpanel"
        aria-labelledby="wallet-tab-records"
      >
        <RecordsPanel :coins="coins" :initial-kind="recordsKind" />
      </div>
      <div
        v-else-if="active === 'addressBook'"
        id="wallet-panel-addressBook"
        role="tabpanel"
        aria-labelledby="wallet-tab-addressBook"
      >
        <AddressBookPanel v-model:coin="coin" :coins="coins" @withdraw="withdrawTo" />
      </div>
      <div
        v-else-if="active === 'internalTransfer'"
        id="wallet-panel-internalTransfer"
        role="tabpanel"
        aria-labelledby="wallet-tab-internalTransfer"
      >
        <InternalTransferPanel :coin="coin" @submitted="afterTransfer" @transferred="afterTransfer" />
      </div>
      <div
        v-else-if="active === 'margin'"
        id="wallet-panel-margin"
        role="tabpanel"
        aria-labelledby="wallet-tab-margin"
      >
        <MarginAccountsPanel @transfer="payload => openTransfer({ from: 'spot', to: 'margin', coin: payload.coin, symbol: payload.symbol })" />
      </div>
      <div
        v-else-if="active === 'futures' && FuturesAccountPanel !== null"
        id="wallet-panel-futures"
        role="tabpanel"
        aria-labelledby="wallet-tab-futures"
      >
        <component :is="FuturesAccountPanel" />
      </div>
    </template>

    <TransferDialog
      v-model:open="transferOpen"
      :from="transferSetup.from"
      :to="transferSetup.to"
      :coin="transferSetup.coin"
      :marginSymbol="transferSetup.symbol"
      :futures-enabled="futuresShipped"
      :futures-available="futuresBalance"
      :futures-gate="futuresGate"
      @transferred="afterTransfer"
    />
  </section>
</template>

<style scoped>
.wallet {
  max-width: 1240px;
  margin: 0 auto;
  padding: 28px 24px 56px;
}

.wallet-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.wallet-head { gap: 16px; }
.wallet-title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.transfer-action { height: 38px; }
.quick-actions { display: none; }
@media (max-width: 720px) {
  .wallet { padding: 18px 14px 40px; }
  .wallet-title { font-size: 24px; }
  .transfer-action { display: none; }
  /* Total first, then the main actions, the account tabs, and the holdings (owner 2026-11-17). The header and
     the tab panel dissolve (display: contents) so their parts can be ordered beside the panel's own blocks. */
  .wallet { display: flex; flex-direction: column; gap: 14px; }
  .wallet-head, .wallet > [role='tabpanel'] { display: contents; }
  .wallet-title-row { display: none; }
  .quick-actions { order: 2; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .wallet-head :deep(.wallet-tabs) { order: 3; }
  .wallet > [role='tabpanel'] > :deep(*) { order: 4; }
  .quick-more { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
  .quick-more button { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-surface); color: var(--color-text-secondary); font-size: 12.5px; }
  .quick-more button.active { border-color: var(--color-accent); color: var(--color-accent-text); }
  .quick-action { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; padding: 4px 0; color: var(--color-text-secondary); }
  .quick-icon { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 14px; color: var(--color-accent-text); border: 1px solid color-mix(in srgb, var(--color-accent) 34%, var(--color-border)); background: radial-gradient(120% 90% at 22% 12%, color-mix(in srgb, var(--color-accent) 30%, transparent), transparent 62%), linear-gradient(160deg, var(--color-surface-alt), var(--color-surface)); box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 6px 14px -10px color-mix(in srgb, var(--color-accent) 80%, transparent); }
  .quick-action.active .quick-icon { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .quick-label { max-width: 100%; overflow: hidden; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
}
.wallet-title {
  margin: 0;
  font-size: 30px;
  font-weight: 750;
  letter-spacing: -0.02em;
}
</style>
