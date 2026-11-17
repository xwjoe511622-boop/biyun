export function safeWebUrl(value: unknown, allowRelative = false): string {
  if (typeof value !== 'string' || value.trim() === '') return ''
  if (allowRelative && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}
