import { i18n } from '@/i18n/composer'
import { request } from './http'
import { isApiError } from '@/core/errors'
import { isWalletGatewayConfigured } from '@/config/endpoints'
import {
  asRecord,
  decimal,
  isContractWithdrawConfig,
  normalizeAddressList,
  normalizeContractWithdrawConfig,
  normalizeDepositAddress,
  normalizeHistoryPage,
  normalizeWithdrawConfig,
  text,
} from '@/modules/wallet/normalize'
import { normalizeWalletNetworks, type WalletNetwork } from '@/modules/wallet/networks'
import {
  buildAddAddressBody,
  buildCancelWithdrawBody,
  buildDeleteAddressBody,
  buildNetworkDeleteAddressBody,
  buildWithdrawRequestBody,
} from '@/modules/wallet/withdrawRequest'
import type {
  AddAddressPayload,
  DepositAddress,
  HistoryPage,
  WalletAddress,
  WithdrawConfig,
  WithdrawSubmitPayload,
} from '@/modules/wallet/types'

/**
 * Spot-wallet endpoints. Two namespaces are used, and neither silently substitutes for the other:
 *
 * **`api: 'wallet'` — the native Fable WaaS wallet (Rust).** Deposits, withdrawals, the address book
 * and the wallet verification codes are served by the Rust wallet service; the browser reaches it
 * through the same-origin `/wallet-api/*` prefix (`VITE_WALLET_API_BASE`, empty by default → these
 * calls throw "wallet gateway not configured" before `fetch`). The wire field names still follow the
 * historical CIAO shape (`/account/withdraw`, `/account/getRechargeAddress`, …) because the Rust
 * service accepts that compatibility body; the names describe the **historical wire shape only** and
 * do not imply a Java/CIAO controller is still in the path.
 *
 * **default (`/fe-ex-api/`) — paths that a native handler still answers.** Only paths confirmed to
 * exist are kept here:
 *   `cost/Getcost`              fee/min/max + saved withdrawal addresses
 *   `addr/address_list`         address book list
 *   `addr/add_withdraw_addr`    address book add
 *   `addr/delete_withdraw_addr` address book delete (ids are integers)
 *   `record/deposit_list`       deposit history
 *   `v4/common/smsValidCode`    address-book SMS code (operationType 11/21)
 *   `v4/common/emailValidCode`  address-book email code (operationType 13)
 *
 * The address book posts to the address-book controller, so its verification codes must come from the
 * matching `v4/common/*` controller too. The `validCode/*` endpoints are a different, unrelated
 * namespace and are never used for address-book codes (or vice versa).
 *
 * **Contract v2 (`docs/03-reference/api/wallet-address-withdraw-contract.md`).** Addresses are
 * saved per network and a withdrawal may target a pasted address. This module keeps a small
 * compatibility layer so the UI works with or without the v2 fields:
 *   - `addr/networks` answering an array => v2 (`fetchWalletNetworks` returns the list); any failure
 *     => `null`, i.e. the per-coin backend.
 *   - `addr/address_list` rows carrying `network` => v2 rows; rows without it stay per-coin.
 *   - `account/withdraw_config` (v2) is used when a network is known; `cost/Getcost` otherwise.
 *   - direct-address withdrawals (`address` instead of `addressId`) are only built when a v2 network
 *     is known; the request builder refuses them otherwise so an old server never receives one.
 *
 * Every amount, fee and limit stays a decimal **string** end to end; this module never uses
 * `Number`/`parseFloat` on money.
 */
export const WALLET_PATHS = {
  /** Fable wallet (historical wire shape): `ChargeAddressDTO {symbol[, network]}` -> `{addressStr, addressQRCode}`. */
  chargeAddress: 'account/getRechargeAddress',
  /** Fable wallet (historical wire shape): the withdrawal submit body (now carrying `requestId`). */
  submitWithdraw: 'account/withdraw',
  /** `CancelWithdrawDTO {withdrawId}`. */
  cancelWithdraw: 'account/cancelWithdraw',
  /** `WithdrawPageListDTO` -> `{count, financeList, pageSize}`. */
  withdrawHistory: 'account/withdrawList',
  /** Wallet SMS code (no body). */
  smsCode: 'validCode/sendSmsCode',
  /** Wallet email code (no body). */
  emailCode: 'validCode/sendEmailCode',
  /** Contract v2: `{ coinSymbol, network }` -> limits, daily remaining, auto-approval. */
  contractWithdrawConfig: 'account/withdraw_config',
  /** Contract v2 `/fe-ex-api/addr/networks` -> `[{ network, displayName, coins, addressRegex, needMemo }]`. */
  networks: 'addr/networks',
  /** Legacy `/fe-ex-api/` paths. */
  withdrawConfig: 'cost/Getcost',
  addressList: 'addr/address_list',
  addAddress: 'addr/add_withdraw_addr',
  deleteAddress: 'addr/delete_withdraw_addr',
  depositHistory: 'record/deposit_list',
  /** Legacy `/v4/common/smsValidCode` — address-book SMS code, `operationType` 11 add / 21 delete. */
  addressBookSmsCode: 'v4/common/smsValidCode',
  /** Legacy `/v4/common/emailValidCode` — address-book email code, `operationType` 13 add. */
  addressBookEmailCode: 'v4/common/emailValidCode',
} as const

