import { i18n } from '@/i18n/composer'
import { cmp, isDecimalString, isPositive } from '@/modules/finance/decimal'
import type { AddAddressPayload, WithdrawSubmitPayload } from './types'

/**
 * Pure builders for the wallet request bodies. They exist so the exact wire shape — which is then
 * RSA/AES-encrypted by `modules/api/security.ts` — can be asserted without decrypting anything.
 *
 * The wallet is now a **native Rust (Fable WaaS) service**: the withdrawal submission carries a
 * client-generated `requestId` idempotency key, and the Rust backend derives/settles the ledger
 * itself. The CIAO/`WithdrawDTO` field names below are kept only as the **historical compatibility
 * wire shape** the Rust service continues to accept; they no longer name a Java/CIAO controller.
 *
 * Field-shape notes (historical wire, still authoritative for the plaintext body):
 * - `symbol`, numeric `addressId` (a JSON number when saved mode is used), `amount`/`fee` decimal
 *   strings, `googleCode`, optional `smsAuthCode` / `emailValidCode` (6 digits; blanks are omitted
 *   because the historical DTO `@Length(6,6)` rejects an empty string). `payAmount = amount - fee`
 *   is derived server-side, i.e. the client POSTs the **gross** amount.
 * - `requestId` is the new idempotency field: a UUID (or 16–64 `[A-Za-z0-9-]`) reused across retries
 *   of the same reviewed draft; see `WithdrawSubmitPayload.requestId`.
 */

/** Server ids are `Long`/`Integer`; a JSON string would fail deserialization. */
export function toNumericId(id: string, field: string): number {
  const raw = id.trim()
  if (!/^\d+$/.test(raw)) {
    throw new Error(i18n.global.t('serviceMessage.mustBeAnIntegerIdReturnedByTheServer', { field, id }))
  }
  const value = Number(raw) // float-ok: integer id, safe-integer checked
  if (!Number.isSafeInteger(value)) {
    throw new Error(i18n.global.t('serviceMessage.exceedsTheSafeIntegerRange', { field, id }))
  }
  return value
}

/**
 * Withdrawal idempotency key: a RFC 4122 UUID (`crypto.randomUUID()`) or a 16–64 char token of
 * `[A-Za-z0-9-]`. Reused verbatim across retries of one reviewed draft.
 */
const WITHDRAW_REQUEST_ID_RE = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9-]{16,64})$/

export function isWithdrawRequestId(value: string): boolean {
  return WITHDRAW_REQUEST_ID_RE.test(value.trim())
}

export interface WithdrawPlainBody {
  /** Idempotency key; see `WithdrawSubmitPayload.requestId`. */
  requestId: string
  symbol: string
  /** Contract v2 common field (sent with `network`). */
  coinSymbol?: string
  network?: string
  /** Saved mode. */
  addressId?: number
  /** Contract v2 direct mode. */
  address?: string
  saveAddress?: boolean
  label?: string
  /** Gross amount, exactly as typed (never `amount - fee`). */
  amount: string
  fee: string
  googleCode: string
  smsAuthCode?: string
  emailValidCode?: string
}

/**
 * Builds the plaintext withdrawal body posted to the Fable wallet `/account/withdraw` (historical wire shape).
 * Throws on a negative/non-decimal amount or fee, a missing 6-digit Google code or a non-integer
 * address id, so an invalid draft can never be encrypted and sent.
 */
export function buildWithdrawRequestBody(payload: WithdrawSubmitPayload): WithdrawPlainBody {
  const requestId = (payload.requestId ?? '').trim()
  if (!isWithdrawRequestId(requestId)) {
    throw new Error(i18n.global.t('serviceMessage.theWithdrawalRequestIdMustBeAUuidOr'))
  }
  const symbol = payload.symbol.trim()
  if (symbol === '') {
    throw new Error(i18n.global.t('serviceMessage.selectAWithdrawalCoin'))
  }
  const amount = payload.amount.trim()
  const fee = payload.fee.trim()
  if (!isDecimalString(amount) || !isPositive(amount)) {
    throw new Error(i18n.global.t('serviceMessage.theWithdrawalAmountMustBeADecimalGreaterThan'))
  }
  if (!isDecimalString(fee)) {
    // `isDecimalString` rejects negatives; `0` is allowed when the configured range is `0`–`0`.
    throw new Error(i18n.global.t('serviceMessage.theFeeMustBeANonnegativeDecimal'))
  }
  if (cmp(amount, fee) <= 0) {
    throw new Error(i18n.global.t('serviceMessage.theWithdrawalAmountMustExceedTheFee'))
  }
  const googleCode = payload.googleCode.trim()
  if (!/^\d{6}$/.test(googleCode)) {
    throw new Error(i18n.global.t('serviceMessage.enterASixDigitGoogleVerificationCode'))
  }

  const body: WithdrawPlainBody = { requestId, symbol, amount, fee, googleCode }
  const network = (payload.network ?? '').trim()
  if (network !== '') {
    // Contract v2: `coinSymbol` + `network` are the common fields; `symbol` stays for the historical DTO.
    body.coinSymbol = symbol
    body.network = network
  }
  const addressId = payload.addressId.trim()
  const direct = (payload.address ?? '').trim()
  if (addressId !== '' && direct !== '') {
    throw new Error(i18n.global.t('serviceMessage.specifyEitherAddressidOrAddress'))
  }
  if (addressId !== '') {
    body.addressId = toNumericId(addressId, 'addressId')
  } else {
    if (direct === '') {
      throw new Error(i18n.global.t('serviceMessage.selectASavedAddressOrEnterAWithdrawalAddress'))
    }
    if (network === '') {
      // The historical backend only accepts a saved `addressId`; never send it a raw address.
      throw new Error(i18n.global.t('serviceMessage.onlyWithdrawalsToSavedAddressesAreSupported'))
    }
    body.address = direct
    if (payload.saveAddress === true) {
      body.saveAddress = true
      const label = (payload.label ?? '').trim()
      if (label !== '') body.label = label
    }
  }
  // Optional factors are omitted when blank: the DTO `@Length(min = 6)`s reject an empty string.
  const smsAuthCode = payload.smsAuthCode.trim()
  if (smsAuthCode !== '') {
    if (!/^\d{6}$/.test(smsAuthCode)) {
      throw new Error(i18n.global.t('serviceMessage.enterASixDigitSmsCode'))
    }
    body.smsAuthCode = smsAuthCode
  }
  const emailValidCode = payload.emailValidCode.trim()
  if (emailValidCode !== '') {
    if (!/^\d{6}$/.test(emailValidCode)) {
      throw new Error(i18n.global.t('serviceMessage.enterASixDigitEmailCode'))
    }
    body.emailValidCode = emailValidCode
  }
  return body
}

