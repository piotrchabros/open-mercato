import {
  formatDuration,
  formatReferrerHost,
  resolveInsightValueKey,
  toTimestamp,
} from '../lib/insights-format'

describe('insights-format', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_900_000)).toBe('1h 05m')
    expect(formatDuration(-5)).toBe('0s')
    expect(formatDuration(Number.NaN)).toBe('0s')
  })

  it('maps unknown dimension values to other', () => {
    expect(resolveInsightValueKey('device', 'Mobile')).toBe('mobile')
    expect(resolveInsightValueKey('browser', 'weirdo')).toBe('other')
    expect(resolveInsightValueKey('os', '')).toBe('other')
  })

  it('extracts referrer host', () => {
    expect(formatReferrerHost(null)).toBeNull()
    expect(formatReferrerHost('https://www.linkedin.com/feed')).toBe('linkedin.com')
    expect(formatReferrerHost('not a url')).toBe('not a url')
  })

  it('parses timestamps', () => {
    expect(toTimestamp(null)).toBeNull()
    expect(toTimestamp('garbage')).toBeNull()
    expect(toTimestamp('2026-01-01T00:00:00.000Z')).toBe(Date.UTC(2026, 0, 1))
  })
})
