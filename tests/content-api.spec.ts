// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from '@/modules/api/http'
import {
  decodeEntities,
  fetchCmsArticle,
  fetchFooterArticles,
  fetchHelpTree,
  fetchNotice,
  fetchNotices,
  isNoticeId,
  searchHelp,
} from '@/modules/content/content.api'
import {
  configuredLevels,
  fetchCoinFees,
  fetchFuturesFees,
  fetchSpotFees,
  normalizeSpotFees,
  rateToPercent,
} from '@/modules/content/fees.api'
import { formatDateTime } from '@/modules/content/api-helpers'

// Synthetic only: no request leaves this process.
vi.mock('@/modules/api/http', () => ({ request: vi.fn() }))
const mocked = vi.mocked(request)

beforeEach(() => vi.resetAllMocks())

describe('notice API (NoticeInfoAct)', () => {
  it('sends page/pageSize/keyword and maps the list contract', async () => {
    mocked.mockResolvedValue({
      noticeInfoList: [{ id: 7, title: 'A &amp; B', lang: 'zh', timeLong: 1790342828000, content: '<p>x</p>' }],
      count: 21, pageSize: 10, openSearch: 1,
    })
    const page = await fetchNotices({ page: 2, pageSize: 10, keyword: '  btc ' })
    expect(mocked).toHaveBeenCalledWith('notice/notice_info_list', { body: { page: 2, pageSize: 10, keyword: 'btc' }, signal: undefined })
    expect(page).toEqual({ count: 21, searchable: true, items: [{ id: '7', title: 'A & B', time: 1790342828000, content: '<p>x</p>' }] })
  })

  it('omits an empty keyword and accepts a null list', async () => {
    mocked.mockResolvedValue({ noticeInfoList: null, count: 0, pageSize: 10, openSearch: 1 })
    const page = await fetchNotices({ page: 1, pageSize: 10, keyword: '   ' })
    expect(mocked.mock.calls[0]?.[1]).toMatchObject({ body: { page: 1, pageSize: 10 } })
    expect(page.items).toEqual([])
  })

  it('rejects a drifted contract with a parse error naming the field', async () => {
    mocked.mockResolvedValue({ noticeInfoList: [{ title: 'no id' }], count: 1 })
    await expect(fetchNotices({ page: 1, pageSize: 10 })).rejects.toMatchObject({ kind: 'parse', message: expect.stringContaining('noticeInfoList.0.id') })
  })

  it('maps the detail contract (ctime, not timeLong)', async () => {
    mocked.mockResolvedValue({ noticeInfo: { id: 3, title: 'T', content: '<b>c</b>', ctime: 1790000000000, lang: 'en' } })
    await expect(fetchNotice('3')).resolves.toEqual({ id: '3', title: 'T', time: 1790000000000, content: '<b>c</b>' })
    expect(mocked).toHaveBeenCalledWith('notice/notice_info', { body: { id: 3 }, signal: undefined })
  })

  it('validates notice route ids', () => {
    expect(isNoticeId('12')).toBe(true)
    expect(isNoticeId('0')).toBe(false)
    expect(isNoticeId('1;drop')).toBe(false)
    expect(isNoticeId(undefined)).toBe(false)
  })

  it('decodes entities without interpreting markup', () => {
    expect(decodeEntities('&lt;img src=x onerror=1&gt; &amp;')).toBe('<img src=x onerror=1> &')
    expect(decodeEntities('<b>raw</b> &amp;')).toBe('<b>raw</b> &')
  })
})

