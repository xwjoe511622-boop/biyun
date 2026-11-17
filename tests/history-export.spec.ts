// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import ExportDialog from '@/components/history-export/ExportDialog.vue'
import ExportRecords from '@/components/history-export/ExportRecords.vue'
import { rangeLabel, sizeLabel, wallClock, zoneLabel } from '@/components/history-export/format'
import { useHistoryExport } from '@/components/history-export/state'
import { ApiError } from '@/core/errors'
import { session } from '@/core/session'
import * as api from '@/modules/api/history-export.api'
import { localDayStartMs, parseInfo, parseLink, parseRecord, presetRange, reachesArchive } from '@/modules/api/history-export.api'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

// Synthetic only: the request functions are mocked, the parsers and helpers are the real ones.
vi.mock('@/modules/api/history-export.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/api/history-export.api')>()
  return { ...actual, fetchExportInfo: vi.fn(), fetchExports: vi.fn(), createExport: vi.fn(), fetchDownloadLink: vi.fn() }
})

const DAY = 86_400_000
const OCT19 = Date.UTC(2026, 9, 19)
const INFO = { hotFromMs: Date.UTC(2026, 9, 5), earliestMs: Date.UTC(2026, 9, 4), maxRangeDays: 366, per30Days: 10, used30Days: 1, waiting: 0, maxWaiting: 2, retentionDays: 7 }

function record(id: string, status: api.ExportStatus, extra: Partial<api.ExportRecord> = {}): api.ExportRecord {
  return { id, kind: 'spot_funds', startTime: Date.UTC(2026, 9, 4), endTime: OCT19, tzOffsetMin: 480, status, rows: 382, fileBytes: 2048, fileName: 'longbit-spot-funds-20261004-20261018.zip', error: null, createdAt: OCT19, expiresAt: OCT19 + 7 * DAY, ...extra }
}

describe('history export contract', () => {
  it('parses info, records and links strictly', () => {
    expect(parseInfo(INFO)).toEqual(INFO)
    expect(parseInfo({ ...INFO, hotFromMs: null, earliestMs: null }).hotFromMs).toBeNull()
    expect(() => parseInfo({ ...INFO, maxRangeDays: '366' })).toThrow(ApiError)
    const raw = { ...record('12', 'ready'), id: '12' }
    expect(parseRecord(raw)).toEqual(raw)
    expect(() => parseRecord({ ...raw, kind: 'margin' })).toThrow(ApiError)
    expect(() => parseRecord({ ...raw, status: 'done' })).toThrow(ApiError)
    expect(() => parseRecord({ ...raw, id: 12 })).toThrow(ApiError)
    expect(() => parseRecord({ ...raw, rows: 1.5 })).toThrow(ApiError)
    expect(parseLink({ url: 'https://b.example/x.zip?X-Amz-Signature=1', fileName: 'x.zip', expiresIn: 300 }).fileName).toBe('x.zip')
    expect(() => parseLink({ url: 'javascript:alert(1)', fileName: 'x', expiresIn: 300 })).toThrow(ApiError)
  })

  it('turns local days into UTC instants only at the edge', () => {
    // 2026-10-04 00:00 in UTC+8 is 2026-10-03 16:00Z
    expect(localDayStartMs('2026-10-04', 480)).toBe(Date.UTC(2026, 9, 3, 16))
    expect(localDayStartMs('2026-10-04', -210)).toBe(Date.UTC(2026, 9, 4, 3, 30))
    expect(localDayStartMs('2026/10/04', 0)).toBeNull()
    // past 3 months in UTC+8 at 2026-10-19 10:00 local: ends at local midnight of 10-20
    const r = presetRange(90, Date.UTC(2026, 9, 19, 2), 480)
    expect(r.endTime).toBe(Date.UTC(2026, 9, 19, 16))
    expect(r.endTime - r.startTime).toBe(90 * DAY)
    expect(reachesArchive(Date.UTC(2026, 9, 4), INFO)).toBe(true)
    expect(reachesArchive(Date.UTC(2026, 9, 5), INFO)).toBe(false)
    expect(reachesArchive(null, INFO)).toBe(false)
    expect(reachesArchive(Date.UTC(2026, 9, 4), { hotFromMs: null })).toBe(false)
    expect(zoneLabel(480)).toBe('UTC+08:00')
    expect(zoneLabel(-210)).toBe('UTC-03:30')
    expect(wallClock(Date.UTC(2026, 9, 18, 16), 480)).toBe('2026-10-19 00:00')
    expect(rangeLabel(Date.UTC(2026, 9, 3, 16), Date.UTC(2026, 9, 18, 16), 480)).toBe('2026-10-04 ~ 2026-10-18')
    expect(sizeLabel(2048)).toBe('2.0 KB')
  })
})

let pinia: Pinia
let app: App | null = null
let host: HTMLDivElement

