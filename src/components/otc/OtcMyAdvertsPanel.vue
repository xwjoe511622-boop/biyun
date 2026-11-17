<script setup lang="ts">
import { ref, watch } from 'vue'
import { CopyPlus, PowerOff } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import CoinMark from '@/components/common/CoinMark.vue'
import OtcDialog from './OtcDialog.vue'
import OtcPager from './OtcPager.vue'
import { groupDigits, isDecimalString } from '@/modules/finance/decimal'
import { closeAdvert, fetchMyAdverts, type MyAdvert } from '@/modules/otc/api'
import type { AdvertFormState } from '@/modules/otc/advert-form'
import { coinDpFor, fiatDpFor } from '@/modules/otc/coins'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'
import { useOtcStore } from '@/stores/otc'

/**
 * My adverts (`otc/v4/person_ads`, PersonalPageAct.java:530, one side per request) with
 * "take offline" (`otc/close_wanted`, AdvertAct.java:583). The server has no re-list or edit call.
 */
const props = defineProps<{ uid: string }>()
const emit = defineEmits<{ (event: 'duplicate', prefill: Partial<AdvertFormState>): void }>()

const PAGE_SIZE = 10
const { t } = useOtcI18n()
const otc = useOtcStore()

const side = ref<'BUY' | 'SELL'>('SELL')
const page = ref(1)
const rows = ref<MyAdvert[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const closing = ref<MyAdvert | null>(null)
const closeBusy = ref(false)
const closeError = ref('')
const notice = ref('')
let generation = 0

function online(row: MyAdvert): boolean {
  return row.status === '1' || row.status === '2'
}

async function load(): Promise<void> {
  if (props.uid === '') return
  const gen = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await fetchMyAdverts(props.uid, side.value, page.value, PAGE_SIZE)
    if (gen !== generation) return
    rows.value = result.items
    total.value = result.count
  } catch (err) {
    if (gen !== generation) return
    rows.value = []
    error.value = describeOtcError(t, err)
  } finally {
    if (gen === generation) loading.value = false
  }
}

function fiat(row: MyAdvert, value: string): string {
  return isDecimalString(value) ? groupDigits(value, fiatDpFor(otc.coinMeta(row.coin), row.payCoin)) : '--'
}
function coin(row: MyAdvert, value: string): string {
  return isDecimalString(value) ? groupDigits(value, coinDpFor(otc.coinMeta(row.coin))) : '--'
}
function statusLabel(status: string): string {
  const key = `otc.adverts.statusMap.${status}`
  const text = t(key)
  return text === key ? status || '--' : text
}

function duplicate(row: MyAdvert): void {
  emit('duplicate', {
    side: row.side === 'BUY' ? 'BUY' : 'SELL',
    coin: row.coin,
    payCoin: row.payCoin,
    priceType: 'fixed',
    price: row.price,
    minTrade: row.minTrade,
    maxTrade: row.maxTrade,
    payments: row.payments.map(p => p.key),
  })
}

async function confirmClose(): Promise<void> {
  if (closing.value === null) return
  closeBusy.value = true
  closeError.value = ''
  try {
    await closeAdvert(closing.value.advertId)
    closing.value = null
    notice.value = t('otc.adverts.closed')
    void otc.loadAccounts()
    await load()
  } catch (err) {
    closeError.value = describeOtcError(t, err)
  } finally {
    closeBusy.value = false
  }
}

watch(side, () => {
  if (page.value !== 1) page.value = 1
  else void load()
})
watch(page, () => { void load() })
watch(() => props.uid, () => { void load() }, { immediate: true })
defineExpose({ reload: load })
</script>

