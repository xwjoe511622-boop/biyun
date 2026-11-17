import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/errors'
import { INITIAL_OPEN_STATE, openAccountReducer } from '@/modules/futures/open-account'
import { allAnswered, choose, cooldownOf, isQuizRequiredError, pick, waitText, type QuizQuestion } from '@/modules/futures/quiz'

const single: QuizQuestion = { id: 1, type: 'single', textZh: '问', textEn: 'Q', options: [{ key: 'A', zh: '甲', en: 'a' }, { key: 'B', zh: '乙', en: 'b' }] }
const multi: QuizQuestion = { id: 2, type: 'multi', textZh: '多', textEn: 'M', options: [{ key: 'A', zh: '甲', en: 'a' }, { key: 'B', zh: '乙', en: 'b' }, { key: 'C', zh: '丙', en: 'c' }] }
const apiError = (code: string, data?: unknown) => new ApiError({ kind: 'business', code, message: 'x', product: 'futures', data } as never)

describe('futures risk quiz', () => {
  it('single choice replaces, multiple choice toggles in option order', () => {
    expect(choose(single, ['A'], 'B')).toEqual(['B'])
    expect(choose(multi, ['C'], 'A')).toEqual(['A', 'C'])
    expect(choose(multi, ['A', 'C'], 'A')).toEqual(['C'])
  })
  it('submit only when every question is answered', () => {
    expect(allAnswered([single, multi], { 1: ['A'] })).toBe(false)
    expect(allAnswered([single, multi], { 1: ['A'], 2: ['B'] })).toBe(true)
    expect(allAnswered([], {})).toBe(false)
  })
  it('codes and texts', () => {
    expect(isQuizRequiredError(apiError('100520'))).toBe(true)
    expect(isQuizRequiredError(apiError('100501'))).toBe(false)
    expect(cooldownOf(apiError('100521', { retryAt: 1790000000000 }))).toBe(1790000000000)
    expect(cooldownOf(apiError('100520'))).toBeNull()
    expect(pick('中', 'en', true)).toBe('中')
    expect(pick('中', '', false)).toBe('中')
    expect(waitText(125_000, 0, true)).toBe('2 分 5 秒')
    expect(waitText(5_000, 0, false)).toBe('5 s')
  })
  it('reducer: quiz state between opening and opened', () => {
    const opening = openAccountReducer({ ...INITIAL_OPEN_STATE, status: 'unopened' }, { type: 'autoOpen' })
    const quiz = openAccountReducer(opening, { type: 'quizRequired' })
    expect(quiz.status).toBe('quiz')
    expect(quiz.error).toBeNull()
    expect(openAccountReducer(quiz, { type: 'opened' }).status).toBe('opened')
    expect(openAccountReducer({ ...INITIAL_OPEN_STATE, status: 'opened' }, { type: 'quizRequired' }).status).toBe('opened')
  })
})
