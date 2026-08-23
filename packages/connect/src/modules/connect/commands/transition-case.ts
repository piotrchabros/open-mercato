import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase, ConnectCaseTransition, type ConnectCaseStatus } from '../data/entities'
import { evaluateCaseAccess, type CaseActor } from '../lib/case-access'
import { validateTransition } from '../lib/case-lifecycle'
import { stageDomainEvent } from '../lib/domain-outbox'

/**
 * The single writer for interactive lifecycle changes AND the auto-close sweep.
 *
 * Shared on purpose: if the sweep had its own path it would eventually drift
 * from the interactive rules — skipping a guard, or closing a Case an agent had
 * just reopened. One command means one set of guards, one audit shape and one
 * lock.
 */

export type ConnectTransitionAction = 'resolve' | 'close' | 'reopen'

const transitionSchema = z.object({
  caseId: z.string().uuid(),
  action: z.enum(['resolve', 'close', 'reopen']),
  actor: z.object({
    userId: z.string().uuid().nullable(),
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    features: z.array(z.string()),
    /**
     * `system:auto_close` is constructed ONLY by the scheduler from the
     * schedule's own tenant/organization. There is no request shape that can
     * produce it, so a browser caller cannot borrow the system principal.
     */
    kind: z.enum(['user', 'system:auto_close']).default('user'),
  }),
  /** Required for resolve — a wrap-up is what makes a resolution reviewable. */
  wrapUp: z.string().max(5000).optional(),
  reason: z.string().max(500).optional(),
  expectedUpdatedAt: z.string().optional(),
})

export type TransitionCaseInput = z.input<typeof transitionSchema>

export type TransitionCaseResult =
  | { status: 'transitioned'; caseId: string; from: ConnectCaseStatus; to: ConnectCaseStatus; updatedAt: string }
  | { status: 'noop'; caseId: string; updatedAt: string }
  | { status: 'not_found' }
  | { status: 'forbidden'; reason: 'not_owner' | 'requires_manage' }
  | { status: 'invalid_transition'; from: ConnectCaseStatus; to: ConnectCaseStatus; reason: string }
  | { status: 'wrap_up_required' }
  | { status: 'case_merged'; canonicalCaseId: string }
  | { status: 'conflict'; currentUpdatedAt: string }

export const CONNECT_TRANSITION_CASE_COMMAND_ID = 'connect.cases.transition'

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

const TARGET_STATUS: Record<ConnectTransitionAction, ConnectCaseStatus> = {
  resolve: 'resolved',
  close: 'closed',
  reopen: 'in_progress',
}

export async function transitionCase(
  container: ContainerLike,
  rawInput: TransitionCaseInput,
  now: Date = new Date(),
): Promise<TransitionCaseResult> {
  const input = transitionSchema.parse(rawInput)
  const actor: CaseActor = {
    userId: input.actor.userId ?? '00000000-0000-0000-0000-000000000000',
    tenantId: input.actor.tenantId,
    organizationId: input.actor.organizationId,
    features: input.actor.features,
  }
  const isSystem = input.actor.kind === 'system:auto_close'
  const rootEm = (container.resolve('em') as EntityManager).fork()

  return rootEm.transactional(async (tem) => {
    const em = tem as EntityManager
    const target = await em.findOne(
      ConnectCase,
      {
        id: input.caseId,
        tenantId: input.actor.tenantId,
        organizationId: input.actor.organizationId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!target) return { status: 'not_found' }

    if (!isSystem) {
      const access = evaluateCaseAccess(target, actor)
      if (!access.canRead) return { status: 'not_found' }
      // Closing is terminal — a later inbound opens a successor rather than
      // reviving this Case — so it is not a front-line judgement.
      if (input.action === 'close' && !access.canClose) {
        return { status: 'forbidden', reason: 'requires_manage' }
      }
      if (input.action !== 'close' && !access.canAct) {
        return { status: 'forbidden', reason: 'not_owner' }
      }
    }

    // A merged source is read-only history. Resolving, reopening or closing it
    // would record a lifecycle decision about a Case whose work now lives on the
    // canonical target — including for the auto-close sweep, which is why this
    // check sits outside the `isSystem` branch.
    if (target.mergedIntoCaseId) {
      return { status: 'case_merged', canonicalCaseId: target.mergedIntoCaseId }
    }

    if (input.expectedUpdatedAt) {
      const current = target.updatedAt.toISOString()
      if (new Date(input.expectedUpdatedAt).toISOString() !== current) {
        return { status: 'conflict', currentUpdatedAt: current }
      }
    }

    const from = target.status
    const to = TARGET_STATUS[input.action]

    // A resolution with no wrap-up is unreviewable: nobody downstream can tell
    // what was actually done for the customer.
    if (input.action === 'resolve' && !(input.wrapUp ?? '').trim()) {
      return { status: 'wrap_up_required' }
    }

    const validation = validateTransition(from, to)
    if (!validation.ok) {
      if (validation.reason === 'no_op') {
        return { status: 'noop', caseId: target.id, updatedAt: target.updatedAt.toISOString() }
      }
      return { status: 'invalid_transition', from, to, reason: validation.reason }
    }

    target.status = to
    if (to === 'resolved') {
      target.resolvedAt = now
      target.wrapUp = input.wrapUp ?? target.wrapUp ?? null
    }
    if (to === 'closed') target.closedAt = now
    if (to === 'in_progress') target.resolvedAt = null

    em.persist(
      em.create(ConnectCaseTransition, {
        tenantId: input.actor.tenantId,
        organizationId: input.actor.organizationId,
        caseId: target.id,
        actorKind: isSystem ? 'system' : 'user',
        actorUserId: isSystem ? null : input.actor.userId,
        fromStatus: from,
        toStatus: to,
        payload: {
          action: input.action,
          reason: isSystem ? 'auto_close' : input.reason ?? null,
          actorKind: input.actor.kind,
        },
      }),
    )
    stageDomainEvent(em, {
      tenantId: input.actor.tenantId,
      organizationId: input.actor.organizationId,
      sourceEventId: `connect.case.${input.action}:${target.id}:${now.getTime()}`,
      aggregateId: target.id,
      aggregateVersion: 1,
      eventType: input.action === 'reopen' ? 'connect.case.reopened' : 'connect.case.resolved',
      payload: {
        caseId: target.id,
        from,
        to,
        action: input.action,
        // Carried on the EVENT so the metrics aggregation never joins the
        // mutable Case table: a Case reopened later would otherwise rewrite
        // the resolution timings of a day that was already reported.
        firstInboundAt: target.firstInboundAt?.toISOString() ?? null,
        firstAssignedAt: target.firstAssignedAt?.toISOString() ?? null,
        resolvedAt: target.resolvedAt?.toISOString() ?? null,
        occurredAt: now.toISOString(),
      },
    })

    await em.flush()
    return { status: 'transitioned', caseId: target.id, from, to, updatedAt: target.updatedAt.toISOString() }
  })
}
