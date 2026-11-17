// @vitest-environment jsdom
/**
 * Stable numeric codes, localised by the frontend (2026-10-01): (product, code) tables, sub-reasons, the 200011
 * "result unknown" flow, guard sub-reasons and the per-id `order_tpsl_cancel` results.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import { clearToasts } from '@/core/toast'
import {
  FUTURES_CODES,
  SPOT_CODES,
  describeApiError,
  describeTpslCancel,
  guardedRefresh,
  isAuthUnavailable,
  isOrderResultUnknown,
  isServiceUnavailable,
  orderUnconfirmedText,
  subReasonText,
  tpslCancelOutcome,
} from '@/modules/api/error-codes'
import { describeGuardError } from '@/modules/api/guard-errors'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { describeFuturesGateError } from '@/modules/transfer/errors'
import type { CreateOrderPayload } from '@/modules/futures/api'
import { buildContract } from '@/modules/futures/contracts'
import { normalizePublicInfo } from '@/modules/futures/types'
import { useFuturesAccountStore } from '@/stores/futures-account'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesOrdersStore } from '@/stores/futures-orders'

// Archived vendor enums define the compatibility-code coverage; current Rust codes remain the runtime authority.
// (Node's fs through a non-literal specifier: the app tsconfig has no Node types, and vite's fs.allow denies `?raw`
// imports outside the app root.)
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { readFileSync(path: string, encoding: 'utf8'): string; existsSync(path: string): boolean }
const testProcess = (globalThis as unknown as { process: { cwd(): string; env: Record<string, string | undefined> } }).process
// Optional cross-repository comparison only. Backend source is deliberately absent from this delivery.
const BACKEND = testProcess.env.LB_VENDOR_SOURCE_ROOT
const readVendor = (relative: string): string => BACKEND && fs.existsSync(`${BACKEND}/${relative}`) ? fs.readFileSync(`${BACKEND}/${relative}`, 'utf8') : ''
const futuresEnumSource = readVendor('back-futures/futures-common/futures-entity/src/main/java/com/chainup/futures/common/enums/ApiResultCode.java')
const spotEnumSource = readVendor('back-exchange/ex-parent/exchange-common/src/main/java/com/chainup/common/result/WebApiResultType.java')

/** Every integer code declared by a Java enum constant (`NAME(10018, "…"` or `NAME("10018", "…"`). */
function enumCodes(source: string): number[] {
  const codes = new Set<number>()
  for (const match of source.matchAll(/^\s+[A-Za-z_][A-Za-z0-9_]*\(\s*"?(-?\d+)"?\s*,/gm)) codes.add(Number(match[1]))
  return [...codes]
}

const CJK = /[一-鿿]/
const futures = (code: string, message = '', data?: unknown): ApiError => new ApiError({ kind: 'api', code, message, data, product: 'futures' })
const spot = (code: string, message = '', data?: unknown): ApiError => new ApiError({ kind: 'api', code, message, data, product: 'spot' })

describe('code tables cover the Java enums (drift guard)', () => {
  const vendorTest = futuresEnumSource && spotEnumSource ? it : it.skip
  vendorTest.each([
    ['futures ApiResultCode', futuresEnumSource, FUTURES_CODES],
    ['spot WebApiResultType', spotEnumSource, SPOT_CODES],
  ] as const)('%s: every code has a zh and an en text', (_name, source, table) => {
    const codes = enumCodes(source)
    expect(codes.length).toBeGreaterThan(100)
    const missing = codes.filter((code) => table[code] === undefined)
    expect(missing).toEqual([])
    for (const code of codes) {
      const [zh, en] = table[code]
      expect(zh.trim(), `zh ${code}`).not.toBe('')
      expect(en.trim(), `en ${code}`).not.toBe('')
      expect(CJK.test(en), `en ${code} has Chinese: ${en}`).toBe(false)
    }
  })

  it('includes the 2026-10-01 futures codes', () => {
    for (const code of [10018, 10019, 10072, 10077, 10078, 10079, 10082, 10090, 101003, 200004, 200009, 200010, 200011, 200013, 200014, 200015]) {
      expect(FUTURES_CODES[code], String(code)).toBeDefined()
    }
  })
})

describe('describeApiError', () => {
  it('same number, different product, different text', () => {
    expect(describeApiError(futures('10001', 'x'), 'zh_CN')).toBe('可用余额不足')
    expect(describeApiError(spot('10001', 'x'), 'zh_CN')).toBe('系统繁忙，请稍后重试')
    expect(describeApiError(futures('10013'), 'en_US')).toBe('Exceeds the maximum position for the current leverage')
    expect(describeApiError(spot('10013'), 'en_US')).toBe('This phone number is already registered')
  })

  it('normalises the code with Number() (string or number on the wire)', () => {
    expect(describeApiError(futures(' 10082 '), 'zh_CN')).toBe('订单已成交或已撤销')
    expect(new ApiError({ kind: 'api', code: '10082', message: '' }).codeNumber).toBe(10082)
  })

  it('adds data.param / data.reason as readable sub-reasons', () => {
    expect(describeApiError(futures('10018', 'missing', { param: 'volume' }), 'zh_CN')).toBe('缺少必填参数（数量）')
    expect(describeApiError(futures('10018', 'missing', { param: 'volume' }), 'en_US')).toBe('Missing required parameter (quantity)')
    expect(describeApiError(futures('10019', '', { param: 'triggerPrice' }), 'zh_CN')).toBe('参数须为数字（触发价）')
    expect(describeApiError(futures('10078', '', { param: 'price', reason: 'NOT_POSITIVE' }), 'en_US'))
      .toBe('Invalid price: limit-type orders need a price above 0 (price: must be above 0)')
    expect(describeApiError(futures('200004', '', { param: 'contractId', reason: 'NOT_NUMBER' }), 'zh_CN')).toBe('参数不合法（合约：不是有效数字）')
    expect(describeApiError(futures('200009', '', { param: 'leverageLevel' }), 'zh_CN')).toBe('数值参数不合法（精度或范围）（杠杆倍数）')
    expect(describeApiError(futures('200010', '', { reason: 'CONNECT_FAILED' }), 'zh_CN')).toBe('服务暂时不可用，请求未执行，可以重试（服务连接失败）')
    expect(describeApiError(futures('10072', '', { param: 'fancyField' }), 'en_US')).toBe('Unsupported order type (fancyField)')
    expect(subReasonText({ reason: 'SOMETHING_INTERNAL' }, 'zh_CN')).toBe('')
  })

  it('falls back to the server msg, then to a generic code text', () => {
    expect(describeApiError(futures('987654', '服务器原文'), 'zh_CN')).toBe('服务器原文')
    expect(describeApiError(futures('987654', ''), 'zh_CN')).toBe('错误码 987654')
    expect(describeApiError(futures('987654', '接口返回错误码 987654'), 'en_US')).toBe('Error 987654')
    expect(describeApiError(spot('-1', ''), 'zh_CN')).toBe('请求未执行（服务端未返回原因），请稍后重试')
  })

  it('keeps server text with values for template codes when it is in the UI language', () => {
    expect(describeApiError(spot('10019', '用户名或密码错误,您还有3次机会'), 'zh_CN')).toBe('用户名或密码错误,您还有3次机会')
    expect(describeApiError(spot('10019', '用户名或密码错误,您还有3次机会'), 'en_US')).toBe('Incorrect username or password')
    expect(describeApiError(spot('10999', '该币种暂停交易'), 'zh_CN')).toBe('该币种暂停交易')
  })

  it('reuses the transfer and wallet wording for their own codes', () => {
    expect(describeApiError(spot('105005'), 'zh_CN')).toContain('未实现盈利不可划转')
    expect(describeApiError(spot('110102'), 'en_US')).toBe('This network does not support the coin, or the network does not match the coin')
  })

  it('leaves transport errors and code-less HTTP failures readable', () => {
    expect(describeApiError(new ApiError({ kind: 'timeout', code: '', message: '请求超时' }), 'zh_CN')).toBe('请求超时')
    expect(describeApiError(new ApiError({ kind: 'http', code: '502', status: 502, message: 'HTTP 502 Bad Gateway', product: 'futures' }), 'zh_CN'))
      .toBe('服务暂时不可用（HTTP 502），请稍后重试')
    expect(describeApiError(new ApiError({ kind: 'http', code: '200014', status: 404, message: 'Unknown endpoint', data: { status: 404, path: '/x' }, product: 'futures' }), 'zh_CN'))
      .toBe('接口不存在')
    expect(describeApiError(new Error('boom'), 'zh_CN')).toBe('boom')
  })
})

describe('guard sub-reasons (-1013 / -2010 / -1003 / -1015)', () => {
  const guard = (code: string, data: unknown, message = 'Filter failure: LOT_SIZE. quantity must be >= 0.001', status = 200) =>
    new ApiError({ kind: status === 200 ? 'api' : 'http', code, message, data, status, product: 'futures' })

  it('builds the text from data.reason and the numeric fields', () => {
    expect(describeApiError(guard('-1013', { filter: 'LOT_SIZE', reason: 'QTY_TOO_SMALL', minQty: 0.001, minContracts: 10, quantity: 0.0005 }), 'zh_CN'))
      .toBe('不符合下单规则：数量太小：至少 0.001（10 张）')
    expect(describeApiError(guard('-1013', { reason: 'TICK_SIZE', tickSize: '0.1' }), 'en_US')).toBe('Order rejected by trading rules: price must be a multiple of 0.1')
    expect(describeApiError(guard('-1013', { reason: 'NOTIONAL_TOO_SMALL', minNotional: 50, notional: 12.5 }), 'zh_CN'))
      .toBe('不符合下单规则：订单金额太小：至少 50 USDT（当前约 12.5 USDT）')
    expect(describeApiError(guard('-1013', { reason: 'STEP_SIZE', stepSize: 1e-8 }), 'zh_CN')).toBe('不符合下单规则：数量须为 0.00000001 的整数倍')
    expect(describeApiError(guard('-1013', { reason: 'PRICE_TOO_HIGH', maxPrice: 87150, markPrice: 83000 }), 'zh_CN'))
      .toBe('不符合下单规则：价格太高：最高 87150（标记价格 83000）')
    expect(describeApiError(guard('-2010', { reason: 'SELF_TRADE', ownOrderPrice: 83000 }), 'zh_CN'))
      .toBe('自成交保护：新单会与您自己价格为 83000 的挂单成交，已取消新单（请先撤掉该挂单或调整价格）')
    expect(describeApiError(guard('-1015', { reason: 'ORDERS_10S', limit: 20, used: 21, retryAfter: 3 }, 'Too many new orders', 429), 'zh_CN'))
      .toBe('下单过于频繁：每 10 秒最多 20 笔新订单，请 3 秒后再试（撤单、平仓不受限）')
    expect(describeApiError(guard('-1003', { reason: 'BANNED', retryAfter: 120 }, 'banned', 418), 'en_US'))
      .toBe('Too many requests: temporarily banned after repeated rate-limit hits for 120s (cancels and closes still work)')
  })

  it('falls back to the server msg when a needed field is missing or the reason is unknown', () => {
    expect(describeGuardError(guard('-1013', { reason: 'QTY_TOO_SMALL' }), 'en_US')).toBe('Order rejected by trading rules: quantity must be >= 0.001')
    expect(describeGuardError(guard('-1013', { reason: 'NEW_THING' }), 'en_US')).toBe('Order rejected by trading rules: quantity must be >= 0.001')
  })
})

describe('special futures codes', () => {
  it('200011 and a timed-out request mean "result unknown"', () => {
    expect(isOrderResultUnknown(futures('200011', '', { reason: 'TIMEOUT' }))).toBe(true)
    expect(isOrderResultUnknown(new ApiError({ kind: 'timeout', code: '', message: 't' }))).toBe(true)
    expect(isOrderResultUnknown(spot('200011'))).toBe(false)
    expect(isOrderResultUnknown(futures('200010'))).toBe(false)
    expect(describeApiError(futures('200011', '', { reason: 'TIMEOUT' }), 'zh_CN')).toBe('下单结果未确认：请勿重复提交，正在刷新委托列表…')
    expect(orderUnconfirmedText('en_US')).toBe('Order result not confirmed — do not resubmit; refreshing your open orders…')
  })

  it('200010 says it can be retried; 200013 is not a sign-out', () => {
    expect(isServiceUnavailable(futures('200010'))).toBe(true)
    expect(describeApiError(futures('200010'), 'en_US')).toContain('not executed; you can retry')
    expect(isAuthUnavailable(futures('200013'))).toBe(true)
    expect(describeFuturesGateError(futures('200013'), 'zh_CN', true)).toEqual({ kind: 'futuresAuth', text: '登录校验服务暂时不可用，请稍后重试（无需重新登录）' })
    expect(describeFuturesGateError(futures('200013'), 'zh_CN', false).kind).toBe('futuresAuth')
  })

  it('guardedRefresh never retries, swallows a failed refresh and holds for the minimum time', async () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn(async () => { throw new Error('offline') })
      let done = false
      const pending = guardedRefresh(refresh, 1000).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(done).toBe(true)
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('order_tpsl_cancel per-id results', () => {
  const data = {
    results: [
      { orderId: '11', code: '0', msg: 'success' },
      { orderId: '12', code: '10082', msg: 'The order is already filled or cancelled' },
      { orderId: 'x', code: '200004', msg: 'Invalid parameter', reason: 'NOT_NUMBER' },
    ],
    succeeded: 1,
    failed: 2,
  }

  it('lists the failed ids with localised reasons', () => {
    const error = new ApiError({ kind: 'api', code: '10021', message: 'Cancel order failed', data, product: 'futures' })
    const outcome = tpslCancelOutcome(error, 'zh_CN')
    expect(outcome).toEqual({
      succeeded: 1,
      failed: 2,
      failures: [
        { orderId: '12', code: 10082, text: '订单已成交或已撤销' },
        { orderId: 'x', code: 200004, text: '参数不合法（不是有效数字）' },
      ],
    })
    expect(describeTpslCancel(outcome!, 'zh_CN')).toBe('已撤销 1 个，2 个未撤销：#12 订单已成交或已撤销；#x 参数不合法（不是有效数字）')
    expect(describeTpslCancel(tpslCancelOutcome(error, 'en_US')!, 'en_US'))
      .toBe('1 cancelled, 2 not cancelled: #12 The order is already filled or cancelled; #x Invalid parameter (not a number)')
  })

  it('reads a full success and ignores answers without per-id results', () => {
    expect(describeTpslCancel(tpslCancelOutcome({ results: [{ orderId: '1', code: 0 }], succeeded: 1, failed: 0 }, 'zh_CN')!, 'zh_CN')).toBe('已撤销 1 个')
    expect(tpslCancelOutcome(futures('10021', 'Cancel order failed'), 'zh_CN')).toBeNull()
    expect(tpslCancelOutcome(null, 'zh_CN')).toBeNull()
  })
})

/* ---------------------------------------------------------------- 200011 through the futures store */

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

describe('futures placeOrder: 200011 refreshes instead of retrying and keeps the button busy', () => {
  let pinia: Pinia
  let calls: string[] = []
  let releaseList: (() => void) | null = null
  const payload: CreateOrderPayload = { contractId: 1, positionType: 1, side: 'BUY', open: 'OPEN', type: 1, volume: '10', price: '60000', leverageLevel: 10, isConditionOrder: false }

  beforeEach(() => {
    localStorage.clear()
    session.clear()
    clearToasts()
    calls = []
    releaseList = null
    pinia = createPinia()
    setActivePinia(pinia)
    const market = useFuturesMarketStore()
    const info = normalizePublicInfo({
      contractList: [{
        id: 1, contractName: 'E-BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', marginRate: '1', base: 'BTC', quote: 'USDT', minLever: 1, maxLever: 125,
        coinResultVo: { symbolPricePrecision: 2, marginCoinPrecision: 6, minOrderVolume: 1, minOrderMoney: 1, maxLimitVolume: 99999999, maxMarketVolume: 99999999, maxMarketMoney: 99999999, fundsInStatus: 1, fundsOutStatus: 1, depth: ['2', '1', '0'] },
      }],
    })
    market.contracts = info.contractList.map(buildContract).filter((c) => c !== null)
    market.selectedName = 'E-BTC-USDT'
    session.setToken('jwt')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(FUTURES_API_PREFIX, '').split('?')[0]
      calls.push(path)
      if (path === 'user/get_user_config') return respond({ code: '0', data: { openContract: 1, nowLevel: 10, marginModel: 1 } })
      if (path === 'position/get_assets_list') return respond({ code: '0', data: { positionList: [], accountList: [{ symbol: 'USDT', canUseAmount: '1000', totalAmount: '1000' }] } })
      if (path === 'order/current_order_list') {
        if (releaseList === null) await new Promise<void>((resolve) => { releaseList = resolve })
        return respond({ code: '0', data: { count: 1, orderList: [{ id: '1002', contractId: 1, contractName: 'E-BTC-USDT', side: 'BUY', open: 'OPEN', type: 1, price: '60000', volume: '10', dealVolume: '0', status: 0, ctime: 1790000000000 }] } })
      }
      if (path === 'order/order_create') return respond({ code: '200011', msg: 'The order result is not confirmed', data: { reason: 'TIMEOUT' } })
      return respond({ code: '0', data: {} })
    }))
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.unstubAllGlobals()
    session.clear()
    localStorage.clear()
  })

  it('answers the unconfirmed text, re-reads 当前委托 + 持仓 once, never resends the order', async () => {
    const orders = useFuturesOrdersStore()
    const account = useFuturesAccountStore()
    releaseList = () => undefined
    await account.refresh()
    await orders.load('current')
    releaseList = null
    calls = []
    const placing = orders.placeOrder(payload, { reserve: '60' })
    // While the refresh runs the submit buttons stay disabled (busy = 'order').
    await vi.waitFor(() => expect(calls).toContain('order/current_order_list'))
    expect(account.busy).toBe('order')
    // A double click during the refresh is refused and sends nothing.
    expect(await orders.placeOrder(payload)).not.toBeNull()
    ;(releaseList as (() => void) | null)?.()
    const result = await placing
    expect(result).toBe('下单结果未确认：请勿重复提交，正在刷新委托列表…')
    expect(calls.filter((path) => path === 'order/order_create')).toHaveLength(1)
    expect(calls).toContain('position/get_assets_list')
    expect(account.busy).toBeNull()
    expect(orders.lists.current.rows.map((row) => row.id)).toContain('1002')
    expect(account.available).toBe('1000')
  })
})
