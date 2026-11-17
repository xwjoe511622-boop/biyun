import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/errors'
import { describeGuardError, guardKind, pickLanguage } from '@/modules/api/guard-errors'
import { applySpotFilter } from '@/modules/api/exchange-filters'
import { FALLBACK_RULES } from '@/modules/finance/precision'

const api = (code: string, message: string, status = 200) =>
  new ApiError({ kind: status === 200 ? 'api' : 'http', code, message, status })

describe('guard error texts (2026-09-29 rate limits + Binance filters)', () => {
  it('classifies codes and HTTP 429', () => {
    expect(guardKind('-1015')).toBe('orders')
    expect(guardKind('-1013')).toBe('filter')
    expect(guardKind('-1003')).toBe('rate')
    expect(guardKind('429', 429)).toBe('rate')
    expect(guardKind('-2010')).toBe('stp')
    expect(guardKind('10069')).toBeNull()
  })

  it('shows the futures order-count refusal in Chinese with a clear title', () => {
    const e = api('-1015', '下单过于频繁：每 10 秒最多 20 笔新订单，请 1 秒后再试（撤单、平仓不受限）', 429)
    expect(describeGuardError(e, 'zh_CN')).toBe('下单过于频繁：每 10 秒最多 20 笔新订单，请 1 秒后再试（撤单、平仓不受限）')
  })

  it('keeps only the UI-language half of the nginx per-IP answer', () => {
    const msg = '请求过于频繁：每个 IP 每秒最多 50 次请求（WebSocket 每 IP 最多 20 条连接），请稍后再试 / Too many requests from this IP; current limit is 50 requests per 1 SECOND.'
    expect(describeGuardError(api('-1003', msg, 429), 'zh_CN')).toBe('请求过于频繁：每个 IP 每秒最多 50 次请求（WebSocket 每 IP 最多 20 条连接），请稍后再试')
    expect(describeGuardError(api('-1003', msg, 429), 'en_US')).toBe('Too many requests from this IP; current limit is 50 requests per 1 SECOND.')
  })

  it('prefixes filter refusals and strips the English "Filter failure" tag', () => {
    const zh = api('-1013', '卖单价格超出允许范围：须在 66400 – 166000 之间（最新成交价 83000 的 80% – 200%）')
    expect(describeGuardError(zh, 'zh_CN')).toBe('不符合下单规则：卖单价格超出允许范围：须在 66400 – 166000 之间（最新成交价 83000 的 80% – 200%）')
    const en = api('-1013', 'Filter failure: PERCENT_PRICE. BUY price must be <= 87150 (105% of the mark price 83000)')
    expect(describeGuardError(en, 'en_US')).toBe('Order rejected by trading rules: BUY price must be <= 87150 (105% of the mark price 83000)')
  })

  it('shows self-trade prevention and market price protection clearly', () => {
    const stp = api('-2010', '自成交保护：这笔买单会与您自己价格为 83000 的卖单成交，已取消新单（请先撤掉该挂单或调整价格）')
    expect(describeGuardError(stp, 'zh_CN')).toBe('自成交保护：这笔买单会与您自己价格为 83000 的卖单成交，已取消新单（请先撤掉该挂单或调整价格）')
    const stpEn = api('-2010', 'Order rejected (self-trade prevention). the new BUY order would match your own resting SELL order at 83000; the new order is cancelled (STP mode EXPIRE_TAKER)')
    expect(describeGuardError(stpEn, 'en_US')).toBe('Order rejected (self-trade prevention): the new BUY order would match your own resting SELL order at 83000; the new order is cancelled (STP mode EXPIRE_TAKER)')
    const range = api('-1013', '市价单价格保护：按当前盘口这笔市价单会以高于 87150 的价格成交（参考价 83000 的 +5%）；此范围内最多可成交约 2490 USDT，请减小数量或改用限价单')
    expect(describeGuardError(range, 'zh_CN')).toMatch(/^不符合下单规则：市价单价格保护/)
  })

  it('falls back to a generic text for a bare 429 and ignores unrelated errors', () => {
    expect(describeGuardError(api('429', 'HTTP 429 Too Many Requests', 429), 'zh_CN')).toBe('请求过于频繁：请稍后再试')
    expect(describeGuardError(api('10069', '杠杆倍数超出允许范围'), 'zh_CN')).toBeNull()
    expect(describeGuardError(new Error('x'), 'zh_CN')).toBeNull()
  })

  it('pickLanguage leaves single-language messages alone', () => {
    expect(pickLanguage('a / b', 'zh_CN')).toBe('a / b')
    expect(pickLanguage('中文 / English', 'zh_CN')).toBe('中文')
    expect(pickLanguage('中文 / English', 'en_US')).toBe('English')
  })
})

describe('applySpotFilter', () => {
  it('tightens BTC quantity decimals and minimums to the Binance filter', () => {
    const rules = { ...FALLBACK_RULES, volumePrecision: 8, limitVolumeMin: '0.000001', marketSellMin: '0.000001', marketBuyMin: '1' }
    const out = applySpotFilter(rules, { stepSize: '0.00001', minQty: '0.00001', minNotional: '5' })
    expect(out.volumePrecision).toBe(5)
    expect(out.limitVolumeMin).toBe('0.00001')
    expect(out.marketSellMin).toBe('0.00001')
    expect(out.marketBuyMin).toBe('5')
    expect(rules.volumePrecision).toBe(8) // input untouched
  })

  it('never loosens the configured rules and ignores a missing filter', () => {
    const rules = { ...FALLBACK_RULES, volumePrecision: 3, limitVolumeMin: '0.01' }
    expect(applySpotFilter(rules, { stepSize: '0.00001', minQty: '0.001' }).volumePrecision).toBe(3)
    expect(applySpotFilter(rules, { minQty: '0.001' }).limitVolumeMin).toBe('0.01')
    expect(applySpotFilter(rules, undefined)).toBe(rules)
  })
})

describe('minOpenOrder (futures Binance LOT_SIZE / MIN_NOTIONAL)', () => {
  it('BTC: 0.001 BTC = 10 contracts beats 50 USDT', async () => {
    const { minOpenOrder } = await import('@/modules/api/exchange-filters')
    expect(minOpenOrder({ multiplier: '0.0001', minQty: '0.001', minNotional: '50' }, '83000')).toEqual({ contracts: 10, coin: '0.001', usdt: '83' })
  })
  it('ETH: 20 USDT needs 8 contracts at 2,690', async () => {
    const { minOpenOrder } = await import('@/modules/api/exchange-filters')
    expect(minOpenOrder({ multiplier: '0.001', minQty: '0.001', minNotional: '20' }, '2690')).toEqual({ contracts: 8, coin: '0.008', usdt: '21.52' })
  })
  it('NVDA: 5 USDT needs 3 contracts at 229; unknown filter -> null', async () => {
    const { minOpenOrder } = await import('@/modules/api/exchange-filters')
    expect(minOpenOrder({ multiplier: '0.01', minQty: '0.01', minNotional: '5' }, '229.4')?.contracts).toBe(3)
    expect(minOpenOrder(undefined, '1')).toBeNull()
  })
})
