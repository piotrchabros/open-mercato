import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectCaseGenerationFact,
  ConnectCaseWaitFact,
  ConnectOutboundDeliveryFact,
  type ConnectGenerationCause,
  type ConnectResponseEvidence,
} from '../data/entities'
import { stageDomainEvent } from './domain-outbox'

/**
 * The single writer for Connect's SLA-agnostic source facts.
 *
 * Every function here stages a fact row AND its announcement inside the
 * caller's transaction, so the two can never disagree: an event that describes
 * a fact nobody wrote, or a fact nobody announced, are both states a downstream
 * consumer has no way to repair.
 *
 * Writes are guarded by `sourceEventId` rather than relying on the unique index
 * to reject a duplicate. A constraint violation would abort the caller's whole
 * transaction — rolling back an agent's reply because an announcement was
 * replayed is a far worse outcome than skipping the duplicate.
 *
 * All of these run under the scoped Case row lock the caller already holds, so
 * the check-then-insert is serialized per Case.
 */

/** Bumped only alongside a documented payload change. Present on every payload. */
export const CONNECT_SLA_FACT_SCHEMA_VERSION = 1

export type FactScope = { tenantId: string; organizationId: string }

async function generationFactExists(
  em: EntityManager,
  scope: FactScope,
  sourceEventId: string,
): Promise<boolean> {
  const existing = await em.findOne(ConnectCaseGenerationFact, { ...scope, sourceEventId })
  return existing != null
}

async function waitFactExists(
  em: EntityManager,
  scope: FactScope,
  sourceEventId: string,
): Promise<boolean> {
  const existing = await em.findOne(ConnectCaseWaitFact, { ...scope, sourceEventId })
  return existing != null
}

async function deliveryFactExists(
  em: EntityManager,
  scope: FactScope,
  sourceEventId: string,
): Promise<boolean> {
  const existing = await em.findOne(ConnectOutboundDeliveryFact, { ...scope, sourceEventId })
  return existing != null
}

export type GenerationStartInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  channelId: string
  cause: Extract<ConnectGenerationCause, 'opened' | 'reopened'>
  occurredAt: Date
}

/**
 * Open a generation.
 *
 * `startedAt` IS `occurredAt` by construction — a generation begins when it is
 * announced — and it is copied onto the later resolution row so a consumer can
 * measure the round from either boundary without joining back.
 */
export async function recordGenerationStarted(
  em: EntityManager,
  input: GenerationStartInput,
): Promise<ConnectCaseGenerationFact | null> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (await generationFactExists(em, scope, input.sourceEventId)) return null

  const fact = em.create(ConnectCaseGenerationFact, {
    ...scope,
    sourceEventId: input.sourceEventId,
    caseId: input.caseId,
    generation: input.generation,
    channelId: input.channelId,
    boundary: 'started',
    cause: input.cause,
    startedAt: input.occurredAt,
    resolvedAt: null,
    occurredAt: input.occurredAt,
  })
  em.persist(fact)

  stageDomainEvent(em, {
    ...scope,
    sourceEventId: input.sourceEventId,
    aggregateId: input.caseId,
    aggregateVersion: input.generation + 1,
    eventType: 'connect.case.generation_started',
    payload: {
      schemaVersion: CONNECT_SLA_FACT_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      caseId: input.caseId,
      generation: input.generation,
      channelId: input.channelId,
      cause: input.cause,
      startedAt: input.occurredAt.toISOString(),
      occurredAt: input.occurredAt.toISOString(),
    },
  })
  return fact
}

/**
 * The instant the given generation began.
 *
 * Falls back to the caller's default when no start row exists, which is the
 * normal state for Cases that were already open when the fact tables were
 * introduced — history is honestly incomplete rather than silently invented.
 */
export async function findGenerationStartedAt(
  em: EntityManager,
  scope: FactScope,
  caseId: string,
  generation: number,
  fallback: Date,
): Promise<Date> {
  const started = await em.findOne(
    ConnectCaseGenerationFact,
    { ...scope, caseId, generation, boundary: 'started' },
    { orderBy: { occurredAt: 'desc', id: 'desc' } },
  )
  return started?.startedAt ?? fallback
}

export type GenerationResolveInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  channelId: string
  startedAt: Date
  occurredAt: Date
}

export async function recordGenerationResolved(
  em: EntityManager,
  input: GenerationResolveInput,
): Promise<ConnectCaseGenerationFact | null> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (await generationFactExists(em, scope, input.sourceEventId)) return null

  const fact = em.create(ConnectCaseGenerationFact, {
    ...scope,
    sourceEventId: input.sourceEventId,
    caseId: input.caseId,
    generation: input.generation,
    channelId: input.channelId,
    boundary: 'resolved',
    cause: 'resolved',
    startedAt: input.startedAt,
    resolvedAt: input.occurredAt,
    occurredAt: input.occurredAt,
  })
  em.persist(fact)

  stageDomainEvent(em, {
    ...scope,
    sourceEventId: input.sourceEventId,
    aggregateId: input.caseId,
    aggregateVersion: input.generation + 1,
    eventType: 'connect.case.generation_resolved',
    payload: {
      schemaVersion: CONNECT_SLA_FACT_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      caseId: input.caseId,
      generation: input.generation,
      channelId: input.channelId,
      startedAt: input.startedAt.toISOString(),
      resolvedAt: input.occurredAt.toISOString(),
      occurredAt: input.occurredAt.toISOString(),
    },
  })
  return fact
}

