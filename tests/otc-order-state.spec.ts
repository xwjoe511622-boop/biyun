import { describe, expect, it } from 'vitest'
import {
  APPEAL_DELAY_MS,
  availableActions,
  isTerminal,
  orderTabQuery,
  parseStatus,
  resolveRole,
  statusKey,
  type OrderActionInput,
} from '@/modules/otc/order-state'

const NOW = 1_700_000_000_000

function input(partial: Partial<OrderActionInput>): OrderActionInput {
  return { status: 1, role: 'buyer', payTime: null, now: NOW, isComplainUser: false, ...partial }
}

describe('otc order state machine', () => {
  it('parses only known status codes', () => {
    expect(parseStatus(1)).toBe(1)
    expect(parseStatus('5')).toBe(5)
    expect(parseStatus('10')).toBeNull()
    expect(parseStatus('')).toBeNull()
    expect(parseStatus(null)).toBeNull()
    expect(statusKey(9)).toBe('appealCancelled')
    expect(statusKey(null)).toBe('unknown')
  })

  it('treats 3/4/7/8/9 as terminal', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].filter(s => isTerminal(s as never))).toEqual([3, 4, 7, 8, 9])
  })

  it('resolves the role from the server uids', () => {
    expect(resolveRole('7', '7', '9')).toBe('seller')
    expect(resolveRole('9', '7', '9')).toBe('buyer')
    expect(resolveRole('3', '7', '9')).toBeNull()
    expect(resolveRole('', '', '')).toBeNull()
  })

  it('pending: buyer can pay or cancel, seller only waits; both see the countdown', () => {
    const buyer = availableActions(input({ status: 1, role: 'buyer' }))
    expect(buyer).toMatchObject({ markPaid: true, cancel: true, release: false, appeal: false, countdown: true, showPaymentAccounts: true })
    const seller = availableActions(input({ status: 1, role: 'seller' }))
    expect(seller).toMatchObject({ markPaid: false, cancel: false, release: false, countdown: true })
  })

  it('paid: only the seller releases; appeal unlocks 5 minutes after payTime', () => {
    const payTime = NOW - 60_000
    const seller = availableActions(input({ status: 2, role: 'seller', payTime }))
    expect(seller.release).toBe(true)
    expect(seller.appeal).toBe(false)
    expect(seller.appealLockedUntil).toBe(payTime + APPEAL_DELAY_MS)
    const buyer = availableActions(input({ status: 2, role: 'buyer', payTime }))
    expect(buyer.release).toBe(false)
    expect(buyer.markPaid).toBe(false)
    expect(buyer.cancel).toBe(false)

    const later = availableActions(input({ status: 2, role: 'buyer', payTime, now: payTime + APPEAL_DELAY_MS }))
    expect(later.appeal).toBe(true)
    expect(later.appealLockedUntil).toBeNull()
  })

  it('paid with unknown payTime does not block the appeal', () => {
    expect(availableActions(input({ status: 2, role: 'buyer', payTime: null })).appeal).toBe(true)
  })

  it('appeal: only the complainant can withdraw; nobody can release (server needs status 2)', () => {
    expect(availableActions(input({ status: 5, role: 'buyer', isComplainUser: true })).cancelAppeal).toBe(true)
    expect(availableActions(input({ status: 5, role: 'seller', isComplainUser: false })).cancelAppeal).toBe(false)
    expect(availableActions(input({ status: 5, role: 'seller' })).release).toBe(false)
  })

  it('terminal and unknown states expose no action', () => {
    for (const status of [3, 4, 7, 8, 9] as const) {
      const actions = availableActions(input({ status, role: 'buyer', payTime: 0 }))
      expect(Object.values(actions).filter(v => v === true)).toEqual([])
    }
    expect(availableActions(input({ status: 1, role: null })).markPaid).toBe(false)
    expect(availableActions(input({ status: null })).cancel).toBe(false)
  })

  it('maps order tabs onto the web-api list endpoints', () => {
    expect(orderTabQuery('pending')).toEqual({ endpoint: 'bystatus', status: 1 })
    expect(orderTabQuery('paid')).toEqual({ endpoint: 'bystatus', status: 2 })
    expect(orderTabQuery('appeal')).toEqual({ endpoint: 'bystatus', status: 5 })
    expect(orderTabQuery('cancelled')).toEqual({ endpoint: 'bystatus', status: 4 })
    expect(orderTabQuery('completed')).toEqual({ endpoint: 'complete', isShowCanceled: 0 })
  })
})
