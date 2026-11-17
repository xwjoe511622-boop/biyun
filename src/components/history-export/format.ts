/**
 * Presentation helpers for history exports. Inside the app every time is UTC epoch ms; only these functions turn one
 * into text for people, in the device's zone (or the zone a statement was generated in).
 */

const pad = (value: number): string => String(value).padStart(2, '0')

/** `UTC+08:00` / `UTC-03:30` from minutes east of UTC. */
export function zoneLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** `YYYY-MM-DD HH:mm` of a UTC instant at `offsetMin` (presentation only). */
export function wallClock(ms: number, offsetMin: number, withTime = true): string {
  const d = new Date(ms + offsetMin * 60_000)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day
}

/** The statement range as inclusive days in the zone it was generated in (`end` is exclusive). */
export function rangeLabel(start: number, end: number, offsetMin: number): string {
  return `${wallClock(start, offsetMin, false)} ~ ${wallClock(end - 1, offsetMin, false)}`
}

/** `1.2 MB` style size of a file (presentation only). */
export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB` // float-ok: file size display
  return `${(bytes / 1024 / 1024).toFixed(1)} MB` // float-ok: file size display
}
