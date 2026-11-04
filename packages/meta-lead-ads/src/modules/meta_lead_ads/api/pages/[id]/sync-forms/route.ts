import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaPage } from '../../../../data/entities'
import { getMetaGraphClient, MetaGraphError, type MetaGraphClient } from '../../../../lib/graph-client'
import { errorResponse, handleRouteError, jsonResponse, resolveRouteContext, runGuards, tryResolve } from '../../../../lib/http'
import { applyGraphErrorSideEffects, syncPageForms } from '../../../../lib/page-service'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../../../lib/preset'
import { errorBodySchema } from '../../../openapi'

const RESOURCE_KIND = 'meta_lead_ads.meta_page'

const idSchema = z.string().uuid()

const syncFormsResponseSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  flagged: z.number().int(),
  total: z.number().int(),
})

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

export async function POST(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
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
    if (page.subscriptionStatus !== 'active' || !page.pageAccessToken) {
      return errorResponse(
        409,
        'page_not_active',
        ctx.translate('meta_lead_ads.errors.page_not_active', 'This page is not active. Check the page first.'),
      )
    }

    const guard = await runGuards(ctx, req, {
      resourceKind: RESOURCE_KIND,
      resourceId: page.id,
      operation: 'custom',
    })
    if (!guard.ok) return guard.response

    const graph = tryResolve<MetaGraphClient>(ctx.container, 'metaGraphClient') ?? getMetaGraphClient()
    const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(ctx.container, scope))
    let result: Awaited<ReturnType<typeof syncPageForms>>
    try {
      result = await syncPageForms({ em: ctx.em, graph, graphOptions }, page)
    } catch (err) {
      if (err instanceof MetaGraphError) {
        await applyGraphErrorSideEffects(
          { resolve: <T = unknown>(name: string) => ctx.container.resolve<T>(name), em: ctx.em },
          { page, connectionId: page.connectionId },
          err.classification,
        )
      }
      throw err
    }

    await guard.runAfterSuccess()
    return jsonResponse(result)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Sync Meta page forms',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    POST: {
      summary: 'Fetch the Instant Forms of a page',
      description:
        'Fetches the page forms and their questions from Meta. New forms are enabled with a default mapping; forms whose questions changed or that disappeared from Meta are flagged for attention.',
      responses: [{ status: 200, description: 'Sync result', schema: syncFormsResponseSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Page not found', schema: errorBodySchema },
        { status: 409, description: 'Page is not active', schema: errorBodySchema },
        { status: 502, description: 'Meta returned an error', schema: errorBodySchema },
      ],
    },
  },
}
