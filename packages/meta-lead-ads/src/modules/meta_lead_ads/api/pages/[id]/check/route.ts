import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaPage } from '../../../../data/entities'
import { PAGE_SUBSCRIPTION_STATUSES } from '../../../../lib/constants'
import { getMetaGraphClient, MetaGraphError, type MetaGraphClient } from '../../../../lib/graph-client'
import { errorResponse, handleRouteError, jsonResponse, resolveRouteContext, runGuards, tryResolve } from '../../../../lib/http'
import { applyPageStatus, describeGraphError, verifyPageSubscription } from '../../../../lib/page-service'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../../../lib/preset'
import { errorBodySchema } from '../../../openapi'

const RESOURCE_KIND = 'meta_lead_ads.meta_page'

const idSchema = z.string().uuid()

const checkResponseSchema = z.object({
  id: z.string().uuid(),
  subscriptionStatus: z.enum(PAGE_SUBSCRIPTION_STATUSES),
  statusCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
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

    const guard = await runGuards(ctx, req, {
      resourceKind: RESOURCE_KIND,
      resourceId: page.id,
      operation: 'custom',
    })
    if (!guard.ok) return guard.response

    const graph = tryResolve<MetaGraphClient>(ctx.container, 'metaGraphClient') ?? getMetaGraphClient()
    const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(ctx.container, scope))
    let verified: Awaited<ReturnType<typeof verifyPageSubscription>>
    try {
      verified = await verifyPageSubscription(
        graph,
        { metaPageId: page.metaPageId, pageAccessToken: page.pageAccessToken },
        graphOptions,
      )
    } catch (err) {
      if (err instanceof MetaGraphError) {
        page.lastError = describeGraphError(err.classification)
        await ctx.em.flush()
      }
      throw err
    }

    await applyPageStatus(
      { resolve: <T = unknown>(name: string) => ctx.container.resolve<T>(name), em: ctx.em },
      page,
      verified,
    )

    await guard.runAfterSuccess()
    return jsonResponse({
      id: page.id,
      subscriptionStatus: page.subscriptionStatus,
      statusCheckedAt: page.statusCheckedAt ? page.statusCheckedAt.toISOString() : null,
      lastError: page.lastError ?? null,
      updatedAt: page.updatedAt.toISOString(),
    })
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Check a Meta page',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    POST: {
      summary: 'Re-verify a page subscription and Leads Access',
      description:
        'Checks the leadgen webhook subscription and probes Leads Access with the stored page token, then stores the resulting status. Emits meta_lead_ads.page.status_changed when the status differs. A Meta error that does not map to a page status answers 502 and leaves the status unchanged.',
      responses: [{ status: 200, description: 'Page status', schema: checkResponseSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Page not found', schema: errorBodySchema },
        { status: 502, description: 'Meta returned an error', schema: errorBodySchema },
      ],
    },
  },
}
