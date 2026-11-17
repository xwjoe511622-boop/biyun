import { useI18n } from 'vue-i18n'

export const messagesMessages = {
  'zh-CN': {
    msg: {
      title: '消息中心',
      lead: '系统通知、充提、安全与认证消息。',
      loginRequired: '登录后查看你的站内消息。',
      all: '全部',
      unread: '未读',
      system: '系统消息',
      category: '消息类别 {id}',
      types: { allMessage: '全部', systemMessage: '系统消息', depositWithdrawMessage: '充提消息', securedMessage: '安全消息', authMessage: '认证消息', otcMessage: 'C2C 消息' },
      markAll: '全部已读',
      markRead: '标为已读',
      remove: '删除',
      removeSelected: '删除所选 ({n})',
      selectAll: '全选本页',
      confirmDelete: '确认删除所选的 {n} 条消息？删除后无法恢复。',
      confirm: '确认删除',
      cancel: '取消',
      emptyTitle: '暂无消息',
      emptyUnread: '没有未读消息',
      emptyMessage: '新的通知会出现在这里。',
      unreadCount: '{n} 条未读',
      unreadTruncated: '未读消息较多，仅显示最近 {n} 条中的未读消息。',
      done: '已更新',
      new: '未读',
      refresh: '刷新',
    },
  },
  'en-US': {
    msg: {
      title: 'Messages',
      lead: 'System notices, deposit/withdrawal, security and verification messages.',
      loginRequired: 'Log in to see your messages.',
      all: 'All',
      unread: 'Unread',
      system: 'System',
      category: 'Message category {id}',
      types: { allMessage: 'All', systemMessage: 'System', depositWithdrawMessage: 'Deposits & withdrawals', securedMessage: 'Security', authMessage: 'Verification', otcMessage: 'C2C' },
      markAll: 'Mark all read',
      markRead: 'Mark read',
      remove: 'Delete',
      removeSelected: 'Delete selected ({n})',
      selectAll: 'Select page',
      confirmDelete: 'Delete the {n} selected messages? This cannot be undone.',
      confirm: 'Delete',
      cancel: 'Cancel',
      emptyTitle: 'No messages',
      emptyUnread: 'No unread messages',
      emptyMessage: 'New notifications will show up here.',
      unreadCount: '{n} unread',
      unreadTruncated: 'Many unread messages: only unread items among the latest {n} are shown.',
      done: 'Updated',
      new: 'New',
      refresh: 'Refresh',
    },
  },
}

export function useMessagesI18n() {
  return useI18n({ useScope: 'local', messages: messagesMessages })
}
