import {
  backfillSchema,
  dataDeletionFormSchema,
  fieldMappingEntrySchema,
  formUpdateSchema,
  formsQuerySchema,
  graphLeadSchema,
  leadEventsQuerySchema,
  leadgenChangeValueSchema,
  pageAssignSchema,
  paginationQuerySchema,
  retrySchema,
  settingsSchema,
  submissionsQuerySchema,
  testLeadSchema,
  webhookPayloadSchema,
} from '../data/validators'

const UUID_A = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const UUID_B = '6a2b9c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const DAY_MS = 24 * 60 * 60 * 1000

describe('pageAssignSchema', () => {
  it('requires connectionId, metaPageId and organizationId', () => {
    expect(pageAssignSchema.safeParse({ connectionId: UUID_A, metaPageId: '123', organizationId: UUID_B }).success).toBe(true)
    expect(pageAssignSchema.safeParse({ metaPageId: '123', organizationId: UUID_B }).success).toBe(false)
    expect(pageAssignSchema.safeParse({ connectionId: UUID_A, metaPageId: '', organizationId: UUID_B }).success).toBe(false)
    expect(pageAssignSchema.safeParse({ connectionId: UUID_A, metaPageId: '1', organizationId: 'nope' }).success).toBe(false)
  })
})

describe('fieldMappingEntrySchema', () => {
  it.each([
    'person.firstName',
    'person.fullName',
    'person.primaryEmail',
    'person.city',
    'company.displayName',
    'company.domain',
    'person.cf:budget',
    'company.cf:industry-1_x',
    'note',
    'consent',
    'ignore',
  ])('accepts target %s', (target) => {
    expect(fieldMappingEntrySchema.safeParse({ questionKey: 'q', target }).success).toBe(true)
  })

  it.each(['person.unknown', 'company.firstName', 'person.cf:', 'person.cf:bad key', 'notes', 'person.cf:' + 'a'.repeat(101), ''])(
    'rejects target %s',
    (target) => {
      expect(fieldMappingEntrySchema.safeParse({ questionKey: 'q', target }).success).toBe(false)
    },
  )

  it('requires a non-empty questionKey', () => {
    expect(fieldMappingEntrySchema.safeParse({ questionKey: '', target: 'note' }).success).toBe(false)
  })
})

describe('formUpdateSchema', () => {
  const base = { id: UUID_A, ownerMode: 'none' as const }

  it('accepts a minimal update', () => {
    expect(formUpdateSchema.safeParse(base).success).toBe(true)
  })

  it('requires pipelineId and pipelineStageId when createDeal is true', () => {
    expect(formUpdateSchema.safeParse({ ...base, createDeal: true }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, createDeal: true, pipelineId: UUID_B }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, createDeal: true, pipelineId: UUID_B, pipelineStageId: null }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, createDeal: true, pipelineId: UUID_B, pipelineStageId: UUID_A }).success).toBe(true)
    expect(formUpdateSchema.safeParse({ ...base, createDeal: false }).success).toBe(true)
  })

  it('requires ownerUserId for fixed owner mode', () => {
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'fixed' }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'fixed', ownerUserId: null }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'fixed', ownerUserId: UUID_B }).success).toBe(true)
  })

  it('requires at least one user for round_robin owner mode', () => {
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'round_robin' }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'round_robin', ownerUserIds: [] }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'round_robin', ownerUserIds: [UUID_B] }).success).toBe(true)
  })

  it('rejects an unknown ownerMode and a missing ownerMode', () => {
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'random' }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ id: UUID_A }).success).toBe(false)
  })

  it('caps fieldMapping at 200 and ownerUserIds at 50', () => {
    const entry = { questionKey: 'q', target: 'note' }
    expect(formUpdateSchema.safeParse({ ...base, fieldMapping: Array(200).fill(entry) }).success).toBe(true)
    expect(formUpdateSchema.safeParse({ ...base, fieldMapping: Array(201).fill(entry) }).success).toBe(false)
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'round_robin', ownerUserIds: Array(50).fill(UUID_A) }).success).toBe(true)
    expect(formUpdateSchema.safeParse({ ...base, ownerMode: 'round_robin', ownerUserIds: Array(51).fill(UUID_A) }).success).toBe(false)
  })

  it('validates mapping targets inside fieldMapping', () => {
    expect(formUpdateSchema.safeParse({ ...base, fieldMapping: [{ questionKey: 'q', target: 'bogus' }] }).success).toBe(false)
  })
})

