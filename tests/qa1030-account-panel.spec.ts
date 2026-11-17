// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import FuturesAccountPanel from '@/components/futures/FuturesAccountPanel.vue'
import { i18n } from '@/i18n'
import { session } from '@/core/session'
import { normalizeAssets, normalizePublicInfo } from '@/modules/futures/types'
import { buildContract } from '@/modules/futures/contracts'
import { useFuturesMarketStore } from '@/stores/futures-market'
import { useFuturesAccountStore } from '@/stores/futures-account'
let app: App | undefined
let pinia: Pinia
let host: HTMLDivElement
beforeEach(() => {
  session.clear(); session.setToken('qa-session')
  pinia = createPinia(); setActivePinia(pinia)
  host = document.createElement('div'); document.body.append(host)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected real request in a display-only test') }))
})
afterEach(() => { app?.unmount(); app = undefined; useFuturesAccountStore().stopPolling(); disposePinia(pinia); session.clear(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
describe('QA-122 actual futures account panel', () => {
  it('keeps maintenance in the server risk group while public marks still update unrealized PnL', async () => {
    i18n.global.locale.value = 'zh-CN'
    const market = useFuturesMarketStore()
    const info = normalizePublicInfo({ contractList: [{ id: 1, contractName: 'E-BTC-USDT', symbol: 'BTC-USDT', multiplier: '0.0001', multiplierCoin: 'BTC', marginCoin: 'USDT', coinResultVo: { symbolPricePrecision: 1, marginCoinPrecision: 4 } }] })
    market.contracts = info.contractList.map(buildContract).filter(entry => entry !== null)
    market.selectedName = 'E-BTC-USDT'
    const account = useFuturesAccountStore()
    account.open = { status: 'opened', error: null, initFailed: false }; account.assetsLoaded = true
    const data = normalizeAssets({ positionList: [{ id: 1, contractId: 1, positionVolume: '10', orderSide: 'BUY', positionType: 1, indexPrice: '1000', openAvgPrice: '900', keepRate: '0.01', reducePrice: '800', leverageLevel: 10 }], accountList: [{ symbol: 'USDT', totalAmount: '1000' }] })
    account.positions = data.positions; account.accounts = data.accounts
    app = createApp(FuturesAccountPanel).use(pinia).use(i18n); app.mount(host); await nextTick()
    const maintenance = () => Array.from(host.querySelectorAll('dt')).find(item => item.textContent?.includes('维持保证金'))?.nextElementSibling?.textContent
    expect(maintenance()).toContain('0.0100')
    const priorPnl = account.unrealizedPnl
    market.marketInfo = { ...market.marketInfo, tagPrice: '2000' }; await nextTick()
    expect(account.unrealizedPnl).not.toBe(priorPnl)
    expect(maintenance()).toContain('0.0100')
    account.positions = account.positions.map(row => ({ ...row, markPrice: '2000', maintenanceMargin: '0.0251', reducePrice: '799' }))
    await nextTick()
    expect(maintenance()).toContain('0.0251')
    expect(account.positions[0]?.reducePrice).toBe('799')
  })
  it('keeps cumulative close PnL after a live snapshot and displays unknown if the server lacks it', async () => {
    const account = useFuturesAccountStore()
    account.open = { status: 'opened', error: null, initFailed: false }
    account.assetsLoaded = true
    account.accounts = normalizeAssets({ accountList: [{ symbol: 'USDT', totalAmount: '1000', canUseAmount: '1000', realizedAmount: '0', cumulativeClosedPnl: '-0.0735000000000001', currentPositionRealizedAmount: '0' }] }).accounts
    app = createApp(FuturesAccountPanel).use(pinia).use(i18n); app.mount(host); await nextTick()
    const value = () => Array.from(host.querySelectorAll('dt')).find((item) => item.textContent?.includes('累计平仓盈亏'))?.nextElementSibling?.textContent
    expect(value()).toContain('-0.0735')
    account.commitLiveSnapshot({ assets: [{ asset: 'USDT', maintMargin: '0', initialMargin: '0', positionInitialMargin: '0', crossUnPnl: '0', marginBalance: '1000', availableBalance: '1000', maxWithdrawAmount: '1000', openOrderInitialMargin: '0', unrealizedProfit: '0', walletBalance: '1000', crossWalletBalance: '1000' }], positions: [] }, [])
    await nextTick()
    expect(value()).toContain('-0.0735')
    expect(account.account?.cumulativeClosedPnl).toBe('-0.0735000000000001')
    account.accounts = normalizeAssets({ accountList: [{ symbol: 'USDT', realizedAmount: '0' }] }).accounts
    await nextTick()
    expect(value()).toBe('--')
  })
})
