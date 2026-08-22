import type { EntityManager } from '@mikro-orm/postgresql'
import type { EnricherContext, ResponseEnricher } from '@open-mercato/shared/lib/crud/response-enricher'
import { evaluateActivation } from '../lib/activation'
import {
  CUSTOMER_CONTEXT_BATCH_LIMIT,
  readCustomerContexts,
  type CustomerContext,
} from '../lib/customer-context'

/**
 * `_connect` on customer person/company API responses.
 *
 * These let Customer screens show "3 open conversations" without the Customers
 * module knowing Connect exists. Three constraints shape them:
 *
 *   - **Batched.** `enrichMany` issues ONE grouped query for the whole page.
 *     The single-record path delegates to it rather than duplicating the query,
 *     so there is exactly one code path and no way for the list to regress into
 *     N+1.
 *   - **Feature-gated.** `connect.customer_match.read` is the same feature the
 *     context routes require, so a viewer who could not call the API cannot get
 *     the same numbers by loading a customer list instead.
 *   - **Silently absent.** A record outside the caller's tenant+organization, a
 *     customer with no Connect traffic, and an inert Connect installation all
 *     produce no `_connect` key at all. An explicit zero would confirm the
 *     record exists in this scope, which is what cross-organization isolation
 *     must not reveal.
 */

export type ConnectCustomerEnrichment = {
  _connect: {
    openCaseCount: number
    lastCaseAt: string | null
    lastCaseStatus: string | null
  }
}

type CustomerRecord = Record<string, unknown> & { id?: unknown }

const CONNECT_CONTEXT_FEATURE = 'connect.customer_match.read'

function recordId(record: CustomerRecord): string | null {
  return typeof record.id === 'string' && record.id ? record.id : null
}

async function enrichRecords(
  kind: 'person' | 'company',
  records: CustomerRecord[],
  ctx: EnricherContext,
): Promise<CustomerRecord[]> {
  // Connect may be installed but not activated for this deployment. Contribute
  // nothing rather than reporting zero conversations, which would read as a
  // fact about the customer instead of about the installation.
  const activation = evaluateActivation(ctx.container as { resolve: <T>(name: string) => T })
  if (activation.state !== 'active') return records
  if (!ctx.tenantId || !ctx.organizationId) return records

  const refs = records
    .map((record) => recordId(record))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ kind, id }))
  if (!refs.length) return records

  const contexts: CustomerContext[] = []
  // Pages are capped at 100 upstream, but chunking keeps the contract honest if
  // a host ever asks for more instead of silently dropping the tail.
  for (let offset = 0; offset < refs.length; offset += CUSTOMER_CONTEXT_BATCH_LIMIT) {
    contexts.push(
      ...(await readCustomerContexts(
        ctx.em as EntityManager,
        { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
        refs.slice(offset, offset + CUSTOMER_CONTEXT_BATCH_LIMIT),
      )),
    )
  }

  const byId = new Map(contexts.map((context) => [context.id, context]))
  return records.map((record) => {
    const id = recordId(record)
    const context = id ? byId.get(id) : undefined
    if (!context) return record
    return {
      ...record,
      _connect: {
        openCaseCount: context.openCaseCount,
        lastCaseAt: context.lastCaseAt,
        lastCaseStatus: context.lastCaseStatus,
      },
    }
  })
}

function customerContextEnricher(kind: 'person' | 'company'): ResponseEnricher<CustomerRecord, Partial<ConnectCustomerEnrichment>> {
  return {
    id: `connect.customer-context-${kind}`,
    targetEntity: `customers.${kind}`,
    features: [CONNECT_CONTEXT_FEATURE],
    // Aggregates over `connect_cases`, which the customers list cache knows
    // nothing about — a cached page must not serve yesterday's counts.
    cacheableOnListHit: false,
    async enrichOne(record, ctx) {
      const [enriched] = await enrichRecords(kind, [record], ctx)
      return (enriched ?? record) as CustomerRecord & Partial<ConnectCustomerEnrichment>
    },
    async enrichMany(records, ctx) {
      const enriched = await enrichRecords(kind, records, ctx)
      return enriched as Array<CustomerRecord & Partial<ConnectCustomerEnrichment>>
    },
  }
}

export const enrichers: ResponseEnricher[] = [
  customerContextEnricher('person') as unknown as ResponseEnricher,
  customerContextEnricher('company') as unknown as ResponseEnricher,
]

export default enrichers
