<script setup lang="ts">
import { computed } from 'vue'
import { CheckCheck, Trash2 } from '@lucide/vue'
import RichText from '@/components/content/RichText.vue'
import { formatDateTime } from '@/modules/content/api-helpers'
import type { MessageItem } from '@/modules/messages/messages.api'

const props = defineProps<{
  item: MessageItem
  typeLabel: string
  selected: boolean
  busy: boolean
  locale: string
  labels: { markRead: string; remove: string; new: string }
}>()
const emit = defineEmits<{
  (event: 'toggle'): void
  (event: 'read'): void
  (event: 'remove'): void
}>()
const time = computed(() => formatDateTime(props.item.time, props.locale))
</script>

<template>
  <li class="msg" :class="{ unread: !item.read, selected }">
    <label class="check">
      <input type="checkbox" :checked="selected" :disabled="busy" :aria-label="typeLabel" @change="emit('toggle')" />
    </label>
    <div class="msg-main" @click="!item.read && !busy && emit('read')">
      <div class="msg-meta">
        <span v-if="!item.read" class="dot" :aria-label="labels.new"></span>
        <span class="type">{{ typeLabel }}</span>
        <span class="time num">{{ time }}</span>
      </div>
      <RichText class="msg-body" :html="item.content" />
    </div>
    <div class="msg-actions">
      <button v-if="!item.read" class="icon-button" type="button" :disabled="busy" :title="labels.markRead" :aria-label="labels.markRead" @click="emit('read')"><CheckCheck :size="16" /></button>
      <button class="icon-button danger" type="button" :disabled="busy" :title="labels.remove" :aria-label="labels.remove" @click="emit('remove')"><Trash2 :size="16" /></button>
    </div>
  </li>
</template>

<style scoped>
.msg { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 16px 18px; border-bottom: 1px solid var(--color-border); transition: background-color .15s; }
.msg:hover { background: var(--color-hover); }
.msg.selected { background: var(--color-accent-soft); }
.msg.unread::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 3px; border-radius: 0 3px 3px 0; background: var(--color-accent); }
.check { display: flex; padding-top: 2px; }
.check input { width: 16px; height: 16px; accent-color: var(--color-accent); cursor: pointer; }
.msg-main { min-width: 0; cursor: default; }
.msg.unread .msg-main { cursor: pointer; }
.msg-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.type { color: var(--color-text); font-size: 13px; font-weight: 650; }
.msg:not(.unread) .type { color: var(--color-text-secondary); font-weight: 600; }
.time { color: var(--color-text-muted); font-size: 12px; }
.msg-body { font-size: 13.5px; line-height: 1.7; }
.msg:not(.unread) .msg-body { color: var(--color-text-muted); }
.msg-body :deep(p) { margin: 0; }
.msg-actions { display: flex; gap: 2px; opacity: .55; transition: opacity .15s; }
.msg:hover .msg-actions, .msg:focus-within .msg-actions { opacity: 1; }
.icon-button { width: 32px; height: 32px; flex-basis: 32px; }
.danger:hover { color: var(--color-down); background: var(--color-down-soft); }
@media (max-width: 640px) {
  .msg { grid-template-columns: 24px minmax(0, 1fr); padding: 14px 12px; }
  .msg-actions { grid-column: 2; opacity: 1; justify-content: flex-end; }
}
</style>
