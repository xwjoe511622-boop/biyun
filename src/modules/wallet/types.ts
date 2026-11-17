/**
 * Spot-wallet view models.
 *
 * Every amount/price/fee field stays a decimal **string** end to end. Server payloads that
 * arrive as JSON numbers are stringified once in `normalize.ts` via `toDecString`, never parsed
 * with `Number`/`parseFloat`.
 */

export interface DepositAddress {
  /** Deposit address without the memo/tag suffix. */
  address: string
  /** Memo/tag split off `addressStr` when the coin is a tag coin (legacy `isHavePage`). */
  tag: string
  /** True when the server payload contained a `_`-separated tag. */
  hasTag: boolean
  /** Legacy `addressQRCode`; rendered only when non-empty and the coin has no tag. */
  qrCode: string
  /**
   * Optional chain metadata returned by the deposit-address endpoint. Historical servers omit
   * these fields, so callers must treat every value as absent until the server supplies it.
   */
  networkName?: string
  chainId?: number
  tokenContract?: string
  confirmations?: number
  /** Optional server-reported minimum deposit. */
  depositMin?: string
  /**
   * Server provisioning state. `READY` = a usable address; `PROVISIONING` = the backend is still
   * allocating it, so no address/tag/QR is available yet. Absent on the historical server shape,
   * which callers treat exactly as before.
   */
  status?: 'READY' | 'PROVISIONING'
}

export interface WalletAddress {
  id: string
  coin: string
  address: string
  tag: string
  label: string
  /** Original `addressId_tag` payload exactly as returned. */
  raw: string
  /**
   * Contract v2 (`addr/address_list`): the network the address is saved for (e.g. `BSC`). Absent or
   * `''` on the historical per-coin address book, where `coin` is the only scope.
   */
  network?: string
  /** `ctime` as returned (string or formatted epoch). */
  createdAt?: string
  /** Optional `lastUsedTime` (not implemented by the v2 server yet; shown only if it appears). */
  lastUsedAt?: string
}

export interface WithdrawConfig {
  coin: string
  /** `feeMin` / `feeMax` as decimals; `''` means the server did not constrain it. */
  feeMin: string
  feeMax: string
  /** `withdraw_min`; `''` means unknown. */
  withdrawMin: string
  /** `withdraw_max`; `''` means "no upper bound" (legacy `fixD('') -> '--'`). */
  withdrawMax: string
  /** `defaultFee`, pre-filled into the fee input. */
  defaultFee: string
  /** `mainChainNameTip`, e.g. the network reminder shown next to the chain selector. */
  chainTip: string
  addresses: WalletAddress[]
  /** Contract v2 `withdraw_config.network`; `''`/absent on the historical `cost/Getcost`. */
  network?: string
  /** Contract v2 `dailyRemaining` (net amount still allowed today); `''` = not reported. */
  dailyRemaining?: string
  /** Contract v2 `autoApprovalThreshold`; `''` = not reported (never guessed client-side). */
  autoApprovalThreshold?: string
  /** Contract v2 `withdrawOpen`; `null`/absent = not reported by this endpoint. */
  withdrawOpen?: boolean | null
  /** Contract v2 `precision`: max decimals the server accepts for the amount. */
  precision?: number
  /** Contract v2 `confirmations` required on chain. */
  confirmations?: number
  /** Contract v2 `dailyLimit`. */
  dailyLimit?: string
}

export type HistoryKind = 'deposit' | 'withdraw'

