import crypto from 'crypto'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { invalidateCrudCache } from '@open-mercato/shared/lib/crud/cache'
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
import { trackingBodySchema, type TrackingBeatInput, type TrackingStartInput } from '../../../data/validators'
import { emitOfferGeneratorEvent } from '../../../events'
import { RATE_LIMITS, TRACKING } from '../../../lib/constants'
import { resolvePublicOfferRoute, type PublicOfferRoute } from '../../../lib/public-offer'
import {
  buildVisitorCookie,
  hashClientIp,
  isBotUserAgent,
  isSameOrigin,
  parseTrackingBody,
  parseUserAgent,
  readVisitorCookie,
} from '../../../lib/tracking'
import { insertView, recordFirstView, touchView } from '../../../lib/views-repository'

export const metadata = {
  POST: { requireAuth: false },
}

const NO_STORE = { 'Cache-Control': 'no-store' }
const COUNTRY_HEADER = 'cf-ipcountry'
const COUNTRY_PATTERN = /^[A-Z]{2}$/
const UNKNOWN_COUNTRIES = new Set(['XX', 'T1'])
const OFFER_CACHE_RESOURCE = 'offer_generator.offer'

const logger = createLogger('offer_generator').child({ component: 'public-sessions' })

let missingIpSecretLogged = false

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } })
}

function errorJson(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status)
}

function tryResolve<T>(container: AppContainer, name: string): T | null {
  try {
    if (typeof container.hasRegistration === 'function' && !container.hasRegistration(name)) return null
    return container.resolve<T>(name)
  } catch {
    return null
  }
}

function readCountry(req: Request, trustProxyDepth: number): string | null {
  if (trustProxyDepth <= 0) return null
  const raw = (req.headers.get(COUNTRY_HEADER) ?? '').trim().toUpperCase()
  return COUNTRY_PATTERN.test(raw) && !UNKNOWN_COUNTRIES.has(raw) ? raw : null
}

function hashIpSafely(ip: string | null): string | null {
  if (!ip) return null
  try {
    return hashClientIp(ip)
  } catch {
    if (!missingIpSecretLogged) {
      missingIpSecretLogged = true
      logger.warn('IP hash secret missing; storing views without ip_hash and skipping the per-IP cap')
    }
    return null
  }
}

async function readRequestText(req: Request): Promise<string | null> {
  const contentLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > TRACKING.MAX_BODY_BYTES) return null
  const text = await req.text()
  return Buffer.byteLength(text, 'utf8') > TRACKING.MAX_BODY_BYTES ? null : text
}

async function isInternalVisitor(req: Request): Promise<boolean> {
  try {
    return !!(await getAuthFromRequest(req))
  } catch {
    return false
  }
}

async function handleBeat(em: EntityManager, offer: PublicOfferRoute, body: TrackingBeatInput): Promise<Response> {
  await touchView(em, {
    viewKey: body.key,
    offerId: offer.id,
    activeMs: body.ms,
    scrollPct: body.sc,
    sections: body.sx,
  })
  return new Response(null, { status: 204, headers: NO_STORE })
}

async function handleStart(
  req: Request,
  container: AppContainer,
  em: EntityManager,
  offer: PublicOfferRoute,
  body: TrackingStartInput,
  rateLimiterService: RateLimiterService | null,
): Promise<Response> {
  const userAgent = req.headers.get('user-agent')
  if (!userAgent || isBotUserAgent(userAgent)) return json({ ok: true, counted: false })

  const visitorId = readVisitorCookie(req.headers) ?? crypto.randomUUID()
  const internal = await isInternalVisitor(req)
  const trustProxyDepth = rateLimiterService?.trustProxyDepth ?? 0
  const { device, browser, os } = parseUserAgent(userAgent)

  const counted = await insertView(em, {
    viewKey: body.key,
    tenantId: offer.tenantId,
    organizationId: offer.organizationId,
    offerId: offer.id,
    visitorId,
    ipHash: hashIpSafely(getClientIp(req, trustProxyDepth)),
    country: readCountry(req, trustProxyDepth),
    device,
    browser,
    os,
    referrer: typeof body.ref === 'string' ? body.ref.slice(0, 300) : null,
    isInternal: internal,
  })
  if (!counted) return json({ ok: true, counted: false })

  const { firstView } = await recordFirstView(em, offer, { internal })
  if (!internal) {
    await invalidateCrudCache(
      container,
      OFFER_CACHE_RESOURCE,
      { id: offer.id, organizationId: offer.organizationId, tenantId: offer.tenantId },
      offer.tenantId,
      'offer_generator.offer.view_recorded',
    )
  }
  if (firstView) {
    await emitOfferGeneratorEvent(
      'offer_generator.offer.viewed',
      { offerId: offer.id, tenantId: offer.tenantId, organizationId: offer.organizationId },
      { tenantId: offer.tenantId, organizationId: offer.organizationId },
    )
  }

  return json({ ok: true, counted: true, visitorId, internal }, 200, {
    'Set-Cookie': buildVisitorCookie(visitorId, process.env.NODE_ENV === 'production'),
  })
}

