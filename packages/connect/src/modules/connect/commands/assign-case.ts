import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectAssignmentAudit,
  ConnectCase,
  ConnectCaseTransition,
} from '../data/entities'
import { evaluateCaseAccess, type CaseActor } from '../lib/case-access'
import { stageDomainEvent } from '../lib/domain-outbox'
import { validateTransition } from '../lib/case-lifecycle'

/**
 * One command for self-claim, privileged assignment, transfer and unassign.
 *
 * Deliberately ONE command rather than a claim endpoint plus an assign
 * endpoint: they differ only in who the target is, and splitting them produced
 * the earlier design's gap where an agent could see unassigned Cases but had no
 * way to take one.
 *
 * The Case update and its audit row commit together, so an assignment can never
 * exist without a record of who made it.
 */

const assignSchema = z.object({
  caseId: z.string().uuid(),
  /** `null` unassigns. The caller's own id is a self-claim. */
  assigneeUserId: z.string().uuid().nullable(),
  actor: z.object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    features: z.array(z.string()),
  }),
  reason: z.string().max(500).optional(),
  /** Optimistic-lock token from the pane that submitted. */
  expectedUpdatedAt: z.string().optional(),
})

export type AssignCaseInput = z.infer<typeof assignSchema>

export type AssignCaseResult =
  | { status: 'assigned'; caseId: string; assigneeUserId: string | null; updatedAt: string }
  | { status: 'noop'; caseId: string; updatedAt: string }
  | { status: 'not_found' }
  | { status: 'forbidden'; reason: 'not_assignable' | 'already_owned' }
  | { status: 'invalid_target' }
  | { status: 'conflict'; currentUpdatedAt: string }

export const CONNECT_ASSIGN_CASE_COMMAND_ID = 'connect.cases.assign'

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

type UserRow = { id: string; tenantId?: string | null; deletedAt?: Date | null; isConfirmed?: boolean }

/**
 * The assignee must be a live user of this tenant who can actually see the
 * organization. Assigning to someone who cannot open the Case produces work
 * that silently belongs to nobody.
 */
async function isAssignableTarget(
  container: ContainerLike,
  em: EntityManager,
  targetUserId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<boolean> {
  const user = (await em.findOne('User' as never, { id: targetUserId } as never)) as UserRow | null
  if (!user || user.deletedAt || user.isConfirmed === false) return false
  if (user.tenantId && user.tenantId !== scope.tenantId) return false
  try {
    const rbac = container.resolve<RbacServiceLike>('rbacService')
    const acl = await rbac.loadAcl(targetUserId, scope)
    if (acl?.organizations != null && !acl.organizations.includes(scope.organizationId)) return false
    return true
  } catch {
    return false
  }
}

export async function assignCase(
  container: ContainerLike,
  rawInput: AssignCaseInput,
  now: Date = new Date(),
): Promise<AssignCaseResult> {
  const input = assignSchema.parse(rawInput)
  const actor: CaseActor = input.actor
  const rootEm = (container.resolve('em') as EntityManager).fork()

  const targetIsSelf = input.assigneeUserId === actor.userId
  if (input.assigneeUserId && !targetIsSelf) {
    const assignable = await isAssignableTarget(container, rootEm, input.assigneeUserId, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
    })
    // A sibling-organization, cross-tenant or unknown target is reported the
    // same way, so the API cannot be used to enumerate users.
    if (!assignable) return { status: 'invalid_target' }
  }

  return rootEm.transactional(async (tem) => {
    const em = tem as EntityManager
    const target = await em.findOne(
      ConnectCase,
      { id: input.caseId, tenantId: actor.tenantId, organizationId: actor.organizationId, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!target) return { status: 'not_found' }

    const access = evaluateCaseAccess(target, actor)
    if (!access.canRead) return { status: 'not_found' }

    // Optimistic locking: two agents racing to claim the same Case must not
    // both believe they won.
    if (input.expectedUpdatedAt) {
      const current = target.updatedAt.toISOString()
      if (new Date(input.expectedUpdatedAt).toISOString() !== current) {
        return { status: 'conflict', currentUpdatedAt: current }
      }
    }

    const previous = target.assigneeUserId ?? null
    if (previous === (input.assigneeUserId ?? null)) {
      return { status: 'noop', caseId: target.id, updatedAt: target.updatedAt.toISOString() }
    }

    if (input.assigneeUserId && targetIsSelf) {
      // A plain handler may only claim what nobody owns; taking a colleague's
      // Case requires the supervisory grant.
      if (previous !== null && !access.canAssign) {
        return { status: 'forbidden', reason: 'already_owned' }
      }
      if (previous === null && !access.canClaim) {
        return { status: 'forbidden', reason: 'not_assignable' }
      }
    } else if (!access.canAssign) {
      return { status: 'forbidden', reason: 'not_assignable' }
    }

    target.assigneeUserId = input.assigneeUserId ?? null
    // Stamped ONCE. Later transfers leave it alone, because the operator
    // question is "how long until someone owned this", and a reassignment three
    // hours in must not restart that clock.
    if (input.assigneeUserId && !target.firstAssignedAt) target.firstAssignedAt = now

    // Taking ownership of a brand-new Case starts work on it. Unassigning does
    // not move the status back — the work that was done still happened.
    const previousStatus = target.status
    if (input.assigneeUserId && validateTransition(previousStatus, 'in_progress').ok && previousStatus === 'new') {
      target.status = 'in_progress'
      em.persist(
        em.create(ConnectCaseTransition, {
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
          caseId: target.id,
          actorKind: 'user',
          actorUserId: actor.userId,
          fromStatus: previousStatus,
          toStatus: 'in_progress',
          payload: { trigger: 'assign' },
        }),
      )
    }

    em.persist(
      em.create(ConnectAssignmentAudit, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        caseId: target.id,
        actorUserId: actor.userId,
        fromAssigneeUserId: previous,
        toAssigneeUserId: input.assigneeUserId ?? null,
        reason: input.reason ?? null,
      }),
    )
    stageDomainEvent(em, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      sourceEventId: `connect.case.assigned:${target.id}:${now.getTime()}`,
      aggregateId: target.id,
      aggregateVersion: 1,
      eventType: 'connect.case.assigned',
      payload: {
        caseId: target.id,
        fromAssigneeUserId: previous,
        toAssigneeUserId: input.assigneeUserId ?? null,
        actorUserId: actor.userId,
        // Immutable: the first time anyone owned this Case. A later transfer
        // must not reset it, or "time to pick up" silently becomes zero.
        firstAssignedAt: target.firstAssignedAt?.toISOString() ?? null,
        occurredAt: now.toISOString(),
      },
    })

    await em.flush()
    return {
      status: 'assigned',
      caseId: target.id,
      assigneeUserId: target.assigneeUserId ?? null,
      updatedAt: target.updatedAt.toISOString(),
    }
  })
}
