<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Filter, Megaphone, RefreshCw } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import StateBlock from '@/components/common/StateBlock.vue'
import OtcAccountPanel from '@/components/otc/OtcAccountPanel.vue'
import OtcPager from '@/components/otc/OtcPager.vue'
import OtcSubnav from '@/components/otc/OtcSubnav.vue'
import OtcTradeDialog from '@/components/otc/OtcTradeDialog.vue'
import { groupDigits, gte, isDecimalString, lte, ratioToPercent } from '@/modules/finance/decimal'
import { sanitizeDecimalInput } from '@/modules/otc/amounts'
import { searchAdverts, type OtcAdvert } from '@/modules/otc/api'
import { coinDpFor, fiatDpFor } from '@/modules/otc/coins'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { useOtcStore } from '@/stores/otc'
import { useSessionStore } from '@/stores/session'

/**
 * C2C hall. Adverts: exchange-otc-api `otc/search` (SearchAdvertAct.java:66). A user who wants to BUY
 * browses SELL adverts and vice-versa (legacy `fiatdeal/center.js`). The amount filter has no server
 * parameter, so it only narrows the rows of the current page by their per-order limits.
 */
type UserSide = 'buy' | 'sell'
const PAGE_SIZE = 10

const { t } = useOtcI18n()
const otc = useOtcStore()
const sessionStore = useSessionStore()
const router = useRouter()

const side = ref<UserSide>('buy')
const coin = ref('')
const payCoin = ref('')
const payment = ref('')
const amountFilter = ref('')
const page = ref(1)

const adverts = ref<OtcAdvert[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null
let generation = 0

const tradeTarget = ref<OtcAdvert | null>(null)
const tradeOpen = ref(false)

const coinMeta = computed(() => otc.coinMeta(coin.value))
const fiatDp = computed(() => fiatDpFor(coinMeta.value, payCoin.value))
const coinDp = computed(() => coinDpFor(coinMeta.value))
const paycoins = computed(() => otc.publicInfo?.paycoins ?? [])
const payments = computed(() => otc.publicInfo?.payments ?? [])
const ready = computed(() => coin.value !== '' && payCoin.value !== '')

const visibleAdverts = computed(() => {
  const amount = amountFilter.value.trim()
  if (!isDecimalString(amount)) return adverts.value
  return adverts.value.filter(ad =>
    (!isDecimalString(ad.minTrade) || gte(amount, ad.minTrade)) && (!isDecimalString(ad.maxTrade) || lte(amount, ad.maxTrade)))
})

function fmtFiat(value: string): string {
  return isDecimalString(value) ? groupDigits(value, fiatDp.value) : '--'
}
function fmtCoin(value: string): string {
  return isDecimalString(value) ? groupDigits(value, coinDp.value) : '--'
}
function completion(ad: OtcAdvert): string {
  return isDecimalString(ad.creditGrade) ? `${ratioToPercent(ad.creditGrade, 1)}%` : ''
}

async function load(): Promise<void> {
  if (!ready.value) return
  controller?.abort()
  controller = new AbortController()
  const gen = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await searchAdverts({
      side: side.value === 'buy' ? 'SELL' : 'BUY',
      symbol: coin.value,
      payCoin: payCoin.value,
      payment: payment.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    }, controller.signal)
    if (gen !== generation) return
    adverts.value = result.items
    total.value = result.count
  } catch (err) {
    if (gen !== generation) return
    adverts.value = []
    total.value = 0
    error.value = describeOtcError(t, err)
  } finally {
    if (gen === generation) loading.value = false
  }
}

function openTrade(ad: OtcAdvert): void {
  if (!sessionStore.isAuthenticated) {
    void router.push('/login')
    return
  }
  tradeTarget.value = ad
  tradeOpen.value = true
}

function onAmount(event: Event): void {
  amountFilter.value = sanitizeDecimalInput((event.target as HTMLInputElement).value, fiatDp.value)
}

function pickDefaults(): void {
  const info = otc.publicInfo
  if (coin.value === '' && otc.coins.length > 0) {
    const preferred = info?.defaultCoin ?? ''
    coin.value = otc.coins.find(c => c.coin === preferred)?.coin ?? otc.coins[0].coin
  }
  if (payCoin.value === '' && info !== null && info.paycoins.length > 0) {
    payCoin.value = info.paycoins.find(p => p.key.toUpperCase() === info.defaultPayCoin)?.key ?? info.paycoins[0].key
  }
}

