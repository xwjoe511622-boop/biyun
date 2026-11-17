import { i18n } from '@/i18n/composer'
import { z } from 'zod'
import { request } from '@/modules/api/http'
import { count, idText, list, parseWith, text } from '@/modules/content/api-helpers'

/**
 * Message center (login required; every method returns `10002` without a user).
 * Source: exchange-web-api `UserMessageAct.java` (class mapping `/message`):
 * - `:57`  `message/user_message` body `{page, pageSize, messageType}` (type 0 = all) ->
 *   `{userMessageList:[{id, receiveUid, messageType, messageContent, status, ctime}], count, pageSize,
 *   messageType, typeList:[{tid, title}]}`. `status` 1 = unread, 2 = read. Sorted `ctime desc`.
 * - `:146` `message/message_del` body `{ids: "1,2,3"}` (comma separated batch delete).
 * - `:214` `message/message_update_status` body `{id}`; `id > 0` marks one read, `id <= 0` marks all read.
 * - `:281` `message/get_no_read_message_count` body `{}` -> `{noReadMsgCount}`.
 * Message types (`MessageType.java:13-20`): 0 all, 1 system, 2 deposit/withdraw, 3 security, 4 KYC, 7 OTC.
 */
export const MESSAGE_ENDPOINTS = {
  list: 'message/user_message',
  remove: 'message/message_del',
  markRead: 'message/message_update_status',
  unreadCount: 'message/get_no_read_message_count',
} as const

export const MESSAGE_TYPE_ALL = 0
export const MESSAGE_TYPE_SYSTEM = 1
export const STATUS_UNREAD = 1
export const STATUS_READ = 2

export interface MessageItem {
  id: string
  type: number
  /** Raw content; may contain HTML and is always sanitized before rendering. */
  content: string
  read: boolean
  /** Epoch ms or null. */
  time: number | null
}

export interface MessageType {
  id: number
  title: string
}

export interface MessagePage {
  items: MessageItem[]
  count: number
  types: MessageType[]
}

const epoch = z
  .union([z.number().finite(), z.string().regex(/^\d+$/)])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : Number(value))) // float-ok: epoch timestamp
const intValue = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform(Number)

const messageSchema = z
  .object({ id: idText, messageType: intValue.nullish(), messageContent: text, status: intValue, ctime: epoch })
  .passthrough()
const listSchema = z
  .object({
    userMessageList: list(messageSchema),
    count,
    typeList: list(z.object({ tid: intValue, title: text }).passthrough()),
  })
  .passthrough()
const unreadSchema = z.object({ noReadMsgCount: count }).passthrough()

export interface MessageQuery {
  page: number
  pageSize: number
  type: number
}

export async function fetchMessages(query: MessageQuery, signal?: AbortSignal): Promise<MessagePage> {
  const body = { page: query.page, pageSize: query.pageSize, messageType: query.type }
  const data = await request<unknown>(MESSAGE_ENDPOINTS.list, { body, signal })
  const parsed = parseWith(listSchema, MESSAGE_ENDPOINTS.list, data)
  return {
    count: parsed.count,
    types: parsed.typeList.map((type) => ({ id: type.tid, title: type.title })),
    items: parsed.userMessageList.map((item) => ({
      id: item.id,
      type: item.messageType ?? 0,
      content: item.messageContent,
      read: item.status === STATUS_READ,
      time: item.ctime,
    })),
  }
}

function assertIds(ids: string[]): string[] {
  const clean = ids.filter((id) => /^[1-9]\d{0,18}$/.test(id))
  if (clean.length === 0 || clean.length !== ids.length) throw new Error(i18n.global.t('clientFailure.invalidMessageId'))
  return clean
}

export async function markMessageRead(id: string): Promise<void> {
  const [clean] = assertIds([id])
  await request<unknown>(MESSAGE_ENDPOINTS.markRead, { body: { id: Number(clean) } }) // float-ok: message id
}

/** Server convention: `id <= 0` marks every unread message of the user as read. */
export async function markAllMessagesRead(): Promise<void> {
  await request<unknown>(MESSAGE_ENDPOINTS.markRead, { body: { id: 0 } })
}

export async function deleteMessages(ids: string[]): Promise<void> {
  const clean = assertIds(ids)
  await request<unknown>(MESSAGE_ENDPOINTS.remove, { body: { ids: clean.join(',') } })
}

export async function fetchUnreadCount(signal?: AbortSignal): Promise<number> {
  const data = await request<unknown>(MESSAGE_ENDPOINTS.unreadCount, { body: {}, signal })
  return parseWith(unreadSchema, MESSAGE_ENDPOINTS.unreadCount, data).noReadMsgCount
}
