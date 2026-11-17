// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { request } from '@/modules/api/http'
import { session } from '@/core/session'
import {
  deleteMessages,
  fetchMessages,
  fetchUnreadCount,
  markAllMessagesRead,
  markMessageRead,
  type MessageItem,
} from '@/modules/messages/messages.api'
import {
  applyRead,
  applyReadAll,
  removeIds,
  toggleSelection,
  unreadAfterDelete,
  unreadAfterRead,
  unreadIn,
} from '@/modules/messages/messages-state'
import { refreshUnreadCount, resetUnreadForTests, setUnreadCount, useUnreadMessages } from '@/modules/messages/useUnreadMessages'

// Synthetic only: no request leaves this process.
vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))
const mocked = vi.mocked(request)

const item = (id: string, read: boolean): MessageItem => ({ id, type: 1, content: `m${id}`, read, time: null })

beforeEach(() => {
  vi.resetAllMocks()
  session.clear()
  resetUnreadForTests()
})
afterEach(() => session.clear())

describe('messages API (UserMessageAct)', () => {
  it('maps status 1/2 to unread/read and returns the type tabs', async () => {
    mocked.mockResolvedValue({
      userMessageList: [
        { id: 5, receiveUid: 1, messageType: 1, messageContent: 'hi', status: 1, ctime: 1790000000000 },
        { id: 4, messageType: '3', messageContent: 'x', status: '2', ctime: null },
      ],
      count: 2, pageSize: 10, messageType: 0,
      typeList: [{ tid: 0, title: 'All' }, { tid: 1, title: 'System' }],
    })
    const page = await fetchMessages({ page: 1, pageSize: 10, type: 0 })
    expect(mocked).toHaveBeenCalledWith('message/user_message', { body: { page: 1, pageSize: 10, messageType: 0 }, signal: undefined })
    expect(page.items.map((m) => [m.id, m.read, m.type])).toEqual([['5', false, 1], ['4', true, 3]])
    expect(page.types).toEqual([{ id: 0, title: 'All' }, { id: 1, title: 'System' }])
  })

  it('rejects a list without status', async () => {
    mocked.mockResolvedValue({ userMessageList: [{ id: 1, messageContent: 'x' }], count: 1, typeList: [] })
    await expect(fetchMessages({ page: 1, pageSize: 10, type: 0 })).rejects.toMatchObject({ kind: 'parse' })
  })

  it('uses the exact bodies for read, read-all and delete', async () => {
    mocked.mockResolvedValue(null)
    await markMessageRead('12')
    await markAllMessagesRead()
    await deleteMessages(['3', '4'])
    expect(mocked.mock.calls).toEqual([
      ['message/message_update_status', { body: { id: 12 } }],
      ['message/message_update_status', { body: { id: 0 } }],
      ['message/message_del', { body: { ids: '3,4' } }],
    ])
  })

  it('refuses malformed ids before any request', async () => {
    await expect(markMessageRead('0')).rejects.toThrow()
    await expect(deleteMessages(['1', '2,3'])).rejects.toThrow()
    await expect(deleteMessages([])).rejects.toThrow()
    expect(mocked).not.toHaveBeenCalled()
  })

  it('reads the unread count', async () => {
    mocked.mockResolvedValue({ noReadMsgCount: 7 })
    await expect(fetchUnreadCount()).resolves.toBe(7)
    expect(mocked).toHaveBeenCalledWith('message/get_no_read_message_count', { body: {}, signal: undefined })
  })
})

describe('read / unread bookkeeping', () => {
  const list = [item('1', false), item('2', true), item('3', false)]

  it('marks one or all read without mutating the input', () => {
    expect(applyRead(list, '1').map((m) => m.read)).toEqual([true, true, false])
    expect(applyReadAll(list).every((m) => m.read)).toBe(true)
    expect(list[0]?.read).toBe(false)
  })

  it('adjusts the server unread total only for messages that were unread', () => {
    expect(unreadIn(list)).toBe(2)
    expect(unreadAfterRead(5, list, '1')).toBe(4)
    expect(unreadAfterRead(5, list, '2')).toBe(5)
    expect(unreadAfterRead(0, list, '1')).toBe(0)
    expect(unreadAfterDelete(5, list, ['1', '2', '3'])).toBe(3)
    expect(removeIds(list, ['2']).map((m) => m.id)).toEqual(['1', '3'])
  })

  it('toggles selection', () => {
    expect(toggleSelection([], 'a')).toEqual(['a'])
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('useUnreadMessages', () => {
  it('stays unknown while signed out and never requests', async () => {
    await expect(refreshUnreadCount()).resolves.toBeNull()
    expect(mocked).not.toHaveBeenCalled()
  })

  it('tracks the server count, formats the badge and clears on session change', async () => {
    session.setToken('token-a')
    mocked.mockResolvedValue({ noReadMsgCount: 120 })
    const scope = effectScope()
    const unread = scope.run(() => useUnreadMessages())!
    await refreshUnreadCount()
    expect(unread.count.value).toBe(120)
    expect(unread.badge.value).toBe('99+')
    setUnreadCount(3)
    expect(unread.badge.value).toBe('3')
    setUnreadCount(0)
    expect(unread.badge.value).toBe('')
    session.clear()
    expect(unread.count.value).toBeNull()
    scope.stop()
  })

  it('ignores a response that arrives after the session changed', async () => {
    session.setToken('token-a')
    let resolve: (value: unknown) => void = () => undefined
    mocked.mockReturnValue(new Promise((r) => { resolve = r }))
    const scope = effectScope()
    const unread = scope.run(() => useUnreadMessages())!
    const pending = refreshUnreadCount()
    session.setToken('token-b')
    resolve({ noReadMsgCount: 9 })
    await pending
    expect(unread.count.value).toBeNull()
    scope.stop()
  })

  it('keeps the previous value when a refresh fails', async () => {
    session.setToken('token-a')
    const scope = effectScope()
    const unread = scope.run(() => useUnreadMessages())!
    mocked.mockResolvedValueOnce({ noReadMsgCount: 2 })
    await refreshUnreadCount()
    mocked.mockRejectedValueOnce(new Error('offline'))
    await refreshUnreadCount()
    expect(unread.count.value).toBe(2)
    scope.stop()
  })
})
