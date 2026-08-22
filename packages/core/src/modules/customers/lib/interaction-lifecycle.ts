import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  CustomerEntity,
  CustomerInteraction,
  CustomerInteractionRetractionSaga,
} from '../data/entities'
import { resolveCustomerReference, type CustomerReferenceResult } from './customer-reference'

const logger = createLogger('customers').child({ component: 'interaction-lifecycle' })

/**
 * Source-owned Customer Interaction lifecycle (Connect upstream Contract B).
 *
 * A downstream module can already create interactions. What it cannot do — and
 * what a mistaken identity link makes urgent — is take them back. Hard deletion
 * would destroy audit evidence, and letting the downstream module write customer
 * tables directly would violate the module boundary. So the customers module
 * owns both directions:
 *
 *   - **Creation is idempotent on a deterministic source key**, and only when
 *     the payload is equivalent. A retried projection resolves to the existing
 *     row; a changed payload under the same key is a conflict, because silently
 *     rewriting a customer's timeline entry is not something a retry should do.
 *   - **Retraction is a journaled saga**, not a delete. `begin` hides an exact
 *     inventory all-or-none, `commit` tombstones it, `abort` restores exactly
 *     what it hid, and the decision is monotonic so a replayed recovery worker
 *     cannot flip a settled saga.
 *
 * Hiding is implemented by setting `deleted_at` alongside `retraction_state`.
 * That is deliberate: the module's soft-delete predicate is already applied by
 * every ordinary reader, so routing retraction through it cannot be defeated by
 * a reader that forgets a newly invented predicate. `retraction_state` is what
 * lets a restricted audit reader tell a retraction from a user deletion, and
 * lets an abort restore precisely its own members.
 */

export const CUSTOMERS_INTERACTIONS_RETRACT_FEATURE = 'customers.interactions.retract'

/**
 * Trusted server-side actor. Resolved by the caller from its own authenticated
 * context; there is no browser path to any operation here.
 */
export type InteractionLifecycleActor = {
  serviceId: string
  userId: string | null
  features: readonly string[]
}

export type InteractionLifecycleScope = {
  tenantId: string
  organizationId: string
}

function isAuthorized(actor: InteractionLifecycleActor): boolean {
  if (!actor || typeof actor.serviceId !== 'string' || actor.serviceId.length === 0) return false
  const grantedFeatures = Array.isArray(actor.features) ? [...actor.features] : []
  return authorizeFeatures([CUSTOMERS_INTERACTIONS_RETRACT_FEATURE], { grantedFeatures })
}

// ── Creation ────────────────────────────────────────────────

export type CreateInteractionInput = {
  scope: InteractionLifecycleScope
  actor: InteractionLifecycleActor
  customer: { kind: 'person' | 'company'; id: string }
  /** Owning module's namespace, e.g. `connect`. */
  namespace: string
  /** Deterministic key within the namespace. */
  sourceKey: string
  /** The identity + association epoch this projection belongs to. */
  identityId: string
  associationEpoch: number
  /** Immutable payload. A changed payload under the same key is a conflict. */
  payload: {
    interactionType: string
    title?: string | null
    body?: string | null
    occurredAt?: Date | null
    authorUserId?: string | null
    visibility?: string | null
    channelProviderKey?: string | null
  }
}

export type CreateInteractionResult =
  | { status: 'created'; interactionId: string }
  | { status: 'duplicate'; interactionId: string }
  | { status: 'conflict'; reason: 'payload_mismatch' | 'group_mismatch' }
  | { status: 'forbidden' }
  | { status: 'customer_missing' }

/**
 * Equivalence for idempotent creation. Deliberately strict: a retry that
 * changed anything is not the same projection, and treating it as one would let
 * a caller rewrite history through the idempotency path.
 */
function payloadMatches(existing: CustomerInteraction, input: CreateInteractionInput): boolean {
  const payload = input.payload
  return (
    existing.interactionType === payload.interactionType &&
    (existing.title ?? null) === (payload.title ?? null) &&
    (existing.body ?? null) === (payload.body ?? null) &&
    (existing.channelProviderKey ?? null) === (payload.channelProviderKey ?? null)
  )
}

