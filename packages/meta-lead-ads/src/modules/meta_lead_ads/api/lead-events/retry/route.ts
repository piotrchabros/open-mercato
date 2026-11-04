import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { MetaLeadEvent } from '../../../data/entities'
import { retrySchema } from '../../../data/validators'
import { MANUALLY_RETRYABLE_LEAD_EVENT_STATUSES } from '../../../lib/lead-events'
import { enqueueProcessLead } from '../../../lib/queue'
import {
  handleRouteError,
  jsonResponse,
  parseJsonBody,
  resolveRouteContext,
  runGuards,
  tryResolve,
} from '../../../lib/http'
import { errorBodySchema } from '../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

const RESOURCE_KIND = 'meta_lead_ads.lead_event'

type SkipReason = 'not_retryable' | 'not_found'

type ActionLogServiceLike = {
  log: (input: {
    tenantId: string
    organizationId: string
    actorUserId?: string
    commandId: string
    actionLabel?: string
    resourceKind?: string
    resourceId?: string
    context?: Record<string, unknown>
  }) => Promise<unknown>
}

const retryResponseSchema = z.object({
  enqueued: z.number().int(),
  skipped: z.array(z.object({ id: z.string().uuid(), reason: z.enum(['not_retryable', 'not_found']) })),
})

export async function POST(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const { ids } = await parseJsonBody(req, retrySchema)
    const uniqueIds = [...new Set(ids)]
    const guard = await runGuards(ctx, req, {
      resourceKind: RESOURCE_KIND,
      operation: 'custom',
      mutationPayload: { ids: uniqueIds },
    })
    if (!guard.ok) return guard.response

    const scopeWhere = { tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null }
    const events = await ctx.em.find(
      MetaLeadEvent,
      { ...scopeWhere, id: { $in: uniqueIds } },
      { fields: ['id', 'status', 'manualRetryCount'] },
    )
    const eventById = new Map(events.map((event) => [event.id, event]))
    const skipped: { id: string; reason: SkipReason }[] = []
    const retriedIds: string[] = []

    for (const id of uniqueIds) {
      const event = eventById.get(id)
      if (!event) {
        skipped.push({ id, reason: 'not_found' })
        continue
      }
      if (!MANUALLY_RETRYABLE_LEAD_EVENT_STATUSES.includes(event.status)) {
        skipped.push({ id, reason: 'not_retryable' })
        continue
      }
      const affected = await ctx.em.nativeUpdate(
        MetaLeadEvent,
        { ...scopeWhere, id, status: { $in: [...MANUALLY_RETRYABLE_LEAD_EVENT_STATUSES] } },
        {
          status: 'received',
          attemptCount: 0,
          manualRetryCount: event.manualRetryCount + 1,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastError: null,
          updatedAt: new Date(),
        },
      )
      if (affected === 0) {
        skipped.push({ id, reason: 'not_retryable' })
        continue
      }
      await enqueueProcessLead({ leadEventId: id, tenantId: ctx.tenantId, organizationId: ctx.organizationId })
      retriedIds.push(id)
    }

    await guard.runAfterSuccess()
    if (retriedIds.length > 0) {
      const actionLogService = tryResolve<ActionLogServiceLike>(ctx.container, 'actionLogService')
      await actionLogService?.log({
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        commandId: 'meta_lead_ads.lead.retry',
        actionLabel: ctx.translate('meta_lead_ads.leads.retry.auditLabel', 'Retry Meta leads'),
        resourceKind: RESOURCE_KIND,
        context: { leadEventIds: retriedIds },
      })
    }
    return jsonResponse({ enqueued: retriedIds.length, skipped })
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Retry Meta lead events',
  methods: {
    POST: {
      summary: 'Re-queue failed or dead-lettered lead events of the active organization',
      requestBody: { schema: retrySchema },
      responses: [{ status: 200, description: 'Retry result', schema: retryResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid body or missing organization scope', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 403, description: 'Missing meta_lead_ads.manage', schema: errorBodySchema },
      ],
    },
  },
}
