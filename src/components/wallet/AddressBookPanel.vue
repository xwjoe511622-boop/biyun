<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowUpFromLine, BookUser, Plus, RotateCw, Search, ShieldCheck, Trash2 } from '@lucide/vue'
import CodeField from './CodeField.vue'
import CopyButton from './CopyButton.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import DialogShell from '@/components/transfer/DialogShell.vue'
import { useLocalizedNotice } from '@/i18n/useLocalizedNotice'
import { session } from '@/core/session'
import {
  addWalletAddress,
  deleteWalletAddress,
  fetchAddressBook,
  sendAddressBookEmailCode,
  sendAddressBookSmsCode,
} from '@/modules/api/wallet.api'
import { coinMetaForBranch, defaultNetwork, type CoinRow } from '@/modules/wallet/coins'
import { checkWithdrawAddress, sameAddress } from '@/modules/wallet/evm'
import { describeWalletError } from '@/modules/wallet/errors'
import { useWalletI18n } from '@/modules/wallet/i18n'
import { groupAddressesByNetwork, networkChoicesForCoin, type AddressGroup } from '@/modules/wallet/networks'
import { addressListHasNetworks, joinAddressTag, normalizeUserSecurity } from '@/modules/wallet/normalize'
import type { WalletAddress } from '@/modules/wallet/types'
import { requiredAddressBookCodes, validateSecurityCodes } from '@/modules/wallet/withdraw'
import { applyEmailCodeSwitch, emailCodeRequired, requiredBookCodes, type WalletBackendShape } from '@/modules/wallet/withdrawMode'
import { useWalletNetworks } from '@/modules/wallet/useWalletNetworks'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

const props = withDefaults(defineProps<{ coin?: string; coins: CoinRow[] }>(), { coin: '' })
const emit = defineEmits<{
  (event: 'update:coin', coin: string): void
  (event: 'withdraw', payload: { coin: string; address: string }): void
}>()
const { t, locale } = useWalletI18n()

const market = useMarketStore()
const sessionStore = useSessionStore()
const { networks, ready: networksReady } = useWalletNetworks()

/** Panel-local copy that has no shared i18n key yet. */
const LOCAL_MESSAGES = {
  'zh-CN': {
    tagRequired: '该币种要求填写标签 / Memo，服务端地址校验会拒绝空标签',
    deleteUnconfirmed: '服务端返回成功，但该地址仍在地址簿中，未确认删除结果',
  },
  'en-US': {
    tagRequired: 'This coin requires a tag / memo; the server address check rejects an empty tag',
    deleteUnconfirmed: 'The server reported success but the address is still listed; the delete is not confirmed',
  },
} as const

function local(key: keyof (typeof LOCAL_MESSAGES)['en-US']): string {
  const bundle = locale.value.toLowerCase().startsWith('zh') ? LOCAL_MESSAGES['zh-CN'] : LOCAL_MESSAGES['en-US']
  return bundle[key]
}

const list = ref<WalletAddress[]>([])
const loading = ref(false)
const error = ref<(() => string) | null>(null)
const { text: notice, set: setNotice } = useLocalizedNotice()
const { text: dialogError, set: setDialogError } = useLocalizedNotice()
const pending = ref(false)
const search = ref('')

const addOpen = ref(false)
const optionId = ref('')
const address = ref('')
const tag = ref('')
const label = ref('')
const googleCode = ref('')
const smsValidCode = ref('')
const emailValidCode = ref('')
const deleteTarget = ref<WalletAddress | null>(null)
const cooldown = ref(0)
const codeChannel = ref<'sms' | 'email' | ''>('')
/** A code send is in flight; the button stays disabled so repeated clicks cannot duplicate it. */
const codePending = ref(false)

let controller: AbortController | null = null
let version = 0
/** Bumped on unmount / session change so a late add/delete/code result cannot repopulate the panel. */
let invalidation = 0
let stopSession: (() => void) | null = null
let cooldownTimer: ReturnType<typeof setInterval> | null = null

