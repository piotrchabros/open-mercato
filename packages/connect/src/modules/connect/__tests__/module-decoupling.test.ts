import * as fs from 'node:fs'
import * as path from 'node:path'
import { createConnectCaseReparentingReader } from '../lib/case-reparenting-reader'
import { createConnectContactDenominatorReader } from '../lib/contact-denominator-reader'
import eventsConfig from '../events'

/**
 * Connect must not depend on the consumers of its lineage contract.
 *
 * The coupling is deliberately one-way: Connect publishes identifier-only
 * events and answers scoped read facades, and an optional consumer such as an
 * SLA module owns its own subscriber and resolves the facade with `tryResolve`.
 * The moment Connect imports or resolves such a consumer, a core Case
 * correction stops working whenever that module is absent — which is exactly
 * the dependency inversion this contract exists to prevent.
 *
 * These are package-local assertions over Connect's own source. They change no
 * platform code and need no reduced module registry.
 */

const MODULE_ROOT = path.resolve(__dirname, '..')

/** Module ids that consume the lineage contract and must never be depended on. */
const CONSUMER_MODULE_IDS = ['connect_sla', 'analytics']

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__integration__') continue
      collectSourceFiles(full, found)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full)
  }
  return found
}

const SOURCE_FILES = collectSourceFiles(MODULE_ROOT)

describe('Connect does not depend on lineage consumers', () => {
  it('finds Connect source to inspect', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(50)
  })

  it.each(CONSUMER_MODULE_IDS)('never imports %s', (moduleId) => {
    const offenders = SOURCE_FILES.filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return new RegExp(`from ['"][^'"]*${moduleId}[^'"]*['"]`).test(source)
    })
    expect(offenders.map((file) => path.relative(MODULE_ROOT, file))).toEqual([])
  })

  // A `resolve()` would throw when the consumer is absent; even `tryResolve`
  // would mean Connect knows a consumer exists. Neither belongs here.
  it.each(CONSUMER_MODULE_IDS)('never resolves a %s service from the container', (moduleId) => {
    const offenders = SOURCE_FILES.filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return new RegExp(`(resolve|tryResolve)\\s*(<[^>]*>)?\\s*\\(\\s*['"\`][^'"\`]*${moduleId}`).test(source)
    })
    expect(offenders.map((file) => path.relative(MODULE_ROOT, file))).toEqual([])
  })
})

