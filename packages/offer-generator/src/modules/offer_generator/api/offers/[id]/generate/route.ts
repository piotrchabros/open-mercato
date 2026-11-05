import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { OFFER_RESOURCE_KIND } from '../../../../commands/offers'
import { generationStartSchema } from '../../../../data/validators'
import { startGenerationRun } from '../../../../lib/generation'
import {
  authenticateRequest,
  handleRouteError,
  noStoreJson,
  notFoundResponse,
  resolveRequestScope,
  unauthorizedResponse,
  validationErrorResponse,
} from '../../../../lib/http'
import { errorBodySchema, generationStartResponseSchema } from '../../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['offer_generator.generate'] },
}

const logger = createLogger('offer_generator').child({ component: 'offer-generate' })

const paramsSchema = z.object({ id: z.string().uuid() })

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(req: Request, routeCtx: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFoundResponse(translate('offer_generator.errors.notFound', 'Offer not found'))
    const body = generationStartSchema.safeParse(await readJsonSafe(req, null))
    if (!body.success) return validationErrorResponse(translate, body.error.issues)

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()
    const { tenantId, organizationId } = scope

    const guarded = await runRouteMutationGuards({
      container: scope.container,
      req,
      auth: { userId: scope.userId, tenantId, organizationId },
      input: {
        resourceKind: OFFER_RESOURCE_KIND,
        resourceId: params.data.id,
        operation: 'update',
        mutationPayload: { kind: body.data.kind },
      },
    })
    if (!guarded.ok) return guarded.response

    const result = await startGenerationRun({
      container: scope.container,
      em: scope.em,
      scope: { tenantId, organizationId },
      userId: scope.userId,
      offerId: params.data.id,
      input: body.data,
    })
    await guarded.runAfterSuccess()

    return noStoreJson({ runId: result.runId, progressJobId: result.progressJobId }, 202)
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Offer generation start failed',
      code: 'offer_generator.generation_start_failed',
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Start an AI offer generation run',
  pathParams: paramsSchema,
  methods: {
    POST: {
      summary: 'Start generating or refining the offer HTML',
      description:
        'Queues an asynchronous generation run for the offer and returns the run id and the progress job id used to follow it.',
      requestBody: { contentType: 'application/json', schema: generationStartSchema },
      responses: [{ status: 202, description: 'Generation run queued', schema: generationStartResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid body, missing prompt or organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer not found', schema: errorBodySchema },
        { status: 409, description: 'A generation run is already active for this offer', schema: errorBodySchema },
        { status: 503, description: 'AI provider not configured', schema: errorBodySchema },
      ],
    },
  },
}
