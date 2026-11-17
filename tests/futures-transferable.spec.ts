import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { session } from '@/core/session'
import { ApiError } from '@/core/errors'
import { FUTURES_API_PREFIX } from '@/modules/api/http'
import { describeTransferError } from '@/modules/transfer/errors'
import { futuresMessages } from '@/modules/futures/i18n'
import { useFuturesAccountStore } from '@/stores/futures-account'

function respond(payload: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) } as unknown as Response
}

function stubAssets(accountList: Record<string, unknown>[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(FUTURES_API_PREFIX, '')
    if (path === 'position/get_assets_list') {
      return respond({ code: '0', data: { positionList: [], accountList } })
    }
    return respond({ code: '0', data: {} })
  }))
}

describe('futures account transferable balance', () => {
  beforeEach(() => {
    session.clear()
    setActivePinia(createPinia())
    session.setToken('jwt')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    session.clear()
  })

  async function load(): Promise<ReturnType<typeof useFuturesAccountStore>> {
    const account = useFuturesAccountStore()
    account.open = { status: 'opened', error: null, initFailed: false }
    await account.loadAssets()
    return account
  }

  it('parses transferableAmount and transferHeldProfit from get_assets_list', async () => {
    stubAssets([{ symbol: 'USDT', canUseAmount: '45000', transferableAmount: '40000', transferHeldProfit: '5000' }])
    const account = await load()
    expect(account.available).toBe('45000')
    expect(account.transferable).toBe('40000')
    expect(account.transferHeldProfit).toBe('5000')
  })

  it('falls back to 可用 when the server sends no transferableAmount', async () => {
    stubAssets([{ symbol: 'USDT', canUseAmount: '45000' }])
    const account = await load()
    expect(account.transferable).toBe(account.available)
    expect(account.transferable).toBe('45000')
  })

  it('keeps a floored transferableAmount of 0 instead of the fallback', async () => {
    stubAssets([{ symbol: 'USDT', canUseAmount: '100', transferableAmount: '0' }])
    const account = await load()
    expect(account.available).toBe('100')
    expect(account.transferable).toBe('0')
  })
})

describe('describeTransferError transferable refusals', () => {
  const apiError = (code: string): ApiError => new ApiError({ kind: 'api', code, message: '' })

  it('105005: unrealized profit cannot be transferred out (zh and en)', () => {
    const zh = describeTransferError(apiError('105005'), 'zh_CN')
    expect(zh.kind).toBe('refused')
    expect(zh.text).toContain('未实现盈利不可划转，平仓后可划转')
    expect(zh.text).toContain('资金未变动')
    expect(describeTransferError(apiError('105005'), 'en_US').text).toContain('Unrealized profit cannot be transferred')
  })

  it('10071: unrealized profit cannot be transferred out (zh)', () => {
    expect(describeTransferError(apiError('10071'), 'zh_CN').text).toContain('未实现盈利不可划转')
  })
})

describe('futures transfer i18n', () => {
  it('transferOutHint explains that unrealized profit is held until the position closes', () => {
    expect(futuresMessages['zh-CN'].fut.transferOutHint).toBe('未实现盈利不可划转，平仓后可划转')
    expect(futuresMessages['en-US'].fut.transferOutHint).not.toBe('')
    expect(futuresMessages['en-US'].fut.transferOutHint).toContain('Unrealized profit')
  })
})
