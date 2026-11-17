import { groupDigits, canonicalDecimal, cmp, decimalPlaces, isDecimalString, isPositive } from '@/modules/finance/decimal'

/**
 * Unified internal transfer model.
 *
 * Routes and their only server endpoints (all on `/fe-ex-api/`):
 *   spot ↔ margin  `lever/finance/transfer` {fromAccount, toAccount, amount, coinSymbol, symbol}
 *                  1 = spot (U_NORMAL), 2 = margin (U_LEVER_NORMAL of `symbol`)   LeverFinanceAct.java:134-233
 *   spot ↔ futures `contract/co_transfer` {transferType, amount, coinSymbol}      ContractAct.java:102-179
 *                  transferType `wallet_to_contract` | `contract_to_wallet`.
 *                  When public info `futures_type` is set and not "0" (futures cloud), only
 *                  wallet_to_contract is accepted (ContractAct.java:139-158); contract→wallet is refused.
 * margin ↔ futures has no endpoint: the user must go through the spot account.
 */
export type TransferAccount = 'spot' | 'margin' | 'futures'

export const ALL_TRANSFER_ACCOUNTS: TransferAccount[] = ['spot', 'margin', 'futures']

export type TransferRouteKind = 'spotToMargin' | 'marginToSpot' | 'spotToFutures' | 'futuresToSpot'

export function routeOf(from: TransferAccount, to: TransferAccount): TransferRouteKind | null {
  if (from === 'spot' && to === 'margin') return 'spotToMargin'
  if (from === 'margin' && to === 'spot') return 'marginToSpot'
  if (from === 'spot' && to === 'futures') return 'spotToFutures'
  if (from === 'futures' && to === 'spot') return 'futuresToSpot'
  return null
}

/** `futures_type` blank or "0" = privately deployed futures (both directions); anything else = futures cloud. */
export function futuresOutboundSupported(futuresType: string | null | undefined): boolean {
  const value = (futuresType ?? '').trim()
  return value === '' || value === '0'
}

export interface TransferDraft {
  from: TransferAccount
  to: TransferAccount
  coin: string
  amount: string
  /** Lower-case margin pair (`btcusdt`) — required when either side is the margin account. */
  marginSymbol: string
}

export interface TransferContext {
  /** Transferable amount of `coin` in the source account; `''` when unknown (no client max). */
  available: string
  precision: number
  /** public_info_v4 `futures_type`. */
  futuresType?: string | null
  /** Coins allowed on the pair / futures account. Empty = no restriction known. */
  allowedCoins?: string[]
}

export interface TransferError {
  field: 'route' | 'coin' | 'amount' | 'symbol'
  /** i18n key under `transfer.error.*`. */
  key: string
  params?: Record<string, string | number>
}

export interface TransferValidation {
  ok: boolean
  errors: TransferError[]
  amount: string
  route: TransferRouteKind | null
}

export function validateTransfer(draft: TransferDraft, context: TransferContext): TransferValidation {
  const errors: TransferError[] = []
  const amount = canonicalDecimal(draft.amount)
  let route: TransferRouteKind | null = null

  if (draft.from === draft.to) {
    errors.push({ field: 'route', key: 'sameAccount' })
  } else {
    route = routeOf(draft.from, draft.to)
    if (route === null) {
      errors.push({ field: 'route', key: 'viaSpot' })
    } else if (route === 'futuresToSpot' && !futuresOutboundSupported(context.futuresType)) {
      errors.push({ field: 'route', key: 'futuresOutUnsupported' })
    }
  }
  if ((draft.from === 'margin' || draft.to === 'margin') && draft.marginSymbol.trim() === '') {
    errors.push({ field: 'symbol', key: 'symbolRequired' })
  }
  if (draft.coin.trim() === '') {
    errors.push({ field: 'coin', key: 'coinRequired' })
  } else if (context.allowedCoins !== undefined && context.allowedCoins.length > 0
    && !context.allowedCoins.map(coin => coin.toUpperCase()).includes(draft.coin.toUpperCase())) {
    errors.push({ field: 'coin', key: 'coinUnsupported' })
  }

  if (amount === '') {
    errors.push({ field: 'amount', key: 'required' })
  } else if (!isDecimalString(amount)) {
    errors.push({ field: 'amount', key: 'invalid' })
  } else if (!isPositive(amount)) {
    errors.push({ field: 'amount', key: 'positive' })
  } else if ((decimalPlaces(amount) ?? 0) > context.precision) {
    errors.push({ field: 'amount', key: 'precision', params: { dp: context.precision } })
  } else if (isDecimalString(context.available) && cmp(amount, context.available) > 0) {
    errors.push({ field: 'amount', key: 'insufficient', params: { available: groupDigits(context.available) } })
  }

  return { ok: errors.length === 0, errors, amount, route }
}

