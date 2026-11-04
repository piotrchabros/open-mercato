import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMIT_ERROR_FALLBACK,
  RATE_LIMIT_ERROR_KEY,
} from '@open-mercato/shared/lib/ratelimit/helpers'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { MetaDeletionRequest } from '../../../data/entities'
import { DELETION_REQUEST_STATUSES, RATE_LIMITS } from '../../../lib/constants'
import { errorResponse, handleRouteError, jsonResponse, tryResolve } from '../../../lib/http'

export const metadata = {
  GET: { requireAuth: false },
}

const CONFIRMATION_CODE_PATTERN = /^dr_[0-9a-f]{12}$/

const deletionStatusResponseSchema = z.object({
  confirmationCode: z.string(),
  status: z.enum(DELETION_REQUEST_STATUSES),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() })

function buildRateLimitKey(req: Request, trustProxyDepth: number): string {
  const clientIp = getClientIp(req, trustProxyDepth)
  return clientIp ? `data-deletion-status:ip:${clientIp}` : 'data-deletion-status:global'
}

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const { code } = await ctx.params
    const container = await createRequestContainer()
    const rateLimiterService = tryResolve<RateLimiterService>(container, 'rateLimiterService')
    if (rateLimiterService) {
      const rateLimitResponse = await checkRateLimit(
        rateLimiterService,
        { points: RATE_LIMITS.dataDeletion, duration: 60, keyPrefix: 'meta_lead_ads:data-deletion-status' },
        buildRateLimitKey(req, rateLimiterService.trustProxyDepth),
        translate(RATE_LIMIT_ERROR_KEY, RATE_LIMIT_ERROR_FALLBACK),
      )
      if (rateLimitResponse) return rateLimitResponse
    }

    const notFound = () =>
      errorResponse(404, 'not_found', translate('meta_lead_ads.errors.not_found', 'Not found'))
    if (!CONFIRMATION_CODE_PATTERN.test(code)) return notFound()

    const em = container.resolve<EntityManager>('em').fork()
    const deletionRequest = await em.findOne(MetaDeletionRequest, { confirmationCode: code, deletedAt: null })
    if (!deletionRequest) return notFound()

    return jsonResponse({
      confirmationCode: deletionRequest.confirmationCode,
      status: deletionRequest.status,
      requestedAt: deletionRequest.createdAt.toISOString(),
      completedAt: deletionRequest.status === 'completed' ? deletionRequest.updatedAt.toISOString() : null,
    })
  } catch (err) {
    return handleRouteError(err, translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'Meta data deletion status',
  pathParams: z.object({ code: z.string().regex(CONFIRMATION_CODE_PATTERN) }),
  methods: {
    GET: {
      summary: 'Get the status of a Meta data deletion request',
      responses: [{ status: 200, description: 'Deletion request status', schema: deletionStatusResponseSchema }],
      errors: [
        { status: 404, description: 'Unknown confirmation code', schema: errorSchema },
        { status: 429, description: 'Rate limit exceeded', schema: errorSchema },
      ],
    },
  },
}
