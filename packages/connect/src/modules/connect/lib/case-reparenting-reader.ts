import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase, ConnectCaseReparenting } from '../data/entities'
import type {
  ConnectLineageInstruction,
  ConnectReparentOperation,
} from '../data/entities'
import {
  REPARENT_LINEAGE_VERSION,
  lineageInstructionFor,
  type ReparentCaseSnapshotV1,
} from './case-reparenting'

/**
 * The read facade optional consumers use, and the ONLY Connect surface they may
 * touch.
 *
 * A consumer such as an SLA module reacts to reparenting events; when it needs
 * to reconcile after a missed one it reads through this facade instead of
 * querying Connect tables or importing Connect entity classes. That is what
 * keeps the coupling one-way: Connect publishes and answers, and never resolves
 * a consumer.
 *
 * Two properties are load-bearing. Every method demands BOTH tenant and
 * organization and puts both in the query — a facade that accepted a bare id
 * would be a cross-organization read primitive handed to third-party code. And
 * every projection is a plain identifier/enum/timestamp object: no subject, no
 * wrap-up, no display label, no handle, no actor name, and no decrypted reason.
 * A consumer reconciling clocks has no business reading a customer's words.
 */

export type ConnectReparentingScope = Readonly<{ tenantId: string; organizationId: string }>
export type ConnectReparentingCursor = Readonly<{ occurredAt: string; id: string }>

export type ConnectReparentingProjection = Readonly<{
  id: string
  operation: ConnectReparentOperation
  sourceCaseId: string
  destinationCaseId: string
  reversesReparentingId: string | null
  lineageInstruction: ConnectLineageInstruction
  lineageVersion: typeof REPARENT_LINEAGE_VERSION
  movedConversationCount: number
  sourceSlaGeneration: number
  destinationSlaGeneration: number
  sourceBefore: ReparentCaseSnapshotV1
  destinationBefore: ReparentCaseSnapshotV1 | null
  sourcePostUpdatedAt: string
  destinationPostUpdatedAt: string
  sourceEventId: string
  occurredAt: string
}>

export type ConnectReparentingPage = Readonly<{
  items: readonly ConnectReparentingProjection[]
  nextCursor: ConnectReparentingCursor | null
}>

export type ConnectCaseLineageOperation = Readonly<
  Pick<
    ConnectReparentingProjection,
    'id' | 'operation' | 'sourceCaseId' | 'destinationCaseId' | 'reversesReparentingId' | 'occurredAt'
  >
>

export type ConnectCaseLineageProjection = Readonly<{
  caseId: string
  mergedIntoCaseId: string | null
  splitFromCaseId: string | null
  lineageVersion: number
  operations: readonly ConnectCaseLineageOperation[]
}>

export type ConnectCaseReparentingReader = {
  getById(scope: ConnectReparentingScope, id: string): Promise<ConnectReparentingProjection | null>
  listAfter(
    scope: ConnectReparentingScope,
    cursor: ConnectReparentingCursor | null,
    limit: number,
  ): Promise<ConnectReparentingPage>
  getCaseLineage(
    scope: ConnectReparentingScope,
    caseId: string,
  ): Promise<ConnectCaseLineageProjection | null>
}

export const CONNECT_REPARENTING_PAGE_LIMIT = 100

type ItemCountRow = { reparenting_id: string; moved: string | number }

/**
 * Item counts for a batch of reparenting rows.
 *
 * Grouped in one pass rather than counted per row: `listAfter` is what a
 * reconciling consumer calls in a loop, and a per-row count would make a
 * hundred-row page a hundred extra round trips.
 */
async function countItems(
  em: EntityManager,
  scope: ConnectReparentingScope,
  reparentingIds: string[],
): Promise<Map<string, number>> {
  if (!reparentingIds.length) return new Map()
  const placeholders = reparentingIds.map(() => '?').join(', ')
  const rows = (await em.execute(
    `select "reparenting_id", count(*) as "moved"
       from "connect_case_reparenting_items"
      where "tenant_id" = ? and "organization_id" = ?
        and "reparenting_id" in (${placeholders})
      group by "reparenting_id"`,
    [scope.tenantId, scope.organizationId, ...reparentingIds],
  )) as ItemCountRow[]
  return new Map(rows.map((row) => [row.reparenting_id, Number(row.moved ?? 0)]))
}

