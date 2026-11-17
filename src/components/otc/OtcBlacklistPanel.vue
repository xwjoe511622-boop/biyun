<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { UserX } from '@lucide/vue'
import StateBlock from '@/components/common/StateBlock.vue'
import OtcPager from './OtcPager.vue'
import { fetchBlacklist, removeFromBlacklist, type BlacklistEntry } from '@/modules/otc/api'
import { describeOtcError, useOtcI18n } from '@/modules/otc/i18n'

/** Blacklist: `otc/person_relationship` (BLACKLIST) and `otc/user_contacts_remove` (PersonalPageAct.java:738/906). */
const PAGE_SIZE = 10
const { t } = useOtcI18n()
const rows = ref<BlacklistEntry[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref('')
const busy = ref('')
const notice = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await fetchBlacklist(page.value, PAGE_SIZE)
    rows.value = result.items
    total.value = result.count
  } catch (err) {
    rows.value = []
    error.value = describeOtcError(t, err)
  } finally {
    loading.value = false
  }
}

async function remove(entry: BlacklistEntry): Promise<void> {
  busy.value = entry.userId
  notice.value = ''
  try {
    await removeFromBlacklist(entry.userId)
    notice.value = t('otc.blacklist.removed')
    await load()
  } catch (err) {
    error.value = describeOtcError(t, err)
  } finally {
    busy.value = ''
  }
}

function go(next: number): void {
  page.value = next
  void load()
}

onMounted(load)
</script>

<template>
  <section class="bl-panel">
    <p v-if="notice !== ''" class="ok-note" role="status">{{ notice }}</p>
    <StateBlock v-if="loading && rows.length === 0" variant="loading" :message="t('common.loading')" />
    <StateBlock v-else-if="error !== ''" variant="error" :message="error" retryable @retry="load" />
    <StateBlock v-else-if="rows.length === 0" variant="empty" :message="t('otc.blacklist.empty')" />
    <ul v-else class="bl-list">
      <li v-for="row in rows" :key="row.userId" class="bl-row">
        <span class="bl-icon"><UserX :size="16" /></span>
        <span class="bl-name wrap-anywhere">{{ row.nickname || row.userId }}</span>
        <span class="muted small">{{ t('otc.orders', { n: row.completeOrders || '--' }) }}</span>
        <button class="btn btn-ghost" type="button" :disabled="busy === row.userId" @click="remove(row)">{{ t('otc.blacklist.remove') }}</button>
      </li>
    </ul>
    <OtcPager :page="page" :page-size="PAGE_SIZE" :total="total" :disabled="loading" @change="go" />
  </section>
</template>

<style scoped>
.bl-panel { display: flex; flex-direction: column; gap: 12px; }
.ok-note { margin: 0; color: var(--color-up); font-weight: 600; font-size: 13px; }
.bl-list { margin: 0; padding: 0; list-style: none; }
.bl-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--color-border); }
.bl-row:last-child { border-bottom: 0; }
.bl-icon { display: inline-flex; color: var(--color-down); }
.bl-name { flex: 1; font-weight: 650; }
.small { font-size: 12px; }
</style>
