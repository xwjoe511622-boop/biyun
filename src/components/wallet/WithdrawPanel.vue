<script setup lang="ts">
import { i18n } from '@/i18n/composer'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BookUser, CircleCheck, CircleAlert, RotateCw, ShieldCheck, TriangleAlert } from '@lucide/vue'
import CoinPicker from './CoinPicker.vue'
import NetworkPicker from './NetworkPicker.vue'
import RecentRecords from './RecentRecords.vue'
import WalletStep from './WalletStep.vue'
import WithdrawAddressInput from './WithdrawAddressInput.vue'
import WithdrawConfirmDialog from './WithdrawConfirmDialog.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { isWalletGatewayConfigured } from '@/config/endpoints'
import { session } from '@/core/session'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { availableBalance, findCoinBalance } from '@/modules/market/symbols'
import { fetchAddressBook, fetchWithdrawConfig, sendEmailCode, sendSmsCode, submitWithdrawal } from '@/modules/api/wallet.api'
import { coinMetaForBranch, defaultNetwork, type CoinRow } from '@/modules/wallet/coins'
import { checkWithdrawAddress, type AddressCheck } from '@/modules/wallet/evm'
import { describeWalletError } from '@/modules/wallet/errors'
import { useWalletI18n } from '@/modules/wallet/i18n'
import { networkChoicesForCoin, savedAddressesFor, supportedCoins } from '@/modules/wallet/networks'
import { normalizeUserSecurity } from '@/modules/wallet/normalize'
import type { WalletAddress, WithdrawConfig, WithdrawSubmitPayload } from '@/modules/wallet/types'
import { validateSecurityCodes, validateWithdrawDraft, type WithdrawFieldError } from '@/modules/wallet/withdraw'
import {
  applyEmailCodeSwitch,
  approvalHint,
  directWithdrawSupported,
  emailCodeRequired,
  maxGrossAmount,
  receiveAmount,
  requiredWithdrawCodes,
  resolveWithdrawTarget,
  type ApprovalHint,
  type WalletBackendShape,
} from '@/modules/wallet/withdrawMode'
import { useWalletNetworks } from '@/modules/wallet/useWalletNetworks'
import { useAccountStore } from '@/stores/account'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

const props = withDefaults(defineProps<{ coin: string; coins: CoinRow[]; initialAddress?: string }>(), { initialAddress: '' })
const emit = defineEmits<{
  (event: 'update:coin', coin: string): void
  (event: 'openAddressBook', coin: string): void
  (event: 'openRecords', kind: 'deposit' | 'withdraw'): void
}>()

const { t } = useWalletI18n()
const account = useAccountStore()
const market = useMarketStore()
const sessionStore = useSessionStore()
const { networks, ready: networksReady } = useWalletNetworks()