function projectRow(row: ConnectCaseReparenting, movedConversationCount: number): ConnectReparentingProjection {
  const sourceBefore = row.sourceBefore as unknown as ReparentCaseSnapshotV1
  const destinationBefore = (row.destinationBefore ?? null) as unknown as ReparentCaseSnapshotV1 | null
  return Object.freeze({
    id: row.id,
    operation: row.operation,
    sourceCaseId: row.sourceCaseId,
    destinationCaseId: row.destinationCaseId,
    reversesReparentingId: row.reversesReparentingId ?? null,
    lineageInstruction: lineageInstructionFor(row.operation),
    lineageVersion: REPARENT_LINEAGE_VERSION,
    movedConversationCount,
    sourceSlaGeneration: sourceBefore.slaGeneration,
    destinationSlaGeneration: destinationBefore?.slaGeneration ?? sourceBefore.slaGeneration,
    sourceBefore,
    destinationBefore,
    sourcePostUpdatedAt: row.sourcePostUpdatedAt.toISOString(),
    destinationPostUpdatedAt: row.destinationPostUpdatedAt.toISOString(),
    // The reparenting id IS the source event id. One identifier means a consumer
    // that deduplicates the event and one that reconciles through this facade
    // agree on what "the same operation" is.
    sourceEventId: row.id,
    occurredAt: row.occurredAt.toISOString(),
  })
}

export function createConnectCaseReparentingReader(em: EntityManager): ConnectCaseReparentingReader {
  return {
    async getById(scope, id) {
      const forked = em.fork()
      const row = await forked.findOne(ConnectCaseReparenting, {
        id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      if (!row) return null
      const counts = await countItems(forked, scope, [row.id])
      return projectRow(row, counts.get(row.id) ?? 0)
    },

    async listAfter(scope, cursor, limit) {
      const forked = em.fork()
      const pageSize = Math.max(1, Math.min(limit, CONNECT_REPARENTING_PAGE_LIMIT))
      const where: Record<string, unknown> = {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      }
      if (cursor) {
        // Keyset, not offset. A reconciling consumer pages while new corrections
        // are being made; an offset page would skip or repeat rows as the set
        // grows underneath it.
        const at = new Date(cursor.occurredAt)
        where.$or = [
          { occurredAt: { $gt: at } },
          { occurredAt: at, id: { $gt: cursor.id } },
        ]
      }
      const rows = await forked.find(ConnectCaseReparenting, where, {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit: pageSize + 1,
      })
      const page = rows.slice(0, pageSize)
      const counts = await countItems(forked, scope, page.map((row) => row.id))
      const last = page[page.length - 1]
      return Object.freeze({
        items: page.map((row) => projectRow(row, counts.get(row.id) ?? 0)),
        nextCursor:
          rows.length > pageSize && last
            ? Object.freeze({ occurredAt: last.occurredAt.toISOString(), id: last.id })
            : null,
      })
    },

    async getCaseLineage(scope, caseId) {
      const forked = em.fork()
      const row = await forked.findOne(ConnectCase, {
        id: caseId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
      if (!row) return null
      const operations = await forked.find(
        ConnectCaseReparenting,
        {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          $or: [{ sourceCaseId: caseId }, { destinationCaseId: caseId }],
        },
        { orderBy: { occurredAt: 'asc', id: 'asc' }, limit: CONNECT_REPARENTING_PAGE_LIMIT },
      )
      return Object.freeze({
        caseId: row.id,
        mergedIntoCaseId: row.mergedIntoCaseId ?? null,
        splitFromCaseId: row.splitFromCaseId ?? null,
        lineageVersion: row.lineageVersion,
        operations: operations.map((operation) =>
          Object.freeze({
            id: operation.id,
            operation: operation.operation,
            sourceCaseId: operation.sourceCaseId,
            destinationCaseId: operation.destinationCaseId,
            reversesReparentingId: operation.reversesReparentingId ?? null,
            occurredAt: operation.occurredAt.toISOString(),
          }),
        ),
      })
    },
  }
}
