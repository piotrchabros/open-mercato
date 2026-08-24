import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { ConnectCase } from '../data/entities'
import { evaluateCaseAccess } from './case-access'

/**
 * The bounded read facade over Connect's SLA source facts.
 *
 * A consumer reading the fact tables directly would have to re-derive scoping,
 * ordering and pagination, and would eventually get one of them wrong in a way
 * that leaks across organizations. This is the only supported way in, and it is
 * deliberately narrow: keyset pages over append-only rows, nothing mutable, no
 * aggregation and no free text.
 *
 * The `through` watermark is what makes a consumer's incremental sync
 * repeatable. Facts are written by concurrent transactions, so rows can become
 * visible with an `occurred_at` BELOW a page already read. Capturing a
 * watermark first and bounding every page by it means a sync run sees one
 * consistent prefix of history instead of a moving target.
 *
 * Reader types are Connect-owned and import nothing from any consumer — the
 * dependency runs one way only.
 */

export type SlaReaderScope = { tenantId: string; organizationId: string }

export type SlaCursor = { occurredAt: string; id: string }

export type SlaPage<T> = {
  items: T[]
  /** Null when the page reached `through`. */
  nextCursor: SlaCursor | null
  /** Echoes the bound this page was read against. */
  highWatermark: SlaCursor
}

export type SlaGenerationDto = {
  id: string
  caseId: string
  generation: number
  channelId: string
  startedAt: string
  /** Non-null only on the resolution boundary of the round. */
  resolvedAt: string | null
  mergedIntoCaseId: string | null
  lineageVersion: number
  updatedAt: string
}

export type SlaWaitDto = {
  id: string
  caseId: string
  generation: number
  startedAt: string
  /** Non-null only on the closing boundary of the interval. */
  endedAt: string | null
}

export type SlaDeliveryDto = {
  id: string
  caseId: string
  generation: number
  outboundMessageId: string
  attemptId: string
  deliveryRevision: number
  confirmedAt: string
  responseEvidence: 'human' | 'human_accepted_ai' | 'unknown'
  responseEvidenceVersion: 1
  authorUserId: string | null
  acceptedByUserId: string | null
}

export type SlaListInput = {
  after?: SlaCursor
  through: SlaCursor
  limit: number
}

export interface ConnectCaseSlaReader {
  captureHighWatermark(scope: SlaReaderScope): Promise<SlaCursor>
  listGenerations(scope: SlaReaderScope, input: SlaListInput): Promise<SlaPage<SlaGenerationDto>>
  listWaitIntervals(scope: SlaReaderScope, input: SlaListInput): Promise<SlaPage<SlaWaitDto>>
  listConfirmedDeliveries(scope: SlaReaderScope, input: SlaListInput): Promise<SlaPage<SlaDeliveryDto>>
  canReadCase(scope: SlaReaderScope & { userId: string }, caseId: string): Promise<boolean>
}

/** The cursor an empty scope starts from: before every possible fact. */
export const CONNECT_SLA_EPOCH_CURSOR: SlaCursor = {
  occurredAt: new Date(0).toISOString(),
  id: '00000000-0000-0000-0000-000000000000',
}

export const CONNECT_SLA_READER_MAX_LIMIT = 100

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const cursorSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
})

const listInputSchema = z.object({
  after: cursorSchema.optional(),
  through: cursorSchema,
  limit: z.number().int().min(1).max(CONNECT_SLA_READER_MAX_LIMIT),
})

const evidenceSchema = z.enum(['human', 'human_accepted_ai', 'unknown'])

function internalError(reason: string): Error {
  return new Error(`[internal] connect_sla_reader_${reason}`)
}

function toIso(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw internalError(`malformed_${field}`)
  return date.toISOString()
}

function toNullableIso(value: unknown, field: string): string | null {
  return value == null ? null : toIso(value, field)
}

function toInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed)) throw internalError(`malformed_${field}`)
  return parsed
}

