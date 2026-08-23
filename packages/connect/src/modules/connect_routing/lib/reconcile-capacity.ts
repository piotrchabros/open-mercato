import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ConnectRoutingCapacityCheckpointState } from '../data/entities'
import type { ReconcileCapacityPayload } from '../data/validators'

const logger = createLogger('connect_routing').child({ component: 'reconcile-capacity' })

/**
 * Stamped onto the checkpoint by a successful run and required by the Phase 3
 * activation gate. Bumping it invalidates every existing completion, which is
 * the intended way to force a re-backfill after the projection's meaning
 * changes.
 */
export const CONNECT_ROUTING_FOUNDATION_VERSION = '2026-08-22-v1'

/**
 * Measured in *authoritative assignee rows* — the grouped result length — not in
 * Cases and not in inferred mutations. At or below this, setup reconciles inline;
 * above it, setup hands the scope to the worker so tenant initialization is not
 * held open behind one large organization.
 */
export const CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD = 500

/** One transaction, bounded statements. Neither half of that is negotiable. */
export const CONNECT_ROUTING_UPSERT_BATCH_SIZE = 500

const CONNECT_CASE_COUNT_READER_KEY = 'connectCurrentCaseCountReader'

/** Postgres `lock_not_available`, which is what `lock_timeout` raises. */
const LOCK_TIMEOUT_SQLSTATE = '55P03'

/**
 * The consumer declares the peer contract it needs rather than importing it, so
 * `connect_routing` keeps a zero-dependency relationship with Connect: no entity
 * import, no ORM relation, no hard `requires`, and nothing to resolve at module
 * load time. Structural typing keeps the two in step.
 */
type ConnectCurrentCaseCountReaderLike = {
  listByAssignee(input: {
    tenantId: string
    organizationId: string
  }): Promise<Array<{ assigneeUserId: string; currentCaseCount: number }>>
}

type ContainerLike = {
  resolve: <T>(name: string) => T
  hasRegistration?: (name: string) => boolean
}

export type ConnectRoutingCapacityCheckpointView = {
  state: ConnectRoutingCapacityCheckpointState
  foundationVersion: string | null
  generation: number
  lastAttemptAt: Date
  completedAt: Date | null
  lastErrorCode: string | null
}

export type ReconcileCapacityResult =
  | {
      outcome: 'reconciled'
      examined: number
      created: number
      updated: number
      zeroed: number
      generation: number
    }
  | { outcome: 'dependency_unavailable'; errorCode: 'connect_reader_unavailable' }
  | { outcome: 'deferred'; examined: number }

/**
 * Returns true when the scope was successfully handed to background processing.
 * A false answer means the caller must finish the work itself — abandoning the
 * backfill because a queue is missing would leave exactly the zeroed capacity
 * this module exists to prevent.
 */
export type ReconcileCapacityDefer = (
  input: ReconcileCapacityPayload & { examined: number },
) => Promise<boolean>

export type ReconcileCapacityInput = ReconcileCapacityPayload & {
  defer?: ReconcileCapacityDefer
}

export type ConnectRoutingCapacityService = {
  reconcile(input: ReconcileCapacityInput): Promise<ReconcileCapacityResult>
  readCheckpoint(scope: ReconcileCapacityPayload): Promise<ConnectRoutingCapacityCheckpointView | null>
  isCapacityReconciled(scope: ReconcileCapacityPayload): Promise<boolean>
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

function isLockTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { code?: unknown; driverException?: { code?: unknown } }
  return record.code === LOCK_TIMEOUT_SQLSTATE || record.driverException?.code === LOCK_TIMEOUT_SQLSTATE
}

/** `generation` is a bigint, so the driver hands it back as a string. */
function parseGeneration(raw: unknown): number {
  const value = typeof raw === 'bigint' || typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('[internal] connect_routing_capacity_generation_out_of_range')
  }
  return value
}

function resolveReader(container: ContainerLike): ConnectCurrentCaseCountReaderLike | null {
  try {
    if (
      typeof container.hasRegistration === 'function' &&
      !container.hasRegistration(CONNECT_CASE_COUNT_READER_KEY)
    ) {
      return null
    }
    const reader = container.resolve<ConnectCurrentCaseCountReaderLike | undefined>(
      CONNECT_CASE_COUNT_READER_KEY,
    )
    return typeof reader?.listByAssignee === 'function' ? reader : null
  } catch {
    return null
  }
}

/**
 * Durably record that an attempt started, in its own committed transaction.
 *
 * This is the marker a later crash is diagnosed from: a scope stuck at `pending`
 * is visibly unfinished, which is what makes the Phase 3 gate fail closed rather
 * than reading an absent row as "nothing to do". It never touches the last
 * completed generation, version or timestamp.
 */
