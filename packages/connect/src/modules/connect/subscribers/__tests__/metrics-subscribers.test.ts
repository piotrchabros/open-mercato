import claimedHandler, { handleDisposed, metadata as claimedMeta } from '../metrics-inbound'
import attemptedHandler, { handleStatusChanged, metadata as attemptedMeta } from '../metrics-outbound'
import assignedHandler, { handleReopened, handleResolved } from '../metrics-case-lifecycle'
import projectionHandler from '../metrics-projection'

/**
 * The metrics subscribers are the only writers of operational facts, and they
 * are the boundary where an event's identifiers become a reporting row. What
 * matters most is what they REFUSE to record: an event without an organization,
 * a duration that runs backwards, and anything resembling message content.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

function base(extra: Record<string, unknown>): Record<string, unknown> {
  return { tenantId: TENANT, organizationId: ORGANIZATION, sourceEventId: 'evt-1', ...extra }
}

function createCtx() {
  const created: Array<Record<string, unknown>> = []
  const em = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      created.push(data)
      return { id: 'fact', ...data }
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
    fork: () => em,
  }
  return { ctx: { resolve: () => em }, created }
}

describe('metrics subscriber registration', () => {
  it('subscribes persistently, so an outage cannot silently lose a day', () => {
    expect(claimedMeta).toMatchObject({ event: 'connect.inbound.claimed', persistent: true })
    expect(attemptedMeta).toMatchObject({ event: 'connect.outbound.attempted', persistent: true })
  })
})

describe('inbound facts', () => {
  it('records a claim on the receipt cohort, not on today', async () => {
    const { ctx, created } = createCtx()
    await claimedHandler(
      base({ claimCohortUtcDate: '2026-08-20', claimedAt: '2026-08-20T23:50:00.000Z', channelId: 'c1' }),
      ctx as never,
    )
    expect(created[0]).toMatchObject({ factType: 'inbound_claimed', cohortUtcDate: '2026-08-20' })
  })

  it('records a dead letter against the ORIGINAL claim day', async () => {
    // Swept after midnight, but the day it belongs to is the day it arrived, or
    // that day's equation is permanently short by one.
    const { ctx, created } = createCtx()
    await handleDisposed(
      base({
        disposition: 'dead_lettered',
        claimCohortUtcDate: '2026-08-20',
        occurredAt: '2026-08-21T00:05:00.000Z',
      }),
      ctx as never,
    )
    expect(created[0]).toMatchObject({ factType: 'inbound_dead_lettered', cohortUtcDate: '2026-08-20' })
  })

  it('carries the applied suppression settings so history is not reinterpreted', async () => {
    const { ctx, created } = createCtx()
    await handleDisposed(
      base({
        disposition: 'suppressed',
        claimCohortUtcDate: '2026-08-20',
        senderHash: 'h1',
        appliedWindowMinutes: 60,
        appliedCountLimit: 3,
      }),
      ctx as never,
    )
    expect(created[0]).toMatchObject({ senderHash: 'h1', appliedWindowMinutes: 60, appliedCountLimit: 3 })
  })

  it('records nothing for an unmapped disposition', async () => {
    const { ctx, created } = createCtx()
    await handleDisposed(base({ disposition: 'invented', claimCohortUtcDate: '2026-08-20' }), ctx as never)
    expect(created).toHaveLength(0)
  })

  it('records nothing for an event with no organization', async () => {
    const { ctx, created } = createCtx()
    await claimedHandler(
      { tenantId: TENANT, sourceEventId: 'evt-1', claimCohortUtcDate: '2026-08-20', claimedAt: '2026-08-20T10:00:00.000Z' },
      ctx as never,
    )
    expect(created).toHaveLength(0)
  })
})

describe('outbound facts', () => {
  it('cohorts an attempt by its enqueue day', async () => {
    const { ctx, created } = createCtx()
    await attemptedHandler(
      base({ enqueueCohortUtcDate: '2026-08-20', occurredAt: '2026-08-20T10:00:00.000Z', attemptId: 'a1' }),
      ctx as never,
    )
    expect(created[0]).toMatchObject({ factType: 'outbound_attempted', cohortUtcDate: '2026-08-20' })
  })

  it('settles a late outcome into the attempt enqueue cohort, not the outcome day', async () => {
    // Otherwise a day could show more outcomes than it had attempts.
    const { ctx, created } = createCtx()
    await handleStatusChanged(
      base({
        status: 'sent',
        attemptId: 'a1',
        enqueueCohortUtcDate: '2026-08-20',
        occurredAt: '2026-08-23T10:00:00.000Z',
      }),
      ctx as never,
    )
    expect(created[0]).toMatchObject({ factType: 'outbound_sent', cohortUtcDate: '2026-08-20' })
  })

  it('records the first-response duration on the RESPONSE day', async () => {
    const { ctx, created } = createCtx()
    await handleStatusChanged(
      base({
        status: 'sent',
        attemptId: 'a1',
        enqueueCohortUtcDate: '2026-08-20',
        occurredAt: '2026-08-20T12:00:00.000Z',
        firstInboundAt: '2026-08-20T11:00:00.000Z',
        firstConfirmedHumanOutboundAt: '2026-08-20T12:00:00.000Z',
      }),
      ctx as never,
    )
    const duration = created.find((fact) => fact.factType === 'first_response_seconds')
    expect(duration).toMatchObject({ value: 3600, cohortUtcDate: '2026-08-20' })
  })

  it('records no duration on a later attempt for the same case', async () => {
    // The source stamps the first confirmed send exactly once, so a
    // replied-then-replied-again Case enters the percentile cohort only once.
    const { ctx, created } = createCtx()
    await handleStatusChanged(
      base({
        status: 'sent',
        attemptId: 'a2',
        enqueueCohortUtcDate: '2026-08-20',
        firstInboundAt: '2026-08-20T11:00:00.000Z',
        firstConfirmedHumanOutboundAt: null,
      }),
      ctx as never,
    )
    expect(created.some((fact) => fact.factType === 'first_response_seconds')).toBe(false)
  })

  it('refuses a negative duration rather than poisoning the percentile', async () => {
    const { ctx, created } = createCtx()
    await handleStatusChanged(
      base({
        status: 'sent',
        attemptId: 'a1',
        firstInboundAt: '2026-08-20T12:00:00.000Z',
        firstConfirmedHumanOutboundAt: '2026-08-20T11:00:00.000Z',
      }),
      ctx as never,
    )
    expect(created.some((fact) => fact.factType === 'first_response_seconds')).toBe(false)
  })

  it('records an unknown outcome as its own bucket', async () => {
    const { ctx, created } = createCtx()
    await handleStatusChanged(base({ status: 'unknown', attemptId: 'a1' }), ctx as never)
    expect(created[0]).toMatchObject({ factType: 'outbound_unknown' })
  })
})

describe('case lifecycle facts', () => {
  it('counts a real pickup', async () => {
    const { ctx, created } = createCtx()
    await assignedHandler(base({ caseId: 'case-1', toAssigneeUserId: 'user-1' }), ctx as never)
    expect(created[0]).toMatchObject({ factType: 'case_assigned' })
  })

  it('does not count an unassignment as a pickup', async () => {
    const { ctx, created } = createCtx()
    await assignedHandler(base({ caseId: 'case-1', toAssigneeUserId: null }), ctx as never)
    expect(created).toHaveLength(0)
  })

  it('measures elapsed time from the FIRST assignment carried on the event', async () => {
    const { ctx, created } = createCtx()
    await handleResolved(
      base({
        caseId: 'case-1',
        firstAssignedAt: '2026-08-20T10:00:00.000Z',
        resolvedAt: '2026-08-20T12:00:00.000Z',
        occurredAt: '2026-08-20T12:00:00.000Z',
      }),
      ctx as never,
    )
    const elapsed = created.find((fact) => fact.factType === 'elapsed_assigned_to_resolution_seconds')
    expect(elapsed).toMatchObject({ value: 7200 })
  })

  it('records no elapsed time for a case that was never assigned', async () => {
    // Zero would put an unearned best case into the percentile.
    const { ctx, created } = createCtx()
    await handleResolved(base({ caseId: 'case-1', resolvedAt: '2026-08-20T12:00:00.000Z' }), ctx as never)
    expect(created.some((fact) => fact.factType === 'elapsed_assigned_to_resolution_seconds')).toBe(false)
    expect(created.some((fact) => fact.factType === 'case_resolved')).toBe(true)
  })

  it('counts a reopen', async () => {
    const { ctx, created } = createCtx()
    await handleReopened(base({ caseId: 'case-1', occurredAt: '2026-08-21T09:00:00.000Z' }), ctx as never)
    expect(created[0]).toMatchObject({ factType: 'case_reopened', cohortUtcDate: '2026-08-21' })
  })
})

describe('projection facts', () => {
  it('measures lag from staging to completion', async () => {
    const { ctx, created } = createCtx()
    await projectionHandler(
      base({
        caseId: 'case-1',
        projectionKey: 'case:case-1:v1',
        toStatus: 'projected',
        stagedAt: '2026-08-20T10:00:00.000Z',
        completedAt: '2026-08-20T10:00:05.000Z',
      }),
      ctx as never,
    )
    expect(created[0]).toMatchObject({ factType: 'projection_lag_ms', value: 5000 })
  })

  it('records a failure without a lag sample', async () => {
    const { ctx, created } = createCtx()
    await projectionHandler(
      base({ caseId: 'case-1', projectionKey: 'case:case-1:v1', toStatus: 'failed' }),
      ctx as never,
    )
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ factType: 'projection_failed' })
  })

  it('records nothing for a link/unlink transition that carries no timings', async () => {
    // Those events exist for the projection module's own bookkeeping; treating
    // them as lag samples would report a lag of zero for work never done.
    const { ctx, created } = createCtx()
    await projectionHandler(base({ identityId: 'i1', toStatus: 'unresolved' }), ctx as never)
    expect(created).toHaveLength(0)
  })
})