const choiceId = ref('')
const config = ref<WithdrawConfig | null>(null)
const book = ref<WalletAddress[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const addressText = ref('')
const addressTouched = ref(false)
const amount = ref('')
const googleCode = ref('')
const smsAuthCode = ref('')
const emailValidCode = ref('')
const saveToBook = ref(false)
const saveLabel = ref('')
const review = ref(false)
const showErrors = ref(false)
/** Set by the confirm click; code errors stay hidden until then. */
const confirmAttempted = ref(false)
const pending = ref(false)
const submitError = ref<string | null>(null)
const notice = ref<string | null>(null)
const cooldown = ref(0)
const codeChannel = ref<'sms' | 'email' | ''>('')
const codePending = ref(false)
const recentKey = ref(0)

/**
 * Idempotency key of the current review draft. Minted **once** when the draft is created and reused
 * verbatim for every retry (a network timeout must never mint a new one). Cleared whenever the draft
 * changes (coin / network / address / amount / fee), is closed, succeeds, or the session changes —
 * the next review mints a fresh key.
 */
const requestId = ref('')

/** RFC 4122 id from the platform CSPRNG; the shape is validated again in `buildWithdrawRequestBody`. */
function newRequestId(): string {
  const c = globalThis.crypto
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error(i18n.global.t('orderDisplay.secureRandomnessIsUnavailableAWithdrawalRequestIdCould'))
}

interface WithdrawResult {
  withdrawId: string
  amount: string
  receive: string
  address: string
  approval: ApprovalHint
  saved: boolean
}
const result = ref<WithdrawResult | null>(null)

let codeGeneration = 0
let controller: AbortController | null = null
let version = 0
let stopSession: (() => void) | null = null
let cooldownTimer: ReturnType<typeof setInterval> | null = null
/** Bumped by unmount / session change so stale mutation results are discarded. */
let invalidation = 0
/** Last coin + request symbol + network we loaded a config for. */
let activeSelection = ''
/** Address handed over by the address book; applied once the selection has settled. */
let pendingPrefill = ''

/**
 * Coins offered in the picker. With the authoritative server directory only supported coins are listed and
 * the current coin is **not** re-added; balances stay untouched. With `null` the legacy `withdrawOpen`
 * filter keeps the current coin visible.
 */
const withdrawCoins = computed(() => {
  const supported = supportedCoins(networks.value)
  if (supported !== null) {
    return props.coins.filter(row => supported.has(row.coin.toUpperCase()))
  }
  return props.coins.filter(row => row.withdrawOpen !== false || row.coin === props.coin)
})
const choices = computed(() => networkChoicesForCoin(market.publicInfo, props.coin, networks.value))
const choice = computed(() => choices.value.find(entry => entry.id === choiceId.value))
const requestSymbol = computed(() => choice.value?.requestSymbol ?? props.coin)
/** Contract v2 network: from `addr/networks`, else from a v2 config answer. `''` = historical backend. */
const effectiveNetwork = computed(() => {
  const fromChoice = choice.value?.network ?? ''
  return fromChoice !== '' ? fromChoice : config.value?.network ?? ''
})
const shape = computed<WalletBackendShape>(() => (effectiveNetwork.value !== '' ? 'network' : 'legacy'))
// Short codes (`BSC`) read well; a self-hosted wallet key (`ETHEREUM-MAINNET`) gives way to the display name.
const networkLabel = computed(() => (effectiveNetwork.value !== '' && !effectiveNetwork.value.includes('-') ? effectiveNetwork.value : choice.value?.label ?? (effectiveNetwork.value !== '' ? effectiveNetwork.value : props.coin)))
const meta = computed(() => coinMetaForBranch(market.publicInfo, props.coin, requestSymbol.value === props.coin ? '' : requestSymbol.value))
/** v2 `precision` from the config wins; otherwise the coin's display precision. */
const precision = computed(() => config.value?.precision ?? meta.value.showPrecision)

const balanceEntry = computed(() => findCoinBalance(account.allCoinMap, props.coin))
const available = computed(() => availableBalance(balanceEntry.value))

/** `withdraw_max_day` from the balance snapshot; the v2 `dailyRemaining` wins when reported. */
const dailyRemaining = computed(() => {
  const fromConfig = config.value?.dailyRemaining
  if (fromConfig !== undefined && fromConfig !== '') return fromConfig
  const entry = balanceEntry.value as Record<string, unknown> | undefined
  const raw = entry?.withdraw_max_day
  const value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : ''
  return isDecimalString(value) ? value : ''
})

/**
 * Withdrawal availability. The v2 config's explicit boolean wins when reported; otherwise the legacy
 * `account.withdrawOpen` balance flag is used (and `null` = unknown, kept as-is).
 */
const withdrawOpen = computed<boolean | null>(() => {
  if (config.value?.withdrawOpen === true || config.value?.withdrawOpen === false) {
    return config.value.withdrawOpen
  }
  const raw = balanceEntry.value?.withdrawOpen
  if (raw === undefined || raw === null) {
    return null
  }
  const value = String(raw).trim()
  return value === '0' ? false : value === '1' ? true : null
})

const kycRequired = computed(() => {
  const info = market.publicInfo as unknown as Record<string, unknown> | null
  const kyc = info?.kycLimitConfig
  if (kyc === null || kyc === undefined || typeof kyc !== 'object') {
    return false
  }
  const raw = (kyc as Record<string, unknown>).withdraw_kyc_open
  return String(raw ?? '0').trim() !== '0'
})

const security = computed(() => normalizeUserSecurity(sessionStore.user))
const gatewayConfigured = computed(() => isWalletGatewayConfigured())
const authenticated = computed(() => sessionStore.isAuthenticated)
const balanceLoaded = computed(() => balanceEntry.value !== undefined && available.value !== '')

/**
 * Everything that stops a withdrawal. Unknown states block instead of behaving as "allowed":
 * an unreported `withdrawOpen` or an unreported `googleStatus` is never treated as "off/disabled".
 */
const blockedReason = computed<string>(() => {
  if (!gatewayConfigured.value) {
    return t('wallet.withdraw.gatewayUnavailable')
  }
  if (withdrawOpen.value === false) {
    return t('wallet.state.withdrawClosed')
  }
  if (withdrawOpen.value === null) {
    return t('wallet.withdraw.flagUnknown')
  }
  if (kycRequired.value && sessionStore.user !== null && security.value.authLevel !== 1) {
    return t('wallet.withdraw.kycRequired')
  }
  if (!security.value.known) {
    return t('wallet.withdraw.securityUnknown')
  }
  if (!security.value.googleEnabled) {
    return t('wallet.withdraw.googleUnavailable')
  }
  return ''
})

/** Saved addresses for the selected network (v2) or, historically, the coin's `Getcost` list. */
const savedList = computed<WalletAddress[]>(() => {
  if (effectiveNetwork.value !== '' && choice.value !== undefined) {
    return savedAddressesFor(book.value, { ...choice.value, network: effectiveNetwork.value })
  }
  return config.value?.addresses ?? []
})
const target = computed(() => resolveWithdrawTarget(addressText.value, savedList.value))
const mode = computed(() => (target.value.mode === 'direct' ? 'direct' : 'saved'))
const addressCheck = computed<AddressCheck>(() => {
  if (target.value.mode === 'saved') return { ok: true, problem: null, evm: false, checksummed: false }
  return checkWithdrawAddress(addressText.value, { addressRegex: choice.value?.addressRegex ?? '' })
})
const directBlocked = computed(() => target.value.mode === 'direct' && !directWithdrawSupported(shape.value))
const addressProblem = computed(() => {
  if (target.value.mode === 'none' || addressCheck.value.ok) return ''
  return addressCheck.value.problem === null || addressCheck.value.problem === 'empty' ? '' : t(`wallet.wd.addressError.${addressCheck.value.problem}`)
})
const showAddressProblem = computed(() => addressProblem.value !== '' && (addressTouched.value || showErrors.value || addressText.value.trim().length >= 42))
const requirement = computed(() =>
  applyEmailCodeSwitch(requiredWithdrawCodes(mode.value, security.value, shape.value), shape.value, emailCodeRequired(market.publicInfo)))

const fee = computed(() => config.value?.defaultFee ?? '')
const emptyConfig = computed<WithdrawConfig>(() => ({
  coin: props.coin, feeMin: '', feeMax: '', withdrawMin: '', withdrawMax: '', defaultFee: '', chainTip: '', addresses: [],
}))
const validation = computed(() =>
  validateWithdrawDraft(
    {
      addressId: target.value.mode === 'none' ? '' : target.value.mode === 'saved' ? target.value.entry.id : 'direct',
      amount: amount.value,
      fee: fee.value,
    },
    {
      config: config.value ?? emptyConfig.value,
      available: available.value,
      dayMax: dailyRemaining.value,
      precision: precision.value,
    },
  ),
)
const receive = computed(() => receiveAmount(amount.value, fee.value))
const canSaveToBook = computed(() => mode.value === 'direct' && shape.value === 'network')
/** §6.3: only address-book destinations (or a new address saved with this submission) can auto-approve. */
const approvalEligible = computed(() => shape.value === 'legacy' || mode.value === 'saved' || (canSaveToBook.value && saveToBook.value))
const approval = computed(() => approvalHint(receive.value, config.value?.autoApprovalThreshold, approvalEligible.value))
const maxAmount = computed(() => maxGrossAmount({
  available: available.value,
  fee: fee.value,
  withdrawMax: config.value?.withdrawMax ?? '',
  dailyRemaining: dailyRemaining.value,
  precision: precision.value,
}))

const codeErrors = computed<WithdrawFieldError[]>(() =>
  validateSecurityCodes(
    { googleCode: googleCode.value, smsAuthCode: smsAuthCode.value, emailValidCode: emailValidCode.value },
    requirement.value,
  ),
)
const amountErrors = computed(() => validation.value.errors.filter(entry => entry.field === 'amount' || entry.field === 'fee'))
/** Amount problems are shown live once something is typed, and on the submit attempt otherwise. */
const visibleAmountError = computed(() => {
  if (!showErrors.value && amount.value.trim() === '') return ''
  const first = amountErrors.value[0]
  return first === undefined ? '' : t(first.key, first.params ?? {})
})
const addressMissing = computed(() => showErrors.value && target.value.mode === 'none')

/** v2 labels are optional (§6.6), so saving never blocks on an empty label. */
const saveLabelMissing = computed(() => false)

const canReview = computed(
  () =>
    !pending.value &&
    blockedReason.value === '' &&
    config.value !== null &&
    validation.value.ok &&
    addressCheck.value.ok &&
    !directBlocked.value,
)

/**
 * The single submission gate. It mirrors every precondition the server contract needs; if any of
 * them is unknown, `canSubmit` is false and no request is ever built.
 */
const canSubmit = computed(
  () =>
    !pending.value &&
    review.value &&
    gatewayConfigured.value &&
    authenticated.value &&
    sessionStore.user !== null &&
    security.value.known &&
    security.value.googleEnabled &&
    config.value !== null &&
    balanceLoaded.value &&
    withdrawOpen.value === true &&
    target.value.mode !== 'none' &&
    addressCheck.value.ok &&
    !directBlocked.value &&
    blockedReason.value === '' &&
    validation.value.ok &&
    !saveLabelMissing.value &&
    codeErrors.value.length === 0,
)

const addressStatus = computed<{ tone: 'ok' | 'info' | 'warn' | 'bad'; text: string } | null>(() => {
  if (target.value.mode === 'none') return null
  if (showAddressProblem.value) return { tone: 'bad', text: addressProblem.value }
  if (target.value.mode === 'saved') {
    return { tone: 'ok', text: shape.value === 'network' ? t('wallet.wd.modeSaved') : t('wallet.wd.modeSavedLegacy') }
  }
  if (directBlocked.value) return { tone: 'warn', text: t('wallet.wd.directUnsupported') }
  if (!addressCheck.value.ok) return null
  const key = requirement.value.sms ? 'modeDirectSms' : requirement.value.email ? 'modeDirect' : 'modeDirectGoogle'
  return { tone: 'info', text: t(`wallet.wd.${key}`) }
})

function describe(error_: unknown): string {
  return describeWalletError(error_, key => t(key))
}

function abort(): void {
  controller?.abort()
  controller = null
}

function wipeCodes(): void {
  googleCode.value = ''
  smsAuthCode.value = ''
  emailValidCode.value = ''
}

function resetDraft(): void {
  addressText.value = ''
  addressTouched.value = false
  amount.value = ''
  saveToBook.value = false
  saveLabel.value = ''
  wipeCodes()
  review.value = false
  showErrors.value = false
  submitError.value = null
  requestId.value = ''
}

function resetCodeRequest(): void {
  codeGeneration += 1
  codePending.value = false
  cooldown.value = 0
  if (cooldownTimer !== null) clearInterval(cooldownTimer)
  cooldownTimer = null
}

/**
 * Network/coin switch housekeeping: drop every value that belongs to the previous chain, including
 * the typed address (which must never be reused on a different network) and the review state.
 * The typed amount is kept because it is chain-independent.
 */
function resetForNetwork(): void {
  resetCodeRequest()
  abort()
  version += 1
  activeSelection = ''
  config.value = null
  book.value = []
  error.value = null
  addressText.value = ''
  addressTouched.value = false
  saveToBook.value = false
  saveLabel.value = ''
  review.value = false
  showErrors.value = false
  submitError.value = null
  notice.value = null
  wipeCodes()
  requestId.value = ''
}

async function loadConfig(): Promise<void> {
  if (!sessionStore.isAuthenticated || props.coin === '' || choice.value === undefined) {
    return
  }
  abort()
  const current = ++version
  const active = new AbortController()
  controller = active
  loading.value = true
  error.value = null
  const network = choice.value.network
  try {
    const next = await fetchWithdrawConfig(requestSymbol.value, network === '' ? { signal: active.signal } : { signal: active.signal, network })
    if (current !== version) {
      return
    }
    config.value = next
    const resolvedNetwork = network !== '' ? network : next.network ?? ''
    if (resolvedNetwork !== '') {
      // v2: the book is per network; one read covers every coin of that network.
      const list = await fetchAddressBook({ network: resolvedNetwork }, { signal: active.signal }).catch(() => [] as WalletAddress[])
      if (current !== version) return
      book.value = list
    }
  } catch (error_) {
    if (current !== version) {
      return
    }
    config.value = null
    error.value = describe(error_)
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

async function requestCode(channel: 'sms' | 'email'): Promise<void> {
  if (cooldown.value > 0 || pending.value || codePending.value || !authenticated.value || blockedReason.value !== '') {
    return
  }
  const generation = ++codeGeneration
  const token = session.getToken()
  const current = () => generation === codeGeneration && token === session.getToken()
  codePending.value = true
  codeChannel.value = channel
  notice.value = null
  submitError.value = null
  try {
    // Withdrawal codes come from the wallet `validCode/*` endpoint the withdraw service consumes.
    if (channel === 'sms') {
      await sendSmsCode()
    } else {
      await sendEmailCode()
    }
    if (!current()) return
    notice.value = t('wallet.withdraw.codeSent')
    startCooldown()
  } catch (error_) {
    if (current()) submitError.value = describe(error_)
  } finally {
    if (current()) codePending.value = false
  }
}

function openReview(): void {
  showErrors.value = true
  addressTouched.value = true
  if (!canReview.value) {
    return
  }
  submitError.value = null
  notice.value = null
  confirmAttempted.value = false
  // One idempotency key per reviewed draft; reused by every retry of this draft.
  if (requestId.value === '') requestId.value = newRequestId()
  review.value = true
}

function closeReview(): void {
  if (pending.value) return
  review.value = false
  // Dismissing and reopening an unchanged draft must keep its idempotency key after a timeout.
  wipeCodes()
}

/** The only place a withdrawal request is ever sent. */
async function confirmSubmit(): Promise<void> {
  showErrors.value = true
  confirmAttempted.value = true
  const currentTarget = target.value
  if (!canSubmit.value || config.value === null || currentTarget.mode === 'none') {
    return
  }
  const token = invalidation
  pending.value = true
  submitError.value = null
  notice.value = null
  if (requestId.value === '') {
    // Defensive: the review should have minted it; never send a blank idempotency key.
    requestId.value = newRequestId()
  }
  const network = effectiveNetwork.value
  const saving = canSaveToBook.value && saveToBook.value
  const payload: WithdrawSubmitPayload = {
    // Same key for every retry of this draft; the server refuses a duplicate requestId.
    requestId: requestId.value,
    symbol: requestSymbol.value,
    addressId: currentTarget.mode === 'saved' ? currentTarget.entry.id : '',
    // The ledger derives payAmount = amount - fee server-side, so POST the gross amount.
    amount: amount.value.trim(),
    fee: validation.value.fee,
    googleCode: googleCode.value.trim(),
    smsAuthCode: requirement.value.sms ? smsAuthCode.value.trim() : '',
    emailValidCode: requirement.value.email ? emailValidCode.value.trim() : '',
  }
  if (network !== '') payload.network = network
  if (currentTarget.mode === 'direct') {
    payload.address = currentTarget.address
    if (saving) {
      payload.saveAddress = true
      payload.label = saveLabel.value.trim()
    }
  }
  const summary: WithdrawResult = {
    withdrawId: '',
    amount: amount.value.trim(),
    receive: receive.value,
    address: currentTarget.mode === 'saved' ? currentTarget.entry.address : currentTarget.address,
    approval: approval.value,
    saved: saving,
  }
  try {
    const withdrawId = await submitWithdrawal(payload)
    if (token !== invalidation) {
      // The session changed or the panel unmounted while the request was in flight: never
      // repopulate the UI and never trigger follow-up reads.
      return
    }
    result.value = { ...summary, withdrawId: typeof withdrawId === 'string' ? withdrawId : '' }
    notice.value = t('wallet.withdraw.submitted')
    resetDraft()
    recentKey.value += 1
    await Promise.all([account.load(), saving ? loadConfig() : Promise.resolve()])
  } catch (error_) {
    if (token !== invalidation) {
      return
    }
    // Keep the draft so the user can retry, but never keep one-time codes after an attempt.
    submitError.value = describe(error_)
    wipeCodes()
  } finally {
    if (token === invalidation) pending.value = false
  }
}

function newWithdrawal(): void {
  result.value = null
  notice.value = null
}

function fillMax(): void {
  if (maxAmount.value !== '') amount.value = maxAmount.value
}

/**
 * Applies a coin/network selection exactly once per pair: it aborts in-flight reads, clears every
 * chain-scoped value (config, typed address, review, codes) and then reloads the config.
 */
function applySelection(force = false): void {
  // Wait for the `addr/networks` probe: it decides the network scope, and a late answer must not
  // look like a user network switch that wipes the typed address.
  if (props.coin === '' || choice.value === undefined) {
    return
  }
  if (!networksReady.value) {
    if (force) resetForNetwork()
    return
  }
  const key = `${props.coin}|${choice.value.requestSymbol}|${choice.value.network}`
  if (!force && key === activeSelection) {
    return
  }
  resetForNetwork()
  activeSelection = key
  if (pendingPrefill !== '') {
    addressText.value = pendingPrefill
    pendingPrefill = ''
  }
  void loadConfig()
}

watch(
  choices,
  (list) => {
    if (list.some(entry => entry.id === choiceId.value)) return
    const preferred = defaultNetwork(market.publicInfo, props.coin)
    choiceId.value = (list.find(entry => entry.id === preferred) ?? list[0])?.id ?? ''
  },
  { immediate: true },
)

watch(
  () => props.coin,
  () => {
    resetDraft()
    result.value = null
    if (props.coin === '') {
      resetForNetwork()
      return
    }
    applySelection(true)
  },
  { immediate: true },
)

watch(choice, () => {
  applySelection()
})

watch(networksReady, (ready) => {
  if (ready) applySelection()
})

watch(
  () => props.initialAddress,
  (value) => {
    if (value === '') return
    if (activeSelection !== '') {
      addressText.value = value
    } else {
      pendingPrefill = value
    }
  },
  { immediate: true },
)

// A blocked reason appearing or changing (server flag flip, unknown security snapshot, gateway
// going away) must close the review step rather than let a stale draft be confirmed.
watch(blockedReason, () => {
  if (blockedReason.value === '' || !review.value) {
    return
  }
  review.value = false
  requestId.value = ''
  wipeCodes()
})

// Any edit to the reviewed draft (amount / address / fee) invalidates both the review and its
// idempotency key: the user must review the new values again, and the next review mints a fresh key.
watch([amount, addressText, fee], () => {
  requestId.value = ''
  if (!review.value) {
    return
  }
  review.value = false
  wipeCodes()
})

onMounted(() => {
  if (sessionStore.user === null) {
    void sessionStore.loadUserInfo()
  }
  // A re-auth / logout invalidates everything the form holds, including one-time codes.
  let token = session.getToken()
  stopSession = session.onInvalidate((snapshot) => {
    if (snapshot.token === token) {
      return
    }
    token = snapshot.token
    invalidation += 1
    version += 1
    abort()
    resetCodeRequest()
    pending.value = false
    loading.value = false
    error.value = null
    notice.value = null
    result.value = null
    config.value = null
    book.value = []
    activeSelection = ''
    resetDraft()
    if (snapshot.token !== null) {
      applySelection(true)
    }
  })
})

onBeforeUnmount(() => {
  invalidation += 1
  resetCodeRequest()
  // Invalidate every in-flight read as well, so a late response cannot write into a dead panel.
  version += 1
  abort()
  stopSession?.()
  if (cooldownTimer !== null) {
    clearInterval(cooldownTimer)
  }
})

function money(value: string): string {
  return value === '' ? '--' : groupDigits(value)
}

const approvalText = computed(() => {
  const threshold = config.value?.autoApprovalThreshold ?? ''
  if (approval.value === 'auto') return t('wallet.wd.approvalAuto', { threshold, coin: props.coin })
  if (approval.value === 'newAddress') return t('wallet.wd.approvalNewAddress')
  if (approval.value === 'review' && threshold !== '' && !/^0(\.0+)?$/.test(threshold)) {
    return t('wallet.wd.approvalReview', { threshold, coin: props.coin })
  }
  return t('wallet.wd.approvalReviewAll')
})

const networkDetails = computed<Record<string, string[]>>(() => {
  const id = choice.value?.id
  if (id === undefined || config.value === null || config.value.defaultFee === '') return {}
  const line = /^0(\.0+)?$/.test(config.value.defaultFee)
    ? t('wallet.flow.feeFree')
    : t('wallet.flow.fee', { fee: config.value.defaultFee, coin: props.coin })
  return { [id]: [line] }
})
</script>

<template>
  <div class="flow">
    <div class="flow-main">
      <div class="flow-head">
        <p v-if="blockedReason !== ''" class="notice notice-error flow-block" role="alert">{{ blockedReason }}</p>
        <p v-else-if="config !== null && config.chainTip !== ''" class="notice notice-info flow-block">{{ t('wallet.withdraw.chainTip') }}: {{ config.chainTip }}</p>
        <button class="btn btn-ghost reload" type="button" :disabled="loading || pending" @click="applySelection(true)">
          <RotateCw :size="13" aria-hidden="true" />
          {{ loading ? t('common.loading') : t('common.refresh') }}
        </button>
      </div>

      <section v-if="result !== null" class="result" aria-live="polite" data-testid="withdraw-result">
        <CircleCheck class="result-icon" :size="44" aria-hidden="true" />
        <h3 class="result-title">{{ t('wallet.wd.resultTitle') }}</h3>
        <p class="result-amount num">{{ money(result.amount) }} {{ coin }}</p>
        <p class="result-sub">
          {{ result.approval === 'auto'
            ? t('wallet.wd.resultAuto')
            : result.approval === 'review'
              ? t('wallet.wd.resultReview')
              : result.approval === 'newAddress' ? t('wallet.wd.resultNewAddress') : t('wallet.wd.resultUnknown') }}
        </p>
        <dl class="result-facts">
          <div><dt>{{ t('wallet.wd.confirmAddress') }}</dt><dd class="num wrap-anywhere">{{ result.address }}</dd></div>
          <div><dt>{{ t('wallet.wd.confirmReceive') }}</dt><dd class="num">{{ money(result.receive) }} {{ coin }}</dd></div>
          <div v-if="result.withdrawId !== ''"><dt>{{ t('wallet.wd.resultId') }}</dt><dd class="num">{{ result.withdrawId }}</dd></div>
        </dl>
        <p v-if="result.saved" class="result-saved"><BookUser :size="14" aria-hidden="true" />{{ t('wallet.wd.resultSaved') }}</p>
        <div class="result-actions">
          <button class="btn btn-primary" type="button" @click="emit('openRecords', 'withdraw')">{{ t('wallet.wd.viewRecords') }}</button>
          <button class="btn" type="button" @click="newWithdrawal">{{ t('wallet.wd.again') }}</button>
        </div>
      </section>

      <template v-else>
        <WalletStep :index="1" :title="t('wallet.flow.stepCoin')" :done="coin !== ''">
          <CoinPicker :model-value="coin" :coins="withdrawCoins" :label="t('wallet.coin')" :disabled="pending" @update:model-value="emit('update:coin', $event)" />
        </WalletStep>

        <WalletStep :index="2" :title="t('wallet.flow.stepNetwork')" :done="choice !== undefined" :muted="coin === ''">
          <NetworkPicker v-model="choiceId" :choices="choices" :label="t('wallet.network')" :details="networkDetails" :disabled="pending" />
          <p v-if="shape === 'legacy' && config !== null" class="step-hint legacy"><CircleAlert :size="13" aria-hidden="true" />{{ t('wallet.flow.backendLegacy') }}</p>
        </WalletStep>

        <WalletStep :index="3" :title="t('wallet.flow.stepWithdrawAddress')" :done="target.mode !== 'none' && addressCheck.ok && !directBlocked" :muted="choice === undefined">
          <StateBlock v-if="loading && config === null" variant="loading" :message="t('common.loading')" />
          <StateBlock v-else-if="error !== null" variant="error" :message="error" retryable @retry="applySelection(true)" />
          <template v-else>
            <WithdrawAddressInput
              v-model="addressText"
              :saved="savedList"
              :label="t('wallet.withdraw.address')"
              :placeholder="t('wallet.wd.addressPlaceholder', { network: networkLabel })"
              :network-label="networkLabel"
              :verified="shape === 'network'"
              :invalid="showAddressProblem || addressMissing"
              :disabled="pending"
              @manage="emit('openAddressBook', coin)"
              @blur="addressTouched = true"
            />
            <p v-if="addressMissing" class="field-error">{{ t('wallet.withdraw.error.addressRequired') }}</p>
            <p v-else-if="addressStatus !== null" class="addr-status" :class="addressStatus.tone" data-testid="address-status">
              <ShieldCheck v-if="addressStatus.tone === 'ok'" :size="14" aria-hidden="true" />
              <TriangleAlert v-else-if="addressStatus.tone === 'warn' || addressStatus.tone === 'bad'" :size="14" aria-hidden="true" />
              <CircleAlert v-else :size="14" aria-hidden="true" />
              <span>{{ addressStatus.text }}</span>
              <button v-if="directBlocked" class="inline-link" type="button" @click="emit('openAddressBook', coin)">{{ t('wallet.wd.addToBook') }}</button>
            </p>
            <p v-else class="step-hint">{{ t('wallet.wd.platformHint') }}</p>
          </template>
        </WalletStep>

        <WalletStep :index="4" :title="t('wallet.flow.stepAmount')" :done="validation.ok" :muted="config === null" last>
          <div class="amount-block">
            <label class="field">
              <span class="field-label">
                <span>{{ t('wallet.withdraw.amount') }}</span>
                <span class="avail">{{ t('wallet.wd.available') }} <b class="num">{{ money(available) }}</b> {{ coin }}</span>
              </span>
              <span class="field-input amount-input" :class="{ invalid: visibleAmountError !== '' }">
                <input
                  v-model="amount"
                  class="num"
                  inputmode="decimal"
                  autocomplete="off"
                  :aria-label="t('wallet.withdraw.amount')"
                  :placeholder="config !== null && config.withdrawMin !== '' ? t('wallet.wd.amountPlaceholder', { min: config.withdrawMin }) : ''"
                  :disabled="pending"
                />
                <span class="field-suffix">{{ coin }}</span>
                <button class="max-btn" type="button" :disabled="pending || maxAmount === ''" @click="fillMax">{{ t('wallet.wd.max') }}</button>
              </span>
            </label>
            <p v-if="visibleAmountError !== ''" class="field-error" role="alert">{{ visibleAmountError }}</p>

            <dl class="limits">
              <div v-if="config !== null && (config.withdrawMin !== '' || config.withdrawMax !== '')">
                <dt>{{ t('wallet.wd.limits') }}</dt>
                <dd class="num">{{ t('wallet.wd.limitsValue', { min: config.withdrawMin === '' ? '--' : groupDigits(config.withdrawMin), max: config.withdrawMax === '' ? '∞' : groupDigits(config.withdrawMax), coin }) }}</dd>
              </div>
              <div v-if="dailyRemaining !== ''">
                <dt>{{ t('wallet.wd.dailyRemaining') }}</dt>
                <dd class="num" data-testid="daily-remaining">{{ money(dailyRemaining) }} {{ coin }}</dd>
              </div>
              <div>
                <dt>{{ t('wallet.wd.networkFee') }}</dt>
                <dd class="num" data-testid="withdraw-fee">{{ fee === '' ? '--' : `${money(fee)} ${coin}` }}</dd>
              </div>
            </dl>
          </div>

          <div class="receive-bar">
            <div class="receive-main">
              <span class="receive-label">{{ t('wallet.wd.receive') }}</span>
              <span class="receive-value num" data-testid="withdraw-receive">{{ money(receive) }} <small>{{ coin }}</small></span>
              <span v-if="approval !== 'unknown'" class="approval" :class="approval" data-testid="approval-hint">{{ approvalText }}</span>
            </div>
            <button class="btn btn-primary submit-btn" type="button" :disabled="blockedReason !== '' || config === null || pending || (showErrors && !canReview)" data-testid="withdraw-submit" @click="openReview">
              {{ t('wallet.wd.submit') }}
            </button>
          </div>
          <p v-if="submitError !== null && !review" class="notice notice-error" role="alert">{{ submitError }}</p>
          <p v-if="notice !== null && !review" class="notice notice-info">{{ notice }}</p>
        </WalletStep>
      </template>
    </div>

    <aside class="flow-side">
      <RecentRecords
        kind="withdraw"
        :coin="coin"
        :network="effectiveNetwork"
        :title="t('wallet.wd.recent')"
        :empty="t('wallet.wd.recentEmpty')"
        :refresh-key="recentKey"
        @view-all="emit('openRecords', 'withdraw')"
      />
    </aside>

    <WithdrawConfirmDialog
      :open="review"
      :coin="coin"
      :network-label="networkLabel"
      :address="target.mode === 'saved' ? target.entry.address : target.mode === 'direct' ? target.address : ''"
      :saved-label="target.mode === 'saved' ? target.entry.label : ''"
      :mode="mode"
      :shape="shape"
      :amount="amount"
      :fee="fee"
      :receive="receive"
      :approval="approval"
      :approval-text="approvalText"
      :requirement="requirement"
      :can-save="canSaveToBook"
      :pending="pending"
      :can-submit="canSubmit"
      :cooldown="cooldown"
      :code-channel="codeChannel"
      :code-pending="codePending"
      :code-errors="confirmAttempted ? codeErrors : []"
      :save-label-missing="saveLabelMissing"
      :error="submitError"
      :notice="notice"
      v-model:google-code="googleCode"
      v-model:email-code="emailValidCode"
      v-model:sms-code="smsAuthCode"
      v-model:save-to-book="saveToBook"
      v-model:save-label="saveLabel"
      @close="closeReview"
      @send="requestCode"
      @confirm="confirmSubmit"
    />
  </div>
</template>

<style scoped>
.flow { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; align-items: start; }
.flow-main { min-width: 0; padding: 24px 24px 26px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.flow-side { position: sticky; top: calc(var(--header-h) + 16px); min-width: 0; padding: 18px 18px 8px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.flow-head { display: flex; align-items: flex-start; justify-content: flex-end; gap: 12px; margin: -8px -8px 8px 0; }
.flow-block { flex: 1 1 auto; margin: 0; }
.reload { height: 32px; padding: 0 10px; }
.step-hint { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.5; }
.step-hint.legacy { color: var(--color-warning); }
.step-hint :deep(svg) { flex: 0 0 auto; margin-top: 2px; }

.addr-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 0; font-size: 12.5px; font-weight: 600; line-height: 1.5; }
.addr-status.ok { color: var(--color-up); }
.addr-status.info { color: var(--color-info); }
.addr-status.warn { color: var(--color-warning); }
.addr-status.bad { color: var(--color-down); }
.addr-status :deep(svg) { flex: 0 0 auto; }
.addr-status span { flex: 1 1 200px; }
.inline-link { padding: 2px 0; color: var(--color-accent-text); font-size: 12.5px; font-weight: 700; text-decoration: underline; }

.amount-block { display: flex; flex-direction: column; gap: 6px; }
.avail { color: var(--color-text-muted); font-weight: 500; }
.avail b { color: var(--color-text); font-weight: 650; }
.amount-input { height: 54px; }
.amount-input input { font-family: var(--font-mono); font-size: 18px; font-weight: 600; }
.max-btn { flex: 0 0 auto; white-space: nowrap; height: 30px; padding: 0 10px; border-radius: 6px; color: var(--color-accent-text); font-size: 13px; font-weight: 750; }
.max-btn:hover:not(:disabled) { background: var(--color-accent-soft); }
.max-btn:disabled { color: var(--color-text-muted); cursor: not-allowed; }
.limits { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 6px 0 0; }
.limits div { display: flex; gap: 6px; font-size: 12px; }
.limits dt { color: var(--color-text-muted); }
.limits dd { margin: 0; color: var(--color-text-secondary); font-weight: 600; }

.receive-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 18px; padding: 16px 18px;
  border: 1px solid var(--color-border-strong); border-radius: 12px; background: var(--color-surface-alt);
}
.receive-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.receive-label { color: var(--color-text-muted); font-size: 12px; }
.receive-value { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.receive-value small { color: var(--color-text-secondary); font-size: 13px; font-weight: 600; }
.approval { align-self: flex-start; margin-top: 4px; padding: 3px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 650; }
.approval.auto { background: var(--color-up-soft); color: var(--color-up); }
.approval.review, .approval.newAddress { background: var(--color-warning-soft); color: var(--color-warning); }
.submit-btn { flex: 0 0 auto; min-width: 180px; height: 48px; font-size: 15px; }

.result { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 28px 8px 12px; text-align: center; }
.result-icon { color: var(--color-up); }
.result-title { margin: 4px 0 0; font-size: 20px; font-weight: 750; }
.result-amount { margin: 0; font-size: 28px; font-weight: 700; }
.result-sub { max-width: 440px; margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.result-facts { display: flex; flex-direction: column; gap: 10px; width: min(100%, 520px); margin: 14px 0 0; padding: 14px 16px; border-radius: 12px; background: var(--color-surface-alt); text-align: left; }
.result-facts div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 10px; font-size: 13px; }
.result-facts dt { color: var(--color-text-muted); }
.result-facts dd { white-space: normal; word-break: break-all; margin: 0; font-weight: 600; }
.result-saved { display: flex; align-items: center; gap: 6px; margin: 4px 0 0; color: var(--color-up); font-size: 12.5px; font-weight: 600; }
.result-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 12px; }
.result-actions .btn { min-width: 160px; height: 44px; }

@media (max-width: 1080px) {
  .flow { grid-template-columns: minmax(0, 1fr); }
  .flow-side { position: static; }
}
@media (max-width: 720px) {
  .flow-main { padding: 18px 14px; border-radius: 14px; }
  .receive-bar { flex-direction: column; align-items: stretch; }
  .submit-btn { width: 100%; }
  .result-facts div { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
</style>