async function markAttempt(em: EntityManager, scope: ReconcileCapacityPayload): Promise<void> {
  await em.execute(
    `insert into "connect_routing_capacity_checkpoints"
       ("tenant_id", "organization_id", "state", "generation", "last_attempt_at", "last_error_code", "created_at", "updated_at")
     values (?, ?, 'pending', 0, now(), null, now(), now())
     on conflict ("tenant_id", "organization_id") do update
       set "state" = 'pending',
           "last_attempt_at" = now(),
           "last_error_code" = null,
           "updated_at" = now()`,
    [scope.tenantId, scope.organizationId],
  )
}

/**
 * Best-effort, and deliberately on a connection of its own: the projection
 * transaction has usually rolled back by the time this runs, so writing the
 * failure through it would roll the failure back too.
 */
async function recordFailure(
  em: EntityManager,
  scope: ReconcileCapacityPayload,
  state: Extract<ConnectRoutingCapacityCheckpointState, 'failed' | 'dependency_unavailable'>,
  errorCode: string,
): Promise<void> {
  try {
    await em.fork().execute(
      `update "connect_routing_capacity_checkpoints"
          set "state" = ?, "last_error_code" = ?, "updated_at" = now()
        where "tenant_id" = ? and "organization_id" = ?`,
      [state, errorCode, scope.tenantId, scope.organizationId],
    )
  } catch (err) {
    logger.warn('could not record the capacity reconciliation failure state', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      errorCode,
      err,
    })
  }
}

type ProjectionCounts = { created: number; updated: number; zeroed: number; generation: number }

async function project(
  em: EntityManager,
  scope: ReconcileCapacityPayload,
  counts: Array<{ assigneeUserId: string; currentCaseCount: number }>,
): Promise<ProjectionCounts> {
  return em.fork().transactional(async (transactionalEm) => {
    const tem = transactionalEm as EntityManager
    // Bound the wait before touching anything. Without this an operator retry
    // parked behind a stuck reconciler would hold a database connection open
    // indefinitely instead of failing retryably.
    await tem.execute(`set local lock_timeout = '5s'`)
    // The fixed prefix plus both canonical UUIDs makes the hash input specific to
    // this one scope, so sibling organizations never serialize against each other.
    // Only reconcilers take this lock; it does not claim to serialize assignment
    // writes, which is why Phase 3 must still recompute before its first offer.
    await tem.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `connect-routing-capacity:${scope.tenantId}:${scope.organizationId}`,
    ])

    const existingRows = await tem.execute<Array<{ userId: string; currentCaseCount: number }>>(
      `select "user_id" as "userId", "current_case_count" as "currentCaseCount"
         from "connect_agent_presences"
        where "tenant_id" = ? and "organization_id" = ?
        order by "user_id"
        for update`,
      [scope.tenantId, scope.organizationId],
    )
    const existing = new Map(existingRows.map((row) => [row.userId, Number(row.currentCaseCount)]))

    let created = 0
    let updated = 0
    for (const row of counts) {
      const previous = existing.get(row.assigneeUserId)
      if (previous === undefined) created += 1
      else if (previous !== row.currentCaseCount) updated += 1
    }

    for (const batch of chunk(counts, CONNECT_ROUTING_UPSERT_BATCH_SIZE)) {
      // `status` is written only on insert. The conflict branch deliberately
      // leaves every operator/live-state field alone: reconciliation owns the
      // derived count and nothing else.
      const tuples = batch.map(() => `(?, ?, ?, 'offline', ?, now(), now())`).join(', ')
      const params = batch.flatMap((row) => [
        scope.tenantId,
        scope.organizationId,
        row.assigneeUserId,
        row.currentCaseCount,
      ])
      await tem.execute(
        `insert into "connect_agent_presences"
           ("tenant_id", "organization_id", "user_id", "status", "current_case_count", "created_at", "updated_at")
         values ${tuples}
         on conflict ("tenant_id", "organization_id", "user_id") do update
           set "current_case_count" = excluded."current_case_count",
               "updated_at" = now()`,
        params,
      )
    }

    // A row whose agent no longer holds work keeps its identity and goes to zero.
    // Deleting and recreating it would make the unique key ambiguous and would
    // throw away presence state Phase 3 is expected to own.
    const authoritative = new Set(counts.map((row) => row.assigneeUserId))
    const toZero = existingRows
      .filter((row) => Number(row.currentCaseCount) !== 0 && !authoritative.has(row.userId))
      .map((row) => row.userId)
    for (const batch of chunk(toZero, CONNECT_ROUTING_UPSERT_BATCH_SIZE)) {
      const placeholders = batch.map(() => '?').join(', ')
      await tem.execute(
        `update "connect_agent_presences"
            set "current_case_count" = 0, "updated_at" = now()
          where "tenant_id" = ? and "organization_id" = ? and "user_id" in (${placeholders})`,
        [scope.tenantId, scope.organizationId, ...batch],
      )
    }

    // Committed with the projection rows, never before them. An empty or
    // unchanged organization advances here too — otherwise "reconciled and
    // empty" would be indistinguishable from "never reconciled".
    const advanced = await tem.execute<Array<{ generation: unknown }>>(
      `insert into "connect_routing_capacity_checkpoints"
         ("tenant_id", "organization_id", "state", "foundation_version", "generation",
          "last_attempt_at", "completed_at", "last_error_code", "created_at", "updated_at")
       values (?, ?, 'completed', ?, 1, now(), now(), null, now(), now())
       on conflict ("tenant_id", "organization_id") do update
         set "state" = 'completed',
             "foundation_version" = excluded."foundation_version",
             "generation" = "connect_routing_capacity_checkpoints"."generation" + 1,
             "completed_at" = now(),
             "last_error_code" = null,
             "updated_at" = now()
       returning "generation"`,
      [scope.tenantId, scope.organizationId, CONNECT_ROUTING_FOUNDATION_VERSION],
    )

    return {
      created,
      updated,
      zeroed: toZero.length,
      generation: parseGeneration(advanced[0]?.generation),
    }
  })
}