function toUuid(value: unknown, field: string): string {
  const parsed = z.string().uuid().safeParse(value)
  if (!parsed.success) throw internalError(`malformed_${field}`)
  return parsed.data
}

function toNullableUuid(value: unknown, field: string): string | null {
  return value == null ? null : toUuid(value, field)
}

type FactRow = Record<string, unknown>

/**
 * Read one keyset page.
 *
 * `> after AND <= through` on the composite `(occurred_at, id)` is what makes
 * paging exact over append-only rows: no row is skipped when timestamps tie,
 * and no row is returned twice.
 */
async function readPage(
  em: EntityManager,
  table: string,
  columns: string,
  scope: SlaReaderScope,
  input: SlaListInput,
): Promise<{ rows: FactRow[]; nextCursor: SlaCursor | null }> {
  const params: unknown[] = [scope.tenantId, scope.organizationId]
  let predicate = `"tenant_id" = ? and "organization_id" = ?`
  if (input.after) {
    predicate += ` and ("occurred_at", "id") > (?, ?)`
    params.push(new Date(input.after.occurredAt), input.after.id)
  }
  predicate += ` and ("occurred_at", "id") <= (?, ?)`
  params.push(new Date(input.through.occurredAt), input.through.id)
  // One row beyond the page: the only reliable way to answer "is there more"
  // without a second count query that could disagree with the page.
  params.push(input.limit + 1)

  const rows = (await em.execute(
    `select ${columns}, "occurred_at", "id"
       from "${table}"
      where ${predicate}
      order by "occurred_at" asc, "id" asc
      limit ?`,
    params,
  )) as FactRow[]

  const page = rows.slice(0, input.limit)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > input.limit && last
      ? { occurredAt: toIso(last.occurred_at, 'occurred_at'), id: toUuid(last.id, 'id') }
      : null
  return { rows: page, nextCursor }
}

const FACT_TABLES = [
  'connect_case_generation_facts',
  'connect_case_wait_facts',
  'connect_outbound_delivery_facts',
] as const

