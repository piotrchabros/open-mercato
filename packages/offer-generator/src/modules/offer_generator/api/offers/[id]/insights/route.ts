import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { Offer } from '../../../../data/entities'
import {
  authenticateRequest,
  handleRouteError,
  noStoreJson,
  notFoundResponse,
  resolveRequestScope,
  unauthorizedResponse,
} from '../../../../lib/http'
import { getOfferInsights } from '../../../../lib/views-repository'
import { offerInsightsSchema } from '../../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
}

const logger = createLogger('offer_generator').child({ component: 'insights' })

const paramsSchema = z.object({ id: z.string().uuid() })

const errorBodySchema = z.object({ error: z.string(), code: z.string().optional() })

export async function GET(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const notFound = () => notFoundResponse(translate('offer_generator.errors.notFound', 'Not found'))
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
    const offer = await findOneWithDecryption(
      scope.em,
      Offer,
      { id: params.data.id, ...tenantScope, deletedAt: null },
      { fields: ['id'] },
      tenantScope,
    )
    if (!offer) return notFound()

    const insights = await getOfferInsights(scope.em, tenantScope, offer.id)
    return noStoreJson(insights)
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Offer insights request failed',
      code: 'offer_generator.insights_failed',
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Offer view insights',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Get view insights for an offer',
      description:
        'Aggregated public view statistics (internal views excluded from totals), the 200 newest view sessions and per-section dwell time.',
      responses: [{ status: 200, description: 'Offer insights', schema: offerInsightsSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer not found', schema: errorBodySchema },
      ],
    },
  },
}