/** `CancelWithdrawDTO` — `{ withdrawId }` as a number. */
export function buildCancelWithdrawBody(withdrawId: string): { withdrawId: number } {
  return { withdrawId: toNumericId(withdrawId, 'withdrawId') }
}

export interface DeleteAddressBody {
  ids: number[]
  smsValidCode?: string
  googleCode?: string
}

/**
 * `AddrAct.delete_withdraw_addr` body: numeric ids, and only the code fields the legacy controller
 * checks (`smsValidCode` when the account has mobile verification, `googleCode` when Google is on).
 */
export function buildDeleteAddressBody(
  ids: string[],
  codes: { googleCode: string; smsValidCode: string },
): DeleteAddressBody {
  if (ids.length === 0) {
    throw new Error(i18n.global.t('serviceMessage.anAddressIdIsRequiredForDeletion'))
  }
  const body: DeleteAddressBody = { ids: ids.map(id => toNumericId(id, 'ids')) }
  const googleCode = codes.googleCode.trim()
  if (googleCode !== '') {
    body.googleCode = googleCode
  }
  const smsValidCode = codes.smsValidCode.trim()
  if (smsValidCode !== '') {
    body.smsValidCode = smsValidCode
  }
  if (body.googleCode === undefined && body.smsValidCode === undefined) {
    // The controller rejects the request outright when both keys are absent.
    throw new Error(i18n.global.t('serviceMessage.enterAGoogleOrSmsCodeToDeleteAn'))
  }
  return body
}

/**
 * `AddrAct.add_withdraw_addr` body. Historical: `coinSymbol`, `address`, `label` + codes. Contract v2:
 * `network` instead of `coinSymbol`, optional `label`, and the SMS factor is named `smsAuthCode`.
 */
export function buildAddAddressBody(payload: AddAddressPayload): Record<string, string> {
  const network = (payload.network ?? '').trim()
  const coinSymbol = payload.coinSymbol.trim()
  if (network === '' && coinSymbol === '') {
    throw new Error(i18n.global.t('serviceMessage.selectANetworkOrCoinToAddAnAddress'))
  }
  const body: Record<string, string> = {}
  if (network !== '') {
    body.network = network
  }
  if (coinSymbol !== '') {
    body.coinSymbol = coinSymbol
  }
  body.address = payload.address.trim()
  const label = payload.label.trim()
  if (network === '' || label !== '') {
    body.label = label
  }
  const googleCode = payload.googleCode.trim()
  if (googleCode !== '') {
    body.googleCode = googleCode
  }
  const smsValidCode = payload.smsValidCode.trim()
  if (smsValidCode !== '') {
    // v2 names the factor `smsAuthCode` (and still accepts `smsValidCode`); legacy only knows `smsValidCode`.
    body[network !== '' ? 'smsAuthCode' : 'smsValidCode'] = smsValidCode
  }
  const emailValidCode = payload.emailValidCode.trim()
  if (emailValidCode !== '') {
    body.emailValidCode = emailValidCode
  }
  return body
}

/** Contract v2 delete (§6.2): exactly `{ id, googleCode }`. */
export function buildNetworkDeleteAddressBody(id: string, googleCode: string): { id: number; googleCode: string } {
  const code = googleCode.trim()
  if (!/^\d{6}$/.test(code)) {
    throw new Error(i18n.global.t('serviceMessage.enterASixDigitGoogleCodeToDeleteAn'))
  }
  return { id: toNumericId(id, 'id'), googleCode: code }
}
