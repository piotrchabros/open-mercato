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
import { readBoundedRequestBytes, WebhookBodyTooLargeError } from '@open-mercato/shared/lib/webhooks'
import type { MetaPage } from '../../data/entities'
import {
  leadgenChangeValueSchema,
  webhookPayloadSchema,
  webhookVerifyQuerySchema,
  type WebhookPayload,
} from '../../data/validators'
import { RATE_LIMITS } from '../../lib/constants'
import { errorResponse, handleRouteError, jsonResponse, tryResolve } from '../../lib/http'
import { insertLeadEvent } from '../../lib/lead-events'
import { readMetaLeadAdsEnvPreset, resolveAppCredentials } from '../../lib/preset'
import { enqueueProcessLead } from '../../lib/queue'
import { findRoutedPageByMetaPageId, scopeOfPage } from '../../lib/scope'
import { timingSafeEqualStrings, verifyHubSignature } from '../../lib/signature'
import { errorBodySchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

const SIGNATURE_HEADER = 'x-hub-signature-256'
const LEADGEN_FIELD = 'leadgen'

const logger = createLogger('meta_lead_ads').child({ component: 'webhook' })

type WebhookEntry = WebhookPayload['entry'][number]

type IntakeCounts = {
  inserted: number
  duplicates: number
  unrouted: number
  rejected: number
}

async function enforceRateLimit(
  container: AppContainer,
  req: Request,
  method: 'get' | 'post',
  points: number,
  translate: TranslateWithFallbackFn,
): Promise<Response | null> {
  const rateLimiterService = tryResolve<RateLimiterService>(container, 'rateLimiterService')
  if (!rateLimiterService) return null
  const clientIp = getClientIp(req, rateLimiterService.trustProxyDepth)
  return checkRateLimit(
    rateLimiterService,
    { points, duration: 60, keyPrefix: `meta_lead_ads:webhook:${method}` },
    clientIp ?? 'global',
    translate(RATE_LIMIT_ERROR_KEY, RATE_LIMIT_ERROR_FALLBACK),
  )
}

function parseJsonBestEffort(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    return null
  }
}

function readFirstEntryPageId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entries = (parsed as { entry?: unknown }).entry
  if (!Array.isArray(entries) || entries.length === 0) return null
  const first: unknown = entries[0]
  if (!first || typeof first !== 'object') return null
  const pageId = (first as { id?: unknown }).id
  if (typeof pageId === 'number') return String(pageId)
  return typeof pageId === 'string' && pageId.trim() ? pageId.trim() : null
}

function createPageResolver(em: EntityManager): (metaPageId: string) => Promise<MetaPage | null> {
  const cache = new Map<string, Promise<MetaPage | null>>()
  return (metaPageId: string) => {
    const key = metaPageId.trim()
    const cached = cache.get(key)
    if (cached) return cached
    const lookup = findRoutedPageByMetaPageId(em, key)
    cache.set(key, lookup)
    return lookup
  }
}

async function enqueueSafely(leadEventId: string, page: MetaPage): Promise<void> {
  try {
    await enqueueProcessLead({ leadEventId, tenantId: page.tenantId, organizationId: page.organizationId })
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'unknown'
    logger.error('Failed to enqueue lead processing', { leadEventId, errorName })
    getTelemetryRuntime()?.reportError(error, {
      module: 'meta_lead_ads',
      code: 'meta_lead_ads.webhook_enqueue_failed',
      attributes: { errorName },
    })
  }
}

async function routeEntry(
  em: EntityManager,
  resolvePage: (metaPageId: string) => Promise<MetaPage | null>,
  entry: WebhookEntry,
  counts: IntakeCounts,
): Promise<void> {
  const leadgenChanges = entry.changes.filter((change) => change.field === LEADGEN_FIELD)
  if (leadgenChanges.length === 0) return
  const page = await resolvePage(entry.id)
  for (const change of leadgenChanges) {
    const parsedValue = leadgenChangeValueSchema.safeParse(change.value)
    if (!parsedValue.success || parsedValue.data.page_id !== entry.id) {
      counts.rejected += 1
      continue
    }
    const value = parsedValue.data
    const result = await insertLeadEvent(em, {
      metaLeadId: value.leadgen_id,
      metaPageId: entry.id,
      metaFormId: value.form_id,
      page,
      source: 'webhook',
      rawNotification: {
        object: 'page',
        entryId: entry.id,
        notified_at: entry.time,
        field: change.field,
        value: change.value,
      },
      submittedAt: new Date(value.created_time * 1000),
      adId: value.ad_id ?? value.adgroup_id ?? null,
    })
    if (result.outcome === 'duplicate') {
      counts.duplicates += 1
      continue
    }
    if (result.status === 'unrouted' || !page || !result.leadEventId) {
      counts.unrouted += 1
      continue
    }
    counts.inserted += 1
    await enqueueSafely(result.leadEventId, page)
  }
}