export async function createInteraction(
  em: EntityManager,
  input: CreateInteractionInput,
): Promise<CreateInteractionResult> {
  if (!isAuthorized(input.actor)) return { status: 'forbidden' }

  const reference: CustomerReferenceResult = await resolveCustomerReference(em, {
    kind: input.customer.kind,
    id: input.customer.id,
    scope: input.scope,
  })
  if (reference.status !== 'resolved') return { status: 'customer_missing' }

  const existing = await em.findOne(CustomerInteraction, {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    sourceNamespace: input.namespace,
    sourceKey: input.sourceKey,
  })
  if (existing) {
    // The retraction group is part of the projection's identity: the same key
    // under a different identity or epoch is a different projection, and
    // adopting it would put a row in a group whose retraction cannot reach it.
    if (
      existing.sourceIdentityId !== input.identityId ||
      existing.sourceAssociationEpoch !== input.associationEpoch
    ) {
      return { status: 'conflict', reason: 'group_mismatch' }
    }
    if (!payloadMatches(existing, input)) return { status: 'conflict', reason: 'payload_mismatch' }
    return { status: 'duplicate', interactionId: existing.id }
  }

  const interaction = em.create(CustomerInteraction, {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    entity: em.getReference(CustomerEntity, input.customer.id),
    interactionType: input.payload.interactionType,
    title: input.payload.title ?? null,
    body: input.payload.body ?? null,
    occurredAt: input.payload.occurredAt ?? new Date(),
    authorUserId: input.payload.authorUserId ?? null,
    visibility: input.payload.visibility ?? null,
    channelProviderKey: input.payload.channelProviderKey ?? null,
    sourceNamespace: input.namespace,
    sourceKey: input.sourceKey,
    sourceIdentityId: input.identityId,
    sourceAssociationEpoch: input.associationEpoch,
  } as never)
  em.persist(interaction)
  await em.flush()

  return { status: 'created', interactionId: interaction.id }
}

// ── Retraction saga ─────────────────────────────────────────

export type RetractionSagaScope = InteractionLifecycleScope & {
  namespace: string
  sagaId: string
  epoch: number
}

export type BeginRetractionSagaInput = {
  scope: RetractionSagaScope
  actor: InteractionLifecycleActor
  identityId: string
  associationEpoch: number
  /** The caller's complete view of the group's active source keys. */
  inventory: readonly string[]
  reason: string
  idempotencyKey: string
}

export type BeginRetractionSagaResult =
  | { status: 'begun'; hiddenCount: number; inventory: string[] }
  | { status: 'already_begun'; hiddenCount: number; inventory: string[] }
  | {
      status: 'inventory_conflict'
      missingFromRequest: string[]
      unknownInRequest: string[]
    }
  | { status: 'forbidden' }
  | { status: 'stale_epoch'; currentEpoch: number }

