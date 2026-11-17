<script setup lang="ts">
/** 锁仓释放 (Vesting): one card per plan with a release progress bar, the next release and the full schedule on demand. */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ChevronDown } from '@lucide/vue'
import CoinMark from '@/components/common/CoinMark.vue'
import GuestGate from '@/components/common/GuestGate.vue'
import BizPage from '@/components/business/ui/BizPage.vue'
import BizStat from '@/components/business/ui/BizStat.vue'
import BizRecords, { type RecordTab } from '@/components/business/ui/BizRecords.vue'
import StatusPill from '@/components/business/ui/StatusPill.vue'
import { useBizContext, useBizQuery } from '@/components/business/ui/useBiz'
import { businessRequest, rowsOf, type BusinessRow } from '@/modules/business/client'
import { amount, dateOnly, dateTime, field, positive, progress } from '@/modules/business/format'

const { lang, authed, t } = useBizContext()
const plans = useBizQuery(() => (authed.value ? '/sapi/v1/vesting/plans' : null), () => ({ current: '1', size: '50' }))
onMounted(() => { void plans.load() })
watch(authed, () => { void plans.load() })

const open = reactive<Record<string, boolean>>({})
const tranches = reactive<Record<string, BusinessRow[]>>({})
async function toggle(id: string) {
  open[id] = !open[id]
  if (open[id] && !tranches[id]) {
    try { tranches[id] = rowsOf(await businessRequest(`/sapi/v1/vesting/plans/${id}/tranches`)) } catch { tranches[id] = [] }
  }
}
const lockedPlans = computed(() => plans.rows.value.filter(r => positive(field(r, 'lockedAmount'))).length)
const recordTabs = computed<RecordTab[]>(() => [{ id: 'r', label: t('vestingUi.releases'), path: '/sapi/v1/vesting/records', paging: true, columns: [
  { key: 'time', label: t('vestingUi.time'), kind: 'time' }, { key: 'asset', label: t('vestingUi.asset'), kind: 'asset' },
  { key: 'type', label: t('vestingUi.type'), map: { release: t('vestingUi.release'), revoke: t('vestingUi.revoke') } }, { key: 'amount', label: t('vestingUi.amount'), kind: 'amount', unit: 'asset' }] }])
const refreshKey = ref(0)
</script>

<template>
  <BizPage :eyebrow="t('vestingUi.vesting')" :title="t('vestingUi.myVestingSchedules')"
    :subtitle="t('vestingUi.lockedAssetsAreReleasedToYourSpotAccountIn')">
    <template v-if="authed" #stats>
      <BizStat :label="t('vestingUi.plans')" :value="String(plans.rows.value.length)" />
      <BizStat :label="t('vestingUi.stillLocked')" :value="String(lockedPlans)" tone="accent" />
    </template>

    <GuestGate v-if="!authed" :message="t('vestingUi.logInToViewYourVestingPlans')" />
    <template v-else>
      <div v-if="plans.rows.value.length" class="vest-list">
        <article v-for="r in plans.rows.value" :key="field(r, 'planId')" class="biz-card vest">
          <div class="vest-top">
            <span class="biz-coin"><CoinMark :symbol="field(r, 'asset')" :size="34" /><span>{{ field(r, 'asset') }}<small>{{ t('vestingUi.plan') }} #{{ field(r, 'planId') }}</small></span></span>
            <StatusPill :code="field(r, 'status')" :lang="lang" />
          </div>
          <div class="vest-progress">
            <div class="biz-kv"><span>{{ t('vestingUi.released') }}</span><span class="num">{{ amount(field(r, 'releasedAmount')) }} / {{ amount(field(r, 'totalAmount')) }} {{ field(r, 'asset') }}</span></div>
            <div class="biz-bar"><i :style="{ width: `${progress(field(r, 'releasedAmount'), field(r, 'totalAmount'))}%` }" /></div>
          </div>
          <dl class="vest-facts">
            <div><dt>{{ t('vestingUi.locked') }}</dt><dd class="num">{{ amount(field(r, 'lockedAmount')) }}</dd></div>
            <div><dt>{{ t('vestingUi.nextRelease') }}</dt><dd class="num">{{ dateOnly(field(r, 'nextReleaseTime')) }}</dd></div>
            <div><dt>{{ t('vestingUi.nextAmount') }}</dt><dd class="num biz-up">{{ positive(field(r, 'nextReleaseAmount')) ? amount(field(r, 'nextReleaseAmount')) : '—' }}</dd></div>
            <div v-if="positive(field(r, 'revokedAmount'))"><dt>{{ t('vestingUi.revoked') }}</dt><dd class="num biz-down">{{ amount(field(r, 'revokedAmount')) }}</dd></div>
          </dl>
          <button class="vest-toggle" type="button" @click="toggle(field(r, 'planId'))">
            {{ open[field(r, 'planId')] ? t('vestingUi.hideSchedule') : t('vestingUi.viewSchedule') }} <ChevronDown :size="14" :class="{ flip: open[field(r, 'planId')] }" />
          </button>
          <table v-if="open[field(r, 'planId')]" class="table vest-table table-cards">
            <thead><tr><th class="left">{{ t('vestingUi.tranche') }}</th><th>{{ t('vestingUi.amount') }}</th><th>{{ t('vestingUi.scheduled') }}</th><th>{{ t('vestingUi.released2') }}</th><th>{{ t('vestingUi.status') }}</th></tr></thead>
            <tbody>
              <tr v-for="tr in tranches[field(r, 'planId')] ?? []" :key="field(tr, 'seq')">
                <td class="left card-title" data-label="">{{ t('vestingUi.label', { fieldtrseq: field(tr, 'seq') }) }}</td><td class="num" :data-label="t('vestingUi.amount')">{{ amount(field(tr, 'amount')) }}</td>
                <td class="num" :data-label="t('vestingUi.scheduled')">{{ dateTime(field(tr, 'releaseTime')) }}</td><td class="num" :data-label="t('vestingUi.released2')">{{ dateTime(field(tr, 'releasedTime')) }}</td>
                <td :data-label="t('vestingUi.status')"><StatusPill :code="field(tr, 'status')" :lang="lang" /></td>
              </tr>
            </tbody>
          </table>
        </article>
      </div>
      <div v-else class="biz-card"><p class="biz-empty" :class="{ err: plans.error.value }">{{ plans.loading.value ? t('vestingUi.loading') : plans.error.value || t('vestingUi.youHaveNoVestingPlans') }}</p></div>
      <BizRecords :lang="lang" :tabs="recordTabs" :refresh-key="refreshKey" />
    </template>
  </BizPage>
</template>

<style scoped>
.vest-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr)); gap: 16px; }
.vest { min-width: 0; display: grid; gap: 16px; padding: 20px; align-content: start; }
.vest-top { display: flex; align-items: center; justify-content: space-between; }
.vest-progress { display: grid; gap: 8px; }
.vest-facts { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.vest-facts dt { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.vest-facts dd { margin: 2px 0 0; white-space: normal; overflow-wrap: anywhere; font-weight: 600; font-size: var(--font-size-sm); }
.vest-toggle { justify-self: start; display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--color-accent-text); font-weight: 600; font-size: var(--font-size-sm); cursor: pointer; padding: 0; }
.vest-toggle .flip { transform: rotate(180deg); }
.vest-table { table-layout: auto; }
.vest-table .left { text-align: left; }
@media (max-width: 860px) { .vest-list { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 420px) { .vest { padding: 16px; } .vest-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
