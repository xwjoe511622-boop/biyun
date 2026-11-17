<script setup lang="ts">
/**
 * 内账转账记录（只读）。服务端按当前登录用户过滤；不含 total，上一页/下一页基于 page 与返回长度判断。
 * 读取失败保留旧记录并提示“更新失败”，不能当作成功；`requestId` 传入时只查询原单，不跨页。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { session } from '@/core/session'
import { useSessionStore } from '@/stores/session'
import { listTransferHistory, type TransferRecord } from '@/modules/api/internal-transfer.api'
import { useInternalTransferI18n } from './InternalTransferMessages'

const props = withDefaults(defineProps<{ requestId?: string; refreshKey?: number }>(), {
  requestId: '',
  refreshKey: 0,
})
const emit = defineEmits<{ (event: 'recordsLoaded', records: TransferRecord[]): void }>()
const { t } = useInternalTransferI18n()
const sessionStore = useSessionStore()

const PAGE_SIZE = 50
const records = ref<TransferRecord[]>([])
const loading = ref(false)
const error = ref<string>('')
const page = ref(1)
/** 上一页/下一页：没有 total，只能用返回长度推断是否还有下一页。 */
const hasNext = ref(false)
let generation = 0

function myUid(): string {
  const id = sessionStore.user?.id
  return id === undefined ? '' : String(id)
}

function direction(record: TransferRecord): string {
  const uid = myUid()
  if (uid !== '' && record.fromUid === uid) return t('internalTransfer.history.outward')
  if (uid !== '' && record.toUid === uid) return t('internalTransfer.history.inward')
  return ''
}

async function load(nextPage: number): Promise<void> {
  const current = ++generation
  const token = session.getToken()
  if (!session.isAuthenticated() || token === null) {
    records.value = []
    hasNext.value = false
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const query = props.requestId !== ''
      ? { requestId: props.requestId }
      : { page: nextPage, pageSize: PAGE_SIZE }
    const result = await listTransferHistory(query)
    if (current !== generation || token !== session.getToken()) return
    records.value = result.list
    page.value = result.page
    hasNext.value = props.requestId === '' && result.list.length === (result.pageSize || PAGE_SIZE)
    emit('recordsLoaded', result.list)
  } catch (e) {
    if (current !== generation || token !== session.getToken()) return
    // 保留旧记录，只提示失败；不得当作成功。
    error.value = `${t('internalTransfer.history.refreshFailed')}: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    if (current === generation) loading.value = false
  }
}

function prev(): void {
  if (page.value > 1) void load(page.value - 1)
}
function next(): void {
  if (hasNext.value) void load(page.value + 1)
}

onMounted(() => {
  void load(1)
})
onBeforeUnmount(() => {
  generation += 1
})

watch(() => sessionStore.token, () => {
  generation += 1
  records.value = []
  hasNext.value = false
  loading.value = false
  error.value = ''
  page.value = 1
  if (sessionStore.isAuthenticated) void load(1)
}, { flush: 'sync' })

watch([() => props.requestId, () => props.refreshKey], () => {
  records.value = []
  hasNext.value = false
  page.value = 1
  void load(1)
})
</script>

<template>
  <section class="history">
    <div class="history-head">
      <h3>{{ t('internalTransfer.history.title') }}</h3>
      <span class="spacer" />
      <button class="btn" type="button" :disabled="loading" @click="load(page)">{{ t('internalTransfer.history.refresh') }}</button>
    </div>

    <p v-if="error !== ''" class="notice notice-error" role="alert" aria-live="polite">{{ error }}</p>
    <p v-else-if="loading && records.length === 0" class="muted" role="status" aria-live="polite">{{ t('internalTransfer.loading') }}</p>

    <div class="table-scroll">
      <table class="records">
        <thead>
          <tr>
            <th>{{ t('internalTransfer.requestId') }}</th>
            <th>{{ t('internalTransfer.history.time') }}</th>
            <th>{{ t('internalTransfer.history.direction') }}</th>
            <th>{{ t('internalTransfer.history.from') }}</th>
            <th>{{ t('internalTransfer.history.to') }}</th>
            <th>{{ t('internalTransfer.history.coin') }}</th>
            <th class="right">{{ t('internalTransfer.history.amount') }}</th>
            <th class="right">{{ t('internalTransfer.history.fee') }}</th>
            <th>{{ t('internalTransfer.history.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.id">
            <td class="num">{{ record.requestId }}</td>
            <td class="num">{{ record.ctime }}</td>
            <td>{{ direction(record) }}</td>
            <td class="num">{{ record.fromUid }}</td>
            <td class="num">{{ record.toUid }}</td>
            <td>{{ record.coin }}</td>
            <td class="num right">{{ record.amount }}</td>
            <td class="num right">{{ record.fee }}</td>
            <td><span :title="record.reason">{{ t(`internalTransfer.status.${record.status}`) }}</span><small v-if="record.reason" class="reason">{{ record.reason }}</small></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="records.length === 0 && !loading && error === ''" class="muted" aria-live="polite">{{ t('internalTransfer.history.empty') }}</p>

    <div v-if="requestId === ''" class="pager">
      <button class="btn" type="button" :disabled="page <= 1 || loading" @click="prev">{{ t('internalTransfer.history.prev') }}</button>
      <span class="muted num">{{ t('internalTransfer.history.page', { page }) }}</span>
      <button class="btn" type="button" :disabled="!hasNext || loading" @click="next">{{ t('internalTransfer.history.next') }}</button>
    </div>
  </section>
</template>

<style scoped>
.history { display: flex; flex-direction: column; gap: 8px; }
.history-head { display: flex; align-items: center; gap: 10px; }
.history-head h3 { margin: 0; font-size: 14px; }
.spacer { flex: 1; }
.table-scroll { overflow-x: auto; }
.records { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 13px; }
.records th, .records td { padding: 6px 8px; border-bottom: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
.records th.right, .records td.right { text-align: right; }
.records td.num { font-family: var(--font-mono); }
.reason { display: block; max-width: 220px; white-space: normal; overflow-wrap: anywhere; color: var(--color-text-muted); }
.pager { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--color-text-muted); }
.notice-error { color: var(--color-down); font-size: 13px; margin: 0; }
</style>