export async function GET(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const container = await createRequestContainer()
    const limited = await enforceRateLimit(container, req, 'get', RATE_LIMITS.webhookGet, translate)
    if (limited) return limited

    const url = new URL(req.url)
    const parsed = webhookVerifyQuerySchema.safeParse({
      'hub.mode': url.searchParams.get('hub.mode') ?? undefined,
      'hub.verify_token': url.searchParams.get('hub.verify_token') ?? undefined,
      'hub.challenge': url.searchParams.get('hub.challenge') ?? undefined,
    })
    const expectedToken = readMetaLeadAdsEnvPreset().verifyToken
    if (
      !parsed.success ||
      parsed.data['hub.mode'] !== 'subscribe' ||
      expectedToken === null ||
      !timingSafeEqualStrings(parsed.data['hub.verify_token'], expectedToken)
    ) {
      return errorResponse(
        403,
        'verify_token_mismatch',
        translate('meta_lead_ads.errors.verify_token_mismatch', 'Webhook verification failed.'),
      )
    }
    return new Response(parsed.data['hub.challenge'], {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (error) {
    return handleRouteError(error, translate)
  }
}

export async function POST(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const container = await createRequestContainer()
    const limited = await enforceRateLimit(container, req, 'post', RATE_LIMITS.webhookPost, translate)
    if (limited) return limited

    let rawBody: Uint8Array
    try {
      rawBody = await readBoundedRequestBytes(req)
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        return errorResponse(
          413,
          'payload_too_large',
          translate('meta_lead_ads.errors.payload_too_large', 'Webhook payload too large.'),
        )
      }
      throw error
    }

    const em = container.resolve<EntityManager>('em').fork()
    const resolvePage = createPageResolver(em)
    const parsedBody = parseJsonBestEffort(rawBody)
    const firstPageId = readFirstEntryPageId(parsedBody)
    const firstPage = firstPageId ? await resolvePage(firstPageId) : null
    const credentials = await resolveAppCredentials(container, firstPage ? scopeOfPage(firstPage) : null)
    const signatureHeader = req.headers.get(SIGNATURE_HEADER)
    if (!credentials.appSecret || !verifyHubSignature(rawBody, signatureHeader, credentials.appSecret)) {
      logger.warn('Rejected webhook with invalid signature', {
        hasSecret: Boolean(credentials.appSecret),
        hasSignature: Boolean(signatureHeader),
      })
      return errorResponse(
        401,
        'invalid_signature',
        translate('meta_lead_ads.errors.invalid_signature', 'Webhook signature is invalid.'),
      )
    }

    const payload = webhookPayloadSchema.safeParse(parsedBody)
    if (!payload.success) {
      return errorResponse(
        400,
        'validation_error',
        translate('meta_lead_ads.errors.validation_error', 'Invalid input'),
      )
    }
    logger.debug('Verified webhook notification', {
      metaPageId: firstPageId,
      entryCount: payload.data.entry.length,
    })

    const counts: IntakeCounts = { inserted: 0, duplicates: 0, unrouted: 0, rejected: 0 }
    for (const entry of payload.data.entry) {
      await routeEntry(em, resolvePage, entry, counts)
    }
    if (counts.rejected > 0 || counts.unrouted > 0) {
      logger.info('Webhook intake summary', { ...counts })
    }
    return jsonResponse({ ok: true })
  } catch (error) {
    return handleRouteError(error, translate)
  }
}

const webhookAcceptedSchema = z.object({ ok: z.literal(true) })

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'Meta Lead Ads webhook',
  description: 'Public endpoint for the Meta leadgen webhook subscription.',
  methods: {
    GET: {
      summary: 'Verify the webhook subscription',
      description:
        'Meta subscription challenge. Answers hub.challenge as text/plain when hub.mode is subscribe and hub.verify_token matches the configured verify token.',
      query: webhookVerifyQuerySchema,
      responses: [
        { status: 200, description: 'Challenge echoed verbatim', schema: z.string(), mediaType: 'text/plain' },
      ],
      errors: [
        { status: 403, description: 'Verify token mismatch or unsupported hub.mode', schema: errorBodySchema },
        { status: 429, description: 'Rate limit exceeded', schema: errorBodySchema },
      ],
    },
    POST: {
      summary: 'Receive a lead notification',
      description:
        'Verifies X-Hub-Signature-256 over the raw body before any write, stores one lead event per leadgen change (received, unrouted or ignored as duplicate) and enqueues processing.',
      requestBody: { contentType: 'application/json', schema: webhookPayloadSchema },
      responses: [{ status: 200, description: 'Notification accepted', schema: webhookAcceptedSchema }],
      errors: [
        { status: 400, description: 'Signed payload is not a page notification', schema: errorBodySchema },
        { status: 401, description: 'Missing or invalid signature', schema: errorBodySchema },
        { status: 413, description: 'Payload too large', schema: errorBodySchema },
        { status: 429, description: 'Rate limit exceeded', schema: errorBodySchema },
      ],
    },
  },
}