async function bootstrap(): Promise<void> {
  await Promise.all([otc.ensureMarketInfo(), otc.loadPublicInfo()])
  pickDefaults()
}

watch(() => [otc.coins.length, otc.publicInfo], pickDefaults)
watch([side, coin, payCoin, payment], () => {
  if (page.value !== 1) page.value = 1
  else void load()
})
watch(page, () => { void load() })

onMounted(() => { void bootstrap() })
onBeforeUnmount(() => { controller?.abort() })
</script>

<template>
  <div class="page otc-page">
    <header class="otc-hero">
      <div class="hero-copy">
        <h1>{{ t('otc.title') }}</h1>
        <p>{{ t('otc.subtitle') }}</p>
      </div>
      <OtcSubnav />
    </header>

    <div class="otc-layout">
      <section class="otc-main">
        <div class="toolbar panel">
          <div class="side-switch" role="tablist" :aria-label="t('otc.title')">
            <button class="side-btn buy" :class="{ active: side === 'buy' }" type="button" role="tab" :aria-selected="side === 'buy'" @click="side = 'buy'">
              {{ t('otc.buy') }}
            </button>
            <button class="side-btn sell" :class="{ active: side === 'sell' }" type="button" role="tab" :aria-selected="side === 'sell'" @click="side = 'sell'">
              {{ t('otc.sell') }}
            </button>
          </div>

          <div class="coin-tabs" role="tablist" :aria-label="t('otc.coin')">
            <button
              v-for="c in otc.coins"
              :key="c.coin"
              class="coin-tab"
              :class="{ active: c.coin === coin }"
              type="button"
              role="tab"
              :aria-selected="c.coin === coin"
              @click="coin = c.coin"
            >
              <CoinMark :symbol="c.coin" :icon-url="c.icon" :size="18" />{{ c.showName }}
            </button>
          </div>

          <div class="filters">
            <label class="filter">
              <span class="filter-label">{{ t('otc.amountFilter') }}</span>
              <span class="filter-input">
                <input :value="amountFilter" inputmode="decimal" :placeholder="t('otc.amountFilterHint')" @input="onAmount" />
                <span class="field-suffix">{{ payCoin }}</span>
              </span>
            </label>
            <label class="filter">
              <span class="filter-label">{{ t('otc.fiat') }}</span>
              <select v-model="payCoin" class="filter-select">
                <option v-for="p in paycoins" :key="p.key" :value="p.key">{{ p.key.toUpperCase() }} · {{ p.title }}</option>
              </select>
            </label>
            <label class="filter">
              <span class="filter-label"><Filter :size="12" /> {{ t('otc.payment') }}</span>
              <select v-model="payment" class="filter-select">
                <option value="">{{ t('otc.allPayments') }}</option>
                <option v-for="p in payments" :key="p.key" :value="p.key">{{ p.title }}</option>
              </select>
            </label>
            <button class="icon-button refresh" type="button" :aria-label="t('common.refresh')" :disabled="loading" @click="load">
              <RefreshCw :size="16" :class="{ spin: loading }" />
            </button>
          </div>
        </div>

        <section class="panel list-panel">
          <StateBlock v-if="otc.publicInfoError !== null && otc.publicInfo === null" variant="error" :message="describeOtcError(t, otc.publicInfoError)" retryable @retry="bootstrap().then(load)" />
          <StateBlock v-else-if="otc.publicInfo !== null && otc.coins.length === 0 && !otc.publicInfoLoading" variant="empty" :message="t('otc.noCoins')" />
          <template v-else>
            <div class="ad-head" aria-hidden="true">
              <span>{{ t('otc.merchant') }}</span>
              <span>{{ t('otc.price') }}</span>
              <span>{{ t('otc.available') }} / {{ t('otc.limits') }}</span>
              <span>{{ t('otc.payment') }}</span>
              <span class="right">{{ t('otc.action') }}</span>
            </div>
            <StateBlock v-if="loading && adverts.length === 0" variant="loading" :message="t('common.loading')" />
            <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="load" />
            <StateBlock v-else-if="visibleAdverts.length === 0" variant="empty" :message="t('otc.noAdverts')" />
            <ul v-else class="ad-list" :class="{ dim: loading }">
              <li v-for="ad in visibleAdverts" :key="ad.advertId" class="ad-row">
                <div class="ad-merchant">
                  <span class="avatar" :class="{ online: ad.online }">
                    <img v-if="ad.avatar !== ''" :src="ad.avatar" alt="" />
                    <template v-else>{{ (ad.nickname || '?').slice(0, 1).toUpperCase() }}</template>
                  </span>
                  <span class="merchant-text">
                    <strong class="merchant-name ellipsis">{{ ad.nickname || '--' }}</strong>
                    <span class="merchant-stats">
                      <span v-if="ad.completeOrders !== ''">{{ t('otc.orders', { n: ad.completeOrders }) }}</span>
                      <span v-if="completion(ad) !== ''">{{ t('otc.completion', { rate: completion(ad) }) }}</span>
                    </span>
                  </span>
                </div>
                <div class="ad-price">
                  <strong class="num">{{ fmtFiat(ad.price) }}</strong><small>{{ ad.payCoin || payCoin }}</small>
                </div>
                <div class="ad-qty">
                  <span><em>{{ t('otc.available') }}</em> <b class="num">{{ fmtCoin(ad.volumeBalance) }}</b> {{ coin }}</span>
                  <span><em>{{ t('otc.limits') }}</em> <b class="num">{{ fmtFiat(ad.minTrade) }} – {{ fmtFiat(ad.maxTrade) }}</b></span>
                </div>
                <div class="ad-pay">
                  <span v-for="p in ad.payments" :key="p.key" class="pay-chip">{{ p.title || otc.paymentTitle(p.key) }}</span>
                </div>
                <div class="ad-action">
                  <button class="btn" :class="side === 'buy' ? 'btn-buy' : 'btn-sell'" type="button" @click="openTrade(ad)">
                    {{ sessionStore.isAuthenticated ? (side === 'buy' ? t('otc.buyCoin', { coin }) : t('otc.sellCoin', { coin })) : t('otc.loginToTrade') }}
                  </button>
                </div>
              </li>
            </ul>
            <OtcPager :page="page" :page-size="PAGE_SIZE" :total="total" :disabled="loading" @change="page = $event" />
          </template>
        </section>
        <p class="source-note">{{ t('otc.dataSource') }}</p>
      </section>

      <div class="otc-side">
        <OtcAccountPanel :coin="coin" />
        <RouterLink class="publish-card" to="/otc/adverts?tab=publish">
          <span class="publish-icon"><Megaphone :size="18" /></span>
          <span><strong>{{ t('otc.publish') }}</strong><small>{{ t('otc.adverts.subtitle') }}</small></span>
        </RouterLink>
      </div>
    </div>

    <OtcTradeDialog :open="tradeOpen" :advert="tradeTarget" :coin="coin" @close="tradeOpen = false" />
  </div>
