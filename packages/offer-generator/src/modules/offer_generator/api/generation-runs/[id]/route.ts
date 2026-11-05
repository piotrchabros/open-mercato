import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { OfferGenerationRun } from '../../../data/entities'
import {
  authenticateRequest,
  handleRouteError,
  noStoreJson,
  notFoundResponse,
  resolveRequestScope,
  unauthorizedResponse,
} from '../../../lib/http'
import { serializeRun } from '../../../lib/serializers'
import { errorBodySchema, generationRunDtoSchema } from '../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
}

const logger = createLogger('offer_generator').child({ component: 'generation-run' })

const paramsSchema = z.object({ id: z.string().uuid() })

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(req: Request, routeCtx: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const notFound = () => notFoundResponse(translate('offer_generator.errors.runNotFound', 'Generation run not found'))
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const run = await findOneWithDecryption(
      scope.em,
      OfferGenerationRun,
      { id: params.data.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    if (!run) return notFound()

    return noStoreJson(serializeRun(run))
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Generation run read failed',
      code: 'offer_generator.generation_run_read_failed',
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Generation run status',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Get a generation run',
      description: 'Returns the status, model and outcome of a generation run scoped to the authenticated organization.',
      responses: [{ status: 200, description: 'Generation run', schema: generationRunDtoSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Generation run not found', schema: errorBodySchema },
      ],
    },
  },
}
