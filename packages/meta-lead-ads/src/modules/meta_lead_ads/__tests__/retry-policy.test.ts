import { decideRetry, resolveRetryDelays } from '../lib/retry-policy'

const DEFAULT_DELAYS = [60_000, 300_000, 900_000, 2_400_000]
const NOW = new Date('2026-11-01T10:00:00.000Z')

describe('decideRetry', () => {
  it.each([
    [0, 60_000],
    [1, 300_000],
    [2, 900_000],
    [3, 2_400_000],
  ])('schedules attempt after %i previous failures with delay %i ms', (previousAttemptCount, delayMs) => {
    const decision = decideRetry({ previousAttemptCount, now: NOW, delays: DEFAULT_DELAYS })
    expect(decision.kind).toBe('retry')
    if (decision.kind !== 'retry') return
    expect(decision.attemptCount).toBe(previousAttemptCount + 1)
    expect(decision.delayMs).toBe(delayMs)
    expect(decision.nextAttemptAt.getTime()).toBe(NOW.getTime() + delayMs)
  })

  it('dead-letters on the fifth transient failure', () => {
    expect(decideRetry({ previousAttemptCount: 4, now: NOW, delays: DEFAULT_DELAYS })).toEqual({
      kind: 'dead_letter',
      attemptCount: 5,
    })
  })

  it('requests the fetch-failed alert only on the third failure', () => {
    const flags = [0, 1, 2, 3].map((previousAttemptCount) => {
      const decision = decideRetry({ previousAttemptCount, now: NOW, delays: DEFAULT_DELAYS })
      return decision.kind === 'retry' ? decision.sendFetchFailedAlert : null
    })
    expect(flags).toEqual([false, false, true, false])
  })
})

describe('resolveRetryDelays', () => {
  it('returns the default schedule without an override', () => {
    expect(resolveRetryDelays({ env: { NODE_ENV: 'development' } })).toEqual(DEFAULT_DELAYS)
  })

  it('honours the env override outside production', () => {
    const env = { NODE_ENV: 'development', OM_META_LEAD_ADS_RETRY_DELAYS_MS: '10,20,30,40' }
    expect(resolveRetryDelays({ env })).toEqual([10, 20, 30, 40])
  })

  it('prefers the credentials value over the env value', () => {
    const env = { NODE_ENV: 'test', OM_META_LEAD_ADS_RETRY_DELAYS_MS: '10,20,30,40' }
    expect(resolveRetryDelays({ env, credentialsValue: '1,2,3,4' })).toEqual([1, 2, 3, 4])
  })

  it('ignores the override in production', () => {
    const env = { NODE_ENV: 'production', OM_META_LEAD_ADS_RETRY_DELAYS_MS: '10,20,30,40' }
    expect(resolveRetryDelays({ env, credentialsValue: '1,2,3,4' })).toEqual(DEFAULT_DELAYS)
  })

  it('honours the override in production when integration testing is enabled', () => {
    const env = {
      NODE_ENV: 'production',
      OM_INTEGRATION_TEST: 'true',
      OM_META_LEAD_ADS_RETRY_DELAYS_MS: '10,20,30,40',
    }
    expect(resolveRetryDelays({ env })).toEqual([10, 20, 30, 40])
  })

  it('falls back to defaults for malformed overrides', () => {
    const env = { NODE_ENV: 'development', OM_META_LEAD_ADS_RETRY_DELAYS_MS: 'abc,5' }
    expect(resolveRetryDelays({ env })).toEqual(DEFAULT_DELAYS)
  })
})