const authenticated = computed(() => sessionStore.isAuthenticated)
/** v2 when `addr/networks` answers or when any row carries `network`; historical per-coin otherwise. */
const shape = computed<WalletBackendShape>(() =>
  (networks.value !== null && networks.value.length > 0) || addressListHasNetworks(list.value) ? 'network' : 'legacy')

interface AddOption {
  id: string
  label: string
  /** Contract v2 network code or `''`. */
  network: string
  /** Historical `coinSymbol` (chain symbol) or `''`. */
  coinSymbol: string
  addressRegex: string
  tagRequired: boolean
}

/** v2: one option per network. Historical: one option per coin (and chain branch). */
const addOptions = computed<AddOption[]>(() => {
  if (shape.value === 'network' && networks.value !== null && networks.value.length > 0) {
    return networks.value.map(entry => ({
      id: `net:${entry.network}`,
      label: entry.coins.length > 0 ? `${entry.displayName} (${entry.coins.join(', ')})` : entry.displayName,
      network: entry.network,
      coinSymbol: '',
      addressRegex: entry.addressRegex,
      tagRequired: entry.needMemo,
    }))
  }
  return props.coins.flatMap((row) => {
    const choices = networkChoicesForCoin(market.publicInfo, row.coin, null)
    return choices.map(choice => ({
      id: `coin:${choice.requestSymbol}`,
      label: choices.length > 1 ? `${row.coin} · ${choice.label}` : row.coin,
      network: '',
      coinSymbol: choice.requestSymbol,
      addressRegex: '',
      tagRequired: coinMetaForBranch(market.publicInfo, row.coin, choice.requestSymbol === row.coin ? '' : choice.requestSymbol).tagType > 0,
    }))
  })
})
const option = computed(() => addOptions.value.find(entry => entry.id === optionId.value))

/** Preferred option for the current coin: its network (v2) or its default chain (historical). */
function preferredOption(): string {
  const options = addOptions.value
  const coin = props.coin.toUpperCase()
  if (shape.value === 'network') {
    const match = (networks.value ?? []).find(entry => entry.coins.includes(coin))
    return (match !== undefined ? `net:${match.network}` : options[0]?.id) ?? ''
  }
  if (coin !== '') {
    const branch = defaultNetwork(market.publicInfo, props.coin)
    if (options.some(entry => entry.id === `coin:${branch}`)) return `coin:${branch}`
  }
  return options[0]?.id ?? ''
}

const security = computed(() => normalizeUserSecurity(sessionStore.user))
const codeAction = computed<'add' | 'delete'>(() => (deleteTarget.value === null ? 'add' : 'delete'))
/** v2 rows are deleted with Google only; historical rows keep the legacy factor matrix. */
const rowShape = computed<WalletBackendShape>(() => {
  if (deleteTarget.value !== null) return (deleteTarget.value.network ?? '') !== '' ? 'network' : 'legacy'
  return option.value !== undefined && option.value.network !== '' ? 'network' : 'legacy'
})
const requirement = computed(() => applyEmailCodeSwitch(
  requiredBookCodes(codeAction.value, security.value, rowShape.value, action => requiredAddressBookCodes(security.value, action)),
  rowShape.value,
  emailCodeRequired(market.publicInfo),
))

const addressCheck = computed(() => checkWithdrawAddress(address.value, { addressRegex: option.value?.addressRegex ?? '' }))
const addressProblem = computed(() => {
  if (address.value.trim() === '' || addressCheck.value.ok || addressCheck.value.problem === null || addressCheck.value.problem === 'empty') return ''
  return t(`wallet.wd.addressError.${addressCheck.value.problem}`)
})
/** v2 labels are optional (§6.6); the historical `AddrAct` rejects an empty label. */
const labelMissing = computed(() => label.value.trim() === '' && (option.value?.network ?? '') === '')
const tagMissing = computed(() => option.value?.tagRequired === true && tag.value.trim() === '')

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase()
  if (needle === '') return list.value
  return list.value.filter(entry =>
    entry.label.toLowerCase().includes(needle) || entry.address.toLowerCase().includes(needle) || entry.coin.toLowerCase().includes(needle))
})
const groups = computed<AddressGroup[]>(() => groupAddressesByNetwork(filtered.value, networks.value))

