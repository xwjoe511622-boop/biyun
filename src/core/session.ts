/**
 * Session holder.
 *
 * Since 2026-10-17 the login token lives only in the HttpOnly cookie `__Host-lb_session`, which this page cannot
 * read (docs/03-reference/api/web-session-cookie.md). The browser attaches it to every same-origin request; Nginx
 * turns it into the `exchange-token` the services read, after CSRF checks (`X-CSRF-Token` = cookie `__Host-lb_csrf`).
 *
 * What this module keeps is a **session key**: a random, non-secret marker created on login (`c` + 32 hex) that
 * stands for "signed in as this session". It is what `getToken()` / `snapshot().token` return; stores and views
 * compare it to notice logout or an account switch. It is never sent to the server and authenticates nothing.
 *
 * - Persisted to `localStorage` (`picat.session.v2`, versioned JSON, shape-checked on read) so a reload or a new tab
 *   keeps the signed-in state; other tabs follow through the `storage` event.
 * - Removed on logout, on a confirmed rejection (`modules/api/http.ts`) and on an account switch (overwritten).
 * - A session stored before 10-17 (`picat.session.v1`, the token itself) is used once as a header to obtain the
 *   cookies (`common/user_info` with `X-LB-Session: cookie`), then deleted (`legacyToken`, `finishLegacyUpgrade`).
 * - The pending login challenge is the HttpOnly `__Host-lb_pending`; in memory only the verification channel.
 */

export interface SessionUser {
  id?: number
  nickName?: string
  email?: string
  mobileNumber?: string
  userAccount?: string
  countryCode?: string
  avatar?: string
  authLevel?: number
  [key: string]: unknown
}

export interface SessionSnapshot {
  /** The session key (not a credential). */
  token: string | null
  user: SessionUser | null
}

interface SessionState {
  token: string | null
  /** Header token of a pre-10-17 session, only until the cookie upgrade succeeded. */
  legacyToken: string | null
  /**
   * Login challenge between `/user/login_in` and `/user/confirm_login`. `''` = the challenge is the HttpOnly cookie
   * (cookie mode); a non-empty value is only accepted from an older server that still answers the token.
   */
  pendingToken: string | null
  pendingVerifyType: string | null
  user: SessionUser | null
}

export const SESSION_STORAGE_KEY = 'picat.session.v2'
/** Pre-10-17 storage that held the token itself; read once for the upgrade, then removed. */
export const LEGACY_SESSION_STORAGE_KEY = 'picat.session.v1'
const SESSION_STORAGE_VERSION = 2
/** Readable CSRF cookie set by the server with the session (double-submit value). */
export const CSRF_COOKIE = '__Host-lb_csrf'
/** A session key or a legacy JWT: printable ASCII, no whitespace or quotes. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,4096}$/

export function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

/** A fresh random session key (`c` + 32 hex). */
export function newSessionKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Value of the readable CSRF cookie (`''` when absent). */
export function readCsrfCookie(cookie: string = typeof document === 'undefined' ? '' : document.cookie): string {
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== CSRF_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    if (/^[A-Za-z0-9_-]{32,128}$/.test(value)) return value
  }
  return ''
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readEntry(key: string, version: number, field: 'key' | 'token'): string | null {
  const store = storage()
  if (store === null) return null
  try {
    const raw = store.getItem(key)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const entry = parsed as { v?: unknown; key?: unknown; token?: unknown }
      const value = entry[field]
      if (entry.v === version && isValidToken(value)) return value
    }
    store.removeItem(key)
  } catch {
    try { store.removeItem(key) } catch { /* Storage blocked: nothing to clean. */ }
  }
  return null
}

/** Reads the persisted session key; a malformed or foreign entry is removed instead of being trusted. */
export function readStoredToken(): string | null {
  return readEntry(SESSION_STORAGE_KEY, SESSION_STORAGE_VERSION, 'key')
}

/** The pre-10-17 stored token, if any (malformed entries are removed). */
export function readLegacyToken(): string | null {
  return readEntry(LEGACY_SESSION_STORAGE_KEY, 1, 'token')
}

function removeLegacy(): void {
  const store = storage()
  if (store === null) return
  try { store.removeItem(LEGACY_SESSION_STORAGE_KEY) } catch { /* Storage blocked. */ }
}

