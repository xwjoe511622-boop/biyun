import { shallowRef, type ShallowRef } from 'vue'

/**
 * Transient action results (委托已提交, 撤单失败, 划转成功 …) as toasts in a fixed overlay (`ToastHost.vue`, mounted
 * once in `App.vue`). They never enter a panel's layout, so a message appearing or expiring cannot move anything
 * (owner, 2026-09-29: "委托已提交的消息提示会导致组件高度变化，消失后又变回去"). Persistent state (account not
 * initialised, transfer closed …) stays inline; field validation floats next to its field (`.field-error.float`).
 */
export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
  /** Auto-dismiss after this many ms (paused while hovered). */
  timeout: number
  /** Same key → the new toast replaces the old one instead of stacking (e.g. repeated rate-limit refusals). */
  key: string | null
}

const MAX_TOASTS = 4
const DEFAULT_TIMEOUT: Record<ToastTone, number> = { success: 3000, info: 3000, error: 5000 }

const toasts: ShallowRef<readonly Toast[]> = shallowRef([])
let ids = 0

export function showToast(message: string, tone: ToastTone = 'info', options: { timeout?: number; key?: string } = {}): number {
  const text = message.trim()
  if (text === '') return 0
  const key = options.key ?? null
  const toast: Toast = { id: ++ids, tone, message: text, timeout: options.timeout ?? DEFAULT_TIMEOUT[tone], key }
  const kept = toasts.value.filter((entry) => key === null || entry.key !== key)
  toasts.value = [...kept, toast].slice(-MAX_TOASTS)
  return toast.id
}

export const toastSuccess = (message: string, key?: string): number => showToast(message, 'success', { key })
export const toastError = (message: string, key?: string): number => showToast(message, 'error', { key })
export const toastInfo = (message: string, key?: string): number => showToast(message, 'info', { key })

export function dismissToast(id: number): void {
  if (toasts.value.some((entry) => entry.id === id)) toasts.value = toasts.value.filter((entry) => entry.id !== id)
}

export function clearToasts(): void {
  toasts.value = []
}

export function useToasts(): ShallowRef<readonly Toast[]> {
  return toasts
}
