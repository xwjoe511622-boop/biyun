import { describe, expect, it } from 'vitest'
import { parseJsonLossless, quoteUnsafeIntegers } from '@/core/lossless-json'
import { parseLosslessJson } from '@/modules/futures/fapi'
import { normalizeOrders } from '@/modules/futures/types'

/**
 * Owner 10-22: 订单号太大…这种问题一定要规避. Futures order ids are 63-bit snowflakes (3521837122174533632 on prod);
 * plain JSON.parse rounds them to 3521837122174533600 and the cancel hits "Unknown order".
 */
const BIG = '3521837122174533632'

describe('parseJsonLossless', () => {
  it('keeps ids above 2^53 exact under any key, nested and in arrays', () => {
    const text = `{"orderId":${BIG},"id":${BIG},"list":[{"bidId":${BIG}}],"ids":[${BIG},1],"a":-${BIG}}`
    const v = parseJsonLossless(text) as Record<string, unknown>
    expect(v.orderId).toBe(BIG)
    expect(v.id).toBe(BIG)
    expect((v.list as Record<string, unknown>[])[0]?.bidId).toBe(BIG)
    expect(v.ids).toEqual([BIG, 1])
    expect(v.a).toBe(`-${BIG}`)
  })

  it('leaves safe integers, decimals, strings and time keys alone', () => {
    const text = `{"n":9007199254740991,"d":1234567890123456.5,"s":"x ${BIG} \\" ${BIG}","time":1792655359047123456,"T":1792655359047,"ctimeTs":1792655359047123456}`
    const v = parseJsonLossless(text) as Record<string, unknown>
    expect(v.n).toBe(9007199254740991)
    expect(v.d).toBe(1234567890123456.5)
    expect(v.s).toBe(`x ${BIG} " ${BIG}`)
    expect(typeof v.time).toBe('number')
    expect(v.T).toBe(1792655359047)
    expect(typeof v.ctimeTs).toBe('number')
  })

  it('is a no-op on text without long digit runs', () => {
    const text = '{"a":[1,2,{"b":"c"}],"d":null}'
    expect(quoteUnsafeIntegers(text)).toBe(text)
  })

  it('handles a key whose string contains escaped quotes and colons', () => {
    const v = parseJsonLossless(`{"we\\"ird:":${BIG},"k":[[${BIG}]]}`) as Record<string, unknown>
    expect(v['we"ird:']).toBe(BIG)
    expect(v.k).toEqual([[BIG]])
  })

  it('backs the Binance-style futures parser (every id field, not a key list)', () => {
    const v = parseLosslessJson(`{"orderId":${BIG},"positionId":${BIG},"a":${BIG}}`) as Record<string, unknown>
    expect(v).toEqual({ orderId: BIG, positionId: BIG, a: BIG })
  })

  it('lets the classic futures order list keep the exact id the cancel sends back', () => {
    const data = parseJsonLossless(`{"orderList":[{"id":${BIG},"contractId":1,"side":"BUY","price":"1","volume":"1","status":0}],"count":1}`)
    const { rows } = normalizeOrders(data)
    expect(rows[0]?.id).toBe(BIG)
  })
})
