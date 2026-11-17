import { describe, expect, it } from 'vitest'
import { formatElapsed, nextPollDelayMs, PROVISION_SLOW_AFTER_MS, provisionPhase } from '@/modules/wallet/provisionPoll'

describe('deposit address provisioning poll', () => {
  it('backs off 3 s -> 5 s -> 10 s -> 30 s', () => {
    expect(nextPollDelayMs(0)).toBe(3_000)
    expect(nextPollDelayMs(29_999)).toBe(3_000)
    expect(nextPollDelayMs(30_000)).toBe(5_000)
    expect(nextPollDelayMs(119_999)).toBe(5_000)
    expect(nextPollDelayMs(120_000)).toBe(10_000)
    expect(nextPollDelayMs(PROVISION_SLOW_AFTER_MS - 1)).toBe(10_000)
    expect(nextPollDelayMs(PROVISION_SLOW_AFTER_MS)).toBe(30_000)
  })

  it('never stops polling: the slow phase keeps a delay', () => {
    expect(nextPollDelayMs(60 * 60_000)).toBe(30_000)
  })

  it('switches to the "taking longer" phase after 5 minutes, not to a failure', () => {
    expect(provisionPhase(0)).toBe('generating')
    expect(provisionPhase(PROVISION_SLOW_AFTER_MS - 1)).toBe('generating')
    expect(provisionPhase(PROVISION_SLOW_AFTER_MS)).toBe('slow')
  })

  it('formats the elapsed counter as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(9_999)).toBe('0:09')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(-5)).toBe('0:00')
  })
})
