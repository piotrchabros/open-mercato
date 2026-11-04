import handle, { metadata } from '../workers/retention-purge'
import { MetaLeadEvent, MetaSettings } from '../data/entities'

describe('retention-purge worker', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const organizationId = '22222222-2222-4222-8222-222222222222'

  function buildEm(retentionDays: number | null) {
    const forked: Record<string, jest.Mock> = {
      fork: jest.fn(() => forked),
      findOne: jest.fn().mockResolvedValue(retentionDays === null ? null : { id: 's', retentionDays, defaultCountry: 'PL' }),
      find: jest.fn().mockResolvedValue([]),
      nativeUpdate: jest.fn().mockResolvedValue(0),
    }
    return { fork: jest.fn(() => forked), forked }
  }

  function run(em: ReturnType<typeof buildEm>, payload: unknown) {
    return handle(
      { id: 'job', payload, createdAt: new Date().toISOString() } as never,
      { jobId: 'job', attemptNumber: 1, queueName: metadata.queue, resolve: () => em as never },
    )
  }

  it('declares the retention purge queue with concurrency 1', () => {
    expect(metadata).toEqual({
      queue: 'meta-lead-ads-retention-purge',
      id: 'meta_lead_ads:retention-purge',
      concurrency: 1,
    })
  })

  it('does nothing without a scope', async () => {
    const em = buildEm(30)
    await run(em, {})
    expect(em.fork).not.toHaveBeenCalled()
  })

  it('purges events older than the configured retention within scope, keeping hashes', async () => {
    const em = buildEm(7)
    const before = Date.now()
    await run(em, { scope: { tenantId, organizationId } })
    const settingsCall = em.forked.findOne.mock.calls.find(([entity]) => entity === MetaSettings)
    expect(settingsCall).toBeDefined()
    const [entity, filter] = em.forked.find.mock.calls[0]
    expect(entity).toBe(MetaLeadEvent)
    const [where] = filter.$and
    expect(where.tenantId).toBe(tenantId)
    expect(where.organizationId).toBe(organizationId)
    expect(where.payloadPurgedAt).toBeNull()
    const cutoff = (where.createdAt.$lt as Date).getTime()
    expect(cutoff).toBeLessThanOrEqual(before - 7 * 86_400_000 + 1000)
    expect(cutoff).toBeGreaterThan(before - 7 * 86_400_000 - 5000)
    expect(JSON.stringify(filter.$and[1])).not.toContain('emailHash')
  })

  it('falls back to the default retention when no settings row exists', async () => {
    const em = buildEm(null)
    await run(em, { tenantId, organizationId })
    const [, filter] = em.forked.find.mock.calls[0]
    const cutoff = filter.$and[0].createdAt.$lt as Date
    const ageDays = (Date.now() - cutoff.getTime()) / 86_400_000
    expect(Math.round(ageDays)).toBe(30)
  })
})
