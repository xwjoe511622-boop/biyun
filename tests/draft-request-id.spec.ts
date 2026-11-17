import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/errors'
import { DraftRequestId, isUncertainOutcome } from '@/modules/api/draft-request-id'

describe('DraftRequestId (client idempotency id of margin / OTC money writes)', () => {
  it('reuses the id for the same draft after an uncertain outcome, renews it on edit or definite outcome', () => {
    const ids = new DraftRequestId()
    const a = ids.forDraft('["BTCUSDT","USDT","10"]')
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    ids.finish(new ApiError({ kind: 'timeout', code: '', message: 't' }))
    expect(ids.forDraft('["BTCUSDT","USDT","10"]')).toBe(a)
    ids.finish(new ApiError({ kind: 'http', code: '', status: 502, message: 'bad gateway' }))
    expect(ids.forDraft('["BTCUSDT","USDT","10"]')).toBe(a)
    const edited = ids.forDraft('["BTCUSDT","USDT","11"]')
    expect(edited).not.toBe(a)
    ids.finish(new ApiError({ kind: 'api', code: '10011', message: 'refused' }))
    const next = ids.forDraft('["BTCUSDT","USDT","11"]')
    expect(next).not.toBe(edited)
    ids.finish()
    expect(ids.forDraft('["BTCUSDT","USDT","11"]')).not.toBe(next)
  })

  it('classifies outcomes', () => {
    expect(isUncertainOutcome(new Error('x'))).toBe(true)
    expect(isUncertainOutcome(new ApiError({ kind: 'network', code: '', message: '' }))).toBe(true)
    expect(isUncertainOutcome(new ApiError({ kind: 'parse', code: '', message: '' }))).toBe(true)
    expect(isUncertainOutcome(new ApiError({ kind: 'http', code: '', status: 400, message: '' }))).toBe(false)
    expect(isUncertainOutcome(new ApiError({ kind: 'unauthorized', code: '10002', message: '' }))).toBe(false)
  })
})
