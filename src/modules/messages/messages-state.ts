import type { MessageItem } from './messages.api'

/**
 * Pure read/unread bookkeeping for the message center. Local state is only updated after the
 * server accepted the change, so these helpers never pretend a failed request succeeded.
 */

export function applyRead(items: MessageItem[], id: string): MessageItem[] {
  return items.map((item) => (item.id === id && !item.read ? { ...item, read: true } : item))
}

export function applyReadAll(items: MessageItem[]): MessageItem[] {
  return items.map((item) => (item.read ? item : { ...item, read: true }))
}

export function removeIds(items: MessageItem[], ids: string[]): MessageItem[] {
  const drop = new Set(ids)
  return items.filter((item) => !drop.has(item.id))
}

export function unreadIn(items: MessageItem[]): number {
  return items.reduce((total, item) => total + (item.read ? 0 : 1), 0) // float-ok: unread count
}

/** New unread total after marking `id` read, given the server total before the change. */
export function unreadAfterRead(total: number, items: MessageItem[], id: string): number {
  const target = items.find((item) => item.id === id)
  return target !== undefined && !target.read ? Math.max(0, total - 1) : total // float-ok: unread count
}

/** New unread total after deleting `ids`. */
export function unreadAfterDelete(total: number, items: MessageItem[], ids: string[]): number {
  const drop = new Set(ids)
  const removedUnread = items.filter((item) => drop.has(item.id) && !item.read).length
  return Math.max(0, total - removedUnread) // float-ok: unread count
}

/** Toggles a selection id; returns a new array. */
export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
}
