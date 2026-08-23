import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Routing capacity foundation.
 *
 * These two tables ship one phase ahead of the routing behaviour that owns
 * them, and that is deliberate. Phase 1 Connect can already hold hundreds of
 * assigned, active Cases; creating presence rows at the moment routing is
 * switched on would show every agent as empty and let the first evaluation
 * over-push them. So the storage is created early and backfilled early, and
 * routing later reads state that is already true.
 *
 * Two rules apply to everything here:
 *
 *   1. **No cross-module ORM relationship.** `user_id` is a logical link to
 *      `auth.user.id` and stays a plain column; this module never imports a
 *      Connect or auth entity.
 *   2. **Nothing here is live presence.** `status` is `offline` on every row
 *      this phase writes and is never inferred from Case ownership. Liveness
 *      arrives with Phase 3's authenticated heartbeat, not before.
 */

/**
 * `available`, `busy` and `away` are reserved for Phase 3 and are permitted by
 * the check constraint so enabling routing does not need a schema change. Phase
 * 2 only ever writes `offline`.
 */
export type ConnectAgentPresenceStatus = 'available' | 'busy' | 'away' | 'offline'

@Entity({ tableName: 'connect_agent_presences' })
@Unique({
  name: 'connect_agent_presences_scope_uq',
  properties: ['tenantId', 'organizationId', 'userId'],
})
@Index({
  name: 'connect_agent_presences_status_idx',
  properties: ['tenantId', 'organizationId', 'status'],
})
@Check({
  name: 'connect_agent_presences_status_chk',
  expression: `"status" in ('available', 'busy', 'away', 'offline')`,
})
@Check({
  name: 'connect_agent_presences_case_count_chk',
  expression: `"current_case_count" >= 0 and "current_case_count" <= 2147483647`,
})
export class ConnectAgentPresence {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'currentCaseCount'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Logical link to auth.user.id (no DB FK — cross-module). */
  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'status', type: 'text', default: 'offline' })
  status: ConnectAgentPresenceStatus = 'offline'

  /**
   * System-derived. Reconciliation writes the absolute recomputed value; it is
   * never incremented or decremented from an assignment side effect.
   */
  @Property({ name: 'current_case_count', type: 'int', default: 0 })
  currentCaseCount: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /**
   * Present from the start so the Phase 3 presence editor inherits optimistic
   * locking rather than having to add a version column to a populated table.
   */
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type ConnectRoutingCapacityCheckpointState =
  | 'pending'
  | 'completed'
  | 'dependency_unavailable'
  | 'failed'

/**
 * Per-organization evidence that reconciliation actually ran.
 *
 * Without it, an organization with no assigned Cases and an organization that
 * was never reconciled look identical — both have no presence rows — and the
 * Phase 3 activation gate would have to guess. The checkpoint advances on every
 * successful run including empty and no-op ones, so "reconciled and empty" is a
 * positive fact rather than an absence.
 */
@Entity({ tableName: 'connect_routing_capacity_checkpoints' })
@Unique({
  name: 'connect_routing_capacity_checkpoints_scope_uq',
  properties: ['tenantId', 'organizationId'],
})
@Check({
  name: 'connect_routing_capacity_checkpoints_state_chk',
  expression: `"state" in ('pending', 'completed', 'dependency_unavailable', 'failed')`,
})
@Check({
  name: 'connect_routing_capacity_checkpoints_generation_chk',
  expression: `"generation" >= 0`,
})
export class ConnectRoutingCapacityCheckpoint {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'state'
    | 'generation'
    | 'foundationVersion'
    | 'completedAt'
    | 'lastErrorCode'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'state', type: 'text', default: 'pending' })
  state: ConnectRoutingCapacityCheckpointState = 'pending'

  /** Only a successful completion sets this, and only to the current version. */
  @Property({ name: 'foundation_version', type: 'text', nullable: true })
  foundationVersion?: string | null

  /** Increments on every successful run, including empty and unchanged scopes. */
  @Property({ name: 'generation', type: 'bigint', default: 0 })
  generation: number = 0

  @Property({ name: 'last_attempt_at', type: Date })
  lastAttemptAt!: Date

  /** Written in the same transaction as the projection rows, never before. */
  @Property({ name: 'completed_at', type: Date, nullable: true })
  completedAt?: Date | null

  /** Bounded machine code. Never a raw exception message or a user identifier. */
  @Property({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
