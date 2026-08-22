import { ConnectMetricDaily, ConnectOperationalFact } from '../../data/entities'
import handle, { CONNECT_METRICS_REBUILD_WINDOW_DAYS } from '../aggregate-metrics'

/**
 * The aggregate worker must be safe to run twice, aggressive about re-covering
 * old days, and loud when the reconciliation invariant fails. It is also the
 * only place that can decide a metrics number is wrong, so it must never
 * silently paper over one.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

type Options = {
  scopes?: Array<{ tenantId: string; organizationId: string }>
  facts?: Array<Record<string, unknown>>
  existing?: Record<string, unknown> | null
}

function createCtx(options: Options = {}) {
  const scopes = options.scopes ?? [{ tenantId: TENANT, organizationId: ORGANIZATION }]
  const created: Array<Record<string, unknown>> = []
  const executed: Array<{ sql: string; params: unknown[] }> = []
  const em = {
    execute: jest.fn(async (sql: string, params: unknown[]) => {
      executed.push({ sql, params })
      return scopes
    }),
    find: jest.fn(async (entity: unknown) =>
      entity === ConnectOperationalFact ? options.facts ?? [] : [],
    ),
    findOne: jest.fn(async (entity: unknown) =>
      entity === ConnectMetricDaily ? options.existing ?? null : null,
    ),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      const row = { ...data }
      created.push(row)
      return row
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
    fork: () => em,
  }
  const progress = {
    startJob: jest.fn(async () => ({})),
    incrementProgress: jest.fn(async () => ({})),
    completeJob: jest.fn(async () => ({})),
    failJob: jest.fn(async () => ({})),
    isCancellationRequested: jest.fn(async () => false),
  }
  const ctx = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'progressService') return progress
      throw new Error(`[internal] unexpected resolve: ${name}`)
    },
  }
  return { ctx, em, created, executed, progress }
}

function job(payload: Record<string, unknown> = {}) {
  return { id: 'job-1', payload, createdAt: '2026-08-23T00:00:00.000Z' } as never
}

describe('aggregate-metrics', () => {
  it('writes one aggregate row per scope per day in the range', async () => {
    const { ctx, created } = createCtx()
    await handle(job({ from: '2026-08-20', to: '2026-08-22' }), ctx as never)
    expect(created).toHaveLength(3)
    expect(created.map((row) => row.utcDate)).toEqual(['2026-08-20', '2026-08-21', '2026-08-22'])
  })

  it('re-covers a trailing window by default, so a late outcome still lands', async () => {
    const { ctx, created } = createCtx()
    await handle(job(), ctx as never)
    expect(created.length).toBe(CONNECT_METRICS_REBUILD_WINDOW_DAYS + 1)
  })

  it('discovers scopes from the facts rather than from an organization list', async () => {
    const { ctx, created } = createCtx({
      scopes: [
        { tenantId: TENANT, organizationId: ORGANIZATION },
        { tenantId: TENANT, organizationId: 'other-org' },
      ],
    })
    await handle(job({ from: '2026-08-22', to: '2026-08-22' }), ctx as never)
    expect(created.map((row) => row.organizationId).sort()).toEqual([ORGANIZATION, 'other-org'])
  })

  it('narrows to one organization when the job names it', async () => {
    // A rebuild must not be able to touch a sibling organization's aggregates.
    const { ctx, executed } = createCtx()
    await handle(
      job({ from: '2026-08-22', to: '2026-08-22', tenantId: TENANT, organizationId: ORGANIZATION }),
      ctx as never,
    )
    expect(executed[0]!.sql).toContain('"organization_id" = ?')
    expect(executed[0]!.params).toContain(ORGANIZATION)
  })

  it('updates the existing row rather than leaving a gap mid-rebuild', async () => {
    const existing = { utcDate: '2026-08-22', inboundClaimed: 99, stale: true }
    const { ctx, created } = createCtx({ existing })
    await handle(job({ from: '2026-08-22', to: '2026-08-22' }), ctx as never)
    expect(created).toHaveLength(0)
    expect(existing.inboundClaimed).toBe(0)
    // Clearing the flag is what tells the UI the numbers are current again.
    expect(existing.stale).toBe(false)
  })

  it('is idempotent: a second run produces the same totals', async () => {
    const facts = [
      { factType: 'inbound_claimed', occurredAt: new Date('2026-08-22T10:00:00.000Z') },
      { factType: 'inbound_opened', occurredAt: new Date('2026-08-22T10:00:01.000Z') },
    ]
    const first = createCtx({ facts })
    await handle(job({ from: '2026-08-22', to: '2026-08-22' }), first.ctx as never)
    const second = createCtx({ facts })
    await handle(job({ from: '2026-08-22', to: '2026-08-22' }), second.ctx as never)
    expect(second.created[0]!.inboundClaimed).toBe(first.created[0]!.inboundClaimed)
    expect(second.created[0]!.casesOpened).toBe(first.created[0]!.casesOpened)
  })

  it('does nothing for an inverted range', async () => {
    const { ctx, created } = createCtx()
    await handle(job({ from: '2026-08-23', to: '2026-08-20' }), ctx as never)
    expect(created).toHaveLength(0)
  })

  it('reports progress for an operator-triggered rebuild', async () => {
    const { ctx, progress } = createCtx()
    await handle(
      job({ from: '2026-08-20', to: '2026-08-22', tenantId: TENANT, organizationId: ORGANIZATION, operationId: 'op-1' }),
      ctx as never,
    )
    expect(progress.startJob).toHaveBeenCalledTimes(1)
    expect(progress.incrementProgress).toHaveBeenCalledTimes(3)
    expect(progress.completeJob).toHaveBeenCalledTimes(1)
  })

  it('stops on cancellation without touching the remaining days', async () => {
    const { ctx, created, progress } = createCtx()
    progress.isCancellationRequested.mockResolvedValue(true)
    await handle(
      job({ from: '2026-08-20', to: '2026-08-22', tenantId: TENANT, organizationId: ORGANIZATION, operationId: 'op-1' }),
      ctx as never,
    )
    expect(created).toHaveLength(0)
  })

  it('aggregates without progress reporting when no operation was requested', async () => {
    const { ctx, created, progress } = createCtx()
    await handle(job({ from: '2026-08-22', to: '2026-08-22' }), ctx as never)
    expect(created).toHaveLength(1)
    expect(progress.startJob).not.toHaveBeenCalled()
  })
})
