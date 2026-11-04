import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { MetaLeadEvent } from '../data/entities'
import { emitMetaLeadAdsEvent, META_LEAD_ADS_EVENTS } from '../events'
import {
  FETCH_FAILED_ALERT_ATTEMPT,
  MAX_AUTOMATIC_ATTEMPTS,
  RETRY_DELAYS_MS,
  type MetaScope,
} from './constants'
import type { TransientLeadError } from './errors'
import { notifyDeadLettered, notifyFetchFailed, type Resolver } from './notifier'
import { isTestOverrideAllowed, resolveAppCredentials } from './preset'
import { enqueueProcessLead } from './queue'
import { decryptionScope } from './scope'

const logger = createLogger('meta_lead_ads').child({ component: 'retry-policy' })

const RETRY_DELAYS_ENV_KEY = 'OM_META_LEAD_ADS_RETRY_DELAYS_MS'
const MAX_ERROR_LENGTH = 500

export type RetryDecision =
  | { kind: 'retry'; attemptCount: number; delayMs: number; nextAttemptAt: Date; sendFetchFailedAlert: boolean }
  | { kind: 'dead_letter'; attemptCount: number }

function parseDelayList(raw: string | null | undefined): number[] | null {
  if (!raw) return null
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length === 0 || parts.some((value) => !Number.isFinite(value) || value < 0)) return null
  return parts.map((value) => Math.floor(value))
}

export function resolveRetryDelays(
  input: { env?: NodeJS.ProcessEnv; credentialsValue?: string | null } = {},
): number[] {
  const env = input.env ?? process.env
  if (!isTestOverrideAllowed(env)) return [...RETRY_DELAYS_MS]
  const override = parseDelayList(input.credentialsValue) ?? parseDelayList(env[RETRY_DELAYS_ENV_KEY])
  return override ?? [...RETRY_DELAYS_MS]
}

export function decideRetry(input: { previousAttemptCount: number; now: Date; delays: number[] }): RetryDecision {
  const attemptCount = input.previousAttemptCount + 1
  if (attemptCount >= MAX_AUTOMATIC_ATTEMPTS) return { kind: 'dead_letter', attemptCount }
  const fallbackDelay = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
  const delayMs = input.delays[attemptCount - 1] ?? input.delays[input.delays.length - 1] ?? fallbackDelay
  return {
    kind: 'retry',
    attemptCount,
    delayMs,
    nextAttemptAt: new Date(input.now.getTime() + delayMs),
    sendFetchFailedAlert: attemptCount === FETCH_FAILED_ALERT_ATTEMPT,
  }
}

export async function applyTransientFailure(
  ctx: Resolver & { em: EntityManager },
  leadEventId: string,
  err: TransientLeadError,
  scope: MetaScope,
): Promise<RetryDecision> {
  const em = ctx.em.fork()
  const where = { id: leadEventId, tenantId: scope.tenantId, organizationId: scope.organizationId }
  const event = await findOneWithDecryption(em, MetaLeadEvent, where, undefined, decryptionScope(scope))
  if (!event) throw new Error('[internal] lead event not found')
  const now = new Date()
  const credentials = await resolveAppCredentials(ctx, scope)
  const delays = resolveRetryDelays({ credentialsValue: credentials.retryDelaysMs })
  const decision = decideRetry({ previousAttemptCount: event.attemptCount, now, delays })
  const errorFields = {
    lastErrorCode: err.leadErrorCode,
    lastError: err.message.slice(0, MAX_ERROR_LENGTH),
    updatedAt: now,
  }

  if (decision.kind === 'dead_letter') {
    await em.nativeUpdate(MetaLeadEvent, where, {
      ...errorFields,
      status: 'dead_lettered',
      attemptCount: decision.attemptCount,
      nextAttemptAt: null,
    })
    await notifyDeadLettered(ctx, {
      scope,
      leadEventId,
      metaLeadId: event.metaLeadId,
      errorCode: err.leadErrorCode,
    })
    await emitMetaLeadAdsEvent(META_LEAD_ADS_EVENTS.leadDeadLettered, {
      leadEventId,
      metaLeadId: event.metaLeadId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      formId: event.formId ?? null,
      pageId: event.pageId ?? null,
      errorCode: err.leadErrorCode,
      attemptCount: decision.attemptCount,
      firstFailedAt: event.createdAt.toISOString(),
      lastFailedAt: now.toISOString(),
    })
    logger.warn('lead event dead-lettered', { leadEventId, errorCode: err.leadErrorCode })
    return decision
  }

  await em.nativeUpdate(MetaLeadEvent, where, {
    ...errorFields,
    status: 'retrying',
    attemptCount: decision.attemptCount,
    nextAttemptAt: decision.nextAttemptAt,
  })
  await enqueueProcessLead(
    { leadEventId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { delayMs: decision.delayMs },
  )
  if (decision.sendFetchFailedAlert) {
    await notifyFetchFailed(ctx, {
      scope,
      leadEventId,
      metaLeadId: event.metaLeadId,
      attemptCount: decision.attemptCount,
    })
  }
  return decision
}