function writeStoredToken(key: string | null): void {
  const store = storage()
  if (store === null) return
  try {
    if (key === null || !isValidToken(key)) store.removeItem(SESSION_STORAGE_KEY)
    else store.setItem(SESSION_STORAGE_KEY, JSON.stringify({ v: SESSION_STORAGE_VERSION, key }))
  } catch {
    // Private mode / quota: the session still works for this tab (the cookie), it just is not remembered.
  }
}

function initialState(): SessionState {
  let token = readStoredToken()
  let legacyToken = readLegacyToken()
  if (legacyToken !== null && token === null) {
    // A session from before 10-17: signed in, the header carries it until the cookie upgrade.
    token = newSessionKey()
    writeStoredToken(token)
  } else if (legacyToken !== null) {
    // Both present (an upgrade raced a login): the cookie session wins.
    removeLegacy()
    legacyToken = null
  }
  return { token, legacyToken, pendingToken: null, pendingVerifyType: null, user: null }
}

const state: SessionState = initialState()
/** Last time an authenticated request succeeded (each one extends the server TTL). */
let lastServerContact = 0

/** Called whenever the session key is dropped (logout, expired session, 401). */
type SessionListener = (snapshot: SessionSnapshot) => void
const listeners = new Set<SessionListener>()

function notify(): void {
  const snapshot = session.snapshot()
  listeners.forEach((listener) => listener(snapshot))
}

export const session = {
  /** The session key (not a credential; never put it on the wire). */
  getToken(): string | null {
    return state.token
  },

  isAuthenticated(): boolean {
    return state.token !== null && state.token !== ''
  },

  /** Marks a new session (after `confirm_login` / register set the cookie). Use `newSessionKey()`. */
  setToken(key: string): void {
    if (key !== state.token) {
      state.user = null
      state.pendingToken = null
      state.pendingVerifyType = null
    }
    state.token = key
    state.legacyToken = null
    removeLegacy()
    writeStoredToken(key)
    notify()
  },

  /** Header token of a pre-10-17 session still waiting for its cookie upgrade (`null` normally). */
  legacyToken(): string | null {
    return state.legacyToken
  },

  /** The server answered the upgrade request and set the cookies: forget the header token for good. */
  finishLegacyUpgrade(): void {
    if (state.legacyToken === null) return
    state.legacyToken = null
    removeLegacy()
  },

  setUser(user: SessionUser | null): void {
    state.user = user
    notify()
  },

  getUser(): SessionUser | null {
    return state.user
  },

  setPendingLogin(token: string, verifyType: string | null): void {
    state.pendingToken = token
    state.pendingVerifyType = verifyType
  },

  getPendingLogin(): { token: string | null; verifyType: string | null } {
    return { token: state.pendingToken, verifyType: state.pendingVerifyType }
  },

  clearPendingLogin(): void {
    state.pendingToken = null
    state.pendingVerifyType = null
  },

  /**
   * Drops the local signed-in state. Safe to call when already logged out. The HttpOnly cookie is removed by the
   * server (`user/login_out`, or automatically when it answers for an expired cookie session).
   */
  clear(): void {
    const hadSession = state.token !== null || state.user !== null
    state.token = null
    state.legacyToken = null
    state.user = null
    state.pendingToken = null
    state.pendingVerifyType = null
    lastServerContact = 0
    writeStoredToken(null)
    removeLegacy()
    if (hadSession) {
      notify()
    }
  },

  /** Called by the http layer after an authenticated request succeeded under session key `token`. */
  noteServerContact(token: string, at: number = Date.now()): void {
    if (token === state.token) lastServerContact = at
  },

  lastServerContact(): number {
    return lastServerContact
  },

  /**
   * Re-reads the persisted session key (another tab logged in, switched account or logged out).
   * Returns true when the in-memory session changed.
   */
  syncFromStorage(): boolean {
    const stored = readStoredToken()
    if (stored === state.token) return false
    if (stored === null) {
      session.clear()
    } else {
      state.user = null
      state.pendingToken = null
      state.pendingVerifyType = null
      state.legacyToken = null
      state.token = stored
      lastServerContact = 0
      notify()
    }
    return true
  },

  snapshot(): SessionSnapshot {
    return { token: state.token, user: state.user }
  },

  onInvalidate(listener: SessionListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

// Another tab logged in, switched account or logged out: follow it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_STORAGE_KEY || event.key === null) session.syncFromStorage()
  })
}