function describe(error_: unknown): string {
  return describeWalletError(error_, key => t(key))
}

async function load(): Promise<void> {
  // Reads are only ever issued for an authenticated session.
  if (!authenticated.value) {
    list.value = []
    loading.value = false
    return
  }
  controller?.abort()
  const active = new AbortController()
  controller = active
  const current = ++version
  const requestToken = session.getToken()
  loading.value = true
  error.value = null
  try {
    // `{}` lists every row on both server generations (v2: all networks, historical: all coins).
    const next = await fetchAddressBook({}, { signal: active.signal })
    if (current !== version || session.getToken() !== requestToken) {
      return
    }
    list.value = next
  } catch (error_) {
    if (current !== version || session.getToken() !== requestToken) {
      return
    }
    list.value = []
    error.value = () => describe(error_)
  } finally {
    if (current === version) {
      loading.value = false
    }
  }
}

function startCooldown(): void {
  cooldown.value = 60
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
  }
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0 && cooldownTimer !== null) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }, 1000)
}

function wipeCodes(): void {
  googleCode.value = ''
  smsValidCode.value = ''
  emailValidCode.value = ''
}

/** Drops every sensitive draft, the pending flags and the cooldown timer. */
function resetSensitive(): void {
  address.value = ''
  tag.value = ''
  label.value = ''
  wipeCodes()
  deleteTarget.value = null
  addOpen.value = false
  pending.value = false
  codePending.value = false
  cooldown.value = 0
  codeChannel.value = ''
  dialogError.value = ''
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
}

/** Selection-scoped draft reset: an address/memo from one network must never survive a switch. */
function resetForSelection(): void {
  address.value = ''
  tag.value = ''
  wipeCodes()
  dialogError.value = ''
}

function openAdd(): void {
  deleteTarget.value = null
  notice.value = ''
  dialogError.value = ''
  if (optionId.value === '' || !addOptions.value.some(entry => entry.id === optionId.value)) {
    optionId.value = preferredOption()
  }
  addOpen.value = true
}

function closeAdd(): void {
  if (pending.value) return
  addOpen.value = false
  wipeCodes()
  dialogError.value = ''
}

function openDelete(entry: WalletAddress): void {
  addOpen.value = false
  wipeCodes()
  notice.value = ''
  dialogError.value = ''
  deleteTarget.value = entry
}

function closeDelete(): void {
  if (pending.value) return
  deleteTarget.value = null
  wipeCodes()
  dialogError.value = ''
}

async function requestCode(channel: 'sms' | 'email'): Promise<void> {
  if (cooldown.value > 0 || pending.value || codePending.value || !authenticated.value) {
    return
  }
  const token = invalidation
  const requestToken = session.getToken()
  codePending.value = true
  codeChannel.value = channel
  dialogError.value = ''
  try {
    // The address book uses its own legacy `v4/common/*` code endpoints (add: SMS 11 / email 13,
    // delete: SMS 21); the CIAO withdrawal code functions are a different namespace.
    if (channel === 'sms') {
      await sendAddressBookSmsCode(codeAction.value)
    } else {
      await sendAddressBookEmailCode()
    }
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    setNotice(() => t('wallet.withdraw.codeSent'))
    startCooldown()
  } catch (error_) {
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    setDialogError(() => describe(error_))
  } finally {
    if (token === invalidation) {
      codePending.value = false
    }
  }
}

function currentCodeErrors() {
  return validateSecurityCodes(
    { googleCode: googleCode.value, smsAuthCode: smsValidCode.value, emailValidCode: emailValidCode.value },
    requirement.value,
  )
}

