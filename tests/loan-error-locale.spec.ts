// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import BizDialog from '@/components/business/ui/BizDialog.vue'
import * as client from '@/modules/business/client'

it('translates a rejected loan and updates the visible error when the language changes', async () => {
  const request = vi.spyOn(client, 'businessRequest').mockRejectedValue(
    new client.BusinessApiError('Not enough USDT available to lend right now.', false, '-17004'),
  )
  const lang = ref<'zh' | 'en'>('zh')
  const app = createApp(() => h(BizDialog, {
    open: true, lang: lang.value, title: '借币', path: '/sapi/v2/loan/flexible/borrow',
    fixed: { loanCoin: 'USDT' }, fields: [], summary: [],
  }))
  app.mount(document.createElement('div'))
  try {
    document.querySelector<HTMLButtonElement>('.dlg .btn-primary')!.click()
    const alert = () => document.querySelector('[role="alert"]')?.textContent
    await vi.waitFor(() => expect(alert()).toBe('平台可出借的 USDT 不足，请稍后再试。'))
    lang.value = 'en'
    await nextTick()
    expect(alert()).toBe('Not enough USDT available to lend right now.')
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    app.unmount()
    request.mockRestore()
  }
})
