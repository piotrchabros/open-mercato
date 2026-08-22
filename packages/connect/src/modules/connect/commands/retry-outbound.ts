import { randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectCase,
  ConnectOutbox,
  ConnectOutboundAttempt,
  ConnectOutboundMessage,
} from '../data/entities'
import { evaluateCaseAccess, type CaseActor } from '../lib/case-access'
import { stageDomainEvent } from '../lib/domain-outbox'

/**
 * Explicit retry of a FAILED attempt.
 *
 * Only `failed` is retryable, and that restriction is the whole safety
 * argument: `failed` means the source proved the message did not go out.
 * `unknown` means it might have, and retrying it would send the customer a
 * second copy of the same reply — which is why the UI disables retry there and
 * this command refuses it.
 *
 * A retry creates a CHILD attempt with a new hub correlation while keeping the
 * parent's logical message and client command key, so the customer-visible
 * message stays one message with a second delivery attempt.
 */

const retrySchema = z.object({
  caseId: z.string().uuid(),
  attemptId: z.string().uuid(),
  actor: z.object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    features: z.array(z.string()),
  }),
})

export type RetryOutboundInput = z.infer<typeof retrySchema>

export type RetryOutboundResult =
  | { status: 'retried'; attemptId: string; attemptNumber: number }
  | { status: 'not_found' }
  | { status: 'forbidden'; reason: 'not_owner' }
  | { status: 'not_retryable'; attemptStatus: string }
  | { status: 'already_retried'; attemptId: string }

export const CONNECT_RETRY_OUTBOUND_COMMAND_ID = 'connect.outbound.retry'

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

export async function retryOutbound(
  container: ContainerLike,
  rawInput: RetryOutboundInput,
): Promise<RetryOutboundResult> {
  const input = retrySchema.parse(rawInput)
  const actor: CaseActor = input.actor
  const rootEm = (container.resolve('em') as EntityManager).fork()

  return rootEm.transactional(async (tem) => {
    const em = tem as EntityManager

    const target = await em.findOne(
      ConnectCase,
      {
        id: input.caseId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!target) return { status: 'not_found' }
    const access = evaluateCaseAccess(target, actor)
    if (!access.canRead) return { status: 'not_found' }
    if (!access.canAct) return { status: 'forbidden', reason: 'not_owner' }

    const parent = await em.findOne(
      ConnectOutboundAttempt,
      { id: input.attemptId, tenantId: actor.tenantId, caseId: target.id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!parent) return { status: 'not_found' }

    // The critical restriction. `unknown` may already be in the customer's
    // mailbox; only a proven rejection is safe to re-send.
    if (parent.status !== 'failed') {
      return { status: 'not_retryable', attemptStatus: parent.status }
    }
    // The unique predecessor index is the real arbiter for concurrent clicks;
    // this check turns the race into a clear answer rather than a constraint
    // violation.
    if (parent.consumedByRetry) return { status: 'already_retried', attemptId: parent.id }

    const message = await em.findOne(ConnectOutboundMessage, {
      id: parent.messageId,
      tenantId: actor.tenantId,
    })
    if (!message) return { status: 'not_found' }

    parent.consumedByRetry = true

    const child = em.create(ConnectOutboundAttempt, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      messageId: message.id,
      caseId: target.id,
      predecessorAttemptId: parent.id,
      attemptNumber: parent.attemptNumber + 1,
      // A NEW correlation: Contract A binds a correlation to one attempt
      // immutably, so reusing the parent's would be rejected as a conflict.
      hubCorrelationId: randomUUID(),
      status: 'queued',
    })
    em.persist(child)

    em.persist(
      em.create(ConnectOutbox, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        attemptId: child.id,
        payloadFingerprint: message.payloadFingerprint,
        status: 'pending',
      }),
    )

    stageDomainEvent(em, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      sourceEventId: `connect.outbound.attempted:${child.id}`,
      aggregateId: child.id,
      aggregateVersion: child.attemptNumber,
      eventType: 'connect.outbound.attempted',
      payload: {
        caseId: target.id,
        messageId: message.id,
        attemptId: child.id,
        attemptNumber: child.attemptNumber,
        predecessorAttemptId: parent.id,
      },
    })

    await em.flush()
    return { status: 'retried', attemptId: child.id, attemptNumber: child.attemptNumber }
  })
}
