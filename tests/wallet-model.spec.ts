import { describe, expect, it } from 'vitest'
import type { PublicInfoV4 } from '@/modules/api/types'
import { buildCoinRows, defaultNetwork, isZeroRow, networkOptions, walletCoins } from '@/modules/wallet/coins'
import { normalizeHistoryPage, normalizeUserSecurity, safeExplorerUrl, splitAddressTag } from '@/modules/wallet/normalize'
import {
  requiredAddressBookCodes,
  requiredSecurityCodes,
  validateSecurityCodes,
  validateWithdrawDraft,
} from '@/modules/wallet/withdraw'
import type { WithdrawConfig } from '@/modules/wallet/types'

const config: WithdrawConfig = {
  coin: 'USDT',
  feeMin: '0.1',
  feeMax: '1',
  withdrawMin: '10',
  withdrawMax: '5000',
  defaultFee: '0.5',
  chainTip: '',
  addresses: [],
}

const context = {
  config,
  available: '100',
  dayMax: '2000',
  precision: 2,
}

describe('withdraw draft validation', () => {
  it('accepts a valid gross amount and returns the net for review only', () => {
    const result = validateWithdrawDraft({ addressId: '1', amount: '20', fee: '0.5' }, context)
    expect(result.ok).toBe(true)
    expect(result.net).toBe('19.5')
    expect(result.fee).toBe('0.5')
  })

  it('requires an address', () => {
    const result = validateWithdrawDraft({ addressId: '', amount: '20', fee: '0.5' }, context)
    expect(result.ok).toBe(false)
    expect(result.errors.map(e => e.field)).toContain('address')
  })

  it('rejects an amount that is not greater than the fee', () => {
    const result = validateWithdrawDraft({ addressId: '1', amount: '0.5', fee: '0.5' }, context)
    expect(result.errors.map(e => e.key)).toContain('wallet.withdraw.error.amountNotAboveFee')
  })

  it('rejects an amount above the available balance', () => {
    const result = validateWithdrawDraft({ addressId: '1', amount: '150', fee: '0.5' }, context)
    expect(result.errors.map(e => e.key)).toContain('wallet.withdraw.error.insufficient')
  })

  it('rejects a net below the minimum and above the maximum', () => {
    const below = validateWithdrawDraft({ addressId: '1', amount: '10.2', fee: '0.5' }, context)
    expect(below.errors.map(e => e.key)).toContain('wallet.withdraw.error.belowMin')

    const above = validateWithdrawDraft({ addressId: '1', amount: '6000', fee: '0.5' }, { ...context, available: '10000' })
    expect(above.errors.map(e => e.key)).toContain('wallet.withdraw.error.aboveMax')
  })

  it('enforces the remaining daily quota when the server returns it', () => {
    const result = validateWithdrawDraft(
      { addressId: '1', amount: '3000', fee: '0.5' },
      { ...context, available: '10000', dayMax: '2000' },
    )
    expect(result.errors.map(e => e.key)).toContain('wallet.withdraw.error.aboveDayMax')
  })

  it('enforces the coin precision without rounding the value', () => {
    const result = validateWithdrawDraft({ addressId: '1', amount: '20.123', fee: '0.5' }, context)
    expect(result.errors.map(e => e.key)).toContain('wallet.withdraw.error.precision')
  })

  it('enforces the fee range', () => {
    const low = validateWithdrawDraft({ addressId: '1', amount: '20', fee: '0.05' }, context)
    expect(low.errors.map(e => e.key)).toContain('wallet.withdraw.error.feeBelowMin')

    const high = validateWithdrawDraft({ addressId: '1', amount: '20', fee: '2' }, context)
    expect(high.errors.map(e => e.key)).toContain('wallet.withdraw.error.feeAboveMax')
  })

  it('accepts a zero fee when the configured range is 0-0 and never accepts a negative fee', () => {
    const zeroRange = { ...context, config: { ...config, feeMin: '0', feeMax: '0' } }
    const zeroFee = validateWithdrawDraft({ addressId: '1', amount: '20', fee: '0' }, zeroRange)
    expect(zeroFee.ok).toBe(true)
    expect(zeroFee.net).toBe('20')

    expect(validateWithdrawDraft({ addressId: '1', amount: '20', fee: '0' }, context).ok).toBe(false)
    const negative = validateWithdrawDraft({ addressId: '1', amount: '20', fee: '-0.5' }, zeroRange)
    expect(negative.ok).toBe(false)
    expect(negative.errors.map(e => e.key)).toContain('wallet.withdraw.error.feeInvalid')
  })

  it('treats an empty withdraw_max as "no upper bound" and empty available as unknown', () => {
    const unbounded = validateWithdrawDraft(
      { addressId: '1', amount: '999999', fee: '0.5' },
      { config: { ...config, withdrawMax: '' }, available: '', dayMax: '', precision: 2 },
    )
    expect(unbounded.ok).toBe(true)
  })
})

