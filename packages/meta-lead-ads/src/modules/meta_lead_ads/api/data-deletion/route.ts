import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMIT_ERROR_FALLBACK,
  RATE_LIMIT_ERROR_KEY,
} from '@open-mercato/shared/lib/ratelimit/helpers'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { readBoundedRequestBody, WebhookBodyTooLargeError } from '@open-mercato/shared/lib/webhooks'
import { resolveOAuthRedirectUri } from '@open-mercato/core/modules/integrations/lib/oauth/redirect'
import { MetaConnection, MetaDeletionRequest, MetaPage } from '../../data/entities'
import { dataDeletionFormSchema } from '../../data/validators'
import { DATA_DELETION_PATH, RATE_LIMITS, type MetaScope } from '../../lib/constants'
import { getMetaGraphClient, type MetaGraphClient } from '../../lib/graph-client'
import { errorResponse, handleRouteError, jsonResponse, tryResolve } from '../../lib/http'
import { generateConfirmationCode } from '../../lib/ids'
import { graphOptionsFromCredentials, readMetaLeadAdsEnvPreset, resolveAppCredentials } from '../../lib/preset'
import { purgeLeadEventPayloads } from '../../lib/purge'
import { parseSignedRequest, type SignedRequestPayload } from '../../lib/signature'

export const metadata = {
  POST: { requireAuth: false },
}

const DATA_DELETION_MAX_BODY_BYTES = 64 * 1024

const logger = createLogger('meta_lead_ads').child({ component: 'data-deletion' })

const dataDeletionResponseSchema = z.object({
  url: z.string(),
  confirmation_code: z.string(),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() })

function buildRateLimitKey(req: Request, trustProxyDepth: number): string {
  const clientIp = getClientIp(req, trustProxyDepth)
  return clientIp ? `data-deletion:ip:${clientIp}` : 'data-deletion:global'
}

function peekSignedRequestUserId(signedRequest: string): string | null {
  const separatorIndex = signedRequest.indexOf('.')
  if (separatorIndex <= 0) return null
  try {
    const decoded: unknown = JSON.parse(Buffer.from(signedRequest.slice(separatorIndex + 1), 'base64url').toString('utf8'))
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
    const userId = (decoded as Record<string, unknown>).user_id
    return typeof userId === 'string' && /^\d+$/.test(userId) ? userId : null
  } catch {
    return null
  }
}

function uniqueScopes(connections: Pick<MetaConnection, 'tenantId' | 'organizationId'>[]): MetaScope[] {
  const scopes = new Map<string, MetaScope>()
  for (const connection of connections) {
    scopes.set(`${connection.tenantId}:${connection.organizationId}`, {
      tenantId: connection.tenantId,
      organizationId: connection.organizationId,
    })
  }
  return [...scopes.values()]
}

async function collectCandidateSecrets(container: AppContainer, scopes: MetaScope[]): Promise<string[]> {
  const secrets = new Set<string>()
  for (const scope of scopes) {
    try {
      const credentials = await resolveAppCredentials(container, scope)
      if (credentials.appSecret) secrets.add(credentials.appSecret)
    } catch {
      continue
    }
  }
  const envSecret = readMetaLeadAdsEnvPreset().appSecret
  if (envSecret) secrets.add(envSecret)
  return [...secrets]
}

function verifySignedRequest(signedRequest: string, secrets: string[]): SignedRequestPayload | null {
  for (const secret of secrets) {
    const payload = parseSignedRequest(signedRequest, secret)
    if (payload) return payload
  }
  return null
}

