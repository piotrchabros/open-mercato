import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ActionLogService } from '@open-mercato/core/modules/audit_logs/services/actionLogService'
import { MetaConnection, MetaPage } from '../../../data/entities'
import { getMetaGraphClient, MetaGraphError, type MetaGraphClient } from '../../../lib/graph-client'
import { errorResponse, handleRouteError, jsonResponse, resolveRouteContext, runGuards, tryResolve } from '../../../lib/http'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../../lib/preset'
import { errorBodySchema, optimisticLockConflictSchema } from '../../openapi'

const RESOURCE_KIND = 'meta_lead_ads.meta_connection'

const logger = createLogger('meta_lead_ads').child({ component: 'connections' })

const idSchema = z.string().uuid()

export const metadata = {
  DELETE: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

export async function DELETE(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const { id } = await routeCtx.params
    const notFound = () =>
      errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    const parsedId = idSchema.safeParse(id)
    if (!parsedId.success) return notFound()

    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const connection = await findOneWithDecryption(
      ctx.em,
      MetaConnection,
      { id: parsedId.data, tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (!connection) return notFound()

    enforceCommandOptimisticLock({
      resourceKind: RESOURCE_KIND,
      resourceId: connection.id,
      current: connection.updatedAt,
      request: req,
    })

    const guard = await runGuards(ctx, req, {
      resourceKind: RESOURCE_KIND,
      resourceId: connection.id,
      operation: 'delete',
    })
    if (!guard.ok) return guard.response

    const pages = await findWithDecryption(
      ctx.em,
      MetaPage,
      {
        connectionId: connection.id,
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        deletedAt: null,
      },
      undefined,
      scope,
    )

    const graph = tryResolve<MetaGraphClient>(ctx.container, 'metaGraphClient') ?? getMetaGraphClient()
    const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(ctx.container, scope))
    for (const page of pages) {
      if (!page.pageAccessToken) continue
      try {
        await graph.unsubscribePage(page.metaPageId, page.pageAccessToken, graphOptions)
      } catch (err) {
        logger.warn('Page unsubscribe failed during disconnect', {
          pageId: page.id,
          status: err instanceof MetaGraphError ? err.status : null,
          graphCode: err instanceof MetaGraphError ? err.code : null,
          graphSubcode: err instanceof MetaGraphError ? err.subcode : null,
          errorClass: err instanceof MetaGraphError ? err.classification.errorClass : 'unknown',
        })
      }
    }

    const now = new Date()
    for (const page of pages) {
      page.pageAccessToken = null
      page.subscriptionStatus = 'unsubscribed'
      page.deletedAt = now
    }
    connection.userAccessToken = null
    connection.status = 'disconnected'
    connection.deletedAt = now
    await ctx.em.flush()

    const actionLogService = tryResolve<ActionLogService>(ctx.container, 'actionLogService')
    if (actionLogService) {
      try {
        await actionLogService.log({
          tenantId: ctx.tenantId,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          commandId: 'meta_lead_ads.connection.disconnect',
          actionLabel: ctx.translate('meta_lead_ads.connections.audit.disconnect', 'Disconnect Meta account'),
          resourceKind: RESOURCE_KIND,
          resourceId: connection.id,
          context: { unsubscribedPages: pages.length },
        })
      } catch (err) {
        logger.warn('Audit log write failed for disconnect', {
          errorName: err instanceof Error ? err.name : 'unknown',
        })
      }
    }

    await guard.runAfterSuccess()
    return jsonResponse({ ok: true, unsubscribedPages: pages.length })
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta connection',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    DELETE: {
      summary: 'Disconnect a Meta account',
      description:
        'Unsubscribes every page of the connection from the app (best effort), clears all stored tokens, marks the connection disconnected and soft-deletes it with its pages. Lead events and CRM records are kept. Send the optimistic-lock header with the last known updatedAt.',
      responses: [
        {
          status: 200,
          description: 'Disconnected',
          schema: z.object({ ok: z.literal(true), unsubscribedPages: z.number().int() }),
        },
      ],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Connection not found', schema: errorBodySchema },
        { status: 409, description: 'Optimistic lock conflict', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
