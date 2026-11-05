import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { TranslateWithFallbackFn } from '@open-mercato/shared/lib/i18n/translate'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMIT_ERROR_FALLBACK,
  RATE_LIMIT_ERROR_KEY,
} from '@open-mercato/shared/lib/ratelimit/helpers'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { RATE_LIMITS } from '../../../../lib/constants'
import { sanitizeOfferHtml } from '../../../../lib/html-sanitize'
import { findPublicOffer } from '../../../../lib/public-offer'

export const metadata = {
  GET: { requireAuth: false },
}

const MAX_SEGMENT_LENGTH = 200

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

const logger = createLogger('offer_generator').child({ component: 'public-render' })

const paramsSchema = z.object({ segment: z.string().min(3).max(MAX_SEGMENT_LENGTH) })

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: HTML_HEADERS })
}

function messagePage(status: number, message: string): Response {
  const safe = escapeHtml(message)
  return htmlResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${safe}</title></head><body><p>${safe}</p></body></html>`,
    status,
  )
}

function tryResolve<T>(container: AppContainer, name: string): T | null {
  try {
    if (typeof container.hasRegistration === 'function' && !container.hasRegistration(name)) return null
    return container.resolve<T>(name)
  } catch {
    return null
  }
}

async function enforceRateLimit(
  container: AppContainer,
  req: Request,
  translate: TranslateWithFallbackFn,
): Promise<Response | null> {
  const rateLimiterService = tryResolve<RateLimiterService>(container, 'rateLimiterService')
  if (!rateLimiterService) return null
  return checkRateLimit(
    rateLimiterService,
    { points: RATE_LIMITS.publicRender, duration: 60, keyPrefix: 'offer_generator:render:public' },
    getClientIp(req, rateLimiterService.trustProxyDepth) ?? 'global',
    translate(RATE_LIMIT_ERROR_KEY, RATE_LIMIT_ERROR_FALLBACK),
  )
}

export async function GET(req: Request, routeCtx: { params: Promise<{ segment: string }> }): Promise<Response> {
  const { translate } = await resolveTranslations()
  const notFound = () => messagePage(404, translate('offer_generator.public.notFound', 'Offer not found'))
  try {
    const container = await createRequestContainer()
    const limited = await enforceRateLimit(container, req, translate)
    if (limited) return limited

    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()

    const em = container.resolve<EntityManager>('em').fork()
    const offer = await findPublicOffer(em, params.data.segment)
    if (!offer) return notFound()

    return htmlResponse(sanitizeOfferHtml(offer.html), 200)
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'unknown'
    logger.error('Public offer render failed', { errorName })
    getTelemetryRuntime()?.reportError(error, {
      module: 'offer_generator',
      code: 'offer_generator.public_render_failed',
      attributes: { errorName },
    })
    return messagePage(500, translate('offer_generator.errors.internal', 'Something went wrong.'))
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Public offer document',
  description:
    'Serves the sanitized HTML of a published offer for the public offer page iframe. The segment is <slug>-<accessToken>; the token is compared in constant time.',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Render a public offer',
      description:
        'Returns the sanitized offer HTML with no-store caching and noindex. Unknown segments, wrong tokens, drafts and offers without HTML answer a plain 404 page with no detail.',
      responses: [{ status: 200, description: 'Offer HTML document', schema: z.string(), mediaType: 'text/html' }],
      errors: [
        { status: 404, description: 'Offer not available', schema: z.string(), mediaType: 'text/html' },
        { status: 429, description: 'Rate limit exceeded', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
