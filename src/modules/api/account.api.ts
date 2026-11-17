import { i18n } from '@/i18n/composer'
import { ENDPOINTS } from '@/config/endpoints'
import { request } from './http'
import type { AccountBalanceData } from './types'
import { exactTradingSnapshot } from '@/modules/spot/account-snapshot'
import { session } from '@/core/session'

/**
 * Trading-account balances used by the trade page.
 * Shared by the current trade and assets views. Normal orders use normal_balance only;
 * overcharge_balance and lock_position fields are not ordinary spendable balances.
 */
export async function fetchAccountBalance(): Promise<AccountBalanceData> {
  const token = session.getToken()
  const uid = session.getUser()?.id
  const current = (): boolean => token === session.getToken() && (uid === undefined || uid === session.getUser()?.id)
  const metadata = await request<AccountBalanceData>(ENDPOINTS.accountBalance, { body: {} })
  if (!current()) throw new Error(i18n.global.t('clientFailure.accountSessionChangedRefreshToRetry'))
  // Never stitch a second core response to projected DB buckets. The backend
  // supplies raw 201/202/207/221 quantities from one authoritative core read.
  return exactTradingSnapshot(metadata)
}

/**
 * Assets page balances (v5). Unlike v4 there is no `withdrawAddressMap` and
 * `present_coin_balance` is `0`; the trade page keeps using the v3 endpoint above.
 */
export function fetchAccountBalanceV5(): Promise<AccountBalanceData> {
  return request<AccountBalanceData>(ENDPOINTS.accountBalanceV5, { body: {} })
}