describe('security code requirements', () => {
  it.each([
    { googleStatus: 1 },
    { isOpenMobileCheck: 0 },
    { googleStatus: 1, isOpenMobileCheck: 'unexpected' },
    { googleStatus: 'unexpected', isOpenMobileCheck: 0 },
  ])('blocks incomplete or invalid factor states: %j', (user) => {
    expect(normalizeUserSecurity(user).known).toBe(false)
  })

  it('accepts explicitly reported enabled and disabled factors', () => {
    expect(normalizeUserSecurity({ googleStatus: '1', isOpenMobileCheck: '0' }))
      .toMatchObject({ known: true, googleEnabled: true, mobileCheckEnabled: false })
  })
  it('always requires Google for the CIAO withdrawal and adds email/SMS by account state', () => {
    expect(requiredSecurityCodes({ googleEnabled: true, mobileCheckEnabled: true, email: 'a@b.c' }))
      .toEqual({ google: true, email: true, sms: false })
    expect(requiredSecurityCodes({ googleEnabled: false, mobileCheckEnabled: true, email: '' }))
      .toEqual({ google: true, email: false, sms: true })
  })

  it('uses the distinct legacy address-book add and delete factor matrices', () => {
    expect(requiredAddressBookCodes({ mobileCheckEnabled: true, email: 'a@b.c' }))
      .toEqual({ google: true, email: true, sms: false })
    expect(requiredAddressBookCodes({ mobileCheckEnabled: false, email: '' }))
      .toEqual({ google: true, email: false, sms: false })
    expect(requiredAddressBookCodes({ googleEnabled: true, mobileCheckEnabled: true, email: 'a@b.c' }, 'delete'))
      .toEqual({ google: true, email: false, sms: true })
    expect(requiredAddressBookCodes({ googleEnabled: false, mobileCheckEnabled: true, email: 'a@b.c' }, 'delete'))
      .toEqual({ google: false, email: false, sms: true })
  })

  it('rejects missing or malformed codes and accepts exactly six digits', () => {
    const required = { google: true, email: true, sms: false }
    const errors = validateSecurityCodes({ googleCode: '12345', smsAuthCode: '', emailValidCode: '123456' }, required)
    expect(errors.map(e => e.key)).toEqual(['wallet.withdraw.error.googleRequired'])

    expect(validateSecurityCodes({ googleCode: '123456', smsAuthCode: '', emailValidCode: '123456' }, required)).toEqual([])
    expect(validateSecurityCodes({ googleCode: '123456', smsAuthCode: '', emailValidCode: '123' }, required))
      .toEqual([{ field: 'code', key: 'wallet.withdraw.error.emailRequired' }])
  })
})

describe('coin rows and unknown flags', () => {
  const publicInfo = {
    market: {
      coinList: {
        BTC: { showName: 'Bitcoin', showPrecision: 8 },
        USDT: { showName: 'Tether', showPrecision: 6, mainChainType: 1 },
        XRP: { showName: 'Ripple', showPrecision: 6, tagType: 1 },
      },
      followCoinList: {
        USDT: { USDT: { mainChainName: 'TRC20', showPrecision: 6 }, USDTETH: { mainChainName: 'ERC20', showPrecision: 6 } },
      },
    },
  } as unknown as PublicInfoV4

  it('keeps an unreported open flag as unknown instead of guessing', () => {
    const rows = buildCoinRows({ BTC: { normal_balance: '1', lock_balance: '0', total_balance: '1' } }, publicInfo)
    expect(rows[0].depositOpen).toBeNull()
    expect(rows[0].withdrawOpen).toBeNull()
  })

  it('reads explicit server flags', () => {
    const rows = buildCoinRows(
      { USDT: { normal_balance: '5', depositOpen: 0, withdrawOpen: '1' } },
      publicInfo,
    )
    expect(rows[0].depositOpen).toBe(false)
    expect(rows[0].withdrawOpen).toBe(true)
  })

  it('detects zero rows only from reported values', () => {
    const [zero] = buildCoinRows({ BTC: { normal_balance: '0', lock_balance: '0', total_balance: '0' } }, publicInfo)
    expect(isZeroRow(zero)).toBe(true)

    const [unknown] = buildCoinRows({ BTC: {} }, publicInfo)
    expect(isZeroRow(unknown)).toBe(false)
  })

  it('derives network options only from the server branch map', () => {
    expect(networkOptions(publicInfo, 'BTC')).toEqual([])
    expect(networkOptions(publicInfo, 'USDT')).toEqual([
      { code: 'USDT', label: 'TRC20' },
      { code: 'USDTETH', label: 'ERC20' },
    ])
    expect(defaultNetwork(publicInfo, 'USDT')).toBe('USDT')
  })

  it('drops fiat coins from the wallet coin list', () => {
    const rows = walletCoins({ USD: { normal_balance: '1', isFiat: 1 } }, publicInfo)
    expect(rows).toEqual([])
  })

  it('splits a legacy address_tag on the first underscore', () => {
    expect(splitAddressTag('addr_tag_extra')).toEqual({ address: 'addr', tag: 'tag_extra' })
    expect(splitAddressTag('addr')).toEqual({ address: 'addr', tag: '' })
  })
})

describe('history normalization and explorer links', () => {
  it('parses the count and keeps the raw withdrawal status', () => {
    const page = normalizeHistoryPage(
      { count: '3', financeList: [{ id: 1, status: 2, status_text: 'done' }, { id: 2, status: '0' }] },
      'withdraw',
    )
    expect(page.count).toBe(3)
    expect(page.list.map(entry => entry.status)).toEqual(['2', '0'])
  })

  it('only adopts http(s) explorer URLs', () => {
    expect(safeExplorerUrl('https://explorer.example/tx/1')).toBe('https://explorer.example/tx/1')
    expect(safeExplorerUrl('javascript:alert(1)')).toBe('')
    expect(safeExplorerUrl('not a url')).toBe('')
    expect(safeExplorerUrl('')).toBe('')
  })
})