const canAdd = computed(() =>
  !pending.value &&
  !codePending.value &&
  option.value !== undefined &&
  address.value.trim() !== '' &&
  addressCheck.value.ok &&
  !labelMissing.value &&
  !tagMissing.value)

async function submitAdd(): Promise<void> {
  const errors = currentCodeErrors()
  const selected = option.value
  const blankAddress = address.value.trim() === ''
  const securityUnknown = !authenticated.value || sessionStore.user === null || !security.value.known || !security.value.googleEnabled
  if (
    pending.value ||
    codePending.value ||
    selected === undefined ||
    blankAddress ||
    !addressCheck.value.ok ||
    labelMissing.value ||
    tagMissing.value ||
    errors.length > 0 ||
    securityUnknown
  ) {
    const firstError = errors[0]
    if (blankAddress) {
      setDialogError(() => t('wallet.withdraw.error.addressRequired'))
    } else if (addressCheck.value.problem !== null && addressCheck.value.problem !== 'empty') {
      const key = `wallet.wd.addressError.${addressCheck.value.problem}`
      setDialogError(() => t(key))
    } else if (labelMissing.value) {
      setDialogError(() => t('wallet.address.labelRequired'))
    } else if (tagMissing.value) {
      setDialogError(() => local('tagRequired'))
    } else if (securityUnknown) {
      setDialogError(() => t('wallet.withdraw.securityUnknown'))
    } else {
      setDialogError(() => firstError === undefined ? '' : t(firstError.key))
    }
    return
  }
  pending.value = true
  dialogError.value = ''
  notice.value = ''
  const token = invalidation
  const requestToken = session.getToken()
  try {
    const joinedAddress = joinAddressTag(address.value.trim(), tag.value.trim())
    const addedLabel = label.value.trim()
    const outcome = await addWalletAddress({
      coinSymbol: selected.coinSymbol,
      ...(selected.network !== '' ? { network: selected.network } : {}),
      address: joinedAddress,
      label: addedLabel,
      googleCode: googleCode.value.trim(),
      smsValidCode: smsValidCode.value.trim(),
      emailValidCode: emailValidCode.value.trim(),
    })
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    address.value = ''
    tag.value = ''
    label.value = ''
    wipeCodes()
    addOpen.value = false
    await load()
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    // A successful envelope is not proof the row exists: confirm against the reloaded list. v2 is
    // idempotent per (network, address), so an existing row with its original label also counts.
    // Historical rows must match coin + full address (incl. memo) + label exactly.
    const confirmed = selected.network !== ''
      ? list.value.some(entry => (entry.network ?? '') === selected.network && sameAddress(joinAddressTag(entry.address, entry.tag), joinedAddress))
      : list.value.some(
        entry =>
          entry.coin === selected.coinSymbol.toUpperCase() &&
          joinAddressTag(entry.address, entry.tag) === joinedAddress &&
          entry.label === addedLabel,
      )
    // A failed reload means "not confirmed"; success is never claimed unless the row is really there.
    const key = confirmed && error.value === null
      ? outcome?.created === false ? 'wallet.book.exists' : 'wallet.address.added'
      : 'wallet.address.addUnconfirmed'
    setNotice(() => t(key))
  } catch (error_) {
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    setDialogError(() => describe(error_))
    wipeCodes()
  } finally {
    if (token === invalidation) {
      pending.value = false
    }
  }
}