</template>

<style scoped>
.otc-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 22px; }
.hero-copy h1 { margin: 0; font-size: 34px; font-weight: 750; }
.hero-copy p { margin: 8px 0 0; max-width: 620px; color: var(--color-text-secondary); }
.otc-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 18px; align-items: start; }
.otc-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.otc-side { display: flex; flex-direction: column; gap: 14px; position: sticky; top: calc(var(--header-h) + 24px); }

.toolbar { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px; }
.side-switch { display: inline-flex; align-self: flex-start; padding: 4px; border-radius: var(--radius); background: var(--color-surface-alt); }
.side-btn { min-width: 88px; height: 36px; padding: 0 18px; border-radius: 6px; color: var(--color-text-secondary); font-weight: 700; transition: all 0.15s; }
.side-btn.buy.active { background: var(--color-up); color: #fff; }
.side-btn.sell.active { background: var(--color-down); color: #fff; }
.coin-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.coin-tab {
  display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px; border: 1px solid var(--color-border);
  border-radius: var(--radius-pill); color: var(--color-text-secondary); font-weight: 650; font-size: 13px; white-space: nowrap;
}
.coin-tab:hover { color: var(--color-text); border-color: var(--color-border-strong); }
.coin-tab.active { color: var(--color-text); border-color: var(--color-accent); background: var(--color-accent-soft); }
.filters { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; }
.filter { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.filter-label { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-muted); font-size: 12px; font-weight: 550; }
.filter-input, .filter-select {
  display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--color-border-strong);
  border-radius: var(--radius); background: var(--color-surface-alt); min-width: 0;
}
.filter-input:focus-within, .filter-select:focus { border-color: var(--color-accent); outline: none; box-shadow: 0 0 0 3px var(--color-accent-soft); }
.filter-input input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--color-text); font-size: 13px; }
.filter-select { width: 100%; color: var(--color-text); font-size: 13px; }
.refresh { border: 1px solid var(--color-border-strong); height: 38px; width: 38px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.list-panel { padding: 6px 18px 12px; }
.ad-head, .ad-row {
  display: grid; grid-template-columns: minmax(170px, 1.3fr) minmax(110px, 0.8fr) minmax(190px, 1.4fr) minmax(120px, 1fr) 150px;
  gap: 14px; align-items: center;
}
.ad-head { padding: 12px 4px; border-bottom: 1px solid var(--color-border); color: var(--color-text-muted); font-size: 12px; font-weight: 550; }
.right { text-align: right; }
.ad-list { margin: 0; padding: 0; list-style: none; transition: opacity 0.15s; }
.ad-list.dim { opacity: 0.55; }
.ad-row { padding: 16px 4px; border-bottom: 1px solid var(--color-border); animation: rise-in 0.35s var(--ease-out) both; }
.ad-row:last-child { border-bottom: 0; }
.ad-merchant { display: flex; align-items: center; gap: 10px; min-width: 0; }
.avatar {
  position: relative; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: 0 0 36px;
  border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent-text); font-weight: 750; overflow: visible;
}
.avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.avatar::after {
  content: ''; position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--color-surface); background: var(--color-border-strong);
}
.avatar.online::after { background: var(--color-up); }
.merchant-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.merchant-name { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; }
.merchant-stats { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--color-text-muted); font-size: 12px; }
.ad-price { display: flex; align-items: baseline; gap: 5px; }
.ad-price strong { font-size: 19px; font-weight: 650; }
.ad-price small { color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.ad-qty { display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; color: var(--color-text-secondary); min-width: 0; }
.ad-qty em { display: inline-block; min-width: 36px; color: var(--color-text-muted); font-style: normal; }
.ad-qty b { color: var(--color-text); font-weight: 600; }
.ad-pay { display: flex; flex-wrap: wrap; gap: 5px; }
.pay-chip {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 5px; border-left: 3px solid var(--color-accent);
  background: var(--color-surface-alt); color: var(--color-text-secondary); font-size: 11.5px; font-weight: 600; white-space: nowrap;
}
.ad-action { display: flex; justify-content: flex-end; }
.ad-action .btn { min-width: 120px; }
.source-note { margin: 0; color: var(--color-text-muted); font-size: 12px; }

.publish-card {
  display: flex; align-items: center; gap: 12px; padding: 16px 18px; border: 1px solid var(--color-border); border-radius: var(--radius-lg);
  background: radial-gradient(ellipse 80% 100% at 100% 0%, var(--color-accent-soft), transparent 70%), var(--color-surface);
  transition: border-color 0.15s, transform 0.15s;
}
.publish-card:hover { border-color: var(--color-accent); transform: translateY(-1px); }
.publish-card > span:last-child { display: flex; flex-direction: column; gap: 2px; }
.publish-card small { color: var(--color-text-muted); font-size: 12px; }
.publish-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: 0 0 36px; border-radius: 10px;
  background: var(--color-accent); color: var(--color-on-accent);
}

@media (max-width: 1180px) {
  .otc-layout { grid-template-columns: 1fr; }
  .otc-side { position: static; display: grid; grid-template-columns: 1fr 1fr; align-items: start; }
}
@media (max-width: 900px) {
  .ad-head { display: none; }
  .ad-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: 'merchant price' 'qty qty' 'pay action';
    gap: 10px 12px;
  }
  .ad-merchant { grid-area: merchant; }
  .ad-price { grid-area: price; justify-self: end; }
  .ad-qty { grid-area: qty; }
  .ad-pay { grid-area: pay; }
  .ad-action { grid-area: action; }
  .filters { grid-template-columns: 1fr 1fr; }
  .filters .filter:first-child { grid-column: 1 / -1; }
  .refresh { display: none; }
}
@media (max-width: 640px) {
  .hero-copy h1 { font-size: 26px; }
  .otc-side { grid-template-columns: 1fr; }
  .toolbar, .list-panel { padding-left: 14px; padding-right: 14px; }
  .ad-action .btn { min-width: 0; padding: 0 14px; }
}
</style>
