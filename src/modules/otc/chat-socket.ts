import { session } from '@/core/session'
import { parseJsonLossless } from '@/core/lossless-json'
/**
 * otc-chat WebSocket client.
 *
 * Protocol (otc-parent/otc-chat `socket/OnlineChatNewServer.java:31,159,207-235`; legacy PC
 * `otcDetailOrder/chat/chat.js:160-300`):
 * - URL: `${public_info.otcChatWS}/${btoa(myUid + peerUid)}`.
 * - send: `{ chatId, message: { content, from, to, orderId: <sequence>, time }, type: 'message' }`.
 * - receive: `{ chatId, message: { content, from, to, orderId, time }, type }`; the sender receives an
 *   echo of its own message (used as the delivery acknowledgement).
 * - The server throttles to one message / 5 s per sender and order.
 *
 * The Rust C2C server authenticates the token and checks order membership, as described below.
 */

export interface ChatSocketMessage {
  chatId: string
  content: string
  from: string
  to: string
  orderId: string
  time: number | null
  /** Server message type (camelCase, e.g. `red_packet`); absent for ordinary text. */
  msgType?: string
  /** Red-packet SN, only when `msgType === 'red_packet'` and the ext SN is well-formed. */
  redPacketSn?: string
}

/** `ext` may be an object or a JSON string; arrays/null are rejected. */
function parseExtRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = parseJsonLossless(value)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const RED_PACKET_SN_RE = /^[A-Za-z0-9_-]{1,128}$/

export type ChatSocketState = 'idle' | 'connecting' | 'open' | 'closed' | 'unavailable'

export interface ChatSocketOptions {
  baseUrl: string
  from: string
  to: string
  orderId: string
  onMessage: (message: ChatSocketMessage) => void
  onState: (state: ChatSocketState) => void
  /** Injected for tests. */
  createSocket?: (url: string) => WebSocket
  /** Session key provider (signed-in check); defaults to the in-memory exchange session. */
  getToken?: () => string
}

/**
 * otc-chat authenticates the socket with the exchange session and only accepts a peer that shares an order with the
 * caller (`OtcChatAuthPolicy`). Since 10-17 the session is the HttpOnly cookie: the handshake carries it (same
 * origin only, hence {@link sameOriginChatBase}) and Nginx hands it to the chat after an Origin check. The old
 * `?token=` query form stays for non-browser clients (`token` argument), the page never uses it.
 */
export function chatSocketUrl(baseUrl: string, from: string, to: string, token = ''): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/${btoa(`${from}${to}`)}`
  return token === '' ? url : `${url}?token=${encodeURIComponent(token)}`
}

/**
 * The configured chat socket (`otcChatWS`, e.g. `wss://www.ttexxx.xyz/otc-chat/chatServer`) on the page's own host:
 * the session cookie is host-only, so a page opened on `trade.` or the apex must not dial `www.`. Other paths
 * (a custom chat host) are kept as configured.
 */
export function sameOriginChatBase(baseUrl: string, loc: Pick<Location, 'protocol' | 'host'> | undefined =
  typeof location === 'undefined' ? undefined : location): string {
  if (loc === undefined) return baseUrl
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return baseUrl
  }
  if (!parsed.pathname.startsWith('/otc-chat/')) return baseUrl
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}${parsed.pathname}`
}

export function parseChatFrame(data: unknown): ChatSocketMessage | null {
  if (typeof data !== 'string') return null
  let parsed: unknown
  try {
    parsed = parseJsonLossless(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const frame = parsed as Record<string, unknown>
  const message = frame.message
  if (message === null || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  const content = typeof m.content === 'string' ? m.content : ''
  if (content === '') return null
  const time = typeof m.time === 'number' ? m.time : typeof m.time === 'string' && /^\d+$/.test(m.time) ? Number(m.time) : null // float-ok: epoch timestamp
  const msgType = typeof m.msgType === 'string' ? m.msgType : ''
  let redPacketSn: string | undefined
  if (msgType === 'red_packet') {
    const ext = parseExtRecord(m.ext)
    const sn = ext?.sn
    if (typeof sn === 'string' && RED_PACKET_SN_RE.test(sn)) redPacketSn = sn
  }
  return {
    chatId: frame.chatId === undefined || frame.chatId === null ? '' : String(frame.chatId),
    content,
    from: m.from === undefined ? '' : String(m.from),
    to: m.to === undefined ? '' : String(m.to),
    orderId: m.orderId === undefined ? '' : String(m.orderId),
    time,
    ...(msgType === '' ? {} : { msgType }),
    ...(redPacketSn === undefined ? {} : { redPacketSn }),
  }
}

const RECONNECT_DELAYS_MS = [1000, 3000, 5000, 10000, 20000]

export class OtcChatSocket {
  private socket: WebSocket | null = null
  private chatId = ''
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly options: ChatSocketOptions) {}

  connect(): void {
    if (this.options.baseUrl === '') {
      this.options.onState('unavailable')
      return
    }
    this.stopped = false
    this.open()
  }

  private open(): void {
    if (this.stopped) return
    this.options.onState('connecting')
    // Read the live session each (re)connect: a signed-out or rotated session must never reuse a token.
    // signed in? (session key; the cookie authenticates the handshake)
    const token = this.options.getToken ? this.options.getToken() : session.getToken() ?? ''
    if (token === '') {
      this.options.onState('unavailable')
      return
    }
    const url = chatSocketUrl(sameOriginChatBase(this.options.baseUrl), this.options.from, this.options.to)
    let socket: WebSocket
    try {
      socket = this.options.createSocket ? this.options.createSocket(url) : new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.attempts = 0
      this.options.onState('open')
    }
    socket.onmessage = (event: MessageEvent) => {
      const message = parseChatFrame(event.data)
      if (message === null) return
      if (message.chatId !== '') this.chatId = message.chatId
      if (message.orderId !== '' && message.orderId !== this.options.orderId) return
      this.options.onMessage(message)
    }
    socket.onerror = () => {
      socket.close()
    }
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null
      if (this.stopped) return
      this.options.onState('closed')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempts, RECONNECT_DELAYS_MS.length - 1)]
    this.attempts += 1
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
  }

  /** Returns the client timestamp used to match the server echo, or `null` when not connected. */
  send(content: string): number | null {
    const socket = this.socket
    if (socket === null || socket.readyState !== 1) return null
    const time = Date.now()
    socket.send(JSON.stringify({
      chatId: this.chatId,
      message: { content, from: this.options.from, to: this.options.to, orderId: this.options.orderId, time },
      type: 'message',
    }))
    return time
  }

  close(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.onclose = null
      socket.close()
    }
    this.options.onState('idle')
  }
}
