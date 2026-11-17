// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { session } from '@/core/session'
import { API_PREFIX } from '@/config/endpoints'
import { OTC_API_PREFIX } from '@/modules/api/http'
import {
  appealOrder,
  createOrder,
  fetchMyOrders,
  fetchOrderDetail,
  fetchOtcAccounts,
  fetchPublicInfo,
  releaseOrder,
  searchAdverts,
  transferOtc,
} from '@/modules/otc/api'
import { OtcChatSocket, chatSocketUrl, parseChatFrame, sameOriginChatBase } from '@/modules/otc/chat-socket'

function respond(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'X',
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

function call(index = -1): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
  const calls = fetchMock.mock.calls
  const [url, init] = calls[index < 0 ? calls.length + index : index] as unknown as [string, RequestInit]
  return { url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>, headers: init.headers as Record<string, string> }
}

beforeEach(() => {
  session.clear()
  session.setToken('tok-1')
  fetchMock = vi.fn(async () => respond({ code: 0, msg: 'ok', data: {} }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  session.clear()
})

describe('otc api routing', () => {
  it('sends OTC-service calls to the otc prefix with the spot session cookie', async () => {
    fetchMock.mockResolvedValueOnce(respond({ code: 0, data: { count: 1, advertList: [{ advertId: 9, userId: 3, otcNickName: 'Ann', price: 7.13, volumeBalance: '12.5', minTrade: 100, maxTrade: '5000', payCoin: 'cny', creditGrade: 0.98, payments: [{ key: 'otc.payment.alipay', title: 'Alipay' }] }] } }))
    const page = await searchAdverts({ side: 'SELL', symbol: 'USDT', payCoin: 'CNY', payment: '', page: 1, pageSize: 10 })
    const sent = call()
    expect(sent.url).toBe(`${OTC_API_PREFIX}otc/search`)
    expect(sent.headers['exchange-token']).toBeUndefined()
    expect(sent.headers['X-LB-Session']).toBe('cookie')
    expect(sent.body).toEqual({ side: 'SELL', symbol: 'USDT', payCoin: 'CNY', page: '1', pageSize: '10', isBlockTrade: '0' })
    expect(page.count).toBe(1)
    expect(page.items[0]).toMatchObject({ advertId: '9', price: '7.13', minTrade: '100', payCoin: 'CNY', creditGrade: '0.98' })
  })

  it('keeps web-api calls (accounts, transfer, order lists, appeal ticket) on the default prefix', async () => {
    fetchMock.mockResolvedValueOnce(respond({ code: '0', data: { allCoinMap: { USDT: { coinSymbol: 'usdt', normal: '10.5', lock: '1', total_balance: '11.5', exchangeNormal: '99' } } } }))
    const rows = await fetchOtcAccounts()
    expect(call().url).toBe(`${API_PREFIX}finance/v4/otc_account_list`)
    expect(rows).toEqual([{ coin: 'USDT', normal: '10.5', lock: '1', total: '11.5', spotNormal: '99' }])

    await transferOtc({ from: 'spot', to: 'otc', amount: '5', coin: 'USDT' })
    expect(call().url).toBe(`${API_PREFIX}finance/otc_transfer`)
    expect(call().body).toEqual({ fromAccount: '1', toAccount: '2', amount: '5', coinSymbol: 'USDT' })

    fetchMock.mockResolvedValueOnce(respond({ code: '0', data: { count: 1, orderList: [{ sequence: '2026092612', side: 'BUY', coinSymbol: 'usdt', price: '7.12CNY', totalPrice: '712.00CNY', volume: '100', status: 2, nickName: 'Bob' }] } }))
    const orders = await fetchMyOrders({ endpoint: 'bystatus', status: 2 }, 1, 10)
    expect(call().url).toBe(`${API_PREFIX}order/otc/bystatus`)
    expect(call().body).toEqual({ page: '1', pageSize: '10', status: '2' })
    expect(orders.items[0]).toMatchObject({ price: '7.12', totalPrice: '712.00', payCoin: 'CNY', status: 2, counterparty: 'Bob' })

    await fetchMyOrders({ endpoint: 'complete', isShowCanceled: 0 }, 2, 10)
    expect(call().url).toBe(`${API_PREFIX}order/otc/complete`)
    expect(call().body).toEqual({ page: '2', pageSize: '10', isShowCanceled: '0' })
  })

  it('routes buy vs sell order creation and sends the fund password only for selling', async () => {
    fetchMock.mockResolvedValue(respond({ code: '0', data: { sequence: '20260926001' } }))
    await createOrder({ advertSide: 'SELL', advertId: '9', price: '7.13', totalPrice: '713', volume: '100', type: 'price', capitalPword: 'x' })
    expect(call().url).toBe(`${OTC_API_PREFIX}v4/otc/buy_order_save`)
    expect(call().body).not.toHaveProperty('capitalPword')
    const seq = await createOrder({ advertSide: 'BUY', advertId: '9', price: '7.13', totalPrice: '713', volume: '100', type: 'volume', capitalPword: 'pw' })
    expect(call().url).toBe(`${OTC_API_PREFIX}v4/otc/sell_order_save`)
    expect(call().body).toMatchObject({ capitalPword: 'pw', type: 'volume' })
    expect(seq).toBe('20260926001')
  })

  it('normalises order detail and marks polling requests with exchange-auto', async () => {
    fetchMock.mockResolvedValueOnce(respond({ code: '0', data: {
      sequence: 'S1', coin: 'usdt', paycoin: 'cny', price: 7.13, volume: '100', totalPrice: '713', status: 1, limitTime: 600000,
      buyer: { uid: 1, otcNickName: 'B' }, seller: { uid: 2, otcNickName: 'S', isOnline: 1 },
      payment: [{ payment: 'otc.payment.alipay', userName: 'S', account: 'a@b', qrcodeImg: 'javascript:alert(1)' }],
      isComplainUser: 0,
    } }))
    const detail = await fetchOrderDetail('S1', true)
    expect(call().url).toBe(`${OTC_API_PREFIX}v4/otc/order_detail`)
    expect(call().headers['exchange-auto']).toBe('1')
    expect(detail).toMatchObject({ coin: 'USDT', payCoin: 'CNY', price: '7.13', status: 1, limitTime: 600000 })
    expect(detail.seller).toMatchObject({ uid: '2', online: true })
    expect(detail.paymentAccounts[0].qrcodeImg).toBe('')
  })

  it('release sends sequence + capitalPword; appeal creates the ticket then complains', async () => {
    await releaseOrder('S1', 'pw')
    expect(call().url).toBe(`${OTC_API_PREFIX}otc/confirm_order`)
    expect(call().body).toEqual({ sequence: 'S1', capitalPword: 'pw' })

    fetchMock.mockResolvedValueOnce(respond({ code: '0', data: { complainId: 77 } }))
    fetchMock.mockResolvedValueOnce(respond({ code: '0', data: null }))
    await appealOrder('S1', 'seller', 'not received')
    expect(call(-2).url).toBe(`${API_PREFIX}question/create_problem`)
    expect(call(-2).body).toEqual({ rqType: 9, rqDescribe: 'not received' })
    expect(call().url).toBe(`${OTC_API_PREFIX}otc/complain_order`)
    expect(call().body).toEqual({ sequence: 'S1', complainId: '77' })
  })

  it('an OTC "not logged in" never clears the spot session', async () => {
    fetchMock.mockResolvedValueOnce(respond({ code: 10002, msg: 'not login' }))
    await expect(fetchOrderDetail('S1')).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(session.getToken()).toBe('tok-1')
  })

  it('treats an HTML fallback page (service not routed) as a parse failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', text: async () => '<!doctype html><html></html>' } as unknown as Response)
    await expect(fetchPublicInfo()).rejects.toMatchObject({ kind: 'parse' })
  })

  it('retries public_info once after a transient 502 gateway error', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(respond({}, 502))
    fetchMock.mockResolvedValueOnce(respond({ code: 0, data: { otcChatWS: '', payments: [], paycoins: [], defaultSeach: 'BUY' } }))
    const pending = fetchPublicInfo()
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ chatWsUrl: '' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('accepts only ws(s) chat URLs from public_info', async () => {
    fetchMock.mockResolvedValueOnce(respond({ code: 0, data: { otcChatWS: 'wss://chat.example/otc-chat/chatServer/', payments: [], paycoins: [{ key: 'CNY', title: 'RMB', used: true }], defaultSeach: 'BUY' } }))
    expect((await fetchPublicInfo()).chatWsUrl).toBe('wss://chat.example/otc-chat/chatServer')
    fetchMock.mockResolvedValueOnce(respond({ code: 0, data: { otcChatWS: 'https://evil.example/x' } }))
    expect((await fetchPublicInfo()).chatWsUrl).toBe('')
  })
})