<template>
  <section class="ads-panel">
    <div class="ads-toolbar">
      <div class="tabs side-tabs" role="tablist">
        <button class="tab" :class="{ active: side === 'SELL' }" type="button" role="tab" :aria-selected="side === 'SELL'" @click="side = 'SELL'">{{ t('otc.adverts.sellAds') }}</button>
        <button class="tab" :class="{ active: side === 'BUY' }" type="button" role="tab" :aria-selected="side === 'BUY'" @click="side = 'BUY'">{{ t('otc.adverts.buyAds') }}</button>
      </div>
      <p class="ads-note">{{ t('otc.adverts.noEditNote') }}</p>
    </div>
    <p v-if="notice !== ''" class="ok-note" role="status">{{ notice }}</p>

    <StateBlock v-if="loading && rows.length === 0" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="load" />
    <StateBlock v-else-if="rows.length === 0" variant="empty" :message="t('otc.adverts.empty')" />
    <ul v-else class="ads-list" :class="{ dim: loading }">
      <li v-for="row in rows" :key="row.advertId" class="ad-card">
        <div class="ad-top">
          <CoinMark :symbol="row.coin" :icon-url="otc.coinMeta(row.coin)?.icon ?? ''" :size="26" />
          <strong :class="row.side === 'BUY' ? 'up' : 'down'">{{ row.side === 'BUY' ? t('otc.buy') : t('otc.sell') }} {{ row.coin }}</strong>
          <span class="ad-state" :class="{ live: online(row) }">{{ statusLabel(row.status) }}</span>
          <span class="ad-id num">#{{ row.advertId }}</span>
        </div>
        <dl class="ad-figs">
          <div><dt>{{ t('otc.price') }}</dt><dd class="num">{{ fiat(row, row.price) }} <small>{{ row.payCoin }}</small></dd></div>
          <div><dt>{{ t('otc.form.volume') }}</dt><dd class="num">{{ coin(row, row.volume) }}</dd></div>
          <div><dt>{{ t('otc.adverts.dealt') }}</dt><dd class="num">{{ coin(row, row.dealt) }}</dd></div>
          <div><dt>{{ t('otc.limits') }}</dt><dd class="num">{{ fiat(row, row.minTrade) }} – {{ fiat(row, row.maxTrade) }}</dd></div>
          <div><dt>{{ t('otc.adverts.createdAt') }}</dt><dd>{{ row.createdAt === null ? '--' : new Date(row.createdAt).toLocaleString() }}</dd></div>
        </dl>
        <div class="ad-bottom">
          <div class="ad-pays">
            <span v-for="p in row.payments" :key="p.key" class="chip">{{ p.title || otc.paymentTitle(p.key) }}</span>
          </div>
          <div class="ad-actions">
            <button class="btn btn-ghost" type="button" @click="duplicate(row)"><CopyPlus :size="15" />{{ t('otc.adverts.duplicate') }}</button>
            <button v-if="online(row)" class="btn" type="button" @click="closing = row; closeError = ''"><PowerOff :size="15" />{{ t('otc.adverts.close') }}</button>
          </div>
        </div>
      </li>
    </ul>
    <OtcPager :page="page" :page-size="PAGE_SIZE" :total="total" :disabled="loading" @change="page = $event" />

    <OtcDialog :open="closing !== null" :busy="closeBusy" :title="t('otc.adverts.close')" @close="closing = null">
      <p class="dialog-copy">{{ t('otc.adverts.closeConfirm') }}</p>
      <p v-if="closeError !== ''" class="notice notice-error" role="alert">{{ closeError }}</p>
      <template #footer>
        <button class="btn" type="button" :disabled="closeBusy" @click="closing = null">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="closeBusy" @click="confirmClose">{{ closeBusy ? t('common.loading') : t('common.confirm') }}</button>
      </template>
    </OtcDialog>
  </section>
</template>

<style scoped>
.ads-panel { display: flex; flex-direction: column; gap: 14px; }
.ads-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.side-tabs { padding: 3px; border-radius: var(--radius); background: var(--color-surface-alt); }
.ads-note { margin: 0; color: var(--color-text-muted); font-size: 12px; max-width: 560px; }
.ok-note { margin: 0; color: var(--color-up); font-weight: 600; font-size: 13px; }
.ads-list { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; transition: opacity 0.15s; }
.ads-list.dim { opacity: 0.55; }
.ad-card { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-surface-alt); }
.ad-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ad-top strong { font-size: 15px; }
.ad-state { padding: 2px 9px; border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-text-muted); font-size: 11.5px; font-weight: 650; }
.ad-state.live { background: var(--color-up-soft); color: var(--color-up); }
.ad-id { margin-left: auto; color: var(--color-text-muted); font-size: 12px; }
.ad-figs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
.ad-figs div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ad-figs dt { color: var(--color-text-muted); font-size: 11.5px; }
.ad-figs dd { margin: 0; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.ad-figs small { color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; }
.ad-bottom { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ad-pays { display: flex; flex-wrap: wrap; gap: 6px; }
.ad-actions { display: flex; gap: 8px; }
.ad-actions .btn { height: 34px; }
.dialog-copy { margin: 0; color: var(--color-text-secondary); font-size: 14px; line-height: 1.6; }
@media (max-width: 900px) { .ad-figs { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