export interface TransferRequest {
  path: 'lever/finance/transfer' | 'contract/co_transfer'
  body: Record<string, string>
}

/** Builds the exact request for a validated route. Values are strings (`Map<String, String>` on the server). */
export function buildTransferRequest(route: TransferRouteKind, draft: { coin: string; amount: string; marginSymbol: string }): TransferRequest {
  const coin = draft.coin.toUpperCase()
  switch (route) {
    case 'spotToMargin':
    case 'marginToSpot':
      return {
        path: 'lever/finance/transfer',
        body: {
          fromAccount: route === 'spotToMargin' ? '1' : '2',
          toAccount: route === 'spotToMargin' ? '2' : '1',
          amount: draft.amount,
          coinSymbol: coin,
          symbol: draft.marginSymbol.toLowerCase(),
        },
      }
    case 'spotToFutures':
    case 'futuresToSpot':
      return {
        path: 'contract/co_transfer',
        body: {
          transferType: route === 'spotToFutures' ? 'wallet_to_contract' : 'contract_to_wallet',
          amount: draft.amount,
          coinSymbol: coin,
        },
      }
  }
}

/** Swapping keeps the pair valid: from ↔ to. */
export function swapAccounts<T extends { from: TransferAccount; to: TransferAccount }>(draft: T): T {
  return { ...draft, from: draft.to, to: draft.from }
}

/**
 * Futures account gate. The spot server used to debit the spot account BEFORE futures credited it, and
 * futures answers 100106「用户不存在」for a user without a futures account — the debit then stayed behind
 * as a stuck `co_transfer` (status 0; incident 2026-09-27, 11,000 USDT). Platform rule since then: every
 * user has a futures account by default (created at registration), so there is no "open" step in the UI.
 * The dialog still fails closed: a route touching futures is only enabled once the account is confirmed;
 * while it is being checked or silently created the dialog waits, and only a failed silent creation is
 * shown — as a plain error with retry.
 *
 * `status` mirrors `OpenAccountStatus` of `@/modules/futures/open-account` (structural, so the transfer
 * module does not import the futures module).
 */
export type FuturesGateStatus = 'signedOut' | 'checking' | 'unopened' | 'opening' | 'opened' | 'error'

export interface FuturesGate {
  status: FuturesGateStatus
  error: string | null
  /** The silent `create_co_id` + re-check failed. */
  initFailed: boolean
  /** Why the futures balance is unknown (assets request failed), shown next to「合约账户 --」with a retry. */
  balanceError?: string | null
  /** Creates the futures account silently if needed (idempotent); `force` after a 105001 answer. */
  ensureOpened: (force?: boolean) => Promise<boolean>
  refresh: () => Promise<void>
}

/** What the dialog must show for the futures side: `ok` = transfer allowed. */
export type FuturesGateView = 'ok' | 'preparing' | 'error'

export function futuresGateView(involvesFutures: boolean, status: FuturesGateStatus | undefined): FuturesGateView {
  if (!involvesFutures || status === 'opened') return 'ok'
  return status === 'error' ? 'error' : 'preparing'
}

/**
 * Spot `contract/co_transfer` answer when the futures account is not opened (server-side pre-check added
 * 2026-09-27; nothing is debited). Kept here as well so the transfer module stays independent of futures.
 */
export const TRANSFER_CODE_FUTURES_NOT_OPENED = '105001'

/** Payload of TransferDialog's `transferred` event (emitted only after the server answered code "0"). */
export interface TransferResult {
  from: TransferAccount
  to: TransferAccount
  coin: string
  amount: string
  marginSymbol: string
}
