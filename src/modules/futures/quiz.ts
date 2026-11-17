import { translateForLocale } from '@/i18n/composer'
import { isApiError } from '@/core/errors'
import { request, requestLanguage } from '@/modules/api/http'

/**
 * Futures risk-assessment quiz (2026-10-01, docs/03-reference/futures-risk-quiz.md), Binance-style: when the admin switch
 * is on, a user without a futures account must pass a short quiz before the account is opened. Served by fgw:
 * `quiz/status`, `quiz/start`, `quiz/submit` (on the `futures` namespace). Account creation and futures writes answer
 * `100520` while it is required; the store then opens the quiz dialog instead of failing.
 */
export const CODE_QUIZ_REQUIRED = '100520'
export const CODE_QUIZ_COOLDOWN = '100521'
export const CODE_QUIZ_ATTEMPT = '100522'

export interface QuizOption {
  key: string
  zh: string
  en: string
}

export interface QuizQuestion {
  id: number
  type: 'single' | 'multi'
  textZh: string
  textEn: string
  options: QuizOption[]
}

export interface QuizStatus {
  enabled: boolean
  required: boolean
  passed: boolean
  hasAccount: boolean
  questionsPerAttempt: number
  passScore: number
  cooldownMinutes: number
  cooldownUntil: number | null
}

export interface QuizStart {
  required: boolean
  attemptId?: string
  expiresAt?: number
  passScore?: number
  questions?: QuizQuestion[]
}

export interface QuizItemResult {
  id: number
  correct: boolean
  explainZh: string
  explainEn: string
}

export interface QuizResult {
  passed: boolean
  score: number
  total: number
  passScore: number
  results: QuizItemResult[]
  cooldownUntil: number | null
  cooldownMinutes: number
  opened?: boolean
}

/** answers by question id: the chosen option keys */
export type QuizAnswers = Record<string, string[]>

export function fetchQuizStatus(): Promise<QuizStatus> {
  return request<QuizStatus>('quiz/status', { api: 'futures', body: {} })
}

export function startQuiz(): Promise<QuizStart> {
  return request<QuizStart>('quiz/start', { api: 'futures', body: {} })
}

export function submitQuiz(attemptId: string, answers: QuizAnswers): Promise<QuizResult> {
  return request<QuizResult>('quiz/submit', { api: 'futures', body: { attemptId, answers } })
}

export function isQuizRequiredError(error: unknown): boolean {
  return isApiError(error) && error.code === CODE_QUIZ_REQUIRED
}

/** retryAt (ms) of a 100521 answer, if any */
export function cooldownOf(error: unknown): number | null {
  if (!isApiError(error) || error.code !== CODE_QUIZ_COOLDOWN) return null
  const data = error.data as { retryAt?: unknown } | undefined
  const at = Number(data?.retryAt) // float-ok: epoch timestamp
  return Number.isFinite(at) && at > 0 ? at : null
}

export function quizZh(): boolean {
  return requestLanguage().toLowerCase().startsWith('zh')
}

export function pick(zh: string, en: string, isZh = quizZh()): string {
  return (isZh ? zh : en) || zh || en
}

/** Toggle one option: single choice replaces, multiple choice adds / removes (keys kept in option order). */
export function choose(q: QuizQuestion, current: string[] | undefined, key: string): string[] {
  if (q.type === 'single') return [key]
  const set = new Set(current ?? [])
  if (set.has(key)) set.delete(key)
  else set.add(key)
  return q.options.map((o) => o.key).filter((k) => set.has(k))
}

export function allAnswered(questions: QuizQuestion[], answers: QuizAnswers): boolean {
  return questions.length > 0 && questions.every((q) => (answers[String(q.id)] ?? []).length > 0)
}

/** "5 分 30 秒" / "5 min 30 s" until `at` (ms) */
export function waitText(at: number, now: number, isZh = quizZh()): string {
  const s = Math.max(0, Math.ceil((at - now) / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  const language = isZh ? 'zh' : 'en'
  return m > 0 ? translateForLocale(language, 'quizTime.minS', { m, r }) : translateForLocale(language, 'quizTime.s', { r })
}