describe('settingsSchema', () => {
  it('accepts valid settings', () => {
    expect(settingsSchema.safeParse({ retentionDays: 1, defaultCountry: 'PL' }).success).toBe(true)
    expect(settingsSchema.safeParse({ retentionDays: 365, defaultCountry: 'DE' }).success).toBe(true)
  })

  it('rejects out-of-range or non-integer retentionDays', () => {
    expect(settingsSchema.safeParse({ retentionDays: 0, defaultCountry: 'PL' }).success).toBe(false)
    expect(settingsSchema.safeParse({ retentionDays: 366, defaultCountry: 'PL' }).success).toBe(false)
    expect(settingsSchema.safeParse({ retentionDays: 1.5, defaultCountry: 'PL' }).success).toBe(false)
  })

  it('rejects a malformed defaultCountry', () => {
    expect(settingsSchema.safeParse({ retentionDays: 30, defaultCountry: 'pl' }).success).toBe(false)
    expect(settingsSchema.safeParse({ retentionDays: 30, defaultCountry: 'POL' }).success).toBe(false)
    expect(settingsSchema.safeParse({ retentionDays: 30, defaultCountry: '' }).success).toBe(false)
  })
})

describe('backfillSchema', () => {
  const iso = (ms: number) => new Date(ms).toISOString()

  it('accepts a valid range in the past', () => {
    const to = Date.now() - DAY_MS
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(to - 10 * DAY_MS), to: iso(to) }).success).toBe(true)
  })

  it('rejects from >= to', () => {
    const at = Date.now() - DAY_MS
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(at), to: iso(at) }).success).toBe(false)
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(at), to: iso(at - DAY_MS) }).success).toBe(false)
  })

  it('rejects ranges longer than 90 days and accepts exactly 90', () => {
    const to = Date.now() - DAY_MS
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(to - 90 * DAY_MS), to: iso(to) }).success).toBe(true)
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(to - 90 * DAY_MS - 1000), to: iso(to) }).success).toBe(false)
  })

  it('rejects a to in the future beyond 60 seconds and tolerates a small skew', () => {
    const now = Date.now()
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(now - DAY_MS), to: iso(now + 5 * 60 * 1000) }).success).toBe(false)
    expect(backfillSchema.safeParse({ formId: UUID_A, from: iso(now - DAY_MS), to: iso(now + 10 * 1000) }).success).toBe(true)
  })

  it('rejects non-datetime strings and a bad formId', () => {
    expect(backfillSchema.safeParse({ formId: UUID_A, from: 'yesterday', to: 'today' }).success).toBe(false)
    expect(backfillSchema.safeParse({ formId: 'x', from: iso(Date.now() - DAY_MS), to: iso(Date.now()) }).success).toBe(false)
  })
})

describe('retrySchema', () => {
  it('requires 1..100 uuids', () => {
    expect(retrySchema.safeParse({ ids: [UUID_A] }).success).toBe(true)
    expect(retrySchema.safeParse({ ids: Array(100).fill(UUID_A) }).success).toBe(true)
    expect(retrySchema.safeParse({ ids: [] }).success).toBe(false)
    expect(retrySchema.safeParse({ ids: Array(101).fill(UUID_A) }).success).toBe(false)
    expect(retrySchema.safeParse({ ids: ['nope'] }).success).toBe(false)
  })
})

describe('paginationQuerySchema', () => {
  it('applies defaults and coerces strings', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 })
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '100' })).toEqual({ page: 3, pageSize: 100 })
  })

  it('rejects pageSize above 100 and invalid pages', () => {
    expect(paginationQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
    expect(paginationQuerySchema.safeParse({ pageSize: '0' }).success).toBe(false)
    expect(paginationQuerySchema.safeParse({ page: '0' }).success).toBe(false)
  })
})

