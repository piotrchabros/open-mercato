import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerEntity } from '../data/entities'

/**
 * Minimal customer reference validation (Connect upstream Contract B).
 *
 * A downstream module about to project onto a Customer timeline needs to know
 * one thing first: does this customer exist, in this scope, and is it the kind
 * of record it thinks it is? Answering with anything more — a name, an email,
 * a company — would hand PII to a module that has not asked for and does not
 * need it, so the projection is deliberately `{ kind, id }` and nothing else.
 *
 * Every negative answer collapses to `missing`: wrong kind, deleted, in a
 * sibling organization, in another tenant. A caller must not be able to use
 * this to learn that a customer id exists somewhere it cannot see.
 */

export type CustomerReferenceKind = 'person' | 'company'

export type CustomerReferenceScope = {
  tenantId: string
  organizationId: string
}

export type CustomerReferenceInput = {
  kind: CustomerReferenceKind
  id: string
  scope: CustomerReferenceScope
}

export type CustomerReferenceResult =
  | { status: 'resolved'; reference: { kind: CustomerReferenceKind; id: string } }
  | { status: 'missing' }

const ALLOWED_KINDS: ReadonlySet<string> = new Set<CustomerReferenceKind>(['person', 'company'])

export async function resolveCustomerReference(
  em: EntityManager,
  input: CustomerReferenceInput,
): Promise<CustomerReferenceResult> {
  // An unknown kind is rejected before touching the database: `deal` or
  // `address` are real customer-module entities, and silently widening the
  // accepted set would let a caller project onto records this contract was
  // never reviewed for.
  if (!ALLOWED_KINDS.has(input.kind)) return { status: 'missing' }

  const entity = await em.findOne(CustomerEntity, {
    id: input.id,
    kind: input.kind,
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    deletedAt: null,
  })
  if (!entity) return { status: 'missing' }

  return { status: 'resolved', reference: { kind: input.kind, id: entity.id } }
}