async function submitDelete(): Promise<void> {
  const target = deleteTarget.value
  const errors = currentCodeErrors()
  const securityUnknown = !authenticated.value || sessionStore.user === null || !security.value.known
  if (target === null || pending.value || codePending.value || errors.length > 0 || securityUnknown) {
    const firstError = errors[0]
    if (firstError !== undefined) {
      setDialogError(() => t(firstError.key))
    } else if (securityUnknown) {
      setDialogError(() => t('wallet.withdraw.securityUnknown'))
    }
    return
  }
  pending.value = true
  dialogError.value = ''
  notice.value = ''
  const token = invalidation
  const requestToken = session.getToken()
  const networkRow = (target.network ?? '') !== ''
  try {
    await deleteWalletAddress(
      [target.id],
      { googleCode: googleCode.value.trim(), smsValidCode: networkRow ? '' : smsValidCode.value.trim() },
      networkRow ? { network: true } : {},
    )
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    deleteTarget.value = null
    wipeCodes()
    await load()
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    // The envelope is not proof the row is gone: confirm against the reloaded list. A failed reload
    // (`error.value !== null`) is never reported as a successful delete.
    const removed = !list.value.some(entry => entry.id === target.id)
    if (removed && error.value === null) {
      setNotice(() => t('wallet.address.deleted'))
    } else {
      setNotice(() => local('deleteUnconfirmed'))
    }
  } catch (error_) {
    if (token !== invalidation || session.getToken() !== requestToken) {
      return
    }
    setDialogError(() => describe(error_))
    wipeCodes()
  } finally {
    if (token === invalidation) {
      pending.value = false
    }
  }
}

function useAddress(group: AddressGroup, entry: WalletAddress): void {
  const owned = props.coins.map(row => row.coin)
  const coin = group.network === ''
    ? entry.coin
    : group.coins.find(item => item === props.coin.toUpperCase()) ?? group.coins.find(item => owned.includes(item)) ?? props.coin
  emit('withdraw', { coin, address: entry.address })
}

function sendLabel(channel: 'sms' | 'email'): string {
  return cooldown.value > 0 && codeChannel.value === channel
    ? t('wallet.withdraw.resendIn', { seconds: cooldown.value })
    : t('wallet.withdraw.sendCode')
}

watch(
  () => props.coin,
  () => {
    optionId.value = preferredOption()
    resetForSelection()
  },
)

watch(optionId, () => {
  resetForSelection()
})

// The first answer of the network probe decides the option set; re-pick when it changes shape.
watch([networksReady, shape], () => {
  if (!addOptions.value.some(entry => entry.id === optionId.value)) optionId.value = preferredOption()
})

onMounted(() => {
  optionId.value = preferredOption()
  if (authenticated.value && sessionStore.user === null) {
    void sessionStore.loadUserInfo()
  }
  if (authenticated.value) {
    void load()
  }
  // A token change (logout, expiry, re-auth) invalidates every draft, row and pending action. A
  // profile refresh keeps the same token and must not clear the user's draft.
  let token = session.getToken()
  stopSession = session.onInvalidate((snapshot) => {
    if (snapshot.token === token) {
      return
    }
    token = snapshot.token
    invalidation += 1
    version += 1
    controller?.abort()
    controller = null
    list.value = []
    loading.value = false
    error.value = null
    notice.value = ''
    resetSensitive()
    if (snapshot.token !== null) {
      void load()
    }
  })
})

onBeforeUnmount(() => {
  invalidation += 1
  version += 1
  controller?.abort()
  stopSession?.()
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
  }
})
</script>