beforeEach(() => {
  session.clear()
  vi.resetAllMocks()
  pinia = createPinia()
  setActivePinia(pinia)
  session.setToken('synthetic-export-session')
  useHistoryExport().reset()
  vi.mocked(api.fetchExportInfo).mockResolvedValue(INFO)
})

afterEach(() => {
  app?.unmount()
  app = null
  disposePinia(pinia)
  session.clear()
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(render: () => ReturnType<typeof h>, locale = 'en-US'): Promise<void> {
  app = createApp(defineComponent({ setup: () => render }))
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale, fallbackLocale: 'en-US', messages: { 'en-US': enUS, 'zh-CN': zhCN } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  await flush()
}

function q<T extends Element>(selector: string): T {
  const found = document.body.querySelector<T>(selector)
  if (found === null) throw new Error(`missing ${selector}: ${document.body.textContent ?? ''}`)
  return found
}

describe('export dialog', () => {
  it('submits the custom range as UTC instants with the device zone', async () => {
    vi.mocked(api.createExport).mockResolvedValue('41')
    vi.mocked(api.fetchExports).mockResolvedValue([])
    const created = vi.fn()
    await mount(() => h(ExportDialog, { open: true, kinds: ['spot_orders', 'spot_trades', 'spot_funds'], initialKind: 'spot_funds', initialFrom: '2026-10-04', initialTo: '2026-10-18', onCreated: created }))
    expect(q<HTMLSelectElement>('[data-testid=hx-kind]').value).toBe('spot_funds')
    expect(q('[data-testid=hx-rules]').textContent).toContain('10 statements per 30 days (1 used)')
    q<HTMLButtonElement>('[data-testid=hx-submit]').click()
    await flush()
    const offset = api.browserOffsetMin()
    expect(api.createExport).toHaveBeenCalledWith({ kind: 'spot_funds', startTime: localDayStartMs('2026-10-04', offset), endTime: (localDayStartMs('2026-10-18', offset) ?? 0) + DAY, tzOffsetMin: offset })
    expect(created).toHaveBeenCalledWith('41')
  })

  it('refuses an inverted or too long range without calling the server', async () => {
    await mount(() => h(ExportDialog, { open: true, kinds: ['futures_trades'], initialFrom: '2026-10-18', initialTo: '2026-10-04' }), 'zh-CN')
    expect(q<HTMLButtonElement>('[data-testid=hx-submit]').disabled).toBe(true)
    expect(document.body.textContent).toContain('请选择有效的开始和结束日期')
    app?.unmount()
    app = null
    await mount(() => h(ExportDialog, { open: true, kinds: ['futures_trades'], initialFrom: '2025-01-01', initialTo: '2026-10-18' }))
    expect(q<HTMLButtonElement>('[data-testid=hx-submit]').disabled).toBe(true)
    expect(api.createExport).not.toHaveBeenCalled()
  })

  it('shows the server refusal', async () => {
    vi.mocked(api.createExport).mockRejectedValue(new ApiError({ kind: 'api', code: 'HISTORY_EXPORT_ERROR', message: 'At most 10 statements per 30 days' }))
    await mount(() => h(ExportDialog, { open: true, kinds: ['spot_orders'] }))
    q<HTMLButtonElement>('[data-testid=hx-submit]').click()
    await flush()
    expect(q('[data-testid=hx-error]').textContent).toContain('At most 10 statements')
  })
})

describe('export records', () => {
  it('lists statements and downloads only through a fresh link', async () => {
    vi.mocked(api.fetchExports).mockResolvedValue([record('7', 'ready'), record('6', 'failed', { error: 'too_many_rows', rows: null, fileBytes: null }), record('5', 'expired')])
    vi.mocked(api.fetchDownloadLink).mockResolvedValue({ url: 'https://bucket.example/upload/export/ab/x.zip?X-Amz-Signature=s', fileName: 'x.zip', expiresIn: 300 })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await mount(() => h(ExportRecords))
    expect(q('[data-testid=hx-row-6]').textContent).toContain('Too many records')
    expect(document.body.querySelector('[data-testid=hx-download-6]')).toBeNull()
    expect(document.body.querySelector('[data-testid=hx-download-5]')).toBeNull()
    expect(q('[data-testid=hx-row-7]').textContent).toContain('2026-10-04 ~ 2026-10-19')
    q<HTMLButtonElement>('[data-testid=hx-download-7]').click()
    await flush()
    expect(api.fetchDownloadLink).toHaveBeenCalledWith('7')
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it('polls while a statement is being generated', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.fetchExports).mockResolvedValueOnce([record('8', 'running')]).mockResolvedValue([record('8', 'ready')])
      await useHistoryExport().loadRecords()
      expect(useHistoryExport().pending.value).toBe(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(api.fetchExports).toHaveBeenCalledTimes(2)
      expect(useHistoryExport().pending.value).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(api.fetchExports).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
