import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import handleReconcileJob, { metadata as workerMetadata } from '../workers/reconcile-capacity'
import { reconcileCapacityPayloadSchema } from '../data/validators'
import {
  CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD,
  CONNECT_ROUTING_FOUNDATION_VERSION,
  type ConnectRoutingCapacityService,
} from '../lib/reconcile-capacity'
import {
  clearRoutingScope,
  deleteCases,
  insertCases,
  readCheckpoint,
  readPresence,
  readPresences,
  setPresenceStatus,
  updateCase,
  type CapacityScope,
} from './routing-capacity-sql'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

/**
 * Presence rows, checkpoints and Cases all carry tenant/organization as plain
 * scalar columns with no foreign key, so these specs use synthetic scopes rather
 * than provisioning real tenants. That is what makes the isolation assertions
 * meaningful: four scopes that share user IDs, none of which can see each other.
 */
const SUITE = `${Date.now().toString(16)}`.slice(-6).padStart(6, '0')

function scopeOf(tenant: number, organization: number): CapacityScope {
  // The final UUID group is exactly twelve hex digits: six of suite entropy, a
  // one-digit discriminator, three zeroes and a two-digit index.
  return {
    tenantId: `4e000000-0000-4000-8000-${SUITE}0000${String(tenant).padStart(2, '0')}`,
    organizationId: `4e000000-0000-4000-8000-${SUITE}1000${String(organization).padStart(2, '0')}`,
  }
}

const AGENT_A = '4e000000-0000-4000-8000-00000000a001'
const AGENT_B = '4e000000-0000-4000-8000-00000000a002'
const AGENT_C = '4e000000-0000-4000-8000-00000000a003'

type Harness = {
  em: EntityManager
  service: ConnectRoutingCapacityService
  dispose: () => Promise<void>
}

async function openHarness(): Promise<Harness> {
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  return {
    em: container.resolve<EntityManager>('em'),
    service: container.resolve<ConnectRoutingCapacityService>('connectRoutingCapacityService'),
    dispose: () => container.dispose(),
  }
}

