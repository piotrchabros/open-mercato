import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { MetaLeadEvent } from '../data/entities'
import { PURGE_BATCH } from './constants'

export type PurgeLeadEventPayloadsOptions = {
  clearHashes: boolean
  batchSize?: number
}

function pendingPurgeFilter(clearHashes: boolean): FilterQuery<MetaLeadEvent> {
  if (!clearHashes) return { payloadPurgedAt: null }
  return {
    $or: [{ payloadPurgedAt: null }, { emailHash: { $ne: null } }, { phoneHash: { $ne: null } }],
  }
}

export async function purgeLeadEventPayloads(
  em: EntityManager,
  where: FilterQuery<MetaLeadEvent>,
  opts: PurgeLeadEventPayloadsOptions,
): Promise<number> {
  const batchSize = Math.max(1, opts.batchSize ?? PURGE_BATCH)
  const filter: FilterQuery<MetaLeadEvent> = { $and: [where, pendingPurgeFilter(opts.clearHashes)] }
  let purged = 0
  for (;;) {
    const batch = await em
      .fork()
      .find(MetaLeadEvent, filter, { fields: ['id'], limit: batchSize, orderBy: { id: 'asc' } })
    if (batch.length === 0) break
    const now = new Date()
    const changes: Partial<MetaLeadEvent> = {
      rawPayload: null,
      rawNotification: null,
      payloadPurgedAt: now,
      updatedAt: now,
    }
    if (opts.clearHashes) {
      changes.emailHash = null
      changes.phoneHash = null
    }
    const affected = await em.nativeUpdate(
      MetaLeadEvent,
      { $and: [{ id: { $in: batch.map((row) => row.id) } }, pendingPurgeFilter(opts.clearHashes)] },
      changes,
    )
    purged += affected
    if (affected === 0 || batch.length < batchSize) break
  }
  return purged
}
