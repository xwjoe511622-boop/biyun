<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { session } from '@/core/session'
import { useSessionStore } from '@/stores/session'
import { MessageSquare, SendHorizontal } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import { fetchChatHistory, type ChatMessage } from '@/modules/otc/api'
import { OtcChatSocket, type ChatSocketState } from '@/modules/otc/chat-socket'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'

/**
 * Order chat. History: exchange-otc-api `chatMsg/message` (ChatMsgController.java:60, keyed by the
 * order `sequence`). Live: the otc-chat WebSocket announced in `otc/public_info.otcChatWS`.
 * Without a configured socket the panel stays read-only instead of pretending to send.
 */
const props = defineProps<{ sequence: string; myUid: string; peerUid: string; peerName: string; wsUrl: string }>()
const { t } = useOtcI18n()
const sessionStore = useSessionStore()

const messages = ref<ChatMessage[]>([])
const loading = ref(false)
const error = ref('')
const draft = ref('')
const state = ref<ChatSocketState>('idle')
const pendingTime = ref<number | null>(null)
const sendNote = ref('')
const scroller = ref<HTMLElement | null>(null)
let socket: OtcChatSocket | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let historyVersion = 0
let connectionVersion = 0

const canSend = computed(() => state.value === 'open' && draft.value.trim() !== '' && pendingTime.value === null)

