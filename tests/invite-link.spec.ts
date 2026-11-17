// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from '@/modules/api/http'
import { buildInviteLink, fetchInviteInfo, fetchRebates, isValidInviteCode, summarizeRebates } from '@/modules/invite/invite.api'

vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))
const mocked = vi.mocked(request)
beforeEach(() => vi.resetAllMocks())

describe('buildInviteLink', () => {
  it('targets this client’s register page with the inviteCode query the register view reads', () => {
    expect(buildInviteLink('https://ex.example.com', 'AB12cd')).toBe('https://ex.example.com/register?inviteCode=AB12cd')
    expect(buildInviteLink('http://127.0.0.1:5183/whatever', 'X1')).toBe('http://127.0.0.1:5183/register?inviteCode=X1')
  })

  it('honours a non-root base path', () => {
    expect(buildInviteLink('https://ex.example.com', 'X1', '/pc/')).toBe('https://ex.example.com/pc/register?inviteCode=X1')
    expect(buildInviteLink('https://ex.example.com', 'X1', 'pc')).toBe('https://ex.example.com/pc/register?inviteCode=X1')
  })

  it('refuses malformed codes and unsafe origins instead of encoding them', () => {
    expect(buildInviteLink('https://ex.example.com', '')).toBe('')
    expect(buildInviteLink('https://ex.example.com', 'a b')).toBe('')
    expect(buildInviteLink('https://ex.example.com', 'x&admin=1')).toBe('')
    expect(buildInviteLink('javascript:alert(1)', 'X1')).toBe('')
    expect(buildInviteLink('not a url', 'X1')).toBe('')
    expect(isValidInviteCode('A'.repeat(33))).toBe(false)
  })
})

describe('fetchInviteInfo (return/invite_info_list)', () => {
  it('maps the populated contract', async () => {
    mocked.mockResolvedValue({
      coin: 'USDT', id: 10001, inviteCode: 'ABC123', inviteUrl: 'https://legacy/register?inviteCode=ABC123', inviteQECode: 'data:image/png;base64,AA',
      invite_number: 12, invite_return_number: 3.5,
      invite_list: [{ invitee: '138****0000', register_time: 1790000000000 }],
    })
    const info = await fetchInviteInfo(2, 10)
    expect(mocked).toHaveBeenCalledWith('return/invite_info_list', { body: { page: 2, pageSize: 10 }, signal: undefined })
    expect(info).toEqual({ inviteCode: 'ABC123', coin: 'USDT', invitedCount: 12, rebateTotal: '3.5', invitees: [{ account: '138****0000', registeredAt: 1790000000000 }] })
  })

  it('treats the server’s empty-string list as no invitees', async () => {
    mocked.mockResolvedValue({ coin: 'USDT', inviteCode: 'ABC123', invite_number: 0, invite_return_number: '0E-8', invite_list: '' })
    const info = await fetchInviteInfo(1, 10)
    expect(info.invitees).toEqual([])
    expect(info.invitedCount).toBe(0)
    expect(info.rebateTotal).toBe('0')
  })

  it('rejects a non-list, non-empty invite_list', async () => {
    mocked.mockResolvedValue({ inviteCode: 'A', invite_number: 0, invite_list: 'oops' })
    await expect(fetchInviteInfo(1, 10)).rejects.toMatchObject({ kind: 'parse', message: expect.stringContaining('invite_list') })
  })
})

describe('fetchRebates (invite_code/bonusList)', () => {
  // Shape observed live on 2026-09-28 for the owner account (values as fastjson numbers).
  const live = [
    { id: 4, uid: 2147482508, pid: 2147482110, roleId: 0, symbol: 'BTC', feeSymbol: 'BTC', fee: 0.00011792126, scale: 20, amount: 2.358e-5, ctime: 1790536778000, email: 'a****@x.io', phoneNumber: '' },
    { id: 5, uid: 2147482508, pid: 2147482110, roleId: 0, symbol: 'USDT', feeSymbol: 'USDT', fee: 10.00161728867, scale: 20, amount: 2.00032345, ctime: 1790536779000, email: 'a****@x.io', phoneNumber: '' },
    { id: 6, uid: 2147482502, pid: 2147482110, roleId: 1, symbol: 'USDT', feeSymbol: 'USDT', fee: 1747.70340739725, scale: 20, amount: 349.54068147, ctime: 1790536779000, email: 'c****@x.io', phoneNumber: '' },
  ]

  it('GETs the list, sorts newest first and totals exactly per coin', async () => {
    mocked.mockResolvedValue(live)
    const summary = await fetchRebates()
    expect(mocked).toHaveBeenCalledWith('invite_code/bonusList?pages=1&pageSize=1000', { method: 'GET', signal: undefined })
    expect(summary.records.map((row) => row.id)).toEqual(['6', '5', '4'])
    expect(summary.records[0]).toEqual({ id: '6', market: 'futures', invitee: 'c****@x.io', coin: 'USDT', fee: '1747.70340739725', ratePct: '20', amount: '349.54068147', time: 1790536779000 })
    expect(summary.records[2]).toMatchObject({ market: 'spot', coin: 'BTC', amount: '0.00002358' })
    expect(summary.totals).toEqual([{ coin: 'BTC', amount: '0.00002358' }, { coin: 'USDT', amount: '351.54100492' }])
  })

  it('never shows an unmasked address (admin back-fill) and accepts an empty or null list', async () => {
    mocked.mockResolvedValue([{ id: 1, uid: 7, roleId: 0, symbol: 'usdt', fee: '1', scale: '20', amount: '0.2', ctime: 1, email: 'plain@x.io', phoneNumber: '' }])
    const summary = await fetchRebates()
    expect(summary.records[0].invitee).toBe('UID 7')
    expect(summary.records[0].coin).toBe('USDT')
    mocked.mockResolvedValue(null)
    expect(await fetchRebates()).toEqual({ records: [], totals: [] })
    mocked.mockResolvedValue([])
    expect(summarizeRebates([])).toEqual({ records: [], totals: [] })
  })

  it('rejects a non-list payload as a contract error', async () => {
    mocked.mockResolvedValue({ rows: [] })
    await expect(fetchRebates()).rejects.toMatchObject({ kind: 'parse' })
  })
})