describe('CMS / help API (CmsAct)', () => {
  it('maps the help tree', async () => {
    mocked.mockResolvedValue([{ id: 1, articleTypeName: 'Account', cmsArticleList: [{ id: 9, title: 'Reset 2FA', fileName: 'reset-2fa' }] }, { id: 2, articleTypeName: 'Empty', cmsArticleList: null }])
    const tree = await fetchHelpTree()
    expect(mocked).toHaveBeenCalledWith('cms/list', { body: {}, signal: undefined })
    expect(tree).toEqual([
      { id: '1', name: 'Account', articles: [{ id: '9', title: 'Reset 2FA', fileName: 'reset-2fa' }] },
      { id: '2', name: 'Empty', articles: [] },
    ])
    expect(searchHelp(tree, '2fa')).toEqual([{ id: '9', title: 'Reset 2FA', fileName: 'reset-2fa', category: 'Account' }])
    expect(searchHelp(tree, '  ')).toEqual([])
  })

  it('maps an article and the footer list', async () => {
    mocked.mockResolvedValueOnce({ articleTypeId: 4, title: 'Terms', content: '<p>t</p>', fileName: 'terms', ctimeLong: 1790000000000 })
    await expect(fetchCmsArticle('terms')).resolves.toEqual({ title: 'Terms', content: '<p>t</p>', fileName: 'terms', time: 1790000000000, categoryId: '4' })
    expect(mocked).toHaveBeenLastCalledWith('cms/info', { body: { fileName: 'terms' }, signal: undefined })
    mocked.mockResolvedValueOnce([{ id: 1, title: 'Privacy', fileName: 'privacy' }])
    await expect(fetchFooterArticles()).resolves.toEqual([{ id: '1', title: 'Privacy', fileName: 'privacy' }])
  })

  it('rejects footer entries without a fileName', async () => {
    mocked.mockResolvedValue([{ id: 1, title: 'x', fileName: '' }])
    await expect(fetchFooterArticles()).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('fee API', () => {
  it('normalizes per-pair VIP rates and ignores unconfigured levels', () => {
    const rows = normalizeSpotFees([{ symbol: 'BTCUSDT', TRADE_MAKER_VIP0: 0.001, TRADE_TAKER_VIP0: 0.002, TRADE_TAKER_VIP3: '0.0015' }, { TRADE_MAKER_VIP0: 1 }])
    expect(rows).toEqual([{ symbol: 'btcusdt', maker: { 0: '0.001' }, taker: { 0: '0.002', 3: '0.0015' } }])
    expect(configuredLevels(rows)).toEqual([0, 3])
  })

  it('converts rates to percent exactly', () => {
    expect(rateToPercent('0.002')).toBe('0.2')
    expect(rateToPercent('0.00025')).toBe('0.025')
    expect(rateToPercent('0')).toBe('0')
    expect(rateToPercent('abc')).toBe('')
  })

  it('reads fee_info', async () => {
    mocked.mockResolvedValue({ pairMapList: [{ symbol: 'btcusdt', TRADE_MAKER_VIP0: 0.001 }], withdrawMapList: null })
    await expect(fetchSpotFees()).resolves.toHaveLength(1)
    expect(mocked).toHaveBeenCalledWith('fee_info', { body: {}, signal: undefined })
  })

  it('joins coins_info with coins_fee and keeps missing fees empty', async () => {
    mocked.mockImplementation(async (path: string) => {
      if (path === 'coins_info') {
        return [
          { coinSymbol: 'USDT', name: 'Tether', mainChainName: 'TRC20', depositOpen: 1, withdrawOpen: 0, depositMin: 1, withdrawMin: 0, withdrawMax: 1e5, isOpen: 1 },
          { coinSymbol: 'BTC', name: 'Bitcoin', mainChainName: '', depositOpen: 0, withdrawOpen: 1, depositMin: null, withdrawMin: '0.001', isOpen: 1 },
          { coinSymbol: 'OFF', isOpen: 0 },
        ]
      }
      return { USDT: { defaultWithdrawFee: 1.5, withdrawMin: 1, withdrawMax: 3 } }
    })
    const rows = await fetchCoinFees()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ coin: 'USDT', network: 'TRC20', depositOpen: true, withdrawOpen: false, withdrawFee: '1.5', withdrawMax: '100000' })
    expect(rows[1]).toMatchObject({ coin: 'BTC', withdrawFee: '', depositMin: '', withdrawMin: '0.001' })
  })

  it('reads futures maker/taker through the futures namespace with GET', async () => {
    mocked.mockResolvedValue([{ multiplierCoin: 'BTC', marginCoin: 'USDT', contractSide: 1, openMakerFee: 0.00025, openTakerFee: 0.00075, closeMakerFee: 0.00025, closeTakerFee: 0.00075, symbol: null }])
    const rows = await fetchFuturesFees()
    expect(mocked).toHaveBeenCalledWith('common/getMakerAndTaker', { method: 'GET', api: 'futures', signal: undefined })
    expect(rows[0]).toMatchObject({ label: 'BTC/USDT', openMaker: '0.00025', closeTaker: '0.00075' })
  })
})

describe('formatDateTime', () => {
  it('handles ms, seconds, formatted strings and missing values', () => {
    expect(formatDateTime(null, 'en-US')).toBe('--')
    expect(formatDateTime('2026-01-01 10:00', 'en-US')).toBe('2026-01-01 10:00')
    expect(formatDateTime(1790000000, 'en-US', false)).toBe(formatDateTime(1790000000000, 'en-US', false))
  })
})
