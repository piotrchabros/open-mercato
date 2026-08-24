import {
  addBusinessSeconds,
  CalendarExhaustedError,
  measureBusinessSeconds,
  normalizeBusinessWindows,
  validateTimeZone,
  type BusinessCalendar,
} from '../business-time'

const weekday = (timezone = 'UTC'): BusinessCalendar => ({
  timezone,
  windows: [1, 2, 3, 4, 5].map((day) => ({ weekday: day, startSecond: 9 * 3600, endSecond: 17 * 3600 })),
})

describe('business time', () => {
  test('validates IANA zones and nonnegative integer seconds', () => {
    expect(() => validateTimeZone('Not/A_Zone')).toThrow(RangeError)
    expect(() => addBusinessSeconds(new Date(), -1, weekday())).toThrow(RangeError)
    expect(() => addBusinessSeconds(new Date(), 0.5, weekday())).toThrow(RangeError)
  })

  test('returns an equal copy for a zero target', () => {
    const start = new Date('2026-08-24T12:34:56.789Z')
    const result = addBusinessSeconds(start, 0, weekday())
    expect(result).toEqual(start)
    expect(result).not.toBe(start)
  })

  test('walks exact half-open boundaries, weekends, and leap day', () => {
    expect(addBusinessSeconds(new Date('2026-08-28T16:00:00Z'), 3600, weekday()).toISOString()).toBe('2026-08-28T17:00:00.000Z')
    expect(addBusinessSeconds(new Date('2026-08-28T17:00:00Z'), 1, weekday()).toISOString()).toBe('2026-08-31T09:00:01.000Z')
    const leapCalendar: BusinessCalendar = { timezone: 'UTC', windows: [{ weekday: 4, startSecond: 0, endSecond: 3600 }] }
    expect(addBusinessSeconds(new Date('2024-02-28T23:00:00Z'), 3600, leapCalendar).toISOString()).toBe('2024-02-29T01:00:00.000Z')
  })

  test('splits overnight windows, merges adjacency, and rejects overlap', () => {
    expect(normalizeBusinessWindows([
      { weekday: 1, startSecond: 22 * 3600, endSecond: 2 * 3600 },
      { weekday: 2, startSecond: 2 * 3600, endSecond: 3 * 3600 },
    ])).toEqual([
      { weekday: 1, startSecond: 22 * 3600, endSecond: 86_400 },
      { weekday: 2, startSecond: 0, endSecond: 3 * 3600 },
    ])
    expect(() => normalizeBusinessWindows([
      { weekday: 1, startSecond: 9 * 3600, endSecond: 12 * 3600 },
      { weekday: 1, startSecond: 11 * 3600, endSecond: 13 * 3600 },
    ])).toThrow('Overlapping')
  })

  test('removes an overnight fragment when its local start date is a holiday', () => {
    const calendar: BusinessCalendar = {
      timezone: 'UTC',
      windows: [{ weekday: 1, startSecond: 22 * 3600, endSecond: 2 * 3600 }],
      holidays: ['2026-08-25'],
    }
    expect(addBusinessSeconds(new Date('2026-08-24T23:00:00Z'), 7200, calendar).toISOString()).toBe('2026-08-31T23:00:00.000Z')
  })

  test('advances a boundary in a DST gap to the first valid instant', () => {
    const calendar: BusinessCalendar = { timezone: 'America/New_York', windows: [{ weekday: 0, startSecond: 2 * 3600 + 30 * 60, endSecond: 4 * 3600 }] }
    expect(addBusinessSeconds(new Date('2026-03-08T00:00:00Z'), 1, calendar).toISOString()).toBe('2026-03-08T07:00:01.000Z')
  })

  test('chooses the earlier fold instant for start and later instant for end', () => {
    const calendar: BusinessCalendar = { timezone: 'America/New_York', windows: [{ weekday: 0, startSecond: 1 * 3600 + 30 * 60, endSecond: 1 * 3600 + 45 * 60 }] }
    const start = new Date('2026-11-01T05:30:00Z')
    expect(addBusinessSeconds(start, 4500, calendar).toISOString()).toBe('2026-11-01T06:45:00.000Z')
    expect(measureBusinessSeconds(start, new Date('2026-11-01T06:45:00Z'), calendar)).toBe(4500)
  })

  test('handles non-hour offsets', () => {
    const calendar: BusinessCalendar = { timezone: 'Asia/Kathmandu', windows: [{ weekday: 1, startSecond: 9 * 3600, endSecond: 10 * 3600 }] }
    expect(addBusinessSeconds(new Date('2026-08-24T00:00:00Z'), 3600, calendar).toISOString()).toBe('2026-08-24T04:15:00.000Z')
  })

  test('measures only business time for pauses', () => {
    expect(measureBusinessSeconds(new Date('2026-08-28T16:00:00Z'), new Date('2026-08-31T10:00:00Z'), weekday())).toBe(7200)
  })

  test('is monotonic and add/measure round trips', () => {
    const calendar = weekday('Europe/Berlin')
    const start = new Date('2026-10-23T14:37:00Z')
    const targets = [1, 60, 3600, 28_800, 50_000]
    const results = targets.map((target) => addBusinessSeconds(start, target, calendar))
    expect(results.every((result, index) => index === 0 || result > results[index - 1])).toBe(true)
    for (let index = 0; index < targets.length; index += 1) expect(measureBusinessSeconds(start, results[index], calendar)).toBe(targets[index])
  })

  test('bounds calendars with no reachable weekday', () => {
    const calendar: BusinessCalendar = { timezone: 'UTC', windows: [{ weekday: 1, startSecond: 0, endSecond: 1 }], holidays: [] }
    const allDates = Array.from({ length: 3660 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index))
      return date.toISOString().slice(0, 10)
    })
    expect(() => addBusinessSeconds(new Date('2026-01-01T00:00:00Z'), 1, { ...calendar, holidays: allDates })).toThrow(CalendarExhaustedError)
  })
})
