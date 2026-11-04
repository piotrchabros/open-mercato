import type { EntityManager } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { MetaLeadEvent, type MetaPage } from '../data/entities'
import type { MetaLeadEventSource, MetaLeadEventStatus } from './constants'

export type InsertLeadEventInput = {
  metaLeadId: string
  metaPageId: string
  metaFormId: string
  page: MetaPage | null
  source: MetaLeadEventSource
  rawNotification?: Record<string, unknown> | null
  rawPayload?: Record<string, unknown> | null
  submittedAt?: Date | null
  adId?: string | null
  formId?: string | null
}

export type InsertLeadEventResult = {
  outcome: 'inserted' | 'duplicate'
  leadEventId: string | null
  status: 'received' | 'unrouted' | null
}

export const LEAD_EVENT_TRANSITIONS: Readonly<Record<MetaLeadEventStatus, readonly MetaLeadEventStatus[]>> = {
  received: ['processing'],
  processing: ['processed', 'duplicate', 'skipped', 'retrying', 'failed', 'dead_lettered'],
  retrying: ['processing'],
  failed: ['received'],
  dead_lettered: ['received'],
  processed: ['processed'],
  duplicate: [],
  skipped: [],
  unrouted: [],
}

export const CLAIMABLE_LEAD_EVENT_STATUSES: readonly MetaLeadEventStatus[] = ['received', 'retrying']

export const MANUALLY_RETRYABLE_LEAD_EVENT_STATUSES: readonly MetaLeadEventStatus[] = ['failed', 'dead_lettered']

export function canTransitionLeadEvent(from: MetaLeadEventStatus, to: MetaLeadEventStatus): boolean {
  return LEAD_EVENT_TRANSITIONS[from].includes(to)
}

export function isManuallyRetryableLeadEvent(status: MetaLeadEventStatus): boolean {
  return MANUALLY_RETRYABLE_LEAD_EVENT_STATUSES.includes(status)
}

export function isLeadEventUniqueViolation(error: unknown): boolean {
  if (error instanceof UniqueConstraintViolationException) return true
  if (!error || typeof error !== 'object') return false
  return (error as { code?: string }).code === '23505'
}

export async function insertLeadEvent(em: EntityManager, input: InsertLeadEventInput): Promise<InsertLeadEventResult> {
  const fork = em.fork()
  const page = input.page
  const status: 'received' | 'unrouted' = page ? 'received' : 'unrouted'
  const row = fork.create(MetaLeadEvent, {
    tenantId: page ? page.tenantId : null,
    organizationId: page ? page.organizationId : null,
    metaLeadId: input.metaLeadId,
    metaPageId: input.metaPageId,
    metaFormId: input.metaFormId,
    pageId: page ? page.id : null,
    formId: page ? input.formId ?? null : null,
    adId: input.adId ?? null,
    submittedAt: input.submittedAt ?? null,
    source: input.source,
    rawNotification: page ? input.rawNotification ?? null : null,
    rawPayload: page ? input.rawPayload ?? null : null,
    status,
  })
  try {
    fork.persist(row)
    await fork.flush()
  } catch (error) {
    if (isLeadEventUniqueViolation(error)) {
      return { outcome: 'duplicate', leadEventId: null, status: null }
    }
    throw error
  }
  return { outcome: 'inserted', leadEventId: row.id, status }
}