describe('otc chat socket', () => {
  it('builds the legacy url and parses frames', () => {
    expect(chatSocketUrl('wss://h/otc-chat/chatServer/', '12', '34')).toBe(`wss://h/otc-chat/chatServer/${btoa('1234')}`)
    expect(chatSocketUrl('wss://h/otc-chat/chatServer', '12', '34', 'a b')).toBe(`wss://h/otc-chat/chatServer/${btoa('1234')}?token=a%20b`)
  })

  it('dials the chat socket on the page host so the host-only session cookie is sent', () => {
    const loc = { protocol: 'https:', host: 'trade.example.test' }
    expect(sameOriginChatBase('wss://www.example.test/otc-chat/chatServer', loc)).toBe('wss://trade.example.test/otc-chat/chatServer')
    expect(sameOriginChatBase('wss://chat.example.test/custom', loc)).toBe('wss://chat.example.test/custom')
    expect(sameOriginChatBase('not a url', loc)).toBe('not a url')
    expect(sameOriginChatBase('wss://www.example.test/otc-chat/chatServer', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/otc-chat/chatServer')
    expect(parseChatFrame('{"chatId":5,"message":{"content":"hi","from":"1","to":"2","orderId":"S","time":9}}'))
      .toEqual({ chatId: '5', content: 'hi', from: '1', to: '2', orderId: 'S', time: 9 })
    expect(parseChatFrame('not json')).toBeNull()
    expect(parseChatFrame('{"message":{"content":""}}')).toBeNull()
  })

  it('sends the legacy envelope, filters other orders and reports unavailable without a URL', () => {
    const sent: string[] = []
    const fake = { readyState: 1, send: (v: string) => sent.push(v), close: vi.fn() } as unknown as WebSocket & { onopen: () => void; onmessage: (e: { data: string }) => void }
    const received: string[] = []
    const states: string[] = []
    const urls: string[] = []
    const socket = new OtcChatSocket({
      baseUrl: 'wss://h/c', from: '1', to: '2', orderId: 'S',
      onMessage: m => received.push(m.content), onState: s => states.push(s),
      createSocket: (url) => { urls.push(url); return fake }, getToken: () => 'tok-1',
    })
    socket.connect()
    fake.onopen()
    fake.onmessage({ data: '{"chatId":8,"message":{"content":"a","from":"2","to":"1","orderId":"S","time":1}}' })
    fake.onmessage({ data: '{"message":{"content":"b","from":"2","to":"1","orderId":"OTHER","time":1}}' })
    const time = socket.send('hello')
    expect(time).not.toBeNull()
    expect(JSON.parse(sent[0])).toEqual({ chatId: '8', message: { content: 'hello', from: '1', to: '2', orderId: 'S', time }, type: 'message' })
    expect(received).toEqual(['a'])
    // 10-17: the handshake carries the HttpOnly cookie; no token in the URL
    expect(urls[0]).toBe(`wss://h/c/${btoa('12')}`)
    expect(states).toContain('open')
    socket.close()

    const none: string[] = []
    new OtcChatSocket({ baseUrl: '', from: '1', to: '2', orderId: 'S', onMessage: () => {}, onState: s => none.push(s) }).connect()
    expect(none).toEqual(['unavailable'])

    // No session token: never open an unauthenticated socket.
    const noToken: string[] = []
    const create = vi.fn()
    new OtcChatSocket({ baseUrl: 'wss://h/c', from: '1', to: '2', orderId: 'S', onMessage: () => {}, onState: s => noToken.push(s), createSocket: create, getToken: () => '' }).connect()
    expect(create).not.toHaveBeenCalled()
    expect(noToken).toContain('unavailable')
  })
})
