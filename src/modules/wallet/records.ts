import { i18n } from '@/i18n/composer'
import { explorerTxUrl } from './networks'
import { safeExplorerUrl } from './normalize'
import type { HistoryEntry, HistoryKind } from './types'

export type StatusTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

/**
 * Status codes as defined by the server entities:
 * - withdrawals legacy numeric (`TransactionWithdrawCrypto.status`): 0 未审核, 1 审核通过, 2 审核拒绝,
 *   3 支付中, 4 支付失败, 5 已完成, 6 已撤销
 * - deposits legacy numeric (`TransactionDepositCryptoStatus`): 0 未到账, 1 已到账, 2 失败
 *
 * The native Fable wallet also returns **string** states (below). Both generations are accepted; the
 * string states are labelled directly here (Chinese) so an unknown state never renders as a bare code
 * and `UNKNOWN` is explicit that funds stay frozen.
 */
const WITHDRAW_TONES: Record<string, StatusTone> = { '0': 'warn', '1': 'info', '2': 'bad', '3': 'info', '4': 'bad', '5': 'ok', '6': 'muted' }
const DEPOSIT_TONES: Record<string, StatusTone> = { '0': 'warn', '1': 'ok', '2': 'bad' }

/** Native string states: withdrawal. */
const WITHDRAW_LABELS: Record<string, string> = {
  // FREEZING is "freeze in progress": the freeze is not yet confirmed, so the label must not claim the funds are frozen.
  FREEZING: 'walletStatus.freezeInProgress',
  PENDING_APPROVAL: 'walletStatus.pendingReviewFundsFrozen',
  APPROVED: 'walletStatus.approvedAwaitingOnChainSubmission',
  SUBMITTING: 'walletStatus.submittingFundsStayFrozenIfTheResultIsUnknown',
  PAYOUT_PENDING: 'walletStatus.onChainPayoutInProgressFundsFrozen',
  UNKNOWN: 'walletStatus.resultUnknownFundsFrozenDoNotResubmit',
  REFUNDING: 'walletStatus.refundInProgress',
  REFUNDED: 'walletStatus.refundedFundsUnfrozen',
  // REFUSED means the freeze itself failed and the withdrawal was rejected; do not claim it was unfrozen.
  REFUSED: 'walletStatus.rejectedBecauseTheFreezeFailed',
  SETTLING: 'walletStatus.settling',
  COMPLETED: 'walletStatus.completed',
}
const WITHDRAW_STRING_TONES: Record<string, StatusTone> = {
  FREEZING: 'warn', PENDING_APPROVAL: 'warn', APPROVED: 'info', SUBMITTING: 'info',
  PAYOUT_PENDING: 'info', UNKNOWN: 'warn', REFUNDING: 'warn', REFUNDED: 'muted',
  REFUSED: 'bad', SETTLING: 'info', COMPLETED: 'ok',
}

/** Native string states: deposit. */
const DEPOSIT_LABELS: Record<string, string> = {
  OBSERVED: 'walletStatus.observedAwaitingConfirmation',
  CONFIRMING: 'walletStatus.confirmingOnChain',
  CREDITING: 'walletStatus.crediting',
  CREDITED: 'walletStatus.credited',
  BELOW_MIN: 'walletStatus.belowTheMinimumDepositNotCredited',
  REVERSED: 'walletStatus.reversed',
  REVIEW: 'walletStatus.underManualReview',
}
const DEPOSIT_STRING_TONES: Record<string, StatusTone> = {
  OBSERVED: 'info', CONFIRMING: 'info', CREDITING: 'info', CREDITED: 'ok', BELOW_MIN: 'warn', REVERSED: 'bad', REVIEW: 'warn',
}

export function statusCode(entry: HistoryEntry): string {
  return entry.rawStatus ?? entry.status
}

export function statusTone(kind: HistoryKind, entry: HistoryEntry): StatusTone {
  const code = statusCode(entry)
  const stringTable = kind === 'withdraw' ? WITHDRAW_STRING_TONES : DEPOSIT_STRING_TONES
  const known = stringTable[code]
  if (known !== undefined) return known
  const table = kind === 'withdraw' ? WITHDRAW_TONES : DEPOSIT_TONES
  return table[code] ?? 'muted'
}

/** Chinese label for a native string state; `''` when the code is not one of them. */
export function statusLabel(kind: HistoryKind, entry: HistoryEntry): string {
  const code = statusCode(entry)
  const table = kind === 'withdraw' ? WITHDRAW_LABELS : DEPOSIT_LABELS
  return table[code] ? i18n.global.t(table[code]) : ''
}

/** i18n key for a known **numeric** code, `''` when the code is unknown (string states use `statusLabel`). */
export function statusKey(kind: HistoryKind, entry: HistoryEntry): string {
  const code = statusCode(entry)
  const table = kind === 'withdraw' ? WITHDRAW_TONES : DEPOSIT_TONES
  if (table[code] === undefined) return ''
  return kind === 'withdraw' ? `wallet.rec.withdrawStatus.${code}` : `wallet.rec.depositStatus.${code}`
}

/** Server `txidAddr` (http/https only) first; otherwise a BscScan link for a BSC row. */
export function recordTxUrl(entry: HistoryEntry, network: string): string {
  const server = safeExplorerUrl(entry.txidUrl)
  if (server !== '') return server
  return network === '' ? '' : explorerTxUrl(network, entry.txid)
}
