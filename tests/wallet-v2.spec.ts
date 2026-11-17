// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/core/errors'
import { API_PREFIX } from '@/config/endpoints'
import {
  WALLET_PATHS,
  addWalletAddress,
  deleteWalletAddress,
  fetchAddressBook,
  fetchWalletNetworks,
  fetchWithdrawConfig,
  fetchWithdrawHistory,
} from '@/modules/api/wallet.api'
import { checkWithdrawAddress, hasValidChecksum, sameAddress, toChecksumAddress } from '@/modules/wallet/evm'
import { describeWalletError } from '@/modules/wallet/errors'
import { coinNetworkMap, explorerTxUrl, groupAddressesByNetwork, networkChoicesForCoin, normalizeWalletNetworks, savedAddressesFor } from '@/modules/wallet/networks'
import { addressListHasNetworks, normalizeAddressList } from '@/modules/wallet/normalize'
import type { WalletAddress } from '@/modules/wallet/types'
import { buildAddAddressBody, buildNetworkDeleteAddressBody, buildWithdrawRequestBody } from '@/modules/wallet/withdrawRequest'
import {
  applyEmailCodeSwitch,
  approvalHint,
  emailCodeRequired,
  maxGrossAmount,
  receiveAmount,
  requiredBookCodes,
  requiredWithdrawCodes,
  resolveWithdrawTarget,
} from '@/modules/wallet/withdrawMode'
import { requiredAddressBookCodes } from '@/modules/wallet/withdraw'
import type { PublicInfoV4 } from '@/modules/api/types'

const WALLET_BASE = '/wallet-api/'
const BSC_ROW = {
  network: 'BSC', displayName: 'BNB Smart Chain (BEP-20)', chainId: 56, coins: ['USDC'],
  tokenContracts: { USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' }, addressRegex: '^0x[0-9a-fA-F]{40}$', checksum: 'EIP-55', needMemo: false,
}

function response(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: 'X', text: async () => JSON.stringify(payload) } as unknown as Response
}
const ok = (data: unknown): Response => response({ code: '0', msg: 'suc', data })

function calls(mock: ReturnType<typeof vi.fn>): Array<{ url: string; body: unknown }> {
  return mock.mock.calls.map(([url, init]) => ({ url: String(url), body: (init as RequestInit).body === undefined ? undefined : JSON.parse(String((init as RequestInit).body)) }))
}

describe('EVM address checks (EIP-55)', () => {
  // Reference vectors from the EIP-55 specification.
  const VECTORS = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]
  const rule = { addressRegex: '^0x[0-9a-fA-F]{40}$' }

  it('computes and verifies the checksum encoding', () => {
    VECTORS.forEach((address) => {
      expect(toChecksumAddress(address.toLowerCase())).toBe(address)
      expect(hasValidChecksum(address)).toBe(true)
    })
  })

  it('accepts all-lower / all-upper (no checksum) and rejects a wrong mixed case', () => {
    expect(checkWithdrawAddress(VECTORS[0].toLowerCase(), rule)).toMatchObject({ ok: true, checksummed: false })
    expect(checkWithdrawAddress(`0x${VECTORS[0].slice(2).toUpperCase()}`, rule).ok).toBe(true)
    expect(checkWithdrawAddress(VECTORS[0], rule)).toMatchObject({ ok: true, checksummed: true })
    expect(checkWithdrawAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed', rule)).toMatchObject({ ok: false, problem: 'checksum' })
  })

  it('QA-022: an empty catalog regex on BNB Chain still rejects not-an-address (network family fallback)', () => {
    const [bnb, tron, other] = normalizeWalletNetworks({ networks: [
      { network: 'bnbchain-mainnet', coins: ['USDT'], addressRegex: '' },
      { network: 'tron-mainnet', coins: ['USDT'], addressRegex: '' },
      { network: 'ton-mainnet', coins: ['USDT'], addressRegex: '' },
    ] })
    expect(checkWithdrawAddress('not-an-address', bnb).problem).toBe('format')
    expect(checkWithdrawAddress(VECTORS[0], bnb).ok).toBe(true)
    expect(checkWithdrawAddress('not-an-address', tron).problem).toBe('pattern')
    expect(checkWithdrawAddress('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', tron).ok).toBe(true)
    expect(other.addressRegex).toBe('')
    expect(normalizeWalletNetworks({ networks: [{ network: 'x', coins: ['USDT'], addressRegex: '^a$' }] })[0].addressRegex).toBe('^a$')
  })

  it('rejects bad length, non-hex, the zero address and non-0x input on an EVM network', () => {
    expect(checkWithdrawAddress('0x1234', rule).problem).toBe('format')
    expect(checkWithdrawAddress(`0x${'g'.repeat(40)}`, rule).problem).toBe('format')
    expect(checkWithdrawAddress(`0x${'0'.repeat(40)}`, rule).problem).toBe('zero')
    expect(checkWithdrawAddress('TXYZ', rule).problem).toBe('format')
    expect(checkWithdrawAddress('', rule).problem).toBe('empty')
  })

  it('leaves non-EVM formats to the server when no rule is known', () => {
    expect(checkWithdrawAddress('bc1qexample', { addressRegex: '' }).ok).toBe(true)
    expect(checkWithdrawAddress('0x12', { addressRegex: '' }).problem).toBe('format')
  })

  it('compares EVM addresses case-insensitively, others exactly', () => {
    expect(sameAddress(VECTORS[1], VECTORS[1].toLowerCase())).toBe(true)
    expect(sameAddress('rAddr', 'raddr')).toBe(false)
  })
})