/**
 * The currently open customer wait for one generation, if any.
 *
 * A wait is open when the most recent boundary row for the generation is a
 * start. This is what makes repeats outside a boundary emit nothing: a second
 * confirmed send while already waiting finds an open wait and does not reopen
 * one, and an inbound on a Case that is not waiting finds none to close.
 */
export async function findOpenWait(
  em: EntityManager,
  scope: FactScope,
  caseId: string,
  generation: number,
): Promise<ConnectCaseWaitFact | null> {
  const latest = await em.findOne(
    ConnectCaseWaitFact,
    { ...scope, caseId, generation },
    { orderBy: { occurredAt: 'desc', id: 'desc' } },
  )
  if (!latest || latest.boundary !== 'started') return null
  return latest
}

export type WaitStartInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  occurredAt: Date
}

export async function recordWaitStarted(
  em: EntityManager,
  input: WaitStartInput,
): Promise<ConnectCaseWaitFact | null> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (await waitFactExists(em, scope, input.sourceEventId)) return null
  if (await findOpenWait(em, scope, input.caseId, input.generation)) return null

  const fact = em.create(ConnectCaseWaitFact, {
    ...scope,
    sourceEventId: input.sourceEventId,
    caseId: input.caseId,
    generation: input.generation,
    boundary: 'started',
    startedAt: input.occurredAt,
    endedAt: null,
    occurredAt: input.occurredAt,
  })
  em.persist(fact)

  stageDomainEvent(em, {
    ...scope,
    sourceEventId: input.sourceEventId,
    aggregateId: input.caseId,
    aggregateVersion: input.generation + 1,
    eventType: 'connect.case.customer_wait_started',
    payload: {
      schemaVersion: CONNECT_SLA_FACT_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      caseId: input.caseId,
      generation: input.generation,
      startedAt: input.occurredAt.toISOString(),
      occurredAt: input.occurredAt.toISOString(),
    },
  })
  return fact
}

export type WaitEndInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  occurredAt: Date
}

/**
 * Close the open wait, or do nothing when none is open.
 *
 * Returning null on "no open wait" is what keeps a duplicated inbound or a
 * resolve-after-resolve from inventing a zero-length interval.
 */
export async function recordWaitEnded(
  em: EntityManager,
  input: WaitEndInput,
): Promise<ConnectCaseWaitFact | null> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (await waitFactExists(em, scope, input.sourceEventId)) return null
  const open = await findOpenWait(em, scope, input.caseId, input.generation)
  if (!open) return null

  const fact = em.create(ConnectCaseWaitFact, {
    ...scope,
    sourceEventId: input.sourceEventId,
    caseId: input.caseId,
    generation: input.generation,
    boundary: 'ended',
    startedAt: open.startedAt,
    endedAt: input.occurredAt,
    occurredAt: input.occurredAt,
  })
  em.persist(fact)

  stageDomainEvent(em, {
    ...scope,
    sourceEventId: input.sourceEventId,
    aggregateId: input.caseId,
    aggregateVersion: input.generation + 1,
    eventType: 'connect.case.customer_wait_ended',
    payload: {
      schemaVersion: CONNECT_SLA_FACT_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      caseId: input.caseId,
      generation: input.generation,
      startedAt: open.startedAt.toISOString(),
      endedAt: input.occurredAt.toISOString(),
      occurredAt: input.occurredAt.toISOString(),
    },
  })
  return fact
}

export type DeliveryConfirmedInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  outboundMessageId: string
  attemptId: string
  deliveryRevision: number
  confirmedAt: Date
  responseEvidence: ConnectResponseEvidence
  responseEvidenceVersion: number
  authorUserId: string | null
  acceptedByUserId: string | null
  occurredAt: Date
}

export async function recordDeliveryConfirmed(
  em: EntityManager,
  input: DeliveryConfirmedInput,
): Promise<ConnectOutboundDeliveryFact | null> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  if (await deliveryFactExists(em, scope, input.sourceEventId)) return null

  const fact = em.create(ConnectOutboundDeliveryFact, {
    ...scope,
    sourceEventId: input.sourceEventId,
    caseId: input.caseId,
    generation: input.generation,
    outboundMessageId: input.outboundMessageId,
    attemptId: input.attemptId,
    deliveryRevision: input.deliveryRevision,
    confirmedAt: input.confirmedAt,
    responseEvidence: input.responseEvidence,
    responseEvidenceVersion: input.responseEvidenceVersion,
    authorUserId: input.authorUserId,
    acceptedByUserId: input.acceptedByUserId,
    occurredAt: input.occurredAt,
  })
  em.persist(fact)

  stageDomainEvent(em, {
    ...scope,
    sourceEventId: input.sourceEventId,
    aggregateId: input.attemptId,
    aggregateVersion: input.deliveryRevision,
    eventType: 'connect.outbound.delivery_confirmed',
    payload: {
      schemaVersion: CONNECT_SLA_FACT_SCHEMA_VERSION,
      sourceEventId: input.sourceEventId,
      caseId: input.caseId,
      generation: input.generation,
      outboundMessageId: input.outboundMessageId,
      attemptId: input.attemptId,
      deliveryRevision: input.deliveryRevision,
      confirmedAt: input.confirmedAt.toISOString(),
      responseEvidence: input.responseEvidence,
      responseEvidenceVersion: input.responseEvidenceVersion,
      authorUserId: input.authorUserId,
      acceptedByUserId: input.acceptedByUserId,
      occurredAt: input.occurredAt.toISOString(),
    },
  })
  return fact
}
