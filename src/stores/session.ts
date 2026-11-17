import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { newSessionKey, session, type SessionUser } from '@/core/session'
import { ApiError, isApiError } from '@/core/errors'
import * as authApi from '@/modules/api/auth.api'

export interface LoginChallenge {
  /** `''` in cookie mode (the challenge is the HttpOnly cookie). */
  token: string
  verifyType: string
}

/**
 * Session state. The login token is the HttpOnly session cookie (10-17); `token` here is the non-secret session
 * key persisted by `core/session.ts`, so a reload or a new tab stays signed in until logout or a confirmed server
 * rejection. No action here ever pretends to be authenticated on failure.
 */
export const useSessionStore = defineStore('session', () => {
  const token = ref<string | null>(session.getToken())
  const user = ref<SessionUser | null>(session.getUser())
  const challenge = ref<LoginChallenge | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let profileGeneration = 0
  let authGeneration = 0
  onScopeDispose(session.onInvalidate((snapshot) => {
    if (snapshot.token !== token.value) {
      profileGeneration += 1
      authGeneration += 1
      loading.value = false
      challenge.value = null
      error.value = null
    }
    token.value = snapshot.token
    user.value = snapshot.user
    if (snapshot.token === null) {
      challenge.value = null
    }
  }))

  const isAuthenticated = computed(() => token.value !== null && token.value !== '')
  const pending = computed(() => challenge.value !== null)
  /**
   * `authLevel === 1` means real-name verified (server `common/user_info`).
   * Compared as a string so no numeric parsing is involved.
   */
  const authLevel = computed(() => {
    const raw = user.value?.authLevel
    if (raw === undefined || raw === null) {
      return 0
    }
    return String(raw).trim() === '1' ? 1 : 0
  })

  function describe(error_: unknown): string {
    if (isApiError(error_)) {
      return error_.message
    }
    return error_ instanceof Error ? error_.message : String(error_)
  }

  async function loadUserInfo(): Promise<void> {
    if (!session.isAuthenticated()) {
      return
    }
    const requestToken = session.getToken()
    const generation = ++profileGeneration
    error.value = null
    try {
      const info = await authApi.fetchUserInfo()
      if (generation !== profileGeneration || session.getToken() !== requestToken) return
      session.setUser(info as SessionUser)
      user.value = session.getUser()
    } catch (error_) {
      if (generation !== profileGeneration || session.getToken() !== requestToken) return
      if (!(isApiError(error_) && error_.kind === 'unauthorized')) {
        error.value = describe(error_)
      }
    }
  }

  /** Login step 1: returns the challenge (temporary token + verification channel). */
  async function requestLogin(payload: authApi.LoginPlaintext): Promise<LoginChallenge | null> {
    const generation = ++authGeneration
    const originalToken = session.getToken()
    session.clearPendingLogin()
    challenge.value = null
    loading.value = true
    error.value = null
    try {
      const data = await authApi.loginStepOne(payload)
      if (generation !== authGeneration || session.getToken() !== originalToken) return null
      if (data.session !== 'cookie') {
        // an older server answered the challenge token: this client no longer keeps tokens in page memory
        error.value = 'error.loginTokenInvalid'
        return null
      }
      const next: LoginChallenge = { token: '', verifyType: String(data.type) }
      session.setPendingLogin(next.token, next.verifyType)
      challenge.value = next
      return next
    } catch (error_) {
      if (generation !== authGeneration || session.getToken() !== originalToken) return null
      error.value = describe(error_)
      return null
    } finally {
      if (generation === authGeneration) loading.value = false
    }
  }

  /** Login step 2: the server turns the challenge cookie into the session cookie; a new session key marks it. */
  async function confirmLogin(authCode: string, verifyType: string): Promise<boolean> {
    const pendingLogin = session.getPendingLogin()
    const temporaryToken = pendingLogin.token
    if (temporaryToken === null) {
      error.value = 'error.loginTokenInvalid'
      return false
    }
    const generation = ++authGeneration
    const originalToken = session.getToken()
    loading.value = true
    error.value = null
    try {
      await authApi.loginStepTwo(verifyType === '0' ? { type: verifyType } : { authCode, type: verifyType })
      if (generation !== authGeneration || session.getToken() !== originalToken
        || session.getPendingLogin().token !== temporaryToken) return false
      loading.value = false
      const key = newSessionKey()
      session.setToken(key)
      session.clearPendingLogin()
      token.value = key
      challenge.value = null
      await loadUserInfo()
      return session.getToken() === key
    } catch (error_) {
      if (generation !== authGeneration) return false
      error.value = describe(error_)
      return false
    } finally {
      if (generation === authGeneration) loading.value = false
    }
  }

  function cancelChallenge(): void {
    authGeneration += 1
    loading.value = false
    session.clearPendingLogin()
    challenge.value = null
    error.value = null
  }

  async function logout(): Promise<void> {
    cancelChallenge()
    const requestToken = session.getToken()
    const wasAuthenticated = isAuthenticated.value
    try {
      if (wasAuthenticated) {
        await authApi.logout()
      }
    } catch (error_) {
      // Logout is best-effort: the local session is dropped either way, and the real
      // server error is surfaced instead of being hidden.
      if (session.getToken() === requestToken && !(error_ instanceof ApiError)) {
        error.value = describe(error_)
      }
    } finally {
      if (session.getToken() === requestToken) session.clear()
    }
  }

  return {
    token,
    user,
    challenge,
    loading,
    error,
    isAuthenticated,
    pending,
    authLevel,
    loadUserInfo,
    requestLogin,
    confirmLogin,
    cancelChallenge,
    logout,
  }
})
