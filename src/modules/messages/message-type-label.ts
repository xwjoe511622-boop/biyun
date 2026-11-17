import type { MessageType } from './messages.api'

/** UserMessageAct::MESSAGE_TYPES: stable ids, not positions in the filtered typeList. */
const TYPE_KEYS: Readonly<Record<number, string>> = {
  0: 'allMessage', 1: 'systemMessage', 2: 'depositWithdrawMessage',
  3: 'securedMessage', 4: 'authMessage', 7: 'otcMessage',
}

export function messageTypeLabel(type: MessageType, translate: (key: string, values: { id: number }) => string): string {
  const serverTitle = type.title.trim()
  const key = TYPE_KEYS[type.id]
  if (serverTitle !== '' && serverTitle !== key) return serverTitle
  return translate(key ? `msg.types.${key}` : 'msg.category', { id: type.id })
}