<template>
  <div class="book">
    <header class="book-head">
      <div class="book-intro">
        <h2 class="book-title"><BookUser :size="20" aria-hidden="true" />{{ t('wallet.book.title') }}</h2>
        <p class="book-sub">{{ shape === 'network' ? t('wallet.book.subtitle') : t('wallet.book.subtitleLegacy') }}</p>
      </div>
      <div class="book-tools">
        <label class="book-search">
          <Search :size="15" aria-hidden="true" />
          <input v-model="search" type="search" :aria-label="t('wallet.book.search')" :placeholder="t('wallet.book.search')" />
        </label>
        <button class="btn btn-ghost icon-only" type="button" :aria-label="t('common.refresh')" :title="t('common.refresh')" :disabled="loading" @click="load">
          <RotateCw :size="15" aria-hidden="true" />
        </button>
        <button class="btn btn-primary" type="button" :disabled="!authenticated" data-testid="book-add" @click="openAdd">
          <Plus :size="15" aria-hidden="true" />{{ t('wallet.book.add') }}
        </button>
      </div>
    </header>

    <p v-if="notice !== '' && !addOpen && deleteTarget === null" class="notice notice-info" role="status">{{ notice }}</p>

    <StateBlock v-if="error !== null" variant="error" :message="error()" retryable @retry="load" />
    <StateBlock v-else-if="loading && list.length === 0" variant="loading" :message="t('common.loading')" />
    <div v-else-if="list.length === 0" class="book-empty">
      <BookUser :size="30" aria-hidden="true" />
      <strong>{{ t('wallet.book.empty') }}</strong>
      <span>{{ t('wallet.book.emptyHint') }}</span>
      <button class="btn btn-primary" type="button" :disabled="!authenticated" @click="openAdd"><Plus :size="15" aria-hidden="true" />{{ t('wallet.book.add') }}</button>
    </div>
    <StateBlock v-else-if="groups.length === 0" variant="empty" :message="t('wallet.book.noMatch')" />
    <div v-else class="groups">
      <section v-for="group in groups" :key="group.key" class="group" :data-group="group.key">
        <header class="group-head">
          <div class="group-name">
            <h3>{{ group.title }}</h3>
            <span v-if="group.subtitle !== '' && group.subtitle !== group.title" class="chip mono">{{ group.subtitle }}</span>
            <span v-if="group.network === ''" class="chip legacy">{{ t('wallet.book.legacyGroup') }}</span>
          </div>
          <span class="group-meta">
            <template v-if="group.network !== '' && group.coins.length > 0">{{ t('wallet.book.coinsOnNetwork', { coins: group.coins.join(' / ') }) }} · </template>{{ t('wallet.book.count', group.entries.length) }}
          </span>
        </header>
        <ul class="rows">
          <li v-for="entry in group.entries" :key="entry.id" class="row-item" :data-address-id="entry.id">
            <div class="row-main">
              <div class="row-top">
                <span class="row-label">{{ entry.label || '--' }}</span>
                <span v-if="group.network !== ''" class="verified"><ShieldCheck :size="12" aria-hidden="true" />{{ t('wallet.wd.verifiedBadge') }}</span>
              </div>
              <div class="row-addr">
                <span class="num">{{ entry.address }}{{ entry.tag !== '' ? ` / ${entry.tag}` : '' }}</span>
                <CopyButton :value="entry.address" compact />
              </div>
              <div v-if="entry.createdAt !== undefined || entry.lastUsedAt !== undefined" class="row-meta">
                <span v-if="entry.createdAt !== undefined">{{ t('wallet.book.added', { time: entry.createdAt }) }}</span>
                <span v-if="entry.lastUsedAt !== undefined">{{ t('wallet.book.lastUsed', { time: entry.lastUsedAt }) }}</span>
              </div>
            </div>
            <div class="row-actions">
              <button class="btn btn-ghost small" type="button" @click="useAddress(group, entry)">
                <ArrowUpFromLine :size="14" aria-hidden="true" /><span class="hide-sm">{{ t('wallet.book.use') }}</span>
              </button>
              <button class="btn btn-ghost small danger" type="button" :aria-label="`${t('wallet.book.delete')} ${entry.label}`" @click="openDelete(entry)">
                <Trash2 :size="14" aria-hidden="true" /><span class="hide-sm">{{ t('wallet.book.delete') }}</span>
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <DialogShell :open="addOpen" :title="t('wallet.book.addTitle')" width="480px" :close-label="t('wallet.flow.close')" @close="closeAdd">
      <p class="dialog-hint"><ShieldCheck :size="14" aria-hidden="true" />{{ shape === 'network' ? t(emailCodeRequired(market.publicInfo) ? 'wallet.book.addHint' : 'wallet.book.addHintGoogle') : t('wallet.address.securityHint') }}</p>
      <label class="field">
        <span class="field-label">{{ shape === 'network' ? t('wallet.book.network') : t('wallet.address.coin') }}</span>
        <span class="field-input">
          <select v-model="optionId" :aria-label="t('wallet.network')" :disabled="pending">
            <option v-for="entry in addOptions" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
          </select>
        </span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('wallet.address.address') }}</span>
        <span class="field-input" :class="{ invalid: addressProblem !== '' }">
          <input v-model="address" class="num mono-input" spellcheck="false" autocomplete="off" :aria-label="t('wallet.address.address')" :disabled="pending" />
        </span>
        <span v-if="addressProblem !== ''" class="field-error">{{ addressProblem }}</span>
        <span v-else-if="addressCheck.ok && addressCheck.checksummed" class="field-ok">{{ t('wallet.wd.checksumOk') }}</span>
      </label>
      <label v-if="option?.tagRequired" class="field">
        <span class="field-label">{{ t('wallet.address.tag') }}</span>
        <span class="field-input"><input v-model="tag" :aria-label="t('wallet.address.tag')" :disabled="pending" /></span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('wallet.address.label') }}</span>
        <span class="field-input"><input v-model="label" maxlength="40" :aria-label="t('wallet.address.label')" :placeholder="t('wallet.wd.saveLabelPlaceholder')" :disabled="pending" /></span>
      </label>
      <CodeField v-if="requirement.google" v-model="googleCode" :label="t('wallet.withdraw.googleCode')" :disabled="pending" />
      <CodeField
        v-if="requirement.email"
        v-model="emailValidCode"
        :label="t('wallet.withdraw.emailCode')"
        sendable
        :send-label="sendLabel('email')"
        :can-send="cooldown === 0 && !codePending && !pending"
        :disabled="pending"
        @send="requestCode('email')"
      />
      <CodeField
        v-if="requirement.sms"
        v-model="smsValidCode"
        :label="t('wallet.withdraw.smsCode')"
        sendable
        :send-label="sendLabel('sms')"
        :can-send="cooldown === 0 && !codePending && !pending"
        :disabled="pending"
        @send="requestCode('sms')"
      />
      <p v-if="dialogError !== ''" class="notice notice-error" role="alert">{{ dialogError }}</p>
      <p v-else-if="notice !== ''" class="notice notice-info" role="status">{{ notice }}</p>
      <template #footer>
        <button class="btn" type="button" :disabled="pending" @click="closeAdd">{{ t('wallet.book.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="!canAdd" data-testid="book-save" @click="submitAdd">{{ t('wallet.book.save') }}</button>
      </template>
    </DialogShell>

    <DialogShell :open="deleteTarget !== null" :title="t('wallet.book.deleteTitle')" width="440px" :close-label="t('wallet.flow.close')" @close="closeDelete">
      <template v-if="deleteTarget !== null">
        <div class="delete-card">
          <strong>{{ deleteTarget.label || '--' }}</strong>
          <span class="num">{{ deleteTarget.address }}{{ deleteTarget.tag !== '' ? ` / ${deleteTarget.tag}` : '' }}</span>
        </div>
        <p class="dialog-hint warn">{{ t('wallet.book.deleteBody') }}</p>
        <CodeField v-if="requirement.google" v-model="googleCode" :label="t('wallet.withdraw.googleCode')" :disabled="pending" />
        <CodeField
          v-if="requirement.sms"
          v-model="smsValidCode"
          :label="t('wallet.withdraw.smsCode')"
          sendable
          :send-label="sendLabel('sms')"
          :can-send="cooldown === 0 && !codePending && !pending"
          :disabled="pending"
          @send="requestCode('sms')"
        />
        <p v-if="dialogError !== ''" class="notice notice-error" role="alert">{{ dialogError }}</p>
        <p v-else-if="notice !== ''" class="notice notice-info" role="status">{{ notice }}</p>
      </template>
      <template #footer>
        <button class="btn" type="button" :disabled="pending" @click="closeDelete">{{ t('wallet.book.cancel') }}</button>
        <button class="btn btn-sell" type="button" :disabled="pending" data-testid="book-delete-confirm" @click="submitDelete">{{ t('wallet.book.deleteConfirm') }}</button>
      </template>
    </DialogShell>
  </div>
</template>

<style scoped>
.book { display: flex; flex-direction: column; gap: 16px; padding: 22px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.book-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 14px; }
.book-intro { max-width: 620px; }
.book-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 18px; font-weight: 750; }
.book-sub { margin: 6px 0 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.55; }
.book-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.book-search {
  display: flex; align-items: center; gap: 8px; height: 38px; width: 240px; padding: 0 12px;
  border: 1px solid var(--color-border-strong); border-radius: 8px; background: var(--color-surface-alt); color: var(--color-text-muted);
}
.book-search:focus-within { border-color: var(--color-accent); }
.book-search input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 13px; }
.icon-only { width: 38px; padding: 0; }

.book-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 16px; color: var(--color-text-muted); text-align: center; }
.book-empty strong { color: var(--color-text); font-size: 15px; }
.book-empty span { font-size: 13px; }
.book-empty .btn { margin-top: 8px; }

