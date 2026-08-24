import type { ConnectCaseSlaReader, SlaCursor, SlaDeliveryDto, SlaGenerationDto, SlaWaitDto } from '../../connect/lib/sla-source-reader'
import type { SlaRebuildStatus } from '../data/entities'
import type { RebuildCursorState, RebuildSink, SlaScope } from './async'

export type RebuildRunState = SlaScope & {
  id: string
  commandKey: string
  reason: string
  watermark: SlaCursor | null
  cursors: RebuildCursorState
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  status: SlaRebuildStatus
  processedCount: number
  errorCount: number
  progressJobId: string | null
  internalVersion: number
}

export interface RebuildRunStore {
  findByCommand(scope: SlaScope, commandKey: string): Promise<RebuildRunState | null>
  findActive(scope: SlaScope, now: Date): Promise<RebuildRunState | null>
  create(run: RebuildRunState): Promise<boolean>
  find(scope: SlaScope, runId: string): Promise<RebuildRunState | null>
  claim(scope: SlaScope, runId: string, owner: string, now: Date, expiresAt: Date): Promise<RebuildRunState | null>
  checkpoint(scope: SlaScope, runId: string, owner: string, expectedVersion: number, stream: keyof RebuildCursorState, cursor: SlaCursor | null, processedDelta: number, expiresAt: Date): Promise<RebuildRunState | null>
  finish(scope: SlaScope, runId: string, owner: string, expectedVersion: number, status: 'completed' | 'failed' | 'cancelled', errorDelta: number): Promise<boolean>
}

export type RebuildRequestResult = { outcome: 'created' | 'replay'; run: RebuildRunState } | { outcome: 'overlap'; run: RebuildRunState }
export type RebuildProgress = { start: (id: string, scope: SlaScope) => Promise<void>; increment: (id: string, count: number, scope: SlaScope) => Promise<void>; isCancelled: (id: string, scope: SlaScope) => Promise<boolean>; complete: (id: string, scope: SlaScope) => Promise<void>; fail: (id: string, scope: SlaScope, error: unknown) => Promise<void>; cancelled: (id: string, scope: SlaScope) => Promise<void> }

export function createRebuildRunCoordinator(store: RebuildRunStore, reader: ConnectCaseSlaReader | null, createId: () => string) {
  return {
    async request(scope: SlaScope, input: { commandKey: string; reason: string; progressJobId: string | null }, now = new Date()): Promise<RebuildRequestResult | { outcome: 'dependency_unavailable' }> {
      const replay = await store.findByCommand(scope, input.commandKey)
      if (replay) return { outcome: 'replay', run: replay }
      if (!reader) return { outcome: 'dependency_unavailable' }
      const active = await store.findActive(scope, now)
      if (active) return { outcome: 'overlap', run: active }
      const watermark = await reader.captureHighWatermark(scope)
      const run: RebuildRunState = { ...scope, id: createId(), commandKey: input.commandKey, reason: input.reason, watermark, cursors: { generation: null, wait: null, delivery: null }, leaseOwner: null, leaseExpiresAt: null, status: 'pending', processedCount: 0, errorCount: 0, progressJobId: input.progressJobId, internalVersion: 1 }
      if (!(await store.create(run))) {
        const concurrentReplay = await store.findByCommand(scope, input.commandKey)
        if (concurrentReplay) return { outcome: 'replay', run: concurrentReplay }
        const concurrentActive = await store.findActive(scope, now)
        if (concurrentActive) return { outcome: 'overlap', run: concurrentActive }
        throw new Error('[internal] connect_sla_rebuild_create_conflict')
      }
      return { outcome: 'created', run }
    },
  }
}

export function createLeasedRebuildWorker(store: RebuildRunStore, reader: ConnectCaseSlaReader | null, sink: RebuildSink, progress: RebuildProgress | null = null, leaseMilliseconds = 60_000) {
  return {
    async run(scope: SlaScope, runId: string, owner: string, pageSize: number, now = new Date()): Promise<'completed' | 'cancelled' | 'lease_unavailable' | 'dependency_unavailable'> {
      if (!reader) return 'dependency_unavailable'
      let run = await store.claim(scope, runId, owner, now, new Date(now.getTime() + leaseMilliseconds))
      if (!run) return 'lease_unavailable'
      if (run.status === 'cancelled') return 'cancelled'
      if (!run.watermark) throw new Error('[internal] connect_sla_rebuild_watermark_missing')
      const through = run.watermark
      try {
        if (run.progressJobId) await progress?.start(run.progressJobId, scope)
        for (const stream of ['generation', 'wait', 'delivery'] as const) {
          let after = run.cursors[stream] ?? undefined
          while (true) {
            if (run.progressJobId && progress && await progress.isCancelled(run.progressJobId, scope)) {
              if (await store.finish(scope, runId, owner, run.internalVersion, 'cancelled', 0)) await progress.cancelled(run.progressJobId, scope)
              return 'cancelled'
            }
            const page = stream === 'generation'
              ? await reader.listGenerations(scope, { after, through, limit: pageSize })
              : stream === 'wait'
                ? await reader.listWaitIntervals(scope, { after, through, limit: pageSize })
                : await reader.listConfirmedDeliveries(scope, { after, through, limit: pageSize })
            for (const item of page.items) {
              if (stream === 'generation') await sink.applyGeneration(scope, item as SlaGenerationDto)
              else if (stream === 'wait') await sink.applyWait(scope, item as SlaWaitDto)
              else await sink.applyDelivery(scope, item as SlaDeliveryDto)
            }
            const checkpointed = await store.checkpoint(scope, runId, owner, run.internalVersion, stream, page.nextCursor, page.items.length, new Date(Date.now() + leaseMilliseconds))
            if (!checkpointed) {
              const current = await store.find(scope, runId)
              return current?.status === 'cancelled' ? 'cancelled' : 'lease_unavailable'
            }
            run = checkpointed
            if (run.progressJobId && page.items.length) await progress?.increment(run.progressJobId, page.items.length, scope)
            after = page.nextCursor ?? undefined
            if (!page.nextCursor) break
          }
        }
        const completed = await store.finish(scope, runId, owner, run.internalVersion, 'completed', 0)
        if (completed && run.progressJobId) await progress?.complete(run.progressJobId, scope)
        return completed ? 'completed' : 'lease_unavailable'
      } catch (error) {
        await store.finish(scope, runId, owner, run.internalVersion, 'failed', 1)
        if (run.progressJobId) await progress?.fail(run.progressJobId, scope, error)
        throw error
      }
    },
  }
}