/** Paths that require the configured wallet gateway; an empty prefix means they are closed. */
export const WALLET_GATEWAY_PATHS: readonly string[] = [
  WALLET_PATHS.chargeAddress,
  WALLET_PATHS.contractWithdrawConfig,
  WALLET_PATHS.submitWithdraw,
  WALLET_PATHS.cancelWithdraw,
  WALLET_PATHS.withdrawHistory,
  WALLET_PATHS.smsCode,
  WALLET_PATHS.emailCode,
]

export interface WalletRequestOptions {
  signal?: AbortSignal
}

/**
 * Optional chain metadata added to the deposit-address response. Treat every field as absent
 * when the historical server payload does not include it.
 */
interface DepositAddressMetadata {
  networkName?: string
  chainId?: number
  tokenContract?: string
  confirmations?: number
  depositMin?: string
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const raw = text(value).trim()
  if (!/^\d+$/.test(raw)) {
    return undefined
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function depositAddressMetadata(data: unknown): DepositAddressMetadata {
  const record = asRecord(data)
  const metadata: DepositAddressMetadata = {}
  const networkName = text(record.networkName).trim()
  if (networkName !== '') {
    metadata.networkName = networkName
  }
  const chainId = optionalNonNegativeInteger(record.chainId)
  if (chainId !== undefined) {
    metadata.chainId = chainId
  }
  const tokenContract = text(record.tokenContract).trim()
  if (tokenContract !== '') {
    metadata.tokenContract = tokenContract
  }
  const confirmations = optionalNonNegativeInteger(record.confirmations)
  if (confirmations !== undefined) {
    metadata.confirmations = confirmations
  }
  // Only shown when the server reports it; never derived client-side.
  const depositMin = decimal(record.depositMin !== undefined ? record.depositMin : record.minDeposit)
  if (depositMin !== '') {
    metadata.depositMin = depositMin
  }
  return metadata
}

/** Missing status is historical; an explicit unknown state must never reveal an address. */
function depositStatus(data: unknown): 'READY' | 'PROVISIONING' | undefined {
  const value = asRecord(data).status
  if (value === undefined) return undefined
  if (value === 'READY' || value === 'PROVISIONING') return value
  throw new Error(i18n.global.t('clientFailure.unsupportedDepositAddressStatus'))
}

export interface DepositAddressOptions extends WalletRequestOptions {
  /**
   * Contract v2 network (e.g. `BSC`). Sent alongside `symbol` so a multi-network coin resolves the
   * address of the selected network; `''`/absent keeps the per-coin request.
   */
  network?: string
}

/** Fable wallet `/account/getRechargeAddress` — `{ symbol[, network] }` -> `{ addressStr, addressQRCode }`. */
export async function fetchDepositAddress(
  coin: string,
  options: DepositAddressOptions = {},
): Promise<DepositAddress> {
  const network = (options.network ?? '').trim()
  // `coinSymbol` is the self-hosted wallet connector's field (docs/04-design/wallet-exchange-integration.md §3);
  // `symbol` stays for the historical DTO.
  const body: Record<string, string> = { symbol: coin, coinSymbol: coin }
  if (network !== '') {
    body.network = network
  }
  const data = await request<unknown>(WALLET_PATHS.chargeAddress, {
    api: 'wallet',
    body,
    signal: options.signal,
  })
  const status = depositStatus(data)
  // PROVISIONING has no usable address: never surface an address/tag/QR even if a hostile payload
  // carries one. A genuinely malformed payload still fails visibly through `normalizeDepositAddress`.
  if (status === 'PROVISIONING') {
    return { address: '', tag: '', hasTag: false, qrCode: '', status }
  }
  const result: DepositAddress = {
    ...normalizeDepositAddress(data),
    ...depositAddressMetadata(data),
  }
  if (status === 'READY') {
    result.status = 'READY'
  }
  return result
}

/**
 * Contract v2 `addr/networks`. Returns `null` when the endpoint is absent or does not answer with a
 * network array — the UI then runs in historical (per-coin, saved-address-only) mode. Aborts are
 * re-thrown so a cancelled read never downgrades the mode by accident.
 */
export async function fetchWalletNetworks(options: WalletRequestOptions = {}): Promise<WalletNetwork[] | null> {
  try {
    const data = await request<unknown>(WALLET_PATHS.networks, { body: {}, signal: options.signal })
    return normalizeWalletNetworks(data)
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw error
    }
    if (isApiError(error) && error.kind === 'unauthorized') {
      throw error
    }
    return null
  }
}

export interface WithdrawConfigOptions extends WalletRequestOptions {
  /** Contract v2 network; when set, `account/withdraw_config` is read first. */
  network?: string
}

/**
 * Withdrawal limits. With a v2 `network` the contract `account/withdraw_config` (§6.4: fee range,
 * min/max, `dailyRemaining`, `autoApprovalThreshold`, `withdrawOpen`, `precision`) is used; if it is
 * unavailable, or no network is known (historical backend), the unchanged `cost/Getcost`
 * (`{ symbol }` -> fee range, min/max, saved per-coin addresses) is read instead.
 */
export async function fetchWithdrawConfig(
  coin: string,
  options: WithdrawConfigOptions = {},
): Promise<WithdrawConfig> {
  const network = (options.network ?? '').trim()
  if (network !== '' && isWalletGatewayConfigured()) {
    try {
      const data = await request<unknown>(WALLET_PATHS.contractWithdrawConfig, {
        api: 'wallet',
        body: { coinSymbol: coin, network },
        signal: options.signal,
      })
      if (isContractWithdrawConfig(data)) {
        return normalizeContractWithdrawConfig(data, coin)
      }
    } catch (error) {
      if (options.signal?.aborted === true || (isApiError(error) && error.kind === 'unauthorized')) {
        throw error
      }
      // Fall through to the historical endpoint.
    }
  }
  const data = await request<unknown>(WALLET_PATHS.withdrawConfig, {
    body: { symbol: coin },
    signal: options.signal,
  })
  return normalizeWithdrawConfig(data, coin)
}

export interface AddressBookQuery {
  /** Contract v2 network filter. */
  network?: string
  /** Historical per-coin filter (`coinSymbol`). */
  coin?: string
}

/**
 * `addr/address_list`. A string argument keeps the historical call (`{ coinSymbol }`, `''` = all);
 * `{ network }` is the contract v2 filter; `{}` lists everything on either server.
 */
export async function fetchAddressBook(
  query: string | AddressBookQuery,
  options: WalletRequestOptions = {},
): Promise<WalletAddress[]> {
  const scope: AddressBookQuery = typeof query === 'string' ? { coin: query } : query
  const body: Record<string, string> = {}
  if (scope.network !== undefined && scope.network !== '') {
    body.network = scope.network
  } else if (scope.coin !== undefined && scope.coin !== '') {
    body.coinSymbol = scope.coin
  }
  const data = await request<unknown>(WALLET_PATHS.addressList, {
    body,
    signal: options.signal,
  })
  return normalizeAddressList(data)
}

/** Legacy `addr/add_withdraw_addr`. The tag is joined into `address` because the API stores one string. */
export async function addWalletAddress(
  payload: AddAddressPayload,
  options: WalletRequestOptions = {},
): Promise<AddAddressResult> {
  const data = await request<unknown>(WALLET_PATHS.addAddress, {
    body: buildAddAddressBody(payload),
    signal: options.signal,
  })
  // v2 (§6.2) answers with the entry + `created`; `created: false` means it was already saved.
  const record = asRecord(data)
  return record.created === false || text(record.created) === 'false' ? { created: false } : { created: true }
}

export interface AddAddressResult {
  /** `false` only when the v2 server explicitly reported an existing (idempotent) entry. */
  created: boolean
}

/**
 * Legacy `addr/delete_withdraw_addr`. `ids` is sent as a JSON number array (`List<Integer>` on the
 * server) and only the code fields the controller actually checks are included.
 */
export async function deleteWalletAddress(
  ids: string[],
  codes: Pick<AddAddressPayload, 'googleCode' | 'smsValidCode'>,
  options: WalletRequestOptions & { network?: boolean } = {},
): Promise<void> {
  // Contract v2 rows are deleted with `{ id, googleCode }` (Google only); historical rows keep the
  // legacy `{ ids, googleCode?, smsValidCode? }` body.
  const body = options.network === true && ids.length === 1
    ? buildNetworkDeleteAddressBody(ids[0], codes.googleCode)
    : buildDeleteAddressBody(ids, codes)
  await request<unknown>(WALLET_PATHS.deleteAddress, {
    body,
    signal: options.signal,
  })
}

/**
 * Fable wallet withdrawal submit (historical `/account/withdraw` wire shape). Only ever called from
 * the explicit review confirmation, after every server-required code has been supplied and validated
 * locally. The plaintext body carries the **gross** amount and the reviewed draft's `requestId`
 * (idempotency key); the http layer wraps the body in the signed envelope. Resolves with the server
 * `withdrawId` (`''` when the response did not include one).
 */
export async function submitWithdrawal(
  payload: WithdrawSubmitPayload,
  options: WalletRequestOptions = {},
): Promise<string> {
  const data = await request<unknown>(WALLET_PATHS.submitWithdraw, {
    api: 'wallet',
    signed: true,
    signedPath: '/account/withdraw',
    body: buildWithdrawRequestBody(payload),
    signal: options.signal,
  })
  return text(asRecord(data).withdrawId)
}

/** Fable wallet (historical wire shape) `account/cancelWithdraw` — `{ withdrawId }` as a number. */
export async function cancelWithdrawal(withdrawId: string, options: WalletRequestOptions = {}): Promise<void> {
  await request<unknown>(WALLET_PATHS.cancelWithdraw, {
    api: 'wallet',
    body: buildCancelWithdrawBody(withdrawId),
    signal: options.signal,
  })
}

export interface HistoryQuery {
  /** Empty string means "all coins" (legacy passes `coinSymbol: 'all'`). */
  coin: string
  page: number
  pageSize: number
}

function historyBody(query: HistoryQuery): Record<string, unknown> {
  const body: Record<string, unknown> = { pageSize: query.pageSize, page: query.page }
  if (query.coin !== '') {
    body.coinSymbol = query.coin
  }
  return body
}

/** Legacy `record/deposit_list` — deposit history for one coin. */
export async function fetchDepositHistory(
  query: HistoryQuery,
  options: WalletRequestOptions = {},
): Promise<HistoryPage> {
  const data = await request<unknown>(WALLET_PATHS.depositHistory, {
    body: historyBody(query),
    signal: options.signal,
  })
  return normalizeHistoryPage(data, 'deposit')
}

/** Fable wallet (historical wire shape) `account/withdrawList` — withdrawal history. */
export async function fetchWithdrawHistory(
  query: HistoryQuery,
  options: WalletRequestOptions = {},
): Promise<HistoryPage> {
  const data = await request<unknown>(WALLET_PATHS.withdrawHistory, {
    api: 'wallet',
    body: historyBody(query),
    signal: options.signal,
  })
  return normalizeHistoryPage(data, 'withdraw')
}

/** Wallet `validCode/sendSmsCode` (historical wire shape) — no body parameter. */
export async function sendSmsCode(options: WalletRequestOptions = {}): Promise<void> {
  await request<unknown>(WALLET_PATHS.smsCode, { api: 'wallet', signal: options.signal })
}

/** Wallet `validCode/sendEmailCode` (historical wire shape) — no body parameter. */
export async function sendEmailCode(options: WalletRequestOptions = {}): Promise<void> {
  await request<unknown>(WALLET_PATHS.emailCode, { api: 'wallet', signal: options.signal })
}

/** Address-book code channel actions; the operationType discriminator differs per action. */
export type AddressBookCodeAction = 'add' | 'delete'

/**
 * Legacy `v4/common/smsValidCode` — the address book's **own** SMS code, never the wallet withdrawal
 * code. `operationType` is `11` (`SmsOperateTypeEnum.AddCryptoAddr`) when adding an address and
 * `21` (`DelAddr`) when deleting one; the legacy PC `addressMent.js` did the same
 * (`getCodeClick` / `sendSmsCode`, `operationType = dialogStatus === 'add' ? '11' : '21'`).
 * The session identity travels in the `exchange-token` header, so the body is only the discriminator.
 */
export async function sendAddressBookSmsCode(
  action: AddressBookCodeAction,
  options: WalletRequestOptions = {},
): Promise<void> {
  await request<unknown>(WALLET_PATHS.addressBookSmsCode, {
    body: { operationType: action === 'delete' ? '21' : '11' },
    signal: options.signal,
  })
}

/**
 * Legacy `v4/common/emailValidCode` — `operationType` `13` (`EmailOperateTypeEnum.AddCryptoAddr`),
 * the only email code the legacy address book ever sent. The server reads the bound email from the
 * authenticated session, so no address/token is placed in the body.
 */
export async function sendAddressBookEmailCode(options: WalletRequestOptions = {}): Promise<void> {
  await request<unknown>(WALLET_PATHS.addressBookEmailCode, {
    body: { operationType: '13' },
    signal: options.signal,
  })
}
