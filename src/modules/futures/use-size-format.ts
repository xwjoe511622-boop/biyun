import { i18n } from '@/i18n'
import { groupDigits } from '@/modules/finance/decimal'
import { ensureFuturesMessages } from './i18n'
import { SIZE_UNITS, contractsAmount, sizeUnitLabel, useSizeUnit, valueAmount, type SizeAmount, type SizeContract, type SizeUnit } from './size-unit'

/**
 * Futures quantity display in the app-wide size unit (USDT / base coin / 张, `picat.futures.sizeUnit`).
 * Every futures quantity (book, trades, positions, orders, fills, dialogs, data pages) goes through here.
 */
export function useSizeFormat() {
  ensureFuturesMessages()
  const unit = useSizeUnit()
  // Global translator (reactive to the locale), so this also works outside component setup.
  const contractsLabel = (): string => i18n.global.t('fut.contracts')

  function label(contract: SizeContract | undefined, value: SizeUnit = unit.value): string {
    return sizeUnitLabel(value, contract, contractsLabel())
  }

  function text(result: SizeAmount): string {
    return result.amount === '' ? '--' : groupDigits(result.amount, result.dp)
  }

  /** Contracts → `"0.0396"` in the chosen unit (no unit label). */
  function size(contracts: string, contract: SizeContract | undefined, price = ''): string {
    return text(contractsAmount(contracts, unit.value, contract, price))
  }

  /** Contracts → `"0.0396 BTC"`. */
  function sizeWithUnit(contracts: string, contract: SizeContract | undefined, price = ''): string {
    const result = contractsAmount(contracts, unit.value, contract, price)
    return result.amount === '' ? '--' : `${text(result)} ${label(contract, result.unit)}`
  }

  /**
   * Cell text for a table whose header already names `headerContract`'s unit: the unit is appended
   * only when the row falls back or belongs to a contract with a different label (e.g. ETH rows
   * under a BTC header).
   */
  function cell(result: SizeAmount, contract: SizeContract | undefined, headerContract: SizeContract | undefined): string {
    if (result.amount === '') return '--'
    const own = label(contract, result.unit)
    return own === label(headerContract) ? text(result) : `${text(result)} ${own}`
  }

  function sizeCell(contracts: string, contract: SizeContract | undefined, price: string, headerContract: SizeContract | undefined): string {
    return cell(contractsAmount(contracts, unit.value, contract, price), contract, headerContract)
  }

  function valueCell(value: string, contract: SizeContract | undefined, price: string, headerContract: SizeContract | undefined): string {
    return cell(valueAmount(value, unit.value, contract, price), contract, headerContract)
  }

  /** `"数量 (BTC)"` header. */
  function header(title: string, contract: SizeContract | undefined): string {
    return `${title} (${label(contract)})`
  }

  return { unit, units: SIZE_UNITS, label, size, sizeWithUnit, sizeCell, valueCell, header }
}
