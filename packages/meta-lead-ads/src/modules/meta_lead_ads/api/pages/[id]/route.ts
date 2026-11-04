import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ActionLogService } from '@open-mercato/core/modules/audit_logs/services/actionLogService'
import { MetaForm, MetaPage } from '../../../data/entities'
import { getMetaGraphClient, MetaGraphError, type MetaGraphClient } from '../../../lib/graph-client'
import { errorResponse, handleRouteError, jsonResponse, resolveRouteContext, runGuards, tryResolve } from '../../../lib/http'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../../lib/preset'
import { errorBodySchema, optimisticLockConflictSchema } from '../../openapi'

const RESOURCE_KIND = 'meta_lead_ads.meta_page'

const logger = createLogger('meta_lead_ads').child({ component: 'pages' })

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
    const page = await findOneWithDecryption(
      ctx.em,
      MetaPage,
      { id: parsedId.data, tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (!page) return notFound()

    enforceCommandOptimisticLock({
      resourceKind: RESOURCE_KIND,
      resourceId: page.id,
      current: page.updatedAt,
      request: req,
    })

    const guard = await runGuards(ctx, req, {
      resourceKind: RESOURCE_KIND,
      resourceId: page.id,
      operation: 'delete',
    })
    if (!guard.ok) return guard.response

    if (page.pageAccessToken) {
      const graph = tryResolve<MetaGraphClient>(ctx.container, 'metaGraphClient') ?? getMetaGraphClient()
      const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(ctx.container, scope))
      try {
        await graph.unsubscribePage(page.metaPageId, page.pageAccessToken, graphOptions)
      } catch (err) {
        logger.warn('Page unsubscribe failed during unassignment', {
          pageId: page.id,
          status: err instanceof MetaGraphError ? err.status : null,
          graphCode: err instanceof MetaGraphError ? err.code : null,
          graphSubcode: err instanceof MetaGraphError ? err.subcode : null,
          errorClass: err instanceof MetaGraphError ? err.classification.errorClass : 'unknown',
        })
      }
    }

    const forms = await ctx.em.find(MetaForm, {
      pageId: page.id,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      deletedAt: null,
    })
    const now = new Date()
    for (const form of forms) {
      form.deletedAt = now
    }
    page.pageAccessToken = null
    page.subscriptionStatus = 'unsubscribed'
    page.deletedAt = now
    await ctx.em.flush()

    const actionLogService = tryResolve<ActionLogService>(ctx.container, 'actionLogService')
    if (actionLogService) {
      try {
        await actionLogService.log({
          tenantId: ctx.tenantId,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          commandId: 'meta_lead_ads.page.unassign',
          actionLabel: ctx.translate('meta_lead_ads.pages.audit.unassign', 'Unassign Facebook page'),
          resourceKind: RESOURCE_KIND,
          resourceId: page.id,
          context: { removedForms: forms.length },
        })
      } catch (err) {
        logger.warn('Audit log write failed for page unassignment', {
          errorName: err instanceof Error ? err.name : 'unknown',
        })
      }
    }

    await guard.runAfterSuccess()
    return jsonResponse({ ok: true })
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta page',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    DELETE: {
      summary: 'Unassign a Facebook page',
      description:
        'Unsubscribes the page from the app (best effort), clears its stored token, marks it unsubscribed and soft-deletes it with its forms. Lead events keep their page reference. Send the optimistic-lock header with the last known updatedAt.',
      responses: [{ status: 200, description: 'Page unassigned', schema: z.object({ ok: z.literal(true) }) }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Page not found', schema: errorBodySchema },
        { status: 409, description: 'Optimistic lock conflict', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