.groups { display: flex; flex-direction: column; gap: 16px; }
.group { border: 1px solid var(--color-border); border-radius: 12px; overflow: hidden; }
.group-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; background: var(--color-surface-alt); border-bottom: 1px solid var(--color-border); }
.group-name { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.group-name h3 { margin: 0; font-size: 14.5px; font-weight: 700; }
.chip.mono { font-family: var(--font-mono); letter-spacing: 0.04em; }
.chip.legacy { color: var(--color-warning); background: var(--color-warning-soft); border-color: transparent; }
.group-meta { color: var(--color-text-muted); font-size: 12px; }
.rows { margin: 0; padding: 0; list-style: none; }
.row-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--color-border); }
.row-item:last-child { border-bottom: 0; }
.row-item:hover { background: var(--color-hover); }
.row-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.row-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.row-label { font-size: 14px; font-weight: 700; }
.verified { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--color-up-soft); color: var(--color-up); font-size: 10.5px; font-weight: 650; }
.row-addr { display: flex; align-items: center; gap: 4px; min-width: 0; }
.row-addr .num { white-space: normal; font-family: var(--font-mono); font-size: 13px; color: var(--color-text-secondary); word-break: break-all; }
.row-meta { display: flex; flex-wrap: wrap; gap: 12px; color: var(--color-text-muted); font-size: 11.5px; }
.row-actions { display: flex; flex: 0 0 auto; gap: 4px; }
.small { height: 32px; padding: 0 10px; font-size: 12.5px; }
.danger { color: var(--color-down); }
.danger:hover:not(:disabled) { color: var(--color-down); background: var(--color-down-soft); }

.dialog-hint { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: var(--color-text-secondary); font-size: 12.5px; line-height: 1.5; }
.dialog-hint :deep(svg) { flex: 0 0 auto; margin-top: 2px; color: var(--color-up); }
.dialog-hint.warn { color: var(--color-warning); }
.mono-input { font-family: var(--font-mono) !important; font-size: 13.5px !important; }
.field-ok { color: var(--color-up); font-size: 12px; }
.delete-card { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; background: var(--color-surface-alt); }
.delete-card .num { white-space: normal; font-family: var(--font-mono); font-size: 12.5px; color: var(--color-text-secondary); word-break: break-all; }

@media (max-width: 720px) {
  .book { padding: 16px 14px; }
  .book-tools { width: 100%; }
  .book-search { flex: 1 1 auto; width: auto; }
  .row-item { flex-direction: column; align-items: stretch; gap: 10px; }
  .row-actions { justify-content: flex-end; }
}
@media (max-width: 520px) {
  .hide-sm { display: none; }
}
</style>