export interface HistoryEntry {
  id: string
  coin: string
  amount: string
  fee: string
  /** Withdrawal address (tag already stripped). */
  address: string
  tag: string
  txid: string
  /** Explorer URL supplied by the server (`txidAddr`); adopted verbatim, never built client-side. */
  txidUrl: string
  label: string
  /** Raw server status. Cancellation is allowed only for the exact legacy value `"0"`. */
  status: string
  /** Explicit cancellation capability; legacy read-only records return false. */
  canCancel?: boolean
  statusText: string
  confirmDesc: string
  createdAt: string
  walletTime: string
  /** Server network for the row when reported (`network`), else absent. */
  network?: string
  /** Raw server status for both kinds (deposits keep `status` empty; this drives the chip tone). */
  rawStatus?: string
  /** `confirmations` / `confirmDesc` numerator when reported. */
  confirmations?: number
  /** `confirmDesc` denominator when reported. */
  requiredConfirmations?: number
  /**
   * Server raw dust remainder in **original (smallest) units**, read as a string only and never
   * parsed. It is the sub-16-decimal slice left after the core's DECIMAL(32,16) quantisation —
   * still the user's funds, **not** a fee. Deposit rows may surface it as a hint.
   */
  dustRaw?: string
}

export interface HistoryPage {
  count: number
  list: HistoryEntry[]
}

export interface AddressCodeInput {
  googleCode: string
  smsValidCode: string
  emailValidCode: string
}

export interface AddAddressPayload extends AddressCodeInput {
  /** Historical per-coin scope. `''` when the contract v2 `network` scope is used instead. */
  coinSymbol: string
  /** Contract v2 network scope (e.g. `BSC`); omitted for the historical backend. */
  network?: string
  /** `address` or `address_tag`; the tag is appended here because the API stores one string. */
  address: string
  label: string
}

export interface WithdrawSubmitPayload {
  /**
   * Client-generated idempotency key. The Rust withdrawal backend enforces it: a duplicate submission
   * with a seen `requestId` is refused, so **every retry of one reviewed draft must reuse the same id**
   * (never regenerate on a network timeout). Generated with `crypto.randomUUID()` when the draft is created.
   */
  requestId: string
  /** `WithdrawDTO` (historical wire shape) `symbol` — the branch/chain symbol when the coin has multiple chains. */
  symbol: string
  /**
   * `WithdrawDTO` (historical wire shape) `addressId` (a positive integer); sent as a JSON number. `''` for a contract v2
   * direct-address withdrawal, which sends `address` instead.
   */
  addressId: string
  /** Contract v2 direct mode: the pasted destination address (mutually exclusive with `addressId`). */
  address?: string
  /** Contract v2 `network` (e.g. `BSC`); when present `coinSymbol` is sent alongside `symbol`. */
  network?: string
  /** Contract v2 direct mode: also save the address to the book after the withdrawal is accepted. */
  saveAddress?: boolean
  /** Label used when `saveAddress` is true. */
  label?: string
  /**
   * **Gross** amount typed by the user. The ledger derives the net amount (`amount - fee`)
   * server-side as `amount - fee`, so the client must POST the gross value (`amount`), never the
   * computed net.
   */
  amount: string
  /** `WithdrawDTO.fee`; `0` is valid when the coin's configured fee range is `0`–`0`. */
  fee: string
  /** `WithdrawDTO` (historical wire shape) `googleCode`: required and exactly 6 digits. */
  googleCode: string
  /** `WithdrawDTO.smsAuthCode`: optional, and **omitted** when blank (the DTO `@Length` rejects `""`). */
  smsAuthCode: string
  /** `WithdrawDTO.emailValidCode`: optional, and **omitted** when blank (`@Length` rejects `""`). */
  emailValidCode: string
}

export interface UserSecurity {
  /** `userInfo.googleStatus === '1'`. */
  googleEnabled: boolean
  /** True when the server actually reported `googleStatus` (unknown must not behave as "off"). */
  googleKnown: boolean
  /** `userInfo.isOpenMobileCheck === '1'`. */
  mobileCheckEnabled: boolean
  /** Non-empty when the user bound an email address. */
  email: string
  /** `authLevel`; `1` means real-name verified. */
  authLevel: number
  /** True when the security snapshot is trustworthy enough to decide the 2FA requirement. */
  known: boolean
}
