import { isApiError } from '@/core/errors'
import { CODE_NOT_OPENED, CODE_TRANSFER_NOT_OPENED } from './endpoints'

/**
 * Futures account state as a pure reducer.
 *
 * Platform rule (owner, 2026-09-27): every user has a futures account by default — there is no
 * "open futures" step and no agreement in the UI. The backend creates the account at registration
 * (a .84 timer, within ~30 s). For that window the client closes the gap itself, silently:
 *
 * - `user/get_user_config` reports `openContract` (1/0, `UserConfigResultVo`);
 * - other private futures endpoints answer `100501` (`USER_NOT_OPEN_CONTRACT`);
 * - spot `contract/co_transfer` answers `105001` (pre-check, nothing debited).
 *
 * Any of these moves to `unopened`; the store then calls `user/create_co_id` (idempotent) without
 * asking (`autoOpen` → `opening`) and re-checks. Only when that fails does the state become `error`
 * with `initFailed = true`, which the UI shows as a plain "initialisation failed, retry" error.
 */
/** `quiz` (2026-10-01): the risk-assessment quiz is required before the account can be opened (server code 100520). */
export type OpenAccountStatus = 'signedOut' | 'checking' | 'unopened' | 'opening' | 'quiz' | 'opened' | 'error'

export interface OpenAccountState {
  status: OpenAccountStatus
  error: string | null
  /** True when the silent `create_co_id` + re-check did not produce an opened account. */
  initFailed: boolean
}

export type OpenAccountEvent =
  | { type: 'signedOut' }
  | { type: 'check' }
  | { type: 'config'; openContract: boolean }
  | { type: 'notOpened' }
  | { type: 'checkFailed'; message: string }
  | { type: 'autoOpen' }
  | { type: 'opened' }
  | { type: 'openFailed'; message: string }
  | { type: 'quizRequired' }

export const INITIAL_OPEN_STATE: OpenAccountState = { status: 'signedOut', error: null, initFailed: false }

export function openAccountReducer(state: OpenAccountState, event: OpenAccountEvent): OpenAccountState {
  switch (event.type) {
    case 'signedOut':
      return { ...INITIAL_OPEN_STATE }
    case 'check':
      // A re-check while the account is being created keeps that flow. A re-check of an account already known to be
      // opened (contract switch, after a leverage change) runs in the background: the panels keep showing the account
      // instead of flashing "checking" (2026-09-29, stale-while-revalidate).
      return state.status === 'opening' || state.status === 'opened' ? state : { ...state, status: 'checking', error: null }
    case 'config':
      if (event.openContract) return { status: 'opened', error: null, initFailed: false }
      return state.status === 'opening' ? state : { status: 'unopened', error: null, initFailed: false }
    case 'notOpened':
      return state.status === 'opening' ? state : { status: 'unopened', error: null, initFailed: false }
    case 'checkFailed':
      return { ...state, status: 'error', error: event.message }
    case 'autoOpen':
      return state.status === 'opened' ? state : { status: 'opening', error: null, initFailed: false }
    case 'opened':
      return { status: 'opened', error: null, initFailed: false }
    case 'openFailed':
      return { status: 'error', error: event.message, initFailed: true }
    case 'quizRequired':
      return state.status === 'opened' ? state : { status: 'quiz', error: null, initFailed: false }
    default:
      return state
  }
}

/** True for the "not opened" business answer of a private futures endpoint, or of the spot transfer (105001). */
export function isNotOpenedError(error: unknown): boolean {
  return isApiError(error) && (error.code === CODE_NOT_OPENED || error.code === CODE_TRANSFER_NOT_OPENED)
}