describe('withdraw mode selection -> required codes', () => {
  const saved: WalletAddress[] = [{ id: '12', coin: 'USDC', address: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', tag: '', label: 'l', raw: '', network: 'BSC' }]
  const emailUser = { googleEnabled: true, mobileCheckEnabled: false, email: 'u@x.io' }
  const mobileOnly = { googleEnabled: true, mobileCheckEnabled: true, email: '' }

  it('treats a typed address that is already saved as the saved entry', () => {
    expect(resolveWithdrawTarget('', saved).mode).toBe('none')
    const target = resolveWithdrawTarget(saved[0].address.toLowerCase(), saved)
    expect(target.mode).toBe('saved')
    expect(target.mode === 'saved' ? target.entry.id : '').toBe('12')
    expect(resolveWithdrawTarget('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', saved).mode).toBe('direct')
  })

  it('v2: saved -> Google only; direct -> Google + email, or SMS for a mobile-only account', () => {
    expect(requiredWithdrawCodes('saved', emailUser, 'network')).toEqual({ google: true, email: false, sms: false })
    expect(requiredWithdrawCodes('direct', emailUser, 'network')).toEqual({ google: true, email: true, sms: false })
    expect(requiredWithdrawCodes('direct', mobileOnly, 'network')).toEqual({ google: true, email: false, sms: true })
  })

  it('QA-023: e-mail-code switch off -> v2 direct and book add need Google only; SMS and legacy unchanged', () => {
    expect(emailCodeRequired({ switch: { email_code_required: '0' } })).toBe(false)
    expect(emailCodeRequired({ switch: {} })).toBe(true)
    expect(emailCodeRequired(null)).toBe(true)
    const direct = requiredWithdrawCodes('direct', emailUser, 'network')
    expect(applyEmailCodeSwitch(direct, 'network', false)).toEqual({ google: true, email: false, sms: false })
    expect(applyEmailCodeSwitch(direct, 'network', true)).toEqual(direct)
    expect(applyEmailCodeSwitch(requiredWithdrawCodes('direct', mobileOnly, 'network'), 'network', false)).toEqual({ google: true, email: false, sms: true })
    expect(applyEmailCodeSwitch(requiredWithdrawCodes('saved', emailUser, 'legacy'), 'legacy', false)).toEqual({ google: true, email: true, sms: false })
  })

  it('historical backend keeps the full factor matrix even for saved addresses', () => {
    expect(requiredWithdrawCodes('saved', emailUser, 'legacy')).toEqual({ google: true, email: true, sms: false })
  })

  it('address book: v2 add = Google + email, v2 delete = Google only, legacy unchanged', () => {
    const legacy = (action: 'add' | 'delete') => requiredAddressBookCodes(mobileOnly, action)
    expect(requiredBookCodes('add', emailUser, 'network', legacy)).toEqual({ google: true, email: true, sms: false })
    expect(requiredBookCodes('delete', mobileOnly, 'network', legacy)).toEqual({ google: true, email: false, sms: false })
    expect(requiredBookCodes('delete', mobileOnly, 'legacy', legacy)).toEqual({ google: true, email: false, sms: true })
  })
})

describe('amount / fee / receive maths on decimal strings', () => {
  it('computes the received amount without float drift', () => {
    expect(receiveAmount('0.3', '0.1')).toBe('0.2')
    expect(receiveAmount('0.002', '0')).toBe('0.002')
    expect(receiveAmount('0.1', '0.1')).toBe('')
    expect(receiveAmount('abc', '0')).toBe('')
    expect(receiveAmount('-1', '0')).toBe('')
  })

  it('MAX is bounded by balance, per-withdrawal max + fee and daily remaining + fee, rounded down', () => {
    expect(maxGrossAmount({ available: '0.0456', fee: '0', withdrawMax: '0.01', dailyRemaining: '0.049', precision: 6 })).toBe('0.01')
    expect(maxGrossAmount({ available: '0.0456', fee: '0', withdrawMax: '0.01', dailyRemaining: '0.004', precision: 6 })).toBe('0.004')
    expect(maxGrossAmount({ available: '0.00123456789', fee: '0', withdrawMax: '', dailyRemaining: '', precision: 6 })).toBe('0.001234')
    expect(maxGrossAmount({ available: '5', fee: '0.5', withdrawMax: '1', dailyRemaining: '', precision: 2 })).toBe('1.5')
    expect(maxGrossAmount({ available: '0', fee: '0', withdrawMax: '', dailyRemaining: '', precision: 2 })).toBe('')
  })

  it('auto-approval hint follows the server threshold and requires an address-book destination', () => {
    expect(approvalHint('0.002', '0.002')).toBe('auto')
    expect(approvalHint('0.0021', '0.002')).toBe('review')
    expect(approvalHint('0.001', '0')).toBe('review')
    expect(approvalHint('0.001', undefined)).toBe('unknown')
    expect(approvalHint('0.001', '0.002', false)).toBe('newAddress')
  })
})

describe('network model and grouping', () => {
  const networks = normalizeWalletNetworks([BSC_ROW])
  const publicInfo = {
    market: {
      coinList: { USDC: { showName: 'USDC' }, USDT: { mainChainType: 1 } },
      followCoinList: { USDT: { USDT: { mainChainName: 'TRC20' }, USDTETH: { mainChainName: 'ERC20' } } },
    },
  } as unknown as PublicInfoV4

  it('normalizes the §6.1 payload', () => {
    expect(networks[0]).toMatchObject({ network: 'BSC', chainId: 56, coins: ['USDC'], checksum: 'EIP-55', tokenContracts: { USDC: BSC_ROW.tokenContracts.USDC } })
    expect(() => normalizeWalletNetworks({ nope: 1 })).toThrow()
  })

  it('the server directory is authoritative; the legacy fallback applies only when it is null', () => {
    // coin listed by a server network -> those networks
    expect(networkChoicesForCoin(publicInfo, 'USDC', networks).map(choice => [choice.id, choice.network, choice.requestSymbol]))
      .toEqual([['BSC', 'BSC', 'USDC']])
    // coin not listed by the server -> [] (no legacy branch fallback)
    expect(networkChoicesForCoin(publicInfo, 'USDT', networks)).toEqual([])
    // an empty (non-null) directory -> []
    expect(networkChoicesForCoin(publicInfo, 'USDT', [])).toEqual([])
    // a directory without USDC -> [] for USDC (USDC is not in the new Fable list)
    const noUsdc = normalizeWalletNetworks([{ network: 'ETH', displayName: 'Ethereum', coins: ['ETH'], tokenContracts: {}, addressRegex: '', needMemo: false }])
    expect(networkChoicesForCoin(publicInfo, 'USDC', noUsdc)).toEqual([])
    // null (endpoint absent / historical backend) keeps the legacy branches and the single-coin fallback
    expect(networkChoicesForCoin(publicInfo, 'USDT', null).map(choice => choice.requestSymbol)).toEqual(['USDT', 'USDTETH'])
    expect(networkChoicesForCoin(publicInfo, 'USDC', null)[0]).toMatchObject({ network: '', requestSymbol: 'USDC' })
  })

  it('groups by network across coins and keeps per-coin legacy rows separate', () => {
    const rows: WalletAddress[] = [
      { id: '1', coin: 'USDC', address: '0xa', tag: '', label: 'a', raw: '', network: 'BSC' },
      { id: '2', coin: 'USDT', address: '0xb', tag: '', label: 'b', raw: '', network: 'BSC' },
      { id: '3', coin: 'BTC', address: 'bc1', tag: '', label: 'c', raw: '' },
    ]
    const groups = groupAddressesByNetwork(rows, networks)
    expect(groups.map(group => [group.key, group.entries.length])).toEqual([['net:BSC', 2], ['coin:BTC', 1]])
    expect(groups[0].title).toBe('BNB Smart Chain (BEP-20)')
    const choice = networkChoicesForCoin(publicInfo, 'USDC', networks)[0]
    expect(savedAddressesFor(rows, choice).map(row => row.id)).toEqual(['1', '2'])
  })

  it('builds BscScan links only for BSC and 32-byte hashes', () => {
    const hash = `0x${'1'.repeat(64)}`
    expect(explorerTxUrl('BSC', hash)).toBe(`https://bscscan.com/tx/${hash}`)
    expect(explorerTxUrl('ETH', hash)).toBe('')
    expect(explorerTxUrl('BSC', 'javascript:alert(1)')).toBe('')
    expect(coinNetworkMap(networks)).toEqual({ USDC: 'BSC' })
  })
})

describe('request bodies (contract v2 vs historical)', () => {
  const base = { requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', symbol: 'USDC', addressId: '', amount: '0.002', fee: '0', googleCode: '123456', smsAuthCode: '', emailValidCode: '654321' }

  it('direct mode sends address XOR addressId, plus network/coinSymbol and save flags', () => {
    expect(buildWithdrawRequestBody({ ...base, network: 'BSC', address: '0xabc', saveAddress: true, label: 'x' })).toEqual({
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      symbol: 'USDC', coinSymbol: 'USDC', network: 'BSC', amount: '0.002', fee: '0', googleCode: '123456',
      address: '0xabc', saveAddress: true, label: 'x', emailValidCode: '654321',
    })
    expect(() => buildWithdrawRequestBody({ ...base, network: 'BSC', addressId: '12', address: '0xabc' })).toThrow(/二选一/)
    expect(() => buildWithdrawRequestBody({ ...base, network: 'BSC' })).toThrow()
  })

  it('never builds a raw-address withdrawal for the historical backend', () => {
    expect(() => buildWithdrawRequestBody({ ...base, address: '0xabc' })).toThrow(/地址簿/)
  })

  it('v2 add uses network + smsAuthCode and an optional label; delete is exactly { id, googleCode }', () => {
    expect(buildAddAddressBody({ coinSymbol: '', network: 'BSC', address: '0xabc', label: '', googleCode: '1', smsValidCode: '2', emailValidCode: '' }))
      .toEqual({ network: 'BSC', address: '0xabc', googleCode: '1', smsAuthCode: '2' })
    expect(buildNetworkDeleteAddressBody('12', '111111')).toEqual({ id: 12, googleCode: '111111' })
    expect(() => buildNetworkDeleteAddressBody('12', '')).toThrow()
  })
})

describe('compatibility layer against both server shapes', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.stubEnv('VITE_WALLET_API_BASE', WALLET_BASE)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('addr/networks: v2 list, or null (historical) on 404 / business error', async () => {
    fetchMock = vi.fn(async () => ok([BSC_ROW]))
    vi.stubGlobal('fetch', fetchMock)
    expect((await fetchWalletNetworks())?.[0].network).toBe('BSC')
    expect(calls(fetchMock)[0].url).toBe(`${API_PREFIX}${WALLET_PATHS.networks}`)

    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'not found' }, 404)))
    expect(await fetchWalletNetworks()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => response({ code: '10020', msg: 'x', data: null })))
    expect(await fetchWalletNetworks()).toBeNull()
  })

  it('address_list rows: v2 rows carry network/ctime, historical rows do not', async () => {
    fetchMock = vi.fn(async () => ok({ addressList: [{ id: 12, network: 'bsc', address: '0xAb', label: 'l', ctime: 1790000000000, coinSymbol: 'USDC', verified: true }] }))
    vi.stubGlobal('fetch', fetchMock)
    const v2 = await fetchAddressBook({ network: 'BSC' })
    expect(calls(fetchMock)[0].body).toEqual({ network: 'BSC' })
    expect(v2[0]).toMatchObject({ id: '12', network: 'BSC', coin: 'USDC' })
    expect(v2[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(addressListHasNetworks(v2)).toBe(true)

    const legacy = normalizeAddressList({ addressList: [{ id: 3, symbol: 'BTC', address: 'bc1', label: 'cold' }] })
    expect(legacy[0].network).toBeUndefined()
    expect(addressListHasNetworks(legacy)).toBe(false)
  })

  it('withdraw_config (v2) is used with a network and falls back to cost/Getcost', async () => {
    fetchMock = vi.fn(async () => ok({
      coinSymbol: 'USDC', network: 'BSC', fee: '0', feeMin: '0', feeMax: '0', withdrawMin: '0.001', withdrawMax: '0.01', dailyLimit: '0.05',
      dailyUsed: '0.001', dailyRemaining: '0.049', autoApprovalThreshold: '0.002', withdrawOpen: true, precision: 6, confirmations: 64,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const v2 = await fetchWithdrawConfig('USDC', { network: 'BSC' })
    expect(calls(fetchMock)).toEqual([{ url: `${WALLET_BASE}${WALLET_PATHS.contractWithdrawConfig}`, body: { coinSymbol: 'USDC', network: 'BSC' } }])
    expect(v2).toMatchObject({ network: 'BSC', dailyRemaining: '0.049', autoApprovalThreshold: '0.002', withdrawOpen: true, precision: 6, withdrawMax: '0.01', defaultFee: '0' })

    // Old server: withdraw_config 404 -> Getcost.
    fetchMock = vi.fn(async (url: string) => (String(url).includes('withdraw_config')
      ? response({}, 404)
      : ok({ feeMin: '0', feeMax: '0', withdraw_min: '0.001', withdraw_max: '0.01', defaultFee: '0', userWithdrawAddrList: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const legacy = await fetchWithdrawConfig('USDC', { network: 'BSC' })
    expect(legacy.withdrawMin).toBe('0.001')
    expect(legacy.autoApprovalThreshold).toBeUndefined()
    expect(calls(fetchMock).at(-1)?.url).toBe(`${API_PREFIX}${WALLET_PATHS.withdrawConfig}`)
  })

  it('a null autoApprovalThreshold is treated as not reported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ fee: '0', withdrawMin: '0.001', withdrawMax: '0.01', autoApprovalThreshold: null, withdrawOpen: false })))
    const config = await fetchWithdrawConfig('USDC', { network: 'BSC' })
    expect(config.autoApprovalThreshold).toBeUndefined()
    expect(config.withdrawOpen).toBe(false)
  })

  it('add reports the v2 idempotent flag; delete sends the v2 body for network rows', async () => {
    fetchMock = vi.fn(async () => ok({ id: 12, network: 'BSC', created: false }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await addWalletAddress({ coinSymbol: '', network: 'BSC', address: '0xa', label: '', googleCode: '1', smsValidCode: '', emailValidCode: '2' })).toEqual({ created: false })
    fetchMock = vi.fn(async () => ok({}))
    vi.stubGlobal('fetch', fetchMock)
    expect(await addWalletAddress({ coinSymbol: 'BTC', address: 'bc1', label: 'x', googleCode: '1', smsValidCode: '', emailValidCode: '' })).toEqual({ created: true })

    fetchMock = vi.fn(async () => ok({ deleted: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await deleteWalletAddress(['12'], { googleCode: '111111', smsValidCode: '222222' }, { network: true })
    expect(calls(fetchMock)[0].body).toEqual({ id: 12, googleCode: '111111' })
  })

  it('reads the CIAO-compatible withdraw list fields (address, coinSymbol, epoch createdAt)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({
      count: 1, financeList: [{ id: 88, withdrawId: 88, coinSymbol: 'USDC', amount: '0.002', fee: '0', address: '0xabc', txid: '', status: 0, createdAt: 1790000000000 }],
    })))
    const page = await fetchWithdrawHistory({ coin: 'USDC', page: 1, pageSize: 10 })
    expect(page.list[0]).toMatchObject({ id: '88', coin: 'USDC', address: '0xabc', status: '0', rawStatus: '0' })
    expect(page.list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })
})

describe('error code mapping', () => {
  const t = (key: string): string => `T:${key}`
  it('maps §6.5 codes and keeps other messages verbatim', () => {
    expect(describeWalletError(new ApiError({ kind: 'api', code: '10054', message: 'raw' }), t)).toBe('T:wallet.err.c10054')
    expect(describeWalletError(new ApiError({ kind: 'api', code: '99999', message: 'server says' }), t)).toBe('server says')
    expect(describeWalletError(new ApiError({ kind: 'network', code: '10054', message: 'offline' }), t)).toBe('offline')
    expect(describeWalletError(new Error('plain'), t)).toBe('plain')
  })
})
