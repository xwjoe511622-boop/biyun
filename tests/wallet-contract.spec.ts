import { describe, expect, it } from 'vitest'
import Decimal from 'decimal.js'
import {
  buildAddAddressBody,
  buildCancelWithdrawBody,
  buildDeleteAddressBody,
  buildWithdrawRequestBody,
  toNumericId,
} from '@/modules/wallet/withdrawRequest'

/**
 * The withdrawal body is RSA/AES-encrypted before it reaches the wire, so these tests assert the
 * plaintext contract directly against the CIAO `WithdrawDTO` / `CancelWithdrawDTO` and the legacy
 * `AddrAct` sources (see `withdrawRequest.ts`).
 */

const draft = {
  // The Rust wallet backend requires a client idempotency key; builder tests must carry a valid UUID.
  requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  symbol: 'USDT',
  addressId: '7',
  amount: '20',
  fee: '0.5',
  googleCode: '123456',
  smsAuthCode: '',
  emailValidCode: '',
}

describe('CIAO withdraw request body', () => {
  it('posts the GROSS amount (never the computed net)', () => {
    const body = buildWithdrawRequestBody(draft)
    // The server derives payAmount = amount - fee = 19.5; the wire value stays gross.
    expect(body.amount).toBe('20')
    expect(body.fee).toBe('0.5')
    expect(new Decimal(body.amount).minus(body.fee).toFixed()).toBe('19.5')
    expect(body.amount).not.toBe('19.5')
  })

  it('accepts a zero fee and a numeric addressId', () => {
    const body = buildWithdrawRequestBody({ ...draft, fee: '0' })
    expect(body.fee).toBe('0')
    expect(body.addressId).toBe(7)
    expect(typeof body.addressId).toBe('number')
  })

  it('omits optional sms/email codes when blank and keeps them when provided', () => {
    const blank = buildWithdrawRequestBody(draft)
    expect(Object.prototype.hasOwnProperty.call(blank, 'smsAuthCode')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(blank, 'emailValidCode')).toBe(false)

    const withCodes = buildWithdrawRequestBody({ ...draft, smsAuthCode: '654321', emailValidCode: '111111' })
    expect(withCodes.smsAuthCode).toBe('654321')
    expect(withCodes.emailValidCode).toBe('111111')
  })

  it('requires a 6-digit Google code and forbids negative amount/fee', () => {
    expect(() => buildWithdrawRequestBody({ ...draft, googleCode: '12345' })).toThrow(/6 位/)
    expect(() => buildWithdrawRequestBody({ ...draft, googleCode: '' })).toThrow(/6 位/)
    expect(() => buildWithdrawRequestBody({ ...draft, fee: '-0.5' })).toThrow(/非负/)
    expect(() => buildWithdrawRequestBody({ ...draft, amount: '-1' })).toThrow(/大于 0/)
    // A net that would go negative is rejected as well.
    expect(() => buildWithdrawRequestBody({ ...draft, amount: '0.5', fee: '0.5' })).toThrow(/大于手续费/)
  })
})

describe('numeric id building', () => {
  it('converts server ids to integers and rejects anything else', () => {
    expect(toNumericId('11', 'ids')).toBe(11)
    expect(() => toNumericId('w-9', 'withdrawId')).toThrow(/整数/)
    expect(buildCancelWithdrawBody('9')).toEqual({ withdrawId: 9 })
  })
})

describe('legacy address-book bodies', () => {
  it('sends delete ids as numbers with only the checked code fields', () => {
    expect(buildDeleteAddressBody(['11'], { googleCode: '111111', smsValidCode: '' }))
      .toEqual({ ids: [11], googleCode: '111111' })
    expect(buildDeleteAddressBody(['11', '12'], { googleCode: '', smsValidCode: '222222' }))
      .toEqual({ ids: [11, 12], smsValidCode: '222222' })
    // Both codes absent would be rejected server-side; the client must not send that request.
    expect(() => buildDeleteAddressBody(['11'], { googleCode: '', smsValidCode: '' })).toThrow(/验证码/)
    expect(() => buildDeleteAddressBody([], { googleCode: '111111', smsValidCode: '' })).toThrow(/至少一个 id/)
  })

  it('omits blank optional codes on add', () => {
    const body = buildAddAddressBody({
      coinSymbol: 'XRP',
      address: 'rAddr_memo',
      label: 'cold',
      googleCode: '123456',
      smsValidCode: '',
      emailValidCode: '',
    })
    expect(body).toEqual({ coinSymbol: 'XRP', address: 'rAddr_memo', label: 'cold', googleCode: '123456' })
  })
})