/** Byte-order comparison, so a stored inventory is stable regardless of locale. */
function compareSourceKeys(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function diffInventory(
  requested: readonly string[],
  stored: readonly string[],
): { missingFromRequest: string[]; unknownInRequest: string[] } {
  const requestedSet = new Set(requested)
  const storedSet = new Set(stored)
  // Explicit comparator so the diff order is byte-order stable across locales
  // — the caller may diff or log these lists.
  return {
    missingFromRequest: stored.filter((key) => !requestedSet.has(key)).sort(compareSourceKeys),
    unknownInRequest: requested.filter((key) => !storedSet.has(key)).sort(compareSourceKeys),
  }
}

/**
 * Hide a retraction group all-or-none.
 *
 * The supplied inventory must EXACTLY equal the source's active stored set. An
 * omitted key would leave part of a mistaken link visible on the customer's
 * timeline; an extra key means the caller's view of the group is stale and its
 * whole request is suspect. Either way the answer is a conflict that hides
 * nothing, and the diff tells the caller how its view drifted.
 */
export async function beginRetractionSaga(
  em: EntityManager,
  input: BeginRetractionSagaInput,
): Promise<BeginRetractionSagaResult> {
  if (!isAuthorized(input.actor)) return { status: 'forbidden' }
  const { scope } = input

  return em.transactional(async (tem) => {
    const existingSaga = await tem.findOne(
      CustomerInteractionRetractionSaga,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        namespace: scope.namespace,
        sagaId: scope.sagaId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (existingSaga) {
      // Epoch fencing: a recovery worker replaying an older epoch must not be
      // able to re-open or re-scope a saga that has already moved on.
      if (existingSaga.epoch > scope.epoch) {
        return { status: 'stale_epoch', currentEpoch: existingSaga.epoch }
      }
      const hidden = await tem.count(CustomerInteraction, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        retractionSagaId: scope.sagaId,
      })
      return { status: 'already_begun', hiddenCount: hidden, inventory: existingSaga.inventory }
    }

    // Lock the group by reading its members for update, so a concurrent begin
    // for the same group cannot observe the same "active set" and hide twice.
    const members = await tem.find(
      CustomerInteraction,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        sourceNamespace: scope.namespace,
        sourceIdentityId: input.identityId,
        sourceAssociationEpoch: input.associationEpoch,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    const storedKeys = members
      .map((member) => member.sourceKey)
      .filter((key): key is string => typeof key === 'string')

    const diff = diffInventory(input.inventory, storedKeys)
    if (diff.missingFromRequest.length > 0 || diff.unknownInRequest.length > 0) {
      return { status: 'inventory_conflict', ...diff }
    }

    const now = new Date()
    for (const member of members) {
      member.retractionState = 'pending_hidden'
      member.retractedAt = now
      member.retractionSagaId = scope.sagaId
      // Hidden through the module's existing soft-delete predicate, which every
      // ordinary reader already applies.
      member.deletedAt = now
    }

    const saga = tem.create(CustomerInteractionRetractionSaga, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      namespace: scope.namespace,
      sagaId: scope.sagaId,
      epoch: scope.epoch,
      identityId: input.identityId,
      associationEpoch: input.associationEpoch,
      inventory: [...storedKeys].sort(compareSourceKeys),
      reason: input.reason,
      requestedByUserId: input.actor.userId ?? null,
    })
    tem.persist(saga)
    await tem.flush()

    return { status: 'begun', hiddenCount: members.length, inventory: saga.inventory }
  })
}

export type ListRetractionsInput = {
  scope: RetractionSagaScope
  actor: InteractionLifecycleActor
}

export type ListRetractionsResult =
  | {
      status: 'found'
      inventory: string[]
      decision: 'commit' | 'abort' | null
      finalized: boolean
      epoch: number
    }
  | { status: 'missing' }
  | { status: 'forbidden' }

/**
 * Recover from a lost `begin` acknowledgement.
 *
 * The source is authoritative about what a saga hid, so a caller that never
 * saw the response asks rather than guessing — guessing would mean either
 * re-hiding (harmless but noisy) or assuming nothing happened (which leaves a
 * mistaken link visible).
 */
export async function listRetractions(
  em: EntityManager,
  input: ListRetractionsInput,
): Promise<ListRetractionsResult> {
  if (!isAuthorized(input.actor)) return { status: 'forbidden' }
  const { scope } = input
  const saga = await em.findOne(CustomerInteractionRetractionSaga, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    namespace: scope.namespace,
    sagaId: scope.sagaId,
    epoch: scope.epoch,
  })
  if (!saga) return { status: 'missing' }
  return {
    status: 'found',
    inventory: saga.inventory,
    decision: saga.decision ?? null,
    finalized: saga.finalizedAt != null,
    epoch: saga.epoch,
  }
}

export type RetractionDecisionInput = {
  scope: RetractionSagaScope
  actor: InteractionLifecycleActor
}

export type RetractionDecisionResult =
  | { status: 'decided'; decision: 'commit' | 'abort' }
  | { status: 'already_decided'; decision: 'commit' | 'abort' }
  | { status: 'conflicting_decision'; decision: 'commit' | 'abort' }
  | { status: 'missing' }
  | { status: 'forbidden' }
  | { status: 'stale_epoch'; currentEpoch: number }

async function recordDecision(
  em: EntityManager,
  input: RetractionDecisionInput,
  decision: 'commit' | 'abort',
): Promise<RetractionDecisionResult> {
  if (!isAuthorized(input.actor)) return { status: 'forbidden' }
  const { scope } = input

  return em.transactional(async (tem) => {
    const saga = await tem.findOne(
      CustomerInteractionRetractionSaga,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        namespace: scope.namespace,
        sagaId: scope.sagaId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!saga) return { status: 'missing' }
    if (saga.epoch > scope.epoch) return { status: 'stale_epoch', currentEpoch: saga.epoch }

    if (saga.decision) {
      // Monotonic and mutually exclusive: a replayed decision is idempotent, a
      // contradictory one is refused rather than applied.
      return saga.decision === decision
        ? { status: 'already_decided', decision: saga.decision }
        : { status: 'conflicting_decision', decision: saga.decision }
    }

    saga.decision = decision
    saga.decidedAt = new Date()
    await tem.flush()
    return { status: 'decided', decision }
  })
}

