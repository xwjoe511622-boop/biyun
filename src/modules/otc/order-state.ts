/**
 * C2C order state machine.
 *
 * Status values: `OtcOrderStatus` (exchange-common `com.chainup.common.enums.OtcOrderStatus`, lines 6-14):
 *   1 PAY_PENDING · 2 PAID · 3 COMPLETED · 4 CANCELLED · 5 APPEAL · 6 PAY_COIN (deprecated)
 *   7 EXCEPTION_ORDER · 8 APPEAL_COMPLETED · 9 APPEAL_COMPLETED_CANCELLED
 *
 * Who may do what mirrors the legacy PC order page (`otcDetailOrder/index.js`, `title.js`, `pays.js`)
 * and the server guards (the server stays the authority; the client only hides actions that would
 * certainly be rejected):
 *   mark paid  `v4/otc/order_payed`   buyer, status 1        (OrderActV4.java:881, payedV4)
 *   cancel     `otc/order_cancel`     buyer, status 1 (or 2) (OrderAct.java:1767) — UI offers it at 1 only, as legacy did
 *   release    `otc/confirm_order`    seller, status 2, fund password (OrderAct.java:1946)
 *   appeal     `otc/complain_order`   either party, status 2 (OrderAct.java:2074); legacy waits 5 min after payTime
 *   un-appeal  `otc/complain_cancel`  complainant, status 5  (OrderAct.java:2188)
 */

export type OtcOrderStatus = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type OtcRole = 'buyer' | 'seller'

export type OtcStatusKey =
  | 'pending'
  | 'paid'
  | 'completed'
  | 'cancelled'
  | 'appeal'
  | 'releasing'
  | 'exception'
  | 'appealCompleted'
  | 'appealCancelled'
  | 'unknown'

const STATUS_KEYS: Record<number, OtcStatusKey> = {
  1: 'pending',
  2: 'paid',
  3: 'completed',
  4: 'cancelled',
  5: 'appeal',
  6: 'releasing',
  7: 'exception',
  8: 'appealCompleted',
  9: 'appealCancelled',
}

export function parseStatus(value: unknown): OtcOrderStatus | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^[1-9]$/.test(text)) return null
  return Number.parseInt(text, 10) as OtcOrderStatus
}

export function statusKey(status: OtcOrderStatus | null): OtcStatusKey {
  return status === null ? 'unknown' : STATUS_KEYS[status] ?? 'unknown'
}

export type StatusTone = 'warn' | 'info' | 'up' | 'muted' | 'down'

export function statusTone(status: OtcOrderStatus | null): StatusTone {
  switch (status) {
    case 1: return 'warn'
    case 2: case 6: return 'info'
    case 3: case 8: return 'up'
    case 5: case 7: return 'down'
    default: return 'muted'
  }
}

/** Terminal states never change again, so polling can stop. */
export function isTerminal(status: OtcOrderStatus | null): boolean {
  return status === 3 || status === 4 || status === 7 || status === 8 || status === 9
}

/** Role of the signed-in user: the server's `seller.uid` / `buyer.uid` compared with the session user id. */
export function resolveRole(userId: string, sellerUid: string, buyerUid: string): OtcRole | null {
  if (userId === '') return null
  if (userId === sellerUid) return 'seller'
  if (userId === buyerUid) return 'buyer'
  return null
}

/** Minimum wait after payment before an appeal may be filed (legacy `appealClick`: 300 000 ms). */
export const APPEAL_DELAY_MS = 5 * 60 * 1000

export interface OrderActionInput {
  status: OtcOrderStatus | null
  role: OtcRole | null
  /** `payTime` in ms (when the buyer marked paid); `null` when unknown. */
  payTime: number | null
  now: number
  /** `isComplainUser === 1`: the current user filed the running appeal. */
  isComplainUser: boolean
}

export interface OrderActions {
  markPaid: boolean
  cancel: boolean
  release: boolean
  appeal: boolean
  /** Appeal is the right action but still inside the 5-minute window. */
  appealLockedUntil: number | null
  cancelAppeal: boolean
  /** Counterparty payment accounts are visible (legacy `pays.js#showPay`). */
  showPaymentAccounts: boolean
  countdown: boolean
}

export function availableActions(input: OrderActionInput): OrderActions {
  const { status, role, payTime, now } = input
  const none: OrderActions = {
    markPaid: false, cancel: false, release: false, appeal: false, appealLockedUntil: null,
    cancelAppeal: false, showPaymentAccounts: false, countdown: false,
  }
  if (status === null || role === null) return none

  const result = { ...none }
  if (status === 1) {
    result.countdown = true
    result.showPaymentAccounts = true
    if (role === 'buyer') {
      result.markPaid = true
      result.cancel = true
    }
  } else if (status === 2) {
    if (role === 'seller') {
      result.release = true
      result.showPaymentAccounts = true
    }
    const unlockAt = payTime === null ? null : payTime + APPEAL_DELAY_MS
    if (unlockAt !== null && now < unlockAt) {
      result.appealLockedUntil = unlockAt
    } else {
      result.appeal = true
    }
  } else if (status === 5) {
    // `complain_cancel` (OrderAct.java:2188): status 5 and only the user who filed the appeal.
    // `confirm_order` (OrderAct.java:1946) rejects anything but status 2, so no release here.
    result.cancelAppeal = input.isComplainUser
  }
  return result
}

/** Status tabs of the "My orders" page and how each maps onto the web-api list endpoints. */
export type OrderTabId = 'pending' | 'paid' | 'appeal' | 'completed' | 'cancelled'

export interface OrderTabQuery {
  /** `order/otc/bystatus` with `status`, or `order/otc/complete` with `isShowCanceled`. */
  endpoint: 'bystatus' | 'complete'
  status?: OtcOrderStatus
  isShowCanceled?: 0 | 1
}

export const ORDER_TABS: readonly OrderTabId[] = ['pending', 'paid', 'appeal', 'completed', 'cancelled']

export function orderTabQuery(tab: OrderTabId): OrderTabQuery {
  switch (tab) {
    case 'pending': return { endpoint: 'bystatus', status: 1 }
    case 'paid': return { endpoint: 'bystatus', status: 2 }
    case 'appeal': return { endpoint: 'bystatus', status: 5 }
    // `complete` without cancelled rows = statuses 3, 7 and 8 (OrderAct.otcOrderCompletedList).
    case 'completed': return { endpoint: 'complete', isShowCanceled: 0 }
    case 'cancelled': return { endpoint: 'bystatus', status: 4 }
  }
}
