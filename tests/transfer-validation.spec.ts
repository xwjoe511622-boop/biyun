import { describe, expect, it } from 'vitest'
import { buildTransferRequest, futuresGateView, futuresOutboundSupported, routeOf, swapAccounts, validateTransfer } from '@/modules/transfer/transfer'

const base = { from: 'spot' as const, to: 'margin' as const, coin: 'USDT', amount: '10', marginSymbol: 'btcusdt' }

describe('transfer routes', () => {
  it('only allows the routes the server has endpoints for', () => {
    expect(routeOf('spot', 'margin')).toBe('spotToMargin')
    expect(routeOf('margin', 'spot')).toBe('marginToSpot')
    expect(routeOf('spot', 'futures')).toBe('spotToFutures')
    expect(routeOf('futures', 'spot')).toBe('futuresToSpot')
    expect(routeOf('margin', 'futures')).toBeNull()
    expect(routeOf('futures', 'margin')).toBeNull()
  })

  it('treats a blank or "0" futures_type as private futures (both directions)', () => {
    expect(futuresOutboundSupported('')).toBe(true)
    expect(futuresOutboundSupported(undefined)).toBe(true)
    expect(futuresOutboundSupported('0')).toBe(true)
    expect(futuresOutboundSupported('1')).toBe(false)
  })

  it('swaps direction', () => {
    expect(swapAccounts({ from: 'spot', to: 'futures' })).toEqual({ from: 'futures', to: 'spot' })
  })
})

describe('transfer validation', () => {
  it('rejects identical accounts and margin↔futures', () => {
    expect(validateTransfer({ ...base, to: 'spot' }, { available: '100', precision: 8 }).errors[0].key).toBe('sameAccount')
    expect(validateTransfer({ ...base, from: 'margin', to: 'futures' }, { available: '100', precision: 8 }).errors[0].key).toBe('viaSpot')
  })

  it('refuses futures → spot in futures-cloud mode', () => {
    const result = validateTransfer({ ...base, from: 'futures', to: 'spot', marginSymbol: '' }, { available: '', precision: 8, futuresType: '1' })
    expect(result.errors.map(entry => entry.key)).toContain('futuresOutUnsupported')
  })

  it('requires a margin pair when margin is involved and an allowed coin', () => {
    expect(validateTransfer({ ...base, marginSymbol: '' }, { available: '100', precision: 8 }).errors.map(entry => entry.key)).toContain('symbolRequired')
    expect(validateTransfer({ ...base, coin: 'ETH' }, { available: '100', precision: 8, allowedCoins: ['BTC', 'USDT'] }).errors.map(entry => entry.key)).toContain('coinUnsupported')
  })

  it('checks amount format, precision and available balance', () => {
    const context = { available: '100', precision: 8 }
    expect(validateTransfer({ ...base, amount: '' }, context).errors[0].key).toBe('required')
    expect(validateTransfer({ ...base, amount: '-1' }, context).errors[0].key).toBe('invalid')
    expect(validateTransfer({ ...base, amount: '0' }, context).errors[0].key).toBe('positive')
    expect(validateTransfer({ ...base, amount: '1.123456789' }, context).errors[0].key).toBe('precision')
    expect(validateTransfer({ ...base, amount: '100.1' }, context).errors[0]).toEqual({ field: 'amount', key: 'insufficient', params: { available: '100' } })
    const ok = validateTransfer({ ...base, amount: '100.00' }, context)
    expect(ok.ok).toBe(true)
    expect(ok.amount).toBe('100')
    expect(ok.route).toBe('spotToMargin')
  })

  it('skips the client max when the source balance is unknown (server decides)', () => {
    expect(validateTransfer({ ...base, from: 'futures', to: 'spot' }, { available: '', precision: 8 }).ok).toBe(true)
  })
})

describe('transfer requests', () => {
  it('builds lever/finance/transfer with 1 = spot, 2 = margin', () => {
    expect(buildTransferRequest('spotToMargin', { coin: 'usdt', amount: '5', marginSymbol: 'BTCUSDT' })).toEqual({
      path: 'lever/finance/transfer',
      body: { fromAccount: '1', toAccount: '2', amount: '5', coinSymbol: 'USDT', symbol: 'btcusdt' },
    })
    expect(buildTransferRequest('marginToSpot', { coin: 'BTC', amount: '0.1', marginSymbol: 'btcusdt' }).body).toMatchObject({ fromAccount: '2', toAccount: '1' })
  })

  it('builds contract/co_transfer with the TransactionScene values', () => {
    expect(buildTransferRequest('spotToFutures', { coin: 'USDT', amount: '5', marginSymbol: '' })).toEqual({
      path: 'contract/co_transfer',
      body: { transferType: 'wallet_to_contract', amount: '5', coinSymbol: 'USDT' },
    })
    expect(buildTransferRequest('futuresToSpot', { coin: 'USDT', amount: '5', marginSymbol: '' }).body.transferType).toBe('contract_to_wallet')
  })
})

describe('futuresGateView', () => {
  it('only a confirmed futures account lets a futures route through; everything else waits or errors', () => {
    expect(futuresGateView(false, undefined)).toBe('ok')
    expect(futuresGateView(false, 'unopened')).toBe('ok')
    expect(futuresGateView(true, 'opened')).toBe('ok')
    expect(futuresGateView(true, 'unopened')).toBe('preparing')
    expect(futuresGateView(true, 'opening')).toBe('preparing')
    expect(futuresGateView(true, 'checking')).toBe('preparing')
    expect(futuresGateView(true, 'signedOut')).toBe('preparing')
    expect(futuresGateView(true, undefined)).toBe('preparing')
    expect(futuresGateView(true, 'error')).toBe('error')
  })
})