describe('leadEventsQuerySchema', () => {
  it('parses a comma list of statuses', () => {
    const parsed = leadEventsQuerySchema.parse({ status: 'failed,dead_lettered' })
    expect(parsed.status).toEqual(['failed', 'dead_lettered'])
    expect(parsed.sortDir).toBe('desc')
  })

  it('rejects unknown statuses and an empty list', () => {
    expect(leadEventsQuerySchema.safeParse({ status: 'failed,bogus' }).success).toBe(false)
    expect(leadEventsQuerySchema.safeParse({ status: '' }).success).toBe(false)
  })

  it('rejects pageSize above 100', () => {
    expect(leadEventsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
  })

  it('validates source and filters', () => {
    expect(leadEventsQuerySchema.safeParse({ source: 'test', pageId: UUID_A }).success).toBe(true)
    expect(leadEventsQuerySchema.safeParse({ source: 'other' }).success).toBe(false)
  })
})

describe('formsQuerySchema', () => {
  it('parses boolean tokens', () => {
    expect(formsQuerySchema.parse({ isEnabled: 'true', needsAttention: '0' })).toMatchObject({ isEnabled: true, needsAttention: false })
    expect(formsQuerySchema.safeParse({ isEnabled: 'maybe' }).success).toBe(false)
  })
})

describe('submissionsQuerySchema', () => {
  it('defaults limit to 50 and caps at 100', () => {
    expect(submissionsQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(submissionsQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(submissionsQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
  })
})

describe('webhookPayloadSchema', () => {
  const entry = { id: '1', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: '1' } }] }

  it('accepts page notifications and keeps unknown keys', () => {
    const parsed = webhookPayloadSchema.parse({ object: 'page', entry: [entry], extra: true })
    expect(parsed).toHaveProperty('extra', true)
  })

  it('keeps non-leadgen changes instead of rejecting them', () => {
    const parsed = webhookPayloadSchema.parse({
      object: 'page',
      entry: [{ id: '1', time: 1, changes: [{ field: 'feed', value: { anything: 1 } }] }],
    })
    expect(parsed.entry[0].changes[0].field).toBe('feed')
  })

  it('rejects other objects and empty or oversized entry arrays', () => {
    expect(webhookPayloadSchema.safeParse({ object: 'user', entry: [entry] }).success).toBe(false)
    expect(webhookPayloadSchema.safeParse({ object: 'page', entry: [] }).success).toBe(false)
    expect(webhookPayloadSchema.safeParse({ object: 'page', entry: Array(101).fill(entry) }).success).toBe(false)
  })
})

describe('leadgenChangeValueSchema', () => {
  const value = { leadgen_id: '1', page_id: '2', form_id: '3', created_time: 1700000000 }

  it('accepts a complete value with optional ad ids', () => {
    expect(leadgenChangeValueSchema.safeParse(value).success).toBe(true)
    expect(leadgenChangeValueSchema.safeParse({ ...value, ad_id: '4', adgroup_id: '5' }).success).toBe(true)
  })

  it('requires all identifiers and created_time', () => {
    for (const key of ['leadgen_id', 'page_id', 'form_id', 'created_time']) {
      const copy: Record<string, unknown> = { ...value }
      delete copy[key]
      expect(leadgenChangeValueSchema.safeParse(copy).success).toBe(false)
    }
  })

  it('rejects unknown keys', () => {
    expect(leadgenChangeValueSchema.safeParse({ ...value, surprise: 1 }).success).toBe(false)
  })
})

describe('graphLeadSchema', () => {
  const lead = { id: '1', created_time: '2026-11-01T10:00:00+0000', form_id: '9' }

  it('defaults field_data to an empty array and keeps unknown keys', () => {
    const parsed = graphLeadSchema.parse({ ...lead, custom: 'x' })
    expect(parsed.field_data).toEqual([])
    expect(parsed).toHaveProperty('custom', 'x')
  })

  it('normalizes unknown platform values to undefined and keeps fb and ig', () => {
    expect(graphLeadSchema.parse({ ...lead, platform: 'ig' }).platform).toBe('ig')
    expect(graphLeadSchema.parse({ ...lead, platform: 'fb' }).platform).toBe('fb')
    expect(graphLeadSchema.parse({ ...lead, platform: 'tiktok' }).platform).toBeUndefined()
    expect(graphLeadSchema.parse(lead).platform).toBeUndefined()
  })

  it('validates field_data entries', () => {
    expect(graphLeadSchema.safeParse({ ...lead, field_data: [{ name: 'email', values: ['a@b.c'] }] }).success).toBe(true)
    expect(graphLeadSchema.safeParse({ ...lead, field_data: [{ name: 'email', values: 'a@b.c' }] }).success).toBe(false)
  })

  it('requires id, created_time and form_id', () => {
    expect(graphLeadSchema.safeParse({ id: '1' }).success).toBe(false)
  })
})

describe('testLeadSchema and dataDeletionFormSchema', () => {
  it('accepts optional string answers only', () => {
    expect(testLeadSchema.safeParse({}).success).toBe(true)
    expect(testLeadSchema.safeParse({ answers: { email: 'a@b.c' } }).success).toBe(true)
    expect(testLeadSchema.safeParse({ answers: { email: 1 } }).success).toBe(false)
  })

  it('requires a signed_request', () => {
    expect(dataDeletionFormSchema.safeParse({ signed_request: 'a.b' }).success).toBe(true)
    expect(dataDeletionFormSchema.safeParse({ signed_request: '' }).success).toBe(false)
    expect(dataDeletionFormSchema.safeParse({}).success).toBe(false)
  })
})