function formatTime(value: number | null): string {
  if (value === null) return ''
  const date = new Date(value)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function scrollToEnd(): Promise<void> {
  await nextTick()
  if (scroller.value !== null) scroller.value.scrollTop = scroller.value.scrollHeight
}

async function loadHistory(): Promise<void> {
  const version = ++historyVersion
  const token = session.getToken()
  const identity = `${props.sequence}/${props.myUid}/${props.peerUid}`
  const current = (): boolean => version === historyVersion && token === session.getToken()
    && identity === `${props.sequence}/${props.myUid}/${props.peerUid}`
  loading.value = true
  error.value = ''
  try {
    const rows = await fetchChatHistory(props.sequence, props.myUid, props.peerUid)
    if (!current()) return
    messages.value = rows
    void scrollToEnd()
  } catch (err) {
    if (current()) error.value = describeOtcError(t, err)
  } finally {
    if (current()) loading.value = false
  }
}

function clearPending(): void {
  pendingTime.value = null
  if (pendingTimer !== null) clearTimeout(pendingTimer)
  pendingTimer = null
}

function connect(): void {
  const version = ++connectionVersion
  const token = session.getToken()
  socket?.close()
  socket = new OtcChatSocket({
    baseUrl: props.wsUrl,
    from: props.myUid,
    to: props.peerUid,
    orderId: props.sequence,
    onState: (next) => { if (version === connectionVersion && token === session.getToken()) state.value = next },
    onMessage: (message) => {
      if (version !== connectionVersion || token !== session.getToken()) return
      const mine = message.from === props.myUid
      if (mine && pendingTime.value !== null && message.time === pendingTime.value) {
        clearPending()
        draft.value = ''
      }
      messages.value.push({ id: message.chatId || `${message.time ?? Date.now()}-${messages.value.length}`, fromId: message.from, content: message.content, time: message.time, msgType: message.msgType, redPacketSn: message.redPacketSn })
      void scrollToEnd()
    },
  })
  socket.connect()
}

function send(): void {
  if (!canSend.value || socket === null) return
  sendNote.value = ''
  const time = socket.send(draft.value.trim().slice(0, 500))
  if (time === null) return
  pendingTime.value = time
  // No echo within 5 s = the server throttled or dropped it (legacy chat.js used the same window).
  pendingTimer = setTimeout(() => {
    if (pendingTime.value === time) {
      clearPending()
      sendNote.value = t('otc.chat.throttle')
    }
  }, 5000)
}

watch(() => [props.sequence, props.myUid, props.peerUid, props.wsUrl, sessionStore.token], () => {
  historyVersion += 1
  connectionVersion += 1
  messages.value = []
  error.value = ''
  loading.value = false
  draft.value = ''
  clearPending()
  socket?.close()
  if (props.myUid === '' || props.peerUid === '') return
  void loadHistory()
  connect()
}, { immediate: true })

onBeforeUnmount(() => {
  historyVersion += 1
  connectionVersion += 1
  clearPending()
  socket?.close()
  socket = null
})
</script>

<template>
  <section class="chat-panel">
    <header class="chat-head">
      <MessageSquare :size="16" />
      <div class="chat-title">
        <strong>{{ t('otc.chat.title') }}</strong>
        <span class="muted ellipsis">{{ peerName }}</span>
      </div>
      <span class="chat-state" :class="state">{{ t(`otc.chat.state.${state === 'idle' ? 'connecting' : state}`) }}</span>
    </header>

    <div ref="scroller" class="chat-scroll" aria-live="polite">
      <StateBlock v-if="loading && messages.length === 0" variant="loading" :message="t('common.loading')" />
      <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="loadHistory" />
      <p v-else-if="messages.length === 0" class="chat-empty">{{ t('otc.chat.empty') }}</p>
      <ul v-else class="chat-list">
        <li v-for="m in messages" :key="m.id" class="bubble-row" :class="{ mine: m.fromId === myUid }">
          <RouterLink
            v-if="m.msgType === 'red_packet' && m.redPacketSn"
            class="bubble wrap-anywhere bubble-link"
            :to="'/redpacket/' + encodeURIComponent(m.redPacketSn || '')"
          >{{ m.content }}</RouterLink>
          <span v-else class="bubble wrap-anywhere">{{ m.content }}</span>
          <span class="bubble-meta">{{ m.fromId === myUid ? t('otc.chat.me') : peerName }} · {{ formatTime(m.time) }}</span>
        </li>
      </ul>
    </div>

    <p class="chat-note">{{ state === 'unavailable' ? t('otc.chat.unavailable') : sendNote !== '' ? sendNote : t('otc.chat.securityNote') }}</p>
    <form class="chat-compose" @submit.prevent="send">
      <input
        v-model="draft"
        maxlength="500"
        :placeholder="t('otc.chat.placeholder')"
        :disabled="state === 'unavailable'"
        :aria-label="t('otc.chat.placeholder')"
      />
      <button class="btn btn-primary" type="submit" :disabled="!canSend" :aria-label="t('otc.chat.send')">
        <SendHorizontal :size="16" />
      </button>
    </form>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex; flex-direction: column; min-height: 460px; height: 100%; border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); background: var(--color-surface); overflow: hidden;
}
.chat-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--color-border); color: var(--color-accent-text); }
.chat-title { display: flex; flex-direction: column; flex: 1; min-width: 0; color: var(--color-text); font-size: 13px; }
.chat-state { font-size: 11px; font-weight: 650; color: var(--color-text-muted); white-space: nowrap; }
.chat-state.open { color: var(--color-up); }
.chat-state.closed, .chat-state.unavailable { color: var(--color-warning); }
.chat-scroll { flex: 1; min-height: 220px; max-height: 520px; overflow-y: auto; padding: 14px 16px; background: var(--color-surface-alt); }
.chat-empty { margin: 40px 0; color: var(--color-text-muted); font-size: 13px; text-align: center; }
.chat-list { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.bubble-row { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; max-width: 86%; }
.bubble-row.mine { align-self: flex-end; align-items: flex-end; }
.bubble {
  padding: 9px 12px; border-radius: 14px 14px 14px 4px; background: var(--color-surface); border: 1px solid var(--color-border);
  font-size: 13.5px; line-height: 1.45;
}
.mine .bubble { border-radius: 14px 14px 4px 14px; border-color: transparent; background: var(--color-accent); color: var(--color-on-accent); }
.bubble-meta { color: var(--color-text-muted); font-size: 11px; }
.bubble-link { color: var(--color-accent-text); text-decoration: underline; }
.chat-note { margin: 0; padding: 8px 16px 0; color: var(--color-text-muted); font-size: 11.5px; }
.chat-compose { display: flex; gap: 8px; padding: 10px 12px 12px; }
.chat-compose input {
  flex: 1; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid var(--color-border-strong); border-radius: var(--radius);
  background: var(--color-surface-alt); color: var(--color-text); outline: none;
}
.chat-compose input:focus { border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
.chat-compose .btn { width: 44px; height: 40px; padding: 0; }
</style>
