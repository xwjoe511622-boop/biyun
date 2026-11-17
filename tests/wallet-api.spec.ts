import { i18n } from '@/i18n/composer'
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { session } from '@/core/session'
import { API_PREFIX } from '@/config/endpoints'
import {
  WALLET_PATHS,
  addWalletAddress,
  cancelWithdrawal,
  deleteWalletAddress,
  fetchAddressBook,
  fetchDepositAddress,
  fetchDepositHistory,
  fetchWithdrawConfig,
  fetchWithdrawHistory,
  sendEmailCode,
  sendAddressBookEmailCode,
  sendAddressBookSmsCode,
  sendSmsCode,
  submitWithdrawal,
} from '@/modules/api/wallet.api'

/** Configured wallet gateway used for the CIAO money/verification endpoints. */
const WALLET_BASE = '/wallet-api/'

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function ok(data: unknown): Response {
  return mockResponse({ code: '0', msg: 'suc', data })
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): {
  url: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
} {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, RequestInit]
  return {
    url,
    body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
    headers: init.headers as Record<string, string>,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  session.clear()
  vi.stubEnv('VITE_WALLET_API_BASE', WALLET_BASE)
  fetchMock = vi.fn(async () => ok({}))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  session.clear()
})

describe('wallet api request names and payloads', () => {
  it('reads a deposit address from the CIAO gateway and splits the tag', async () => {
    fetchMock = vi.fn(async () => ok({ addressStr: 'rAddress123_memo42', addressQRCode: 'qr' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchDepositAddress('XRP')

    expect(result).toEqual({ address: 'rAddress123', tag: 'memo42', hasTag: true, qrCode: 'qr' })
    const call = lastCall(fetchMock)
    expect(call.url).toBe(`${WALLET_BASE}${WALLET_PATHS.chargeAddress}`)
    expect(call.body).toEqual({ symbol: 'XRP', coinSymbol: 'XRP' })
  })

  it('keeps an untagged deposit address intact', async () => {
    fetchMock = vi.fn(async () => ok({ addressStr: 'bc1qexample', addressQRCode: '' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchDepositAddress('BTC')
    expect(result).toEqual({ address: 'bc1qexample', tag: '', hasTag: false, qrCode: '' })
  })

  it('adds optional chain metadata without changing historical deposit responses', async () => {
    fetchMock = vi.fn(async () => ok({
      addressStr: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      addressQRCode: '',
      networkName: 'BNB Smart Chain (BEP-20)',
      chainId: 56,
      tokenContract: '0x55d398326f99059fF775485246999027B3197955',
      confirmations: 64,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchDepositAddress('USDT')

    expect(result).toEqual({
      address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
      tag: '',
      hasTag: false,
      qrCode: '',
      networkName: 'BNB Smart Chain (BEP-20)',
      chainId: 56,
      tokenContract: '0x55d398326f99059fF775485246999027B3197955',
      confirmations: 64,
    })
  })

  it('omits malformed optional deposit metadata instead of inventing values', async () => {
    fetchMock = vi.fn(async () => ok({
      addressStr: 'bc1qexample',
      addressQRCode: '',
      networkName: '   ',
      chainId: 'not-a-chain',
      tokenContract: null,
      confirmations: -1,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchDepositAddress('BTC')).resolves.toEqual({
      address: 'bc1qexample',
      tag: '',
      hasTag: false,
      qrCode: '',
    })
  })

  it('fails visibly when the deposit-address payload is not a ChargeAddressVO', async () => {
    fetchMock = vi.fn(async () => ok(null))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchDepositAddress('BTC')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('never surfaces an address or tag for PROVISIONING, even when a hostile payload carries them', async () => {
    fetchMock = vi.fn(async () => ok({
      status: 'PROVISIONING',
      addressStr: 'evilAddress_memo9',
      addressQRCode: 'https://evil.invalid/qr.png',
      networkName: 'BNB Smart Chain (BEP-20)',
      chainId: 56,
      tokenContract: '0x55d398326f99059fF775485246999027B3197955',
      confirmations: 64,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchDepositAddress('USDT', { network: 'BSC' })

    // The address, tag, QR and optional metadata are all dropped; only the state survives.
    expect(result).toEqual({ address: '', tag: '', hasTag: false, qrCode: '', status: 'PROVISIONING' })
    expect(result.address).toBe('')
    expect(result.tag).toBe('')
    expect(result.qrCode).toBe('')
  })

  it('passes READY through, rejects unknown statuses, and keeps the historical shape compatible', async () => {
    fetchMock = vi.fn(async () => ok({ status: 'READY', addressStr: 'bc1qready', addressQRCode: '' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchDepositAddress('BTC')).resolves.toEqual({
      address: 'bc1qready', tag: '', hasTag: false, qrCode: '', status: 'READY',
    })

    // An explicit unrecognized state cannot be mistaken for a legacy READY address.
    fetchMock = vi.fn(async () => ok({ status: 'PENDING', addressStr: 'bc1qpending', addressQRCode: '' }))
    vi.stubGlobal('fetch', fetchMock)
    const originalLocale = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'zh-CN'
      await expect(fetchDepositAddress('BTC')).rejects.toThrow('不支持该充值地址状态')
      i18n.global.locale.value = 'en-US'
      await expect(fetchDepositAddress('BTC')).rejects.toThrow('Unsupported deposit address status')
    } finally {
      i18n.global.locale.value = originalLocale
    }

    // A historical payload without `status` keeps the exact legacy shape (no invented field).
    fetchMock = vi.fn(async () => ok({ addressStr: 'bc1qlegacy', addressQRCode: 'qr' }))
    vi.stubGlobal('fetch', fetchMock)
    const legacy = await fetchDepositAddress('BTC')
    expect(legacy).toEqual({ address: 'bc1qlegacy', tag: '', hasTag: false, qrCode: 'qr' })
    expect('status' in legacy).toBe(false)
  })

  it('keeps cost/Getcost on the legacy default prefix and normalizes money as strings', async () => {
    fetchMock = vi.fn(async () => ok({
      feeMin: 0.0001,
      feeMax: '0.5',
      withdraw_min: 0.01,
      withdraw_max: '',
      defaultFee: 0.0005,
      mainChainNameTip: 'TRC20 only',
      userWithdrawAddrList: [{ id: 7, address: 'Taddr_memo', label: 'saved', symbol: 'USDT' }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const config = await fetchWithdrawConfig('USDT')

    expect(config.feeMin).toBe('0.0001')
    expect(config.feeMax).toBe('0.5')
    expect(config.withdrawMin).toBe('0.01')
    expect(config.withdrawMax).toBe('')
    expect(config.defaultFee).toBe('0.0005')
    expect(config.chainTip).toBe('TRC20 only')
    expect(config.addresses).toEqual([
      { id: '7', coin: 'USDT', address: 'Taddr', tag: 'memo', label: 'saved', raw: 'Taddr_memo' },
    ])
    expect(lastCall(fetchMock).url).toBe(`${API_PREFIX}${WALLET_PATHS.withdrawConfig}`)
    expect(lastCall(fetchMock).body).toEqual({ symbol: 'USDT' })
  })

  it('fails visibly when a financial response is missing its contract fields', async () => {
    fetchMock = vi.fn(async () => ok({ feeMin: '0.1' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchWithdrawConfig('USDT')).rejects.toMatchObject({ kind: 'parse' })

    fetchMock = vi.fn(async () => ok({ count: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchDepositHistory({ coin: '', page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('lists the address book and adds an address with the server-required code names', async () => {
    fetchMock = vi.fn(async () => ok({ addressList: [{ id: 3, symbol: 'BTC', address: 'bc1', label: 'cold' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const list = await fetchAddressBook('BTC')
    expect(list[0]).toMatchObject({ id: '3', coin: 'BTC', address: 'bc1', label: 'cold' })
    expect(lastCall(fetchMock).url).toBe(`${API_PREFIX}${WALLET_PATHS.addressList}`)
    expect(lastCall(fetchMock).body).toEqual({ coinSymbol: 'BTC' })

    fetchMock = vi.fn(async () => ok({}))
    vi.stubGlobal('fetch', fetchMock)
    await addWalletAddress({
      coinSymbol: 'XRP',
      address: 'rAddr_memo9',
      label: 'label',
      googleCode: '123456',
      smsValidCode: '',
      emailValidCode: '654321',
    })
    const call = lastCall(fetchMock)
    expect(call.url).toBe(`${API_PREFIX}${WALLET_PATHS.addAddress}`)
    // Blank optional codes are omitted instead of being sent as "".
    expect(call.body).toEqual({
      coinSymbol: 'XRP',
      address: 'rAddr_memo9',
      label: 'label',
      googleCode: '123456',
      emailValidCode: '654321',
    })
  })

  it('deletes an address with numeric ids exactly as AddrAct reads them', async () => {
    await deleteWalletAddress(['11'], { googleCode: '111111', smsValidCode: '' })

    const call = lastCall(fetchMock)
    expect(call.url).toBe(`${API_PREFIX}${WALLET_PATHS.deleteAddress}`)
    expect(call.body).toEqual({ ids: [11], googleCode: '111111' })

    // A non-integer id must fail before it can be sent as a broken payload.
    await expect(deleteWalletAddress(['w-9'], { googleCode: '111111', smsValidCode: '' })).rejects.toThrow(/整数/)
  })

  it('submits a withdrawal to the CIAO gateway as a signed envelope with the session header', async () => {
    session.setToken('synthetic-wallet-session')

    await submitWithdrawal({
      // Rust wallet idempotency key: a valid fixed UUID (see wallet-contract.spec.ts).
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      symbol: 'USDT',
      addressId: '7',
      amount: '20',
      fee: '0.5',
      googleCode: '123456',
      smsAuthCode: '',
      emailValidCode: '',
    })

    const call = lastCall(fetchMock)
    expect(call.url).toBe(`${WALLET_BASE}${WALLET_PATHS.submitWithdraw}`)
    // Signed envelope: the plaintext (gross amount) is asserted in wallet-contract.spec.ts, because
    // the wire body only carries the encrypted `{data, key}` pair.
    expect(Object.keys(call.body ?? {}).sort()).toEqual(['data', 'key'])
    expect(call.headers.Sign.length).toBeGreaterThan(0)
    expect(Number.isInteger(Number(call.headers.Timestamp))).toBe(true)
    // 10-17: the session is the HttpOnly cookie, never a header
    expect(call.headers['exchange-token']).toBeUndefined()
    expect(call.headers['X-LB-Session']).toBe('cookie')
    expect(call.headers['exchange-client']).toBe('pc')
  })

  it('cancels a withdrawal through the CIAO gateway with a numeric withdrawId', async () => {
    await cancelWithdrawal('9')

    const call = lastCall(fetchMock)
    expect(call.url).toBe(`${WALLET_BASE}${WALLET_PATHS.cancelWithdraw}`)
    expect(call.body).toEqual({ withdrawId: 9 })
  })

  it('routes withdrawal history through the CIAO gateway and deposit history through record/deposit_list', async () => {
    fetchMock = vi.fn(async () => ok({
      count: 1,
      pageSize: 10,
      financeList: [{ id: 5, createdAt: '2026-02-02', amount: '19.5', fee: 0.5, label: '', status: 0, status_text: 'pending', addressTo: 'Taddr_memo', txidAddr: 'https://explorer.example/tx/5' }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const withdrawal = await fetchWithdrawHistory({ coin: 'USDT', page: 1, pageSize: 10 })
    expect(lastCall(fetchMock).url).toBe(`${WALLET_BASE}${WALLET_PATHS.withdrawHistory}`)
    expect(lastCall(fetchMock).body).toEqual({ pageSize: 10, page: 1, coinSymbol: 'USDT' })
    expect(withdrawal.list[0]).toMatchObject({
      id: '5',
      status: '0',
      address: 'Taddr',
      tag: 'memo',
      txidUrl: 'https://explorer.example/tx/5',
    })

    fetchMock = vi.fn(async () => ok({
      count: 2,
      financeList: [{ createdAt: '2026-01-01', amount: '1.25', symbol: 'BTC', confirmDesc: '3/6', status_text: 'ok' }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const deposit = await fetchDepositHistory({ coin: '', page: 2, pageSize: 10 })
    expect(lastCall(fetchMock).url).toBe(`${API_PREFIX}${WALLET_PATHS.depositHistory}`)
    expect(lastCall(fetchMock).body).toEqual({ pageSize: 10, page: 2 })
    expect(deposit.count).toBe(2)
    expect(deposit.list[0]).toMatchObject({ coin: 'BTC', amount: '1.25', statusText: 'ok', confirmDesc: '3/6' })
  })

  it('rejects a javascript explorer URL from the server', async () => {
    fetchMock = vi.fn(async () => ok({
      count: 1,
      financeList: [{ id: 1, createdAt: '2026-02-02', amount: '1', fee: 0, status: 0, status_text: 'pending', txidAddr: 'javascript:alert(1)' }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await fetchWithdrawHistory({ coin: 'USDT', page: 1, pageSize: 10 })
    expect(page.list[0].txidUrl).toBe('')
  })

  it('requests verification codes from the CIAO validCode controller without a body', async () => {
    await sendSmsCode()
    expect(lastCall(fetchMock).url).toBe(`${WALLET_BASE}${WALLET_PATHS.smsCode}`)
    expect(lastCall(fetchMock).body).toBeUndefined()

    await sendEmailCode()
    expect(lastCall(fetchMock).url).toBe(`${WALLET_BASE}${WALLET_PATHS.emailCode}`)
    expect(lastCall(fetchMock).body).toBeUndefined()
  })

  it('surfaces a real server error instead of a fake success', async () => {
    fetchMock = vi.fn(async () => mockResponse({ code: '10034', msg: 'insufficient balance', data: null }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitWithdrawal({
        requestId: '9a1c6f2d-7b34-4e58-8c0a-2f5d6e7a8b90',
        symbol: 'BTC',
        addressId: '1',
        amount: '1',
        fee: '0.001',
        googleCode: '123456',
        smsAuthCode: '',
        emailValidCode: '',
      }),
    ).rejects.toMatchObject({ kind: 'api', code: '10034', message: 'insufficient balance' })
  })
})

describe('address book code namespace', () => {
  it('sends the legacy address-book SMS discriminator on the default prefix, never the CIAO gateway', async () => {
    await sendAddressBookSmsCode('add')
    let call = lastCall(fetchMock)
    expect(call.url).toBe(`${API_PREFIX}${WALLET_PATHS.addressBookSmsCode}`)
    expect(call.url.startsWith(WALLET_BASE)).toBe(false)
    expect(call.body).toEqual({ operationType: '11' })

    await sendAddressBookSmsCode('delete')
    call = lastCall(fetchMock)
    expect(call.url).toBe(`${API_PREFIX}${WALLET_PATHS.addressBookSmsCode}`)
    expect(call.body).toEqual({ operationType: '21' })
  })

  it('sends the legacy address-book email code (operationType 13) on the default prefix', async () => {
    await sendAddressBookEmailCode()
    const call = lastCall(fetchMock)
    expect(call.url).toBe(`${API_PREFIX}${WALLET_PATHS.addressBookEmailCode}`)
    expect(call.url.startsWith(WALLET_BASE)).toBe(false)
    expect(call.body).toEqual({ operationType: '13' })
  })

  it('keeps the legacy address-book codes and the CIAO withdrawal codes in distinct namespaces', async () => {
    await sendAddressBookSmsCode('add')
    const addressBookUrl = lastCall(fetchMock).url

    await sendSmsCode()
    const ciaoSmsUrl = lastCall(fetchMock).url
    await sendEmailCode()
    const ciaoEmailUrl = lastCall(fetchMock).url

    expect(addressBookUrl).toBe(`${API_PREFIX}${WALLET_PATHS.addressBookSmsCode}`)
    expect(ciaoSmsUrl).toBe(`${WALLET_BASE}${WALLET_PATHS.smsCode}`)
    expect(ciaoEmailUrl).toBe(`${WALLET_BASE}${WALLET_PATHS.emailCode}`)
    expect(addressBookUrl).not.toBe(ciaoSmsUrl)
  })
})
