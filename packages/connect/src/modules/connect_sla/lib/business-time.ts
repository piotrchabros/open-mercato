import { fromZonedTime, getTimezoneOffset } from 'date-fns-tz'

export type BusinessWindow = {
  weekday: number
  startSecond: number
  endSecond: number
}

export type BusinessCalendar = {
  timezone: string
  windows: readonly BusinessWindow[]
  holidays?: readonly string[]
}

type LocalDate = { year: number; month: number; day: number }
type Segment = { start: Date; end: Date }

const DAY_SECONDS = 86_400
const MAX_DATES = 3_660
const formatters = new Map<string, Intl.DateTimeFormat>()

export class CalendarExhaustedError extends Error {
  constructor() {
    super('calendar_exhausted')
    this.name = 'CalendarExhaustedError'
  }
}

export function validateTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${timezone}`)
  }
}

export function normalizeBusinessWindows(windows: readonly BusinessWindow[]): BusinessWindow[] {
  const pieces: BusinessWindow[] = []
  for (const window of windows) {
    if (!Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6) throw new RangeError('Invalid weekday')
    if (!Number.isInteger(window.startSecond) || !Number.isInteger(window.endSecond)) throw new RangeError('Window boundaries must be integer seconds')
    if (window.startSecond < 0 || window.startSecond >= DAY_SECONDS || window.endSecond < 0 || window.endSecond > DAY_SECONDS) throw new RangeError('Invalid window boundary')
    if (window.startSecond === window.endSecond) throw new RangeError('Empty window')
    if (window.endSecond > window.startSecond) pieces.push({ ...window })
    else {
      pieces.push({ weekday: window.weekday, startSecond: window.startSecond, endSecond: DAY_SECONDS })
      pieces.push({ weekday: (window.weekday + 1) % 7, startSecond: 0, endSecond: window.endSecond })
    }
  }
  pieces.sort((left, right) => left.weekday - right.weekday || left.startSecond - right.startSecond || left.endSecond - right.endSecond)
  const normalized: BusinessWindow[] = []
  for (const piece of pieces) {
    const previous = normalized.at(-1)
    if (previous?.weekday === piece.weekday && piece.startSecond < previous.endSecond) throw new RangeError('Overlapping business windows')
    if (previous?.weekday === piece.weekday && piece.startSecond === previous.endSecond) previous.endSecond = piece.endSecond
    else normalized.push({ ...piece })
  }
  if (normalized.length === 0) throw new RangeError('Business calendar must contain a window')
  return normalized
}

export function addBusinessSeconds(input: Date, seconds: number, calendar: BusinessCalendar): Date {
  validateInput(input, seconds, calendar)
  if (seconds === 0) return new Date(input)
  const windows = normalizeBusinessWindows(calendar.windows)
  let remaining = seconds
  let cursor = new Date(input)
  let localDate = localDateFor(cursor, calendar.timezone)
  for (let dates = 0; dates < MAX_DATES; dates += 1) {
    for (const segment of segmentsForDate(localDate, calendar, windows)) {
      const startMillis = Math.max(cursor.getTime(), segment.start.getTime())
      const available = Math.max(0, Math.floor((segment.end.getTime() - startMillis) / 1000))
      if (remaining <= available) return new Date(startMillis + remaining * 1000)
      remaining -= available
      cursor = segment.end
    }
    localDate = shiftLocalDate(localDate, 1)
    cursor = resolveBoundary(localDate, 0, calendar.timezone, 'start')
  }
  throw new CalendarExhaustedError()
}

export function measureBusinessSeconds(start: Date, end: Date, calendar: BusinessCalendar): number {
  validateTimeZone(calendar.timezone)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new RangeError('Invalid date')
  if (end.getTime() <= start.getTime()) return 0
  const windows = normalizeBusinessWindows(calendar.windows)
  let total = 0
  let localDate = localDateFor(start, calendar.timezone)
  for (let dates = 0; dates < MAX_DATES; dates += 1) {
    for (const segment of segmentsForDate(localDate, calendar, windows)) {
      const intersectionStart = Math.max(start.getTime(), segment.start.getTime())
      const intersectionEnd = Math.min(end.getTime(), segment.end.getTime())
      if (intersectionEnd > intersectionStart) total += Math.floor((intersectionEnd - intersectionStart) / 1000)
    }
    const next = shiftLocalDate(localDate, 1)
    if (resolveBoundary(next, 0, calendar.timezone, 'start').getTime() >= end.getTime()) return total
    localDate = next
  }
  throw new CalendarExhaustedError()
}

export const businessSecondsBetween = measureBusinessSeconds

function validateInput(input: Date, seconds: number, calendar: BusinessCalendar): void {
  validateTimeZone(calendar.timezone)
  if (!Number.isFinite(input.getTime())) throw new RangeError('Invalid date')
  if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError('Business seconds must be a nonnegative integer')
}

function segmentsForDate(date: LocalDate, calendar: BusinessCalendar, windows: readonly BusinessWindow[]): Segment[] {
  if (new Set(calendar.holidays ?? []).has(dateKey(date))) return []
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  return windows.filter((window) => window.weekday === weekday).map((window) => ({
    start: resolveBoundary(date, window.startSecond, calendar.timezone, 'start'),
    end: resolveBoundary(date, window.endSecond, calendar.timezone, 'end'),
  }))
}

function resolveBoundary(date: LocalDate, second: number, timezone: string, kind: 'start' | 'end'): Date {
  const boundaryDate = second === DAY_SECONDS ? shiftLocalDate(date, 1) : date
  const boundarySecond = second === DAY_SECONDS ? 0 : second
  const hour = Math.floor(boundarySecond / 3600)
  const minute = Math.floor((boundarySecond % 3600) / 60)
  const seconds = boundarySecond % 60
  const localMillis = Date.UTC(boundaryDate.year, boundaryDate.month - 1, boundaryDate.day, hour, minute, seconds)
  const offsets = new Set<number>()
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) offsets.add(getTimezoneOffset(timezone, new Date(localMillis + deltaHours * 3_600_000)))
  const possibleInstants = [...offsets].map((offset) => new Date(localMillis - offset)).sort((left, right) => left.getTime() - right.getTime())
  const candidates = possibleInstants.filter((candidate) => localScalar(candidate, timezone) === localMillis)
  if (candidates.length > 0) return new Date(kind === 'start' ? candidates[0] : candidates[candidates.length - 1])
  const fallback = fromZonedTime(new Date(localMillis), timezone)
  const searchStart = Math.min(fallback.getTime(), ...possibleInstants.map((candidate) => candidate.getTime()))
  const searchEnd = Math.max(fallback.getTime(), ...possibleInstants.map((candidate) => candidate.getTime())) + 4 * 3_600_000
  for (let instant = searchStart; instant <= searchEnd; instant += 1000) {
    const candidate = new Date(instant)
    if (localScalar(candidate, timezone) >= localMillis) return candidate
  }
  throw new RangeError('Unable to resolve local time')
}

function localDateFor(date: Date, timezone: string): LocalDate {
  const parts = localParts(date, timezone)
  return { year: parts.year, month: parts.month, day: parts.day }
}

function localScalar(date: Date, timezone: string): number {
  const parts = localParts(date, timezone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function localParts(date: Date, timezone: string): LocalDate & { hour: number; minute: number; second: number } {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    formatters.set(timezone, formatter)
  }
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, Number(part.value)]))
  return { year: values.get('year') ?? 0, month: values.get('month') ?? 0, day: values.get('day') ?? 0, hour: values.get('hour') ?? 0, minute: values.get('minute') ?? 0, second: values.get('second') ?? 0 }
}

function shiftLocalDate(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

function dateKey(date: LocalDate): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`
}