function handleUnexpectedError(error: unknown, translate: TranslateWithFallbackFn): Response {
  const errorName = error instanceof Error ? error.name : 'unknown'
  logger.error('Offer tracking request failed', { errorName })
  getTelemetryRuntime()?.reportError(error, {
    module: 'offer_generator',
    code: 'offer_generator.tracking_failed',
    attributes: { errorName },
  })
  return errorJson(500, 'internal', translate('offer_generator.errors.internal', 'Something went wrong.'))
}

export async function POST(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    if (!isSameOrigin(req.headers)) {
      return errorJson(403, 'forbidden', translate('offer_generator.errors.forbidden', 'Forbidden'))
    }

    const text = await readRequestText(req)
    if (text === null) {
      return errorJson(
        413,
        'payload_too_large',
        translate('offer_generator.errors.payloadTooLarge', 'Payload too large'),
      )
    }

    const body = parseTrackingBody(text)
    if (!body) {
      return errorJson(400, 'validation_error', translate('offer_generator.errors.validation', 'Invalid input'))
    }

    const container = await createRequestContainer()
    const rateLimiterService = tryResolve<RateLimiterService>(container, 'rateLimiterService')
    if (rateLimiterService) {
      const limited = await checkRateLimit(
        rateLimiterService,
        { points: RATE_LIMITS.session, duration: 60, keyPrefix: 'offer_generator:public:sessions' },
        getClientIp(req, rateLimiterService.trustProxyDepth) ?? 'global',
        translate(RATE_LIMIT_ERROR_KEY, RATE_LIMIT_ERROR_FALLBACK),
      )
      if (limited) return limited
    }

    const em = container.resolve<EntityManager>('em').fork()
    const offer = await resolvePublicOfferRoute(em, body.seg)
    if (!offer) {
      return errorJson(404, 'not_found', translate('offer_generator.errors.notFound', 'Not found'))
    }

    if (body.t === 'beat') return handleBeat(em, offer, body)
    return handleStart(req, container, em, offer, body, rateLimiterService)
  } catch (error) {
    return handleUnexpectedError(error, translate)
  }
}

const sessionErrorSchema = z.object({ error: z.string(), code: z.string().optional() })

const sessionStartResponseSchema = z.object({
  ok: z.literal(true),
  counted: z.boolean(),
  visitorId: z.string().uuid().optional(),
  internal: z.boolean().optional(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Public offer view tracking',
  description:
    'Unauthenticated telemetry endpoint used by the public offer page tracker. It runs no mutation guards, like other public system telemetry endpoints, because it only records anonymous view sessions.',
  methods: {
    POST: {
      summary: 'Start or extend a view session',
      description:
        'Accepts a same-origin JSON body sent as text/plain (navigator.sendBeacon). A start body counts a view (bots and capped traffic are not counted) and sets the visitor cookie; a beat body updates active time, scroll depth and per-section dwell and answers 204. Never updates the offer updated_at column.',
      requestBody: { contentType: 'text/plain', schema: trackingBodySchema },
      responses: [
        { status: 200, description: 'Start processed', schema: sessionStartResponseSchema },
        { status: 204, description: 'Beat processed' },
      ],
      errors: [
        { status: 400, description: 'Malformed tracking body', schema: sessionErrorSchema },
        { status: 403, description: 'Cross-origin request', schema: sessionErrorSchema },
        { status: 404, description: 'Unknown, draft or empty offer', schema: sessionErrorSchema },
        { status: 413, description: 'Body larger than 4096 bytes', schema: sessionErrorSchema },
        { status: 429, description: 'Rate limit exceeded', schema: sessionErrorSchema },
      ],
    },
  },
}