export function createConnectCaseSlaReader(
  em: EntityManager,
  container: AppContainer,
): ConnectCaseSlaReader {
  async function page<T>(
    table: string,
    columns: string,
    rawScope: SlaReaderScope,
    rawInput: SlaListInput,
    map: (row: FactRow) => T,
  ): Promise<SlaPage<T>> {
    const scope = scopeSchema.parse(rawScope)
    const input = listInputSchema.parse(rawInput)
    const { rows, nextCursor } = await readPage(em, table, columns, scope, input)
    return { items: rows.map(map), nextCursor, highWatermark: input.through }
  }

  return {
    async captureHighWatermark(rawScope) {
      const scope = scopeSchema.parse(rawScope)
      // The greatest key across ALL three tables, so one watermark bounds every
      // list call in a sync run and the three streams stay mutually consistent.
      const branches = FACT_TABLES.map(
        (table) =>
          `(select "occurred_at", "id" from "${table}"
             where "tenant_id" = ? and "organization_id" = ?
             order by "occurred_at" desc, "id" desc limit 1)`,
      ).join(' union all ')
      const params = FACT_TABLES.flatMap(() => [scope.tenantId, scope.organizationId])
      const rows = (await em.execute(
        `select "occurred_at", "id" from (${branches}) as "candidates"
          order by "occurred_at" desc, "id" desc limit 1`,
        params,
      )) as FactRow[]
      const row = rows[0]
      if (!row) return CONNECT_SLA_EPOCH_CURSOR
      return { occurredAt: toIso(row.occurred_at, 'occurred_at'), id: toUuid(row.id, 'id') }
    },

    listGenerations(scope, input) {
      return page(
        'connect_case_generation_facts',
        `"case_id", "generation", "channel_id", "started_at", "resolved_at", "merged_into_case_id", "lineage_version", "created_at"`,
        scope,
        input,
        (row) => ({
          id: toUuid(row.id, 'id'),
          caseId: toUuid(row.case_id, 'case_id'),
          generation: toInteger(row.generation, 'generation'),
          channelId: toUuid(row.channel_id, 'channel_id'),
          startedAt: toIso(row.started_at, 'started_at'),
          resolvedAt: toNullableIso(row.resolved_at, 'resolved_at'),
          mergedIntoCaseId: toNullableUuid(row.merged_into_case_id, 'merged_into_case_id'),
          lineageVersion: toInteger(row.lineage_version, 'lineage_version'),
          updatedAt: toIso(row.created_at, 'created_at'),
        }),
      )
    },

    listWaitIntervals(scope, input) {
      return page(
        'connect_case_wait_facts',
        `"case_id", "generation", "started_at", "ended_at"`,
        scope,
        input,
        (row) => ({
          id: toUuid(row.id, 'id'),
          caseId: toUuid(row.case_id, 'case_id'),
          generation: toInteger(row.generation, 'generation'),
          startedAt: toIso(row.started_at, 'started_at'),
          endedAt: toNullableIso(row.ended_at, 'ended_at'),
        }),
      )
    },

    listConfirmedDeliveries(scope, input) {
      return page(
        'connect_outbound_delivery_facts',
        `"case_id", "generation", "outbound_message_id", "attempt_id", "delivery_revision", "confirmed_at", "response_evidence", "response_evidence_version", "author_user_id", "accepted_by_user_id"`,
        scope,
        input,
        (row) => {
          // A value outside the closed set is a corrupted row, not something to
          // coerce: silently mapping it to `unknown` would let a bad write look
          // like ordinary missing evidence.
          const evidence = evidenceSchema.safeParse(row.response_evidence)
          if (!evidence.success) throw internalError('malformed_response_evidence')
          const version = toInteger(row.response_evidence_version, 'response_evidence_version')
          if (version !== 1) throw internalError('malformed_response_evidence_version')
          return {
            id: toUuid(row.id, 'id'),
            caseId: toUuid(row.case_id, 'case_id'),
            generation: toInteger(row.generation, 'generation'),
            outboundMessageId: toUuid(row.outbound_message_id, 'outbound_message_id'),
            attemptId: toUuid(row.attempt_id, 'attempt_id'),
            deliveryRevision: toInteger(row.delivery_revision, 'delivery_revision'),
            confirmedAt: toIso(row.confirmed_at, 'confirmed_at'),
            responseEvidence: evidence.data,
            responseEvidenceVersion: 1 as const,
            authorUserId: toNullableUuid(row.author_user_id, 'author_user_id'),
            acceptedByUserId: toNullableUuid(row.accepted_by_user_id, 'accepted_by_user_id'),
          }
        },
      )
    },

    async canReadCase(rawScope, caseId) {
      const scope = scopeSchema.parse(rawScope)
      const userId = z.string().uuid().safeParse(rawScope.userId)
      const target = z.string().uuid().safeParse(caseId)
      if (!userId.success || !target.success) return false

      const found = await em.findOne(ConnectCase, {
        id: target.data,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
      if (!found) return false

      // Fails CLOSED when RBAC is unavailable: an empty grant set denies every
      // branch of the Case access matrix. A reporting consumer must never be
      // the reason someone sees a Case they cannot open in the Inbox.
      const features = await resolveGrantedFeatures(container, userId.data, scope)
      return evaluateCaseAccess(found, { ...scope, userId: userId.data, features }).canRead
    },
  }
}

type RbacLike = {
  getGrantedFeatures: (
    userId: string,
    opts: { tenantId: string | null; organizationId: string | null },
  ) => Promise<string[]>
}

async function resolveGrantedFeatures(
  container: AppContainer,
  userId: string,
  scope: SlaReaderScope,
): Promise<string[]> {
  try {
    const rbac = container.resolve<RbacLike | undefined>('rbacService')
    if (typeof rbac?.getGrantedFeatures !== 'function') return []
    const granted = await rbac.getGrantedFeatures(userId, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
    return Array.isArray(granted) ? granted.filter((feature) => typeof feature === 'string') : []
  } catch {
    return []
  }
}