async function readCheckpoint(
  em: EntityManager,
  scope: ReconcileCapacityPayload,
): Promise<ConnectRoutingCapacityCheckpointView | null> {
  const rows = await em.fork().execute<
    Array<{
      state: ConnectRoutingCapacityCheckpointState
      foundationVersion: string | null
      generation: unknown
      lastAttemptAt: Date
      completedAt: Date | null
      lastErrorCode: string | null
    }>
  >(
    `select "state", "foundation_version" as "foundationVersion", "generation",
            "last_attempt_at" as "lastAttemptAt", "completed_at" as "completedAt",
            "last_error_code" as "lastErrorCode"
       from "connect_routing_capacity_checkpoints"
      where "tenant_id" = ? and "organization_id" = ?`,
    [scope.tenantId, scope.organizationId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    state: row.state,
    foundationVersion: row.foundationVersion ?? null,
    generation: parseGeneration(row.generation),
    lastAttemptAt: row.lastAttemptAt,
    completedAt: row.completedAt ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
  }
}

export function createConnectRoutingCapacityService(deps: {
  em: EntityManager
  container: ContainerLike
}): ConnectRoutingCapacityService {
  const { em, container } = deps

  return {
    async reconcile(input) {
      const scope: ReconcileCapacityPayload = {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
      }
      const startedAt = Date.now()
      await markAttempt(em.fork(), scope)

      const reader = resolveReader(container)
      if (!reader) {
        // An absent Connect is not "this organization has no assigned Cases".
        // Writing zeros here would look reconciled and would over-push every
        // agent the moment routing turns on, so nothing is written at all.
        await recordFailure(em, scope, 'dependency_unavailable', 'connect_reader_unavailable')
        logger.warn('connect case count reader unavailable; capacity was not reconciled', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          errorCode: 'connect_reader_unavailable',
        })
        return { outcome: 'dependency_unavailable', errorCode: 'connect_reader_unavailable' }
      }

      let counts: Array<{ assigneeUserId: string; currentCaseCount: number }>
      try {
        counts = await reader.listByAssignee(scope)
      } catch (err) {
        await recordFailure(em, scope, 'failed', 'connect_reader_failed')
        throw err
      }

      if (input.defer && counts.length > CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD) {
        if (await input.defer({ ...scope, examined: counts.length })) {
          logger.info('capacity reconciliation deferred to the routing worker', {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            examined: counts.length,
          })
          return { outcome: 'deferred', examined: counts.length }
        }
      }

      let projected: ProjectionCounts
      try {
        projected = await project(em, scope, counts)
      } catch (err) {
        const errorCode = isLockTimeout(err) ? 'scope_lock_timeout' : 'projection_failed'
        await recordFailure(em, scope, 'failed', errorCode)
        throw err
      }

      // Scope, volumes and outcome only. User IDs and Case IDs stay out of logs.
      logger.info('capacity reconciled', {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        durationMs: Date.now() - startedAt,
        examined: counts.length,
        created: projected.created,
        updated: projected.updated,
        zeroed: projected.zeroed,
        generation: projected.generation,
        outcome: 'reconciled',
      })
      return { outcome: 'reconciled', examined: counts.length, ...projected }
    },

    readCheckpoint(scope) {
      return readCheckpoint(em, scope)
    },

    // Deliberately not routed through `this.readCheckpoint`: the Phase 3 gate is
    // the one caller that must never fail open, and a destructured method whose
    // `this` was lost would throw rather than answer false.
    async isCapacityReconciled(scope) {
      const checkpoint = await readCheckpoint(em, scope)
      // Fails closed on every non-answer: missing, pending, failed,
      // dependency-unavailable and stale-version all mean "do not route yet".
      return (
        checkpoint !== null &&
        checkpoint.state === 'completed' &&
        checkpoint.foundationVersion === CONNECT_ROUTING_FOUNDATION_VERSION &&
        checkpoint.generation > 0 &&
        checkpoint.completedAt !== null
      )
    },
  }
}