/** The delivery envelope both queue strategies hand a worker. */
function jobOf(scope: CapacityScope): Parameters<typeof handleReconcileJob>[0] {
  return {
    id: `capacity-${scope.organizationId}`,
    payload: scope,
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}

function jobContextOf(attemptNumber: number, service: ConnectRoutingCapacityService) {
  return {
    jobId: 'capacity-reconcile',
    attemptNumber,
    queueName: workerMetadata.queue,
    resolve: <T = unknown>() => service as T,
  }
}

async function cleanup(em: EntityManager, scopes: CapacityScope[], caseIds: string[]): Promise<void> {
  await deleteCases(em, caseIds)
  for (const scope of scopes) await clearRoutingScope(em, scope)
}

test.describe('TC-CONNECT-ROUTING-CAPACITY: routing capacity foundation', () => {
  test('CAP-INT-001/002/012: exact counts per scope, offline rows, and no cross-scope leakage', async () => {
    const harness = await openHarness()
    const scopes = [scopeOf(1, 1), scopeOf(1, 2), scopeOf(2, 1)]
    const [primary, sibling, otherTenant] = scopes
    const caseIds: string[] = []
    try {
      for (const scope of scopes) await clearRoutingScope(harness.em, scope)

      // The same two user IDs hold work in all three scopes. If a grouped read
      // or a zeroing update ever lost a scope predicate, these numbers collide.
      caseIds.push(...await insertCases(harness.em, primary, [
        { assigneeUserId: AGENT_A, status: 'new' },
        { assigneeUserId: AGENT_A, status: 'in_progress' },
        { assigneeUserId: AGENT_A, status: 'waiting_customer' },
        { assigneeUserId: AGENT_A, status: 'resolved' },
        { assigneeUserId: AGENT_A, status: 'closed' },
        { assigneeUserId: AGENT_A, status: 'new', softDeleted: true },
        { assigneeUserId: AGENT_B, status: 'new' },
        { assigneeUserId: null, status: 'new' },
      ]))
      caseIds.push(...await insertCases(harness.em, sibling, [
        { assigneeUserId: AGENT_A, status: 'new' },
      ]))
      caseIds.push(...await insertCases(harness.em, otherTenant, [
        { assigneeUserId: AGENT_A, status: 'new' },
        { assigneeUserId: AGENT_A, status: 'in_progress' },
      ]))

      await expect(harness.service.reconcile(primary)).resolves.toMatchObject({
        outcome: 'reconciled',
        examined: 2,
        created: 2,
        zeroed: 0,
      })

      // Only the three active statuses count; resolved, closed, soft-deleted and
      // unassigned Cases never do. And nothing is ever inferred as live presence.
      await expect(readPresences(harness.em, primary)).resolves.toEqual([
        { userId: AGENT_A, status: 'offline', currentCaseCount: 3 },
        { userId: AGENT_B, status: 'offline', currentCaseCount: 1 },
      ])
      await expect(readPresences(harness.em, sibling)).resolves.toEqual([])
      await expect(readPresences(harness.em, otherTenant)).resolves.toEqual([])

      await harness.service.reconcile(sibling)
      await harness.service.reconcile(otherTenant)
      await expect(readPresence(harness.em, { ...sibling, userId: AGENT_A }))
        .resolves.toMatchObject({ currentCaseCount: 1 })
      await expect(readPresence(harness.em, { ...otherTenant, userId: AGENT_A }))
        .resolves.toMatchObject({ currentCaseCount: 2 })
      // The first scope is untouched by the two runs that followed it.
      await expect(readPresence(harness.em, { ...primary, userId: AGENT_A }))
        .resolves.toMatchObject({ currentCaseCount: 3 })
    } finally {
      await cleanup(harness.em, scopes, caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-003/011: reruns and redelivered jobs converge without duplicates', async () => {
    const harness = await openHarness()
    const scope = scopeOf(3, 1)
    const empty = scopeOf(3, 2)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)
      await clearRoutingScope(harness.em, empty)
      caseIds.push(...await insertCases(harness.em, scope, [{ assigneeUserId: AGENT_A, status: 'new' }]))

      await expect(harness.service.reconcile(scope)).resolves.toMatchObject({ created: 1, generation: 1 })
      // Rerunning setup and redelivering the worker job are the same operation.
      await expect(harness.service.reconcile(scope)).resolves.toMatchObject({
        created: 0,
        updated: 0,
        zeroed: 0,
        generation: 2,
      })
      await handleReconcileJob(jobOf(scope), jobContextOf(1, harness.service))

      // Three runs, one row: the unconditional unique scope key holds.
      await expect(readPresences(harness.em, scope)).resolves.toEqual([
        { userId: AGENT_A, status: 'offline', currentCaseCount: 1 },
      ])
      await expect(readCheckpoint(harness.em, scope)).resolves.toMatchObject({
        state: 'completed',
        foundationVersion: CONNECT_ROUTING_FOUNDATION_VERSION,
        generation: 3,
      })

      // An organization with no assigned Cases still gets positive evidence that
      // reconciliation ran — otherwise "empty" and "never ran" look identical.
      await expect(harness.service.reconcile(empty)).resolves.toMatchObject({ examined: 0, generation: 1 })
      await expect(readPresences(harness.em, empty)).resolves.toEqual([])
      await expect(readCheckpoint(harness.em, empty)).resolves.toMatchObject({
        state: 'completed',
        generation: 1,
      })
      await expect(harness.service.isCapacityReconciled(empty)).resolves.toBe(true)
    } finally {
      await cleanup(harness.em, [scope, empty], caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-004/012: transfer, resolve, reopen, close, soft-delete and unassign converge', async () => {
    const harness = await openHarness()
    const scope = scopeOf(4, 1)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)
      const seeded = await insertCases(harness.em, scope, [
        { assigneeUserId: AGENT_A, status: 'new' },
        { assigneeUserId: AGENT_A, status: 'in_progress' },
        { assigneeUserId: AGENT_A, status: 'new' },
        { assigneeUserId: AGENT_A, status: 'new' },
      ])
      caseIds.push(...seeded)

      await harness.service.reconcile(scope)
      await expect(readPresence(harness.em, { ...scope, userId: AGENT_A }))
        .resolves.toMatchObject({ currentCaseCount: 4 })

      // Phase 3 will own liveness; reconciliation must not trample it.
      await setPresenceStatus(harness.em, { ...scope, userId: AGENT_A, status: 'available' })

      await updateCase(harness.em, seeded[0], { assigneeUserId: AGENT_B })
      await updateCase(harness.em, seeded[1], { status: 'resolved' })
      await updateCase(harness.em, seeded[2], { softDeleted: true })
      await updateCase(harness.em, seeded[3], { assigneeUserId: null })

      // Only the transfer target still holds work, so the departed agent is
      // zeroed rather than updated — its row is a durable identity, not a
      // row that gets deleted and recreated.
      await expect(harness.service.reconcile(scope)).resolves.toMatchObject({
        outcome: 'reconciled',
        examined: 1,
        created: 1,
        updated: 0,
        zeroed: 1,
      })
      await expect(readPresences(harness.em, scope)).resolves.toEqual([
        // Both sides of the transfer converge, and the operator's status survives.
        { userId: AGENT_A, status: 'available', currentCaseCount: 0 },
        { userId: AGENT_B, status: 'offline', currentCaseCount: 1 },
      ])

      // Reopening restores workload without recreating the identity.
      await updateCase(harness.em, seeded[1], { status: 'in_progress' })
      await updateCase(harness.em, seeded[2], { softDeleted: false })
      await expect(harness.service.reconcile(scope)).resolves.toMatchObject({ updated: 1, zeroed: 0 })
      await expect(readPresence(harness.em, { ...scope, userId: AGENT_A }))
        .resolves.toEqual({ userId: AGENT_A, status: 'available', currentCaseCount: 2 })

      await updateCase(harness.em, seeded[1], { status: 'closed' })
      await updateCase(harness.em, seeded[2], { status: 'closed' })
      await expect(harness.service.reconcile(scope)).resolves.toMatchObject({ zeroed: 1 })
      await expect(readPresence(harness.em, { ...scope, userId: AGENT_A }))
        .resolves.toEqual({ userId: AGENT_A, status: 'available', currentCaseCount: 0 })
    } finally {
      await cleanup(harness.em, [scope], caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-005/006/014: a blocked scope fails retryably while a sibling proceeds', async () => {
    test.setTimeout(60_000)
    const harness = await openHarness()
    const blocked = scopeOf(5, 1)
    const sibling = scopeOf(5, 2)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, blocked)
      await clearRoutingScope(harness.em, sibling)
      caseIds.push(...await insertCases(harness.em, blocked, [{ assigneeUserId: AGENT_A, status: 'new' }]))
      caseIds.push(...await insertCases(harness.em, sibling, [{ assigneeUserId: AGENT_A, status: 'new' }]))

      await harness.service.reconcile(blocked)
      await expect(readCheckpoint(harness.em, blocked)).resolves.toMatchObject({ generation: 1 })

      // Hold the scope's advisory lock from another connection. The reconciler
      // must give up after its bounded wait rather than parking a connection.
      const blocker = harness.em.fork()
      await blocker.begin()
      await blocker.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        `connect-routing-capacity:${blocked.tenantId}:${blocked.organizationId}`,
      ])
      try {
        await expect(harness.service.reconcile(blocked)).rejects.toThrow()
        const checkpoint = await readCheckpoint(harness.em, blocked)
        expect(checkpoint).toMatchObject({ state: 'failed', lastErrorCode: 'scope_lock_timeout' })
        // Failing after the read and before the commit changes nothing, and the
        // evidence of the last good run survives so an operator sees both facts.
        expect(checkpoint?.generation).toBe(1)
        expect(checkpoint?.foundationVersion).toBe(CONNECT_ROUTING_FOUNDATION_VERSION)
        await expect(harness.service.isCapacityReconciled(blocked)).resolves.toBe(false)
        await expect(readPresence(harness.em, { ...blocked, userId: AGENT_A }))
          .resolves.toMatchObject({ currentCaseCount: 1 })

        // The lock key carries both UUIDs, so a sibling organization is not
        // serialized behind it.
        await expect(harness.service.reconcile(sibling)).resolves.toMatchObject({ outcome: 'reconciled' })
      } finally {
        await blocker.rollback()
      }

      // Retrying after the block clears converges without double counting.
      await expect(harness.service.reconcile(blocked)).resolves.toMatchObject({
        outcome: 'reconciled',
        created: 0,
        updated: 0,
        generation: 2,
      })
      await expect(harness.service.isCapacityReconciled(blocked)).resolves.toBe(true)
    } finally {
      await cleanup(harness.em, [blocked, sibling], caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-006: concurrent reconcilers for one scope serialize into one consistent result', async () => {
    const harness = await openHarness()
    const second = await openHarness()
    const scope = scopeOf(6, 1)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)
      caseIds.push(...await insertCases(harness.em, scope, [
        { assigneeUserId: AGENT_A, status: 'new' },
        { assigneeUserId: AGENT_B, status: 'in_progress' },
      ]))

      await Promise.all([harness.service.reconcile(scope), second.service.reconcile(scope)])

      // Two runs, two generations, and exactly one row per agent: the unique key
      // plus absolute values make a race unable to produce duplicates.
      await expect(readPresences(harness.em, scope)).resolves.toEqual([
        { userId: AGENT_A, status: 'offline', currentCaseCount: 1 },
        { userId: AGENT_B, status: 'offline', currentCaseCount: 1 },
      ])
      await expect(readCheckpoint(harness.em, scope)).resolves.toMatchObject({
        state: 'completed',
        generation: 2,
      })
    } finally {
      await cleanup(harness.em, [scope], caseIds)
      await second.dispose()
      await harness.dispose()
    }
  })

  test('CAP-INT-007: an absent Connect reader degrades explicitly and writes no zero rows', async () => {
    const harness = await openHarness()
    const scope = scopeOf(7, 1)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)
      caseIds.push(...await insertCases(harness.em, scope, [{ assigneeUserId: AGENT_A, status: 'new' }]))
      await harness.service.reconcile(scope)

      // Same service, same scope, but the peer contract is gone — exactly what a
      // deployment without the shared inbox installed looks like.
      const { createConnectRoutingCapacityService } = await import('../lib/reconcile-capacity')
      const degraded = createConnectRoutingCapacityService({
        em: harness.em,
        container: {
          resolve: <T>(): T => {
            throw new Error('[internal] connectCurrentCaseCountReader is not registered')
          },
          hasRegistration: () => false,
        },
      })

      await expect(degraded.reconcile(scope)).resolves.toEqual({
        outcome: 'dependency_unavailable',
        errorCode: 'connect_reader_unavailable',
      })
      // The pre-existing count must survive. Zeroing here would look reconciled
      // and would over-push the agent the moment routing turns on.
      await expect(readPresence(harness.em, { ...scope, userId: AGENT_A }))
        .resolves.toMatchObject({ currentCaseCount: 1 })
      const checkpoint = await readCheckpoint(harness.em, scope)
      expect(checkpoint).toMatchObject({
        state: 'dependency_unavailable',
        lastErrorCode: 'connect_reader_unavailable',
        generation: 1,
      })
      await expect(degraded.isCapacityReconciled(scope)).resolves.toBe(false)
    } finally {
      await cleanup(harness.em, [scope], caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-008/013/016: a large scope defers, falls back synchronously, and converts real aggregates', async () => {
    test.setTimeout(180_000)
    const harness = await openHarness()
    const scope = scopeOf(8, 1)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)
      const assignees = CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD + 1
      caseIds.push(...await insertCases(
        harness.em,
        scope,
        Array.from({ length: assignees }, (_unused, index) => ({
          assigneeUserId: `4e000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          status: 'new',
        })),
      ))

      // Above the foreground threshold setup hands the scope to the worker.
      const deferred: Array<{ examined: number }> = []
      await expect(harness.service.reconcile({
        ...scope,
        defer: async ({ examined }) => {
          deferred.push({ examined })
          return true
        },
      })).resolves.toEqual({ outcome: 'deferred', examined: assignees })
      expect(deferred).toEqual([{ examined: assignees }])
      await expect(readPresences(harness.em, scope)).resolves.toEqual([])
      await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(false)

      // With no queue to defer to, the same call must finish the work rather
      // than abandon the safety backfill.
      const startedAt = Date.now()
      await expect(harness.service.reconcile({ ...scope, defer: async () => false })).resolves.toMatchObject({
        outcome: 'reconciled',
        examined: assignees,
        created: assignees,
      })
      const elapsedMs = Date.now() - startedAt
      await expect(readPresences(harness.em, scope)).resolves.toHaveLength(assignees)
      await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(true)
      // Batched statements inside one transaction: comfortably inside the
      // benchmarked budget for 500 authoritative assignee rows.
      expect(elapsedMs).toBeLessThan(30_000)

      // A real `count(*)` arrives from the driver as a bigint string. Three
      // Cases on one agent proves the conversion end to end.
      const extra = await insertCases(harness.em, scope, [
        { assigneeUserId: AGENT_C, status: 'new' },
        { assigneeUserId: AGENT_C, status: 'in_progress' },
        { assigneeUserId: AGENT_C, status: 'waiting_customer' },
      ])
      caseIds.push(...extra)
      await harness.service.reconcile(scope)
      await expect(readPresence(harness.em, { ...scope, userId: AGENT_C }))
        .resolves.toEqual({ userId: AGENT_C, status: 'offline', currentCaseCount: 3 })
    } finally {
      await cleanup(harness.em, [scope], caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-009/015: the module stays decoupled and its worker contract is pinned', async () => {
    const harness = await openHarness()
    const scope = scopeOf(9, 1)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)
      caseIds.push(...await insertCases(harness.em, scope, [{ assigneeUserId: AGENT_A, status: 'new' }]))

      // The whole contract resolved by DI key out of the real bootstrapped
      // container. Routing imports no Connect entity and declares no `requires`;
      // the peer reader reaches it purely through the registration.
      expect(typeof harness.service.reconcile).toBe('function')
      expect(typeof harness.service.readCheckpoint).toBe('function')
      expect(typeof harness.service.isCapacityReconciled).toBe('function')

      expect(workerMetadata.queue).toBe('connect.routing_capacity.reconcile')
      expect(workerMetadata.id).toBe('connect-routing:reconcile-capacity')
      // Stays inside the queue package's 3–5 guidance and the worker DB
      // connection budget.
      expect(workerMetadata.concurrency).toBe(3)
      expect(workerMetadata.concurrency).toBeLessThanOrEqual(5)

      // Local hands the payload through in-process; async round-trips it through
      // JSON. Both must validate, and a redelivery on attempt 2 must be
      // indistinguishable from the first delivery.
      const job = jobOf(reconcileCapacityPayloadSchema.parse(scope))
      await handleReconcileJob(job, jobContextOf(1, harness.service))
      await handleReconcileJob(
        JSON.parse(JSON.stringify(job)) as Parameters<typeof handleReconcileJob>[0],
        jobContextOf(2, harness.service),
      )
      await expect(readPresences(harness.em, scope)).resolves.toEqual([
        { userId: AGENT_A, status: 'offline', currentCaseCount: 1 },
      ])
      await expect(readCheckpoint(harness.em, scope)).resolves.toMatchObject({ generation: 2 })
    } finally {
      await cleanup(harness.em, [scope], caseIds)
      await harness.dispose()
    }
  })

  test('CAP-INT-010: the activation gate fails closed until a fresh completion exists', async () => {
    const harness = await openHarness()
    const scope = scopeOf(10, 1)
    const caseIds: string[] = []
    try {
      await clearRoutingScope(harness.em, scope)

      // Nothing recorded at all must never read as "reconciled and empty".
      await expect(harness.service.readCheckpoint(scope)).resolves.toBeNull()
      await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(false)

      caseIds.push(...await insertCases(harness.em, scope, [{ assigneeUserId: AGENT_A, status: 'new' }]))
      await harness.service.reconcile(scope)
      await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(true)
      await expect(harness.service.readCheckpoint(scope)).resolves.toMatchObject({
        state: 'completed',
        foundationVersion: CONNECT_ROUTING_FOUNDATION_VERSION,
        generation: 1,
      })

      // A checkpoint written against an older foundation is stale, not valid.
      await harness.em.fork().execute(
        `update "connect_routing_capacity_checkpoints" set "foundation_version" = '2020-01-01-v0'
          where "tenant_id" = ? and "organization_id" = ?`,
        [scope.tenantId, scope.organizationId],
      )
      await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(false)

      for (const state of ['pending', 'failed', 'dependency_unavailable']) {
        await harness.em.fork().execute(
          `update "connect_routing_capacity_checkpoints"
              set "state" = ?, "foundation_version" = ?
            where "tenant_id" = ? and "organization_id" = ?`,
          [state, CONNECT_ROUTING_FOUNDATION_VERSION, scope.tenantId, scope.organizationId],
        )
        await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(false)
      }

      // Only a fresh, completed generation reopens the gate.
      await harness.service.reconcile(scope)
      await expect(harness.service.isCapacityReconciled(scope)).resolves.toBe(true)
    } finally {
      await cleanup(harness.em, [scope], caseIds)
      await harness.dispose()
    }
  })
})