describe('the outward read contracts stand alone', () => {
  const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }

  function emStub(rows: unknown[] = []) {
    const em = {
      fork: () => em,
      find: async () => rows,
      findOne: async () => null,
      execute: async () => rows,
    }
    return em
  }

  // A consumer reaching Connect through `tryResolve` gets a reader built from
  // the EntityManager alone. If either factory needed a peer service, the
  // reader would be unavailable exactly when a consumer is reconciling.
  it('builds the lineage reader from an EntityManager alone', async () => {
    const reader = createConnectCaseReparentingReader(emStub() as never)
    await expect(reader.getById(scope, 'missing-id')).resolves.toBeNull()
    await expect(reader.getCaseLineage(scope, 'missing-id')).resolves.toBeNull()
    await expect(reader.listAfter(scope, null, 10)).resolves.toEqual({ items: [], nextCursor: null })
  })

  it('builds the denominator reader from an EntityManager alone', async () => {
    const reader = createConnectContactDenominatorReader(emStub([{ roots: 0 }]) as never)
    await expect(
      reader.countCanonicalRoots({
        ...scope,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ contractVersion: 'connect.contact_root_created.v1', count: 0 })
  })

  it('projects the generation lineage a consumer needs for reconciliation', async () => {
    const snapshot = {
      schemaVersion: 1,
      id: 'case-source',
      status: 'in_progress',
      priority: 'normal',
      assigneeUserId: null,
      channelId: 'channel-1',
      firstInboundAt: null,
      lastInboundAt: null,
      firstAssignedAt: null,
      firstOutboundSentAt: null,
      resolvedAt: null,
      closedAt: null,
      previousCaseId: null,
      mergedIntoCaseId: null,
      splitFromCaseId: null,
      slaGeneration: 4,
      lineageVersion: 0,
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    const row = {
      id: 'reparenting-1',
      operation: 'split',
      sourceCaseId: 'case-source',
      destinationCaseId: 'case-child',
      reversesReparentingId: null,
      sourceBefore: snapshot,
      destinationBefore: null,
      sourcePostUpdatedAt: new Date('2026-08-24T00:01:00.000Z'),
      destinationPostUpdatedAt: new Date('2026-08-24T00:01:00.000Z'),
      occurredAt: new Date('2026-08-24T00:01:00.000Z'),
    }
    const em = {
      fork: () => em,
      findOne: async () => row,
      execute: async () => [{ reparenting_id: row.id, moved: 1 }],
    }

    const projection = await createConnectCaseReparentingReader(em as never).getById(scope, row.id)

    expect(projection).toMatchObject({
      sourceSlaGeneration: 4,
      destinationSlaGeneration: 4,
      sourceBefore: { slaGeneration: 4 },
      destinationBefore: null,
    })
  })

  // Both predicates, on every method. A facade that accepted a bare id would be
  // a cross-organization read primitive handed to third-party code.
  it('requires tenant and organization on every lineage read', async () => {
    const seen: Array<Record<string, unknown>> = []
    const em = {
      fork: () => em,
      find: async (_entity: unknown, where: Record<string, unknown>) => {
        seen.push(where)
        return []
      },
      findOne: async (_entity: unknown, where: Record<string, unknown>) => {
        seen.push(where)
        return null
      },
      execute: async () => [],
    }
    const reader = createConnectCaseReparentingReader(em as never)
    await reader.getById(scope, 'id-1')
    await reader.listAfter(scope, null, 10)
    await reader.getCaseLineage(scope, 'id-1')

    expect(seen.length).toBeGreaterThan(0)
    for (const where of seen) {
      expect(where).toMatchObject({ tenantId: 'tenant-1', organizationId: 'org-1' })
    }
  })

  it('caps the lineage page size so a consumer cannot request an unbounded read', async () => {
    const limits: Array<number | undefined> = []
    const em = {
      fork: () => em,
      find: async (_entity: unknown, _where: unknown, options?: { limit?: number }) => {
        limits.push(options?.limit)
        return []
      },
      findOne: async () => null,
      execute: async () => [],
    }
    const reader = createConnectCaseReparentingReader(em as never)
    await reader.listAfter(scope, null, 5_000)
    // limit is pageSize + 1, used to detect a further page.
    expect(limits[0]).toBe(101)
  })
})

describe('the lineage events stay identifier-only', () => {
  const REPARENT_EVENT_IDS = [
    'connect.case.split',
    'connect.case.merged',
    'connect.case.reparenting_undone',
  ]

  it('declares all three reparenting events', () => {
    const declared = eventsConfig.events.map((event) => event.id)
    for (const id of REPARENT_EVENT_IDS) expect(declared).toContain(id)
  })

  // A consumer must be able to act on a reparenting without querying Connect,
  // but never by receiving what the customer wrote. The payload the command
  // stages is asserted here through the shape it is built from.
  it('builds a payload of identifiers, enums, versions and timestamps only', () => {
    const source = fs.readFileSync(path.join(MODULE_ROOT, 'commands', 'reparent-case.ts'), 'utf8')
    const payloadBuilder = source.slice(
      source.indexOf('function buildEventPayload'),
      source.indexOf('async function finalizeReparenting'),
    )
    expect(payloadBuilder.length).toBeGreaterThan(200)
    for (const forbidden of ['subject', 'wrapUp', 'displayLabel', 'handle', 'reason', 'customerId', 'body']) {
      expect(payloadBuilder).not.toContain(forbidden)
    }
    // A count, not an inventory: a large merge must not put an unbounded id
    // array into persistent event storage.
    expect(payloadBuilder).toContain('movedConversationCount')
    expect(payloadBuilder).toContain('sourceSlaGeneration')
    expect(payloadBuilder).toContain('destinationSlaGeneration')
    expect(payloadBuilder).not.toContain('movedConversationIds')
  })
})
