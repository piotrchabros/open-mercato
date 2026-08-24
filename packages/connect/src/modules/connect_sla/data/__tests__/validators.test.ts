import {
  businessCalendarCreateSchema,
  businessCalendarListQuerySchema,
  businessCalendarPublishSchema,
  caseClockListQuerySchema,
  clockEventPayloadSchema,
  isValidIanaTimezone,
  policyPublishSchema,
  policyListQuerySchema,
  rebuildClocksSchema,
} from '../validators'

const ID = '33333333-3333-4333-8333-333333333333'

describe('connect SLA validators', () => {
  it('normalizes calendar names and rejects unknown scope fields', () => {
    expect(businessCalendarCreateSchema.parse({ name: '  Support  ' }).name).toBe('Support')
    expect(businessCalendarCreateSchema.safeParse({ name: 'Support', tenantId: ID }).success).toBe(false)
  })

  it('validates IANA timezones without accepting arbitrary labels', () => {
    expect(isValidIanaTimezone('Europe/Berlin')).toBe(true)
    expect(isValidIanaTimezone('Not/A_Zone')).toBe(false)
  })

  it('accepts overnight source windows and rejects empty windows', () => {
    const input = { id: ID, timezone: 'Europe/Berlin', windows: [{ weekday: 1, localStart: '22:00', localEnd: '06:00' }] }
    expect(businessCalendarPublishSchema.safeParse(input).success).toBe(true)
    expect(businessCalendarPublishSchema.safeParse({ ...input, windows: [{ weekday: 1, localStart: '09:00', localEnd: '09:00' }] }).success).toBe(false)
  })

  it('rejects duplicate holidays before publication', () => {
    const parsed = businessCalendarPublishSchema.safeParse({
      id: ID,
      timezone: 'UTC',
      windows: [{ weekday: 1, localStart: '09:00', localEnd: '17:00' }],
      holidays: [{ localDate: '2026-12-25' }, { localDate: '2026-12-25', label: 'Christmas' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('requires positive targets and warnings below their targets', () => {
    const base = {
      id: ID,
      responseTargetMinutes: 60,
      resolutionTargetMinutes: 480,
      responseWarningMinutes: 15,
      resolutionWarningMinutes: 60,
      calendarVersionId: ID,
      effectiveFrom: '2026-08-24T00:00:00.000Z',
    }
    expect(policyPublishSchema.safeParse(base).success).toBe(true)
    expect(policyPublishSchema.safeParse({ ...base, responseTargetMinutes: 0 }).success).toBe(false)
    expect(policyPublishSchema.safeParse({ ...base, responseWarningMinutes: 60 }).success).toBe(false)
  })

  it('pins the exact version-one clock event payload', () => {
    const payload = {
      schemaVersion: 1,
      clockId: ID,
      caseId: ID,
      generation: 0,
      responseState: 'open',
      resolutionState: 'open',
      occurredAt: '2026-08-24T00:00:00.000Z',
      sourceEventId: 'evt-1',
    }
    expect(clockEventPayloadSchema.safeParse(payload).success).toBe(true)
    expect(clockEventPayloadSchema.safeParse({ ...payload, amount: 3 }).success).toBe(false)
    expect(clockEventPayloadSchema.safeParse({ ...payload, schemaVersion: 2 }).success).toBe(false)
  })

  it('caps clock lists at one hundred and validates rebuild idempotency keys', () => {
    expect(caseClockListQuerySchema.parse({}).pageSize).toBe(50)
    expect(caseClockListQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false)
    expect(rebuildClocksSchema.safeParse({ commandKey: 'rebuild-1', reason: 'Enable SLA' }).success).toBe(true)
    expect(rebuildClocksSchema.safeParse({ commandKey: ' ', reason: 'Enable SLA' }).success).toBe(false)
  })

  it('accepts DataTable page pagination for calendar and policy lists', () => {
    expect(businessCalendarListQuerySchema.parse({ page: '2', pageSize: '50' })).toMatchObject({ page: 2, pageSize: 50 })
    expect(policyListQuerySchema.parse({ page: '3', pageSize: '25' })).toMatchObject({ page: 3, pageSize: 25 })
    expect(businessCalendarListQuerySchema.safeParse({ cursor: 'unexpected' }).success).toBe(false)
  })
})
