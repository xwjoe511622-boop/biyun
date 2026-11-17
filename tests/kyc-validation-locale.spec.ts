// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { expect, it } from 'vitest'
import KycForm from '@/components/kyc/KycForm.vue'

it.each(['zh-CN', 'en-US'])('updates visible KYC warnings after switching from %s', async (initial) => {
  const i18n = createI18n({ legacy: false, locale: initial, messages: {} })
  const app = createApp(KycForm, { defaultCountryIso: '156' }).use(i18n)
  const root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
  try {
    const file = root.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(file, 'files', { value: [new File(['test'], 'invalid.txt', { type: 'text/plain' })] })
    file.dispatchEvent(new Event('change'))
    root.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('button[type=submit]')!.click()
    for (const locale of [initial, initial === 'zh-CN' ? 'en-US' : 'zh-CN', initial]) {
      i18n.global.locale.value = locale
      await nextTick()
      const chinese = locale === 'zh-CN'
      expect.soft(root.querySelector('.photo-field [role=alert]')?.textContent).toBe(
        chinese ? '仅支持 JPG、PNG、BMP 图片' : 'Only JPG, PNG or BMP images',
      )
      expect.soft(root.querySelector('.notice-error')?.textContent).toBe(
        chinese ? '请先修正标红的字段。' : 'Please fix the highlighted fields first.',
      )
    }
  } finally {
    app.unmount()
    root.remove()
  }
})
