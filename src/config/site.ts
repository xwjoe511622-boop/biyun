/**
 * Registrable domain of the public site. Each deployment sets `VITE_SITE_DOMAIN` at build time
 * (Aliyun test env `exchange.invalid`, AWS production `bitwinex.cc`); the WebSocket host is `ws.<domain>`.
 */
export const SITE_DOMAIN: string = (() => {
  const raw = import.meta.env.VITE_SITE_DOMAIN
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'exchange.invalid'
})()

/** `wss://ws.<SITE_DOMAIN><path>`; `path` starts with `/`. */
export function siteWsUrl(path: string): string {
  return `wss://ws.${SITE_DOMAIN}${path}`
}
