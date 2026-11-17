/**
 * Client-side CSV export built from rows already fetched from the server.
 *
 * The only server export (`trade/export`, OrderAct.java:688) streams an XLS of one pair's fills, is not
 * `@ResponseBody` JSON and covers neither orders nor margin, so the orders centre exports what it has
 * loaded instead. Cells are quoted per RFC 4180 and text that a spreadsheet would evaluate as a formula
 * (`= + - @`, tab, CR) is prefixed with `'`. Plain decimal strings (including negatives) are left intact.
 */

export interface CsvColumn<T> {
  label: string
  value: (row: T) => string
}

const NUMERIC = /^-?\d+(\.\d+)?$/
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: string): string {
  let text = value
  if (FORMULA_START.test(text) && !NUMERIC.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map(column => csvCell(column.label)).join(',')]
  // `--` is the on-screen placeholder for "no value"; the file carries an empty cell instead.
  rows.forEach(row => lines.push(columns.map((column) => {
    const value = column.value(row)
    return csvCell(value === '--' ? '' : value)
  }).join(',')))
  return lines.join('\r\n')
}

/** Triggers a browser download; the UTF-8 BOM keeps Chinese headers readable in Excel. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
