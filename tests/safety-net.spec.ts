// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { ApiError } from '@/core/errors'
import { clearToasts, useToasts } from '@/core/toast'
import { REPEAT_WINDOW_MS, installSafetyNet, reportUnhandled, resetSafetyNet, unhandledMessage } from '@/core/safety-net'

/** 10-01 owner: 「防止卡壳」 — an error nobody handled must still reach the user. */
describe('safety net', () => {
  beforeEach(() => {
    clearToasts()
    resetSafetyNet()
    document.documentElement.lang = 'zh-CN'
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('shows the server message of an unhandled ApiError; stays silent for cancelled requests and expired sessions', () => {
    // Localised by (product, code): futures 10013 is the position cap, spot 10013 is "phone already registered".
    expect(unhandledMessage(new ApiError({ kind: 'api', code: '10013', message: 'x', product: 'futures' }))).toBe('超出当前杠杆下的最大持仓限制')
    expect(unhandledMessage(new ApiError({ kind: 'api', code: '10013', message: 'x', product: 'spot' }))).toBe('该手机号已注册')
    // Unknown code: the server message.
    expect(unhandledMessage(new ApiError({ kind: 'api', code: '987654', message: '服务器原文', product: 'futures' }))).toBe('服务器原文')
    expect(unhandledMessage(new ApiError({ kind: 'timeout', code: '', message: '请求超时（15 秒）：结果未确认，请刷新后查看，不要重复提交' }))).toContain('结果未确认')
    expect(unhandledMessage(new ApiError({ kind: 'api', code: '500', message: '' }))).toBe('错误码 500')
    expect(unhandledMessage(new ApiError({ kind: 'aborted', code: '', message: '请求已取消' }))).toBeNull()
    expect(unhandledMessage(new ApiError({ kind: 'unauthorized', code: '10002', message: '未登录' }))).toBeNull()
    expect(unhandledMessage(new DOMException('x', 'AbortError'))).toBeNull()
  })

  it('turns other errors into a generic line with the detail, and a stale chunk into "reload"', () => {
    expect(unhandledMessage(new TypeError("Cannot read properties of undefined (reading 'trim')"))).toBe("页面出错，请重试或刷新（Cannot read properties of undefined (reading 'trim')）")
    expect(unhandledMessage(new TypeError('Failed to fetch dynamically imported module: /_lb/x.js'))).toBe('页面已更新，请刷新后重试')
  })

  it('toasts once per text within the repeat window', () => {
    const error = new ApiError({ kind: 'network', code: '', message: '网络连接失败，请检查网络后重试' })
    expect(reportUnhandled(error, 'test', 1000)).not.toBeNull()
    expect(reportUnhandled(error, 'test', 2000)).toBeNull()
    expect(reportUnhandled(error, 'test', 1000 + REPEAT_WINDOW_MS + 1)).not.toBeNull()
    expect(useToasts().value.filter((toast) => toast.tone === 'error')).toHaveLength(1)
  })

  it('catches an exception thrown by a click handler (Vue errorHandler) and an unhandled rejection', async () => {
    const app = createApp(defineComponent({ setup: () => () => h('button', { id: 'b', onClick: () => { throw new Error('boom') } }, 'x') }))
    installSafetyNet(app)
    const host = document.createElement('div')
    document.body.appendChild(host)
    app.mount(host)
    ;(host.querySelector('#b') as HTMLButtonElement).click()
    await nextTick()
    expect(useToasts().value.some((toast) => toast.message.includes('boom'))).toBe(true)
    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    Object.assign(event, { reason: new ApiError({ kind: 'api', code: '10013', message: '仓位上限', product: 'futures' }) })
    window.dispatchEvent(event)
    expect(useToasts().value.some((toast) => toast.message === '超出当前杠杆下的最大持仓限制')).toBe(true)
    app.unmount()
  })
})
