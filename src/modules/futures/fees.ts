import { canonicalDecimal } from '@/modules/finance/decimal'
import type { FuturesContract } from './contracts'
import type { FeeRow } from './types'

/** Match each contract independently; an unrelated contract's differing schedule must never blank this row. */
export function feeForContract(contract: FuturesContract | undefined, rows: readonly FeeRow[]): FeeRow | null {
  if (contract === undefined) return null
  const matches = rows.filter(row => row.multiplierCoin.toUpperCase() === contract.multiplierCoin.toUpperCase()
    && row.marginCoin.toUpperCase() === contract.marginCoin.toUpperCase()
    && canonicalDecimal(row.multiplier) === canonicalDecimal(contract.multiplier)
    && (row.contractSide === undefined || row.contractSide === null || row.contractSide === contract.contractSide))
  const first = matches[0]
  if (first === undefined) return null
  const signature = (row: FeeRow): string => [row.openMakerFee, row.openTakerFee, row.closeMakerFee, row.closeTakerFee].map(canonicalDecimal).join('|')
  return matches.every(row => signature(row) === signature(first)) ? first : null
}
