import { isApiError } from '@/core/errors'

/**
 * Contract v2 error codes (§6.5) that get a clear localized message. Any other code keeps the
 * server message verbatim; transport errors keep their own description.
 */
export const WALLET_ERROR_CODES = [
  '10054', '10053', '110102', '110101', '10063', '110103', '10090',
  '10083', '10080', '10010', '110008', '10009', '110007', '10020',
] as const

/** i18n key (`wallet.err.c<code>`) for a known business code, `''` otherwise. */
export function walletErrorKey(error: unknown): string {
  if (!isApiError(error) || error.kind !== 'api') return ''
  const code = error.code.trim()
  return (WALLET_ERROR_CODES as readonly string[]).includes(code) ? `wallet.err.c${code}` : ''
}

/** Localized message for wallet failures: mapped code, else the server/transport message. */
export function describeWalletError(error: unknown, t: (key: string) => string): string {
  const key = walletErrorKey(error)
  if (key !== '') return t(key)
  return isApiError(error) ? error.message : error instanceof Error ? error.message : String(error)
}
