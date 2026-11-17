import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { businessRequest, rowOf, rowsOf, textOf, valueAt } from '@/modules/business/client'
import { cmp, isDecimalString, ratioToPercent } from '@/modules/finance/decimal'

/**
 * Live facts for the home product panels, read from the public business endpoints. Each value is the
 * server's decimal string formatted for display, or `--` when the endpoint is empty, closed or failed.
 * Nothing here is a marketing number: no endpoint, no figure.
 */
export interface ProductFacts {
  /** Highest indicative APR across flexible and locked Earn products, e.g. `12.50%`. */
  earnTopApr: string
  earnAsset: string
  /** Annual borrowing rate of the cheapest loanable asset, e.g. `8.00%`. */
  loanApr: string
  loanCoin: string
  /** Number of configured VIP levels. */
  vipLevels: string
  /** Lowest futures maker fee across VIP levels, e.g. `0.015%`. */
  vipBestMaker: string
  launchProjects: string
  launchPools: string
}

const EMPTY: ProductFacts = {
  earnTopApr: '--', earnAsset: '', loanApr: '--', loanCoin: '', vipLevels: '--', vipBestMaker: '--', launchProjects: '--', launchPools: '--',
}

function percent(ratio: string, dp = 2): string {
  return isDecimalString(ratio) ? `${ratioToPercent(ratio, dp)}%` : '--'
}

/** Picks the row whose decimal at `key` is largest (or smallest with `lowest`). */
function pick(rows: { value: string; label: string }[], lowest = false): { value: string; label: string } | null {
  let best: { value: string; label: string } | null = null
  for (const row of rows) {
    if (!isDecimalString(row.value)) continue
    if (best === null || cmp(row.value, best.value) === (lowest ? -1 : 1)) best = row
  }
  return best
}

async function settle<T>(task: Promise<T>): Promise<T | null> {
  try {
    return await task
  } catch {
    return null
  }
}

export function useProductFacts(): Ref<ProductFacts> {
  const facts = ref<ProductFacts>({ ...EMPTY })
  const controller = new AbortController()

  async function load(): Promise<void> {
    const signal = controller.signal
    const [flexible, locked, loans, vip, projects, pools] = await Promise.all([
      settle(businessRequest('/sapi/v1/simple-earn/flexible/list', { current: '1', size: '50' }, false, signal)),
      settle(businessRequest('/sapi/v1/simple-earn/locked/list', { current: '1', size: '50' }, false, signal)),
      settle(businessRequest('/sapi/v2/loan/flexible/loanable/data', {}, false, signal)),
      settle(businessRequest('/sapi/v1/vip/levels', {}, false, signal)),
      settle(businessRequest('/sapi/v1/launchpad/projects', { current: '1', size: '1' }, false, signal)),
      settle(businessRequest('/sapi/v1/launchpool/pools', { current: '1', size: '1' }, false, signal)),
    ])
    if (signal.aborted) return

    const earnRows = [
      ...rowsOf(flexible).map((row) => ({ value: textOf(row.latestAnnualPercentageRate), label: textOf(row.asset) })),
      ...rowsOf(locked).map((row) => ({ value: textOf(valueAt(row, 'detail.apr')), label: textOf(valueAt(row, 'detail.asset')) })),
    ]
    const earn = pick(earnRows)
    const loan = pick(rowsOf(loans).map((row) => ({ value: textOf(row.annualInterestRate), label: textOf(row.loanCoin) })), true)
    const vipBody = rowOf(vip)
    const vipRows = vipBody.enabled === false ? [] : rowsOf(vip, 'levels')
    const maker = pick(vipRows.map((row) => ({ value: textOf(row.futuresMaker), label: textOf(row.level) })), true)
    const total = (body: unknown): string => {
      const value = textOf(rowOf(body).total)
      return /^\d+$/.test(value) ? value : '--'
    }

    facts.value = {
      earnTopApr: earn === null ? '--' : percent(earn.value),
      earnAsset: earn?.label ?? '',
      loanApr: loan === null ? '--' : percent(loan.value),
      loanCoin: loan?.label ?? '',
      vipLevels: vipRows.length > 0 ? String(vipRows.length) : '--',
      vipBestMaker: maker === null ? '--' : percent(maker.value, 3),
      launchProjects: projects === null ? '--' : total(projects),
      launchPools: pools === null ? '--' : total(pools),
    }
  }

  onMounted(() => void load())
  onBeforeUnmount(() => controller.abort())
  return facts
}