export async function commitRetractionSaga(
  em: EntityManager,
  input: RetractionDecisionInput,
): Promise<RetractionDecisionResult> {
  return recordDecision(em, input, 'commit')
}

export async function abortRetractionSaga(
  em: EntityManager,
  input: RetractionDecisionInput,
): Promise<RetractionDecisionResult> {
  return recordDecision(em, input, 'abort')
}

export type FinalizeRetractionSagaResult =
  | { status: 'finalized'; decision: 'commit' | 'abort'; affectedCount: number }
  | { status: 'already_finalized'; decision: 'commit' | 'abort' }
  | { status: 'undecided' }
  | { status: 'missing' }
  | { status: 'forbidden' }
  | { status: 'stale_epoch'; currentEpoch: number }

/**
 * Apply the recorded decision.
 *
 * Separated from `commit`/`abort` so the decision survives a crash between
 * deciding and applying: a recovery worker re-runs `finalize` and gets the same
 * outcome, because the decision — not the caller's intent — is what is stored.
 *
 * On abort, only rows this saga hid are restored, and only if they are still
 * `pending_hidden`. A row an operator deleted in the meantime stays deleted:
 * an abort must undo the saga, not resurrect unrelated decisions.
 */
export async function finalizeRetractionSaga(
  em: EntityManager,
  input: RetractionDecisionInput,
): Promise<FinalizeRetractionSagaResult> {
  if (!isAuthorized(input.actor)) return { status: 'forbidden' }
  const { scope } = input

  return em.transactional(async (tem) => {
    const saga = await tem.findOne(
      CustomerInteractionRetractionSaga,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        namespace: scope.namespace,
        sagaId: scope.sagaId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!saga) return { status: 'missing' }
    if (saga.epoch > scope.epoch) return { status: 'stale_epoch', currentEpoch: saga.epoch }
    if (!saga.decision) return { status: 'undecided' }
    if (saga.finalizedAt) return { status: 'already_finalized', decision: saga.decision }

    const members = await tem.find(CustomerInteraction, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      retractionSagaId: saga.sagaId,
      retractionState: 'pending_hidden',
    })

    for (const member of members) {
      if (saga.decision === 'commit') {
        member.retractionState = 'tombstoned'
      } else {
        member.retractionState = null
        member.retractedAt = null
        member.retractionSagaId = null
        member.deletedAt = null
      }
    }

    saga.finalizedAt = new Date()
    await tem.flush()

    logger.info('retraction saga finalized', {
      sagaId: saga.sagaId,
      decision: saga.decision,
      affectedCount: members.length,
    })

    return { status: 'finalized', decision: saga.decision, affectedCount: members.length }
  })
}

// ── DI facade ───────────────────────────────────────────────

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

/**
 * `customersInteractionLifecycle`.
 *
 * Registered beside the legacy interaction command rather than replacing it:
 * existing `customers.interactions.create` callers keep their signature and
 * behaviour, and only a module that needs retractable projections opts in here.
 */
export function createInteractionLifecycleService(container: ContainerLike) {
  const fork = (): EntityManager => (container.resolve('em') as EntityManager).fork()

  return {
    resolveCustomerReference: (input: Parameters<typeof resolveCustomerReference>[1]) =>
      resolveCustomerReference(fork(), input),
    createInteraction: (input: CreateInteractionInput) => createInteraction(fork(), input),
    beginRetractionSaga: (input: BeginRetractionSagaInput) => beginRetractionSaga(fork(), input),
    listRetractions: (input: ListRetractionsInput) => listRetractions(fork(), input),
    commitRetractionSaga: (input: RetractionDecisionInput) => commitRetractionSaga(fork(), input),
    abortRetractionSaga: (input: RetractionDecisionInput) => abortRetractionSaga(fork(), input),
    finalizeRetractionSaga: (input: RetractionDecisionInput) => finalizeRetractionSaga(fork(), input),
  }
}

export type CustomersInteractionLifecycleService = ReturnType<typeof createInteractionLifecycleService>
