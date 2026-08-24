import type { EntityManager } from '@mikro-orm/postgresql'
import { raw } from '@mikro-orm/core'
import { RebuildRun } from '../data/entities'
import type { RebuildRunState, RebuildRunStore } from './rebuild-runs'
import type { RebuildCursorState, SlaScope } from './async'
import type { SlaCursor } from '../../connect/lib/sla-source-reader'

export function createMikroRebuildRunStore(em: EntityManager): RebuildRunStore {
  return {
    async findByCommand(scope, commandKey) { return mapRun(await em.findOne(RebuildRun, { ...scope, commandKey })) },
    async findActive(scope, now) { return mapRun(await em.findOne(RebuildRun, { ...scope, status: { $in: ['pending', 'running'] }, $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $gt: now } }] }, { orderBy: { createdAt: 'asc' } })) },
    async create(state) {
      const { cursors, watermark, ...values } = state
      const run = em.create(RebuildRun, { ...values, watermark: encodeCursor(watermark), generationCursor: encodeCursor(cursors.generation), waitCursor: encodeCursor(cursors.wait), deliveryCursor: encodeCursor(cursors.delivery) })
      em.persist(run)
      try { await em.flush(); return true } catch { em.remove(run); return false }
    },
    async find(scope, runId) { return mapRun(await em.findOne(RebuildRun, { ...scope, id: runId })) },
    async claim(scope, runId, owner, now, expiresAt) {
      await em.nativeUpdate(RebuildRun, { ...scope, id: runId, status: { $in: ['pending', 'running'] }, $or: [{ leaseOwner: owner }, { leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] }, { status: 'running', leaseOwner: owner, leaseExpiresAt: expiresAt, internalVersion: raw('"internal_version" + 1') })
      em.clear()
      return mapRun(await em.findOne(RebuildRun, { ...scope, id: runId, leaseOwner: owner, status: 'running' }))
    },
    async checkpoint(scope, runId, owner, expectedVersion, stream, cursor, processedDelta, expiresAt) {
      const field = stream === 'generation' ? 'generationCursor' : stream === 'wait' ? 'waitCursor' : 'deliveryCursor'
      const changed = await em.nativeUpdate(RebuildRun, { ...scope, id: runId, status: 'running', leaseOwner: owner, internalVersion: expectedVersion }, { [field]: encodeCursor(cursor), processedCount: raw(`"processed_count" + ${processedDelta}`), leaseExpiresAt: expiresAt, internalVersion: expectedVersion + 1 })
      if (!changed) return null
      em.clear()
      return mapRun(await em.findOne(RebuildRun, { ...scope, id: runId }))
    },
    async finish(scope, runId, owner, expectedVersion, status, errorDelta) {
      const changed = await em.nativeUpdate(RebuildRun, { ...scope, id: runId, status: 'running', leaseOwner: owner, internalVersion: expectedVersion }, { status, errorCount: raw(`"error_count" + ${errorDelta}`), leaseOwner: null, leaseExpiresAt: null, internalVersion: expectedVersion + 1 })
      return changed > 0
    },
  }
}

function mapRun(run: RebuildRun | null): RebuildRunState | null {
  if (!run) return null
  return { tenantId: run.tenantId, organizationId: run.organizationId, id: run.id, commandKey: run.commandKey, reason: run.reason, watermark: decodeCursor(run.watermark), cursors: { generation: decodeCursor(run.generationCursor), wait: decodeCursor(run.waitCursor), delivery: decodeCursor(run.deliveryCursor) }, leaseOwner: run.leaseOwner, leaseExpiresAt: run.leaseExpiresAt, status: run.status, processedCount: run.processedCount, errorCount: run.errorCount, progressJobId: run.progressJobId, internalVersion: run.internalVersion }
}
function encodeCursor(cursor: SlaCursor | null): string | null { return cursor ? JSON.stringify(cursor) : null }
function decodeCursor(value: string | null): SlaCursor | null { if (!value) return null; const parsed = JSON.parse(value) as Record<string, unknown>; return typeof parsed.occurredAt === 'string' && typeof parsed.id === 'string' ? { occurredAt: parsed.occurredAt, id: parsed.id } : null }
