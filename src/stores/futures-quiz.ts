import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Global futures risk-quiz dialog (components/futures/RiskQuizDialog.vue, mounted once in App.vue). `ask()` opens it and
 * resolves true once the user passed and the futures account was opened, false when the dialog is closed first.
 * Concurrent callers (config load, order, transfer) share one dialog.
 */
export const useFuturesQuizStore = defineStore('futures-quiz', () => {
  const visible = ref(false)
  let waiters: Array<(ok: boolean) => void> = []

  function ask(): Promise<boolean> {
    visible.value = true
    return new Promise((resolve) => { waiters.push(resolve) })
  }

  function finish(ok: boolean): void {
    visible.value = false
    const w = waiters
    waiters = []
    for (const resolve of w) resolve(ok)
  }

  return { visible, ask, finish }
})