async function unsubscribeConnectionPages(
  container: AppContainer,
  em: EntityManager,
  connection: Pick<MetaConnection, 'id' | 'tenantId' | 'organizationId'>,
): Promise<void> {
  const scope: MetaScope = { tenantId: connection.tenantId, organizationId: connection.organizationId }
  const pages = await findWithDecryption(
    em,
    MetaPage,
    { connectionId: connection.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    {},
    scope,
  )
  if (pages.length === 0) return
  const graph = tryResolve<MetaGraphClient>(container, 'metaGraphClient') ?? getMetaGraphClient()
  let graphOptions: ReturnType<typeof graphOptionsFromCredentials> | undefined
  try {
    graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(container, scope))
  } catch {
    graphOptions = undefined
  }
  for (const page of pages) {
    if (!page.pageAccessToken) continue
    try {
      await graph.unsubscribePage(page.metaPageId, page.pageAccessToken, graphOptions)
    } catch {
      logger.warn('Best-effort page unsubscribe failed during data deletion', { pageId: page.id })
    }
  }
  await em.nativeUpdate(
    MetaPage,
    { id: { $in: pages.map((page) => page.id) }, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { pageAccessToken: null, subscriptionStatus: 'unsubscribed', updatedAt: new Date() },
  )
}

function buildStatusUrl(req: Request, confirmationCode: string): string {
  const path = `${DATA_DELETION_PATH}/${confirmationCode}`
  try {
    return resolveOAuthRedirectUri(undefined, path)
  } catch {
    return new URL(path, req.url).toString()
  }
}

export async function POST(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const container = await createRequestContainer()
    const rateLimiterService = tryResolve<RateLimiterService>(container, 'rateLimiterService')
    if (rateLimiterService) {
      const rateLimitResponse = await checkRateLimit(
        rateLimiterService,
        { points: RATE_LIMITS.dataDeletion, duration: 60, keyPrefix: 'meta_lead_ads:data-deletion' },
        buildRateLimitKey(req, rateLimiterService.trustProxyDepth),
        translate(RATE_LIMIT_ERROR_KEY, RATE_LIMIT_ERROR_FALLBACK),
      )
      if (rateLimitResponse) return rateLimitResponse
    }

    const invalidSignedRequest = () =>
      errorResponse(
        400,
        'invalid_signed_request',
        translate('meta_lead_ads.errors.invalid_signed_request', 'The signed request is invalid.'),
      )

    let rawBody: string
    try {
      rawBody = await readBoundedRequestBody(req, { maxBytes: DATA_DELETION_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof WebhookBodyTooLargeError) {
        return errorResponse(
          413,
          'payload_too_large',
          translate('meta_lead_ads.errors.payload_too_large', 'The request body is too large.'),
        )
      }
      throw err
    }

    const form = dataDeletionFormSchema.safeParse({
      signed_request: new URLSearchParams(rawBody).get('signed_request') ?? '',
    })
    if (!form.success) return invalidSignedRequest()
    const signedRequest = form.data.signed_request

    const claimedUserId = peekSignedRequestUserId(signedRequest)
    if (!claimedUserId) return invalidSignedRequest()

    const em = container.resolve<EntityManager>('em').fork()
    const connections = await em.find(
      MetaConnection,
      { metaUserId: claimedUserId, deletedAt: null },
      { fields: ['id', 'tenantId', 'organizationId'] },
    )
    const secrets = await collectCandidateSecrets(container, uniqueScopes(connections))
    const payload = verifySignedRequest(signedRequest, secrets)
    if (!payload || payload.user_id !== claimedUserId) return invalidSignedRequest()

    const deletionRequest = em.create(MetaDeletionRequest, {
      confirmationCode: generateConfirmationCode(),
      metaUserId: payload.user_id,
      status: 'pending',
      purgedCount: 0,
    })
    await em.persist(deletionRequest).flush()

    const purgedCount = await purgeLeadEventPayloads(em, { metaUserId: payload.user_id }, { clearHashes: false })

    for (const connection of connections) {
      try {
        await unsubscribeConnectionPages(container, em, connection)
      } catch {
        logger.warn('Failed to unsubscribe pages during data deletion', { connectionId: connection.id })
      }
    }
    if (connections.length > 0) {
      await em.nativeUpdate(
        MetaConnection,
        { id: { $in: connections.map((connection) => connection.id) } },
        { status: 'disconnected', userAccessToken: null, updatedAt: new Date() },
      )
    }

    deletionRequest.purgedCount = purgedCount
    deletionRequest.status = 'completed'
    await em.flush()

    logger.info('Meta data deletion request completed', {
      deletionRequestId: deletionRequest.id,
      purgedCount,
      connectionCount: connections.length,
    })

    return jsonResponse({
      url: buildStatusUrl(req, deletionRequest.confirmationCode),
      confirmation_code: deletionRequest.confirmationCode,
    })
  } catch (err) {
    return handleRouteError(err, translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'Meta data deletion callback',
  methods: {
    POST: {
      summary: 'Handle a Meta data deletion request',
      description:
        'Verifies the signed_request, purges the raw Meta payloads stored for the user, disconnects their connections and returns a status URL with a confirmation code.',
      requestBody: {
        contentType: 'application/x-www-form-urlencoded',
        schema: dataDeletionFormSchema,
      },
      responses: [{ status: 200, description: 'Deletion request recorded and completed', schema: dataDeletionResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid signed request', schema: errorSchema },
        { status: 413, description: 'Request body too large', schema: errorSchema },
        { status: 429, description: 'Rate limit exceeded', schema: errorSchema },
      ],
    },
  },
}
