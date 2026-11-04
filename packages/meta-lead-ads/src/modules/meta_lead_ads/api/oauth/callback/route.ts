import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest, type AuthContext } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { getAppBaseUrl } from '@open-mercato/shared/lib/url'
import {
  consumeOAuthStateOnce,
  OAuthStateError,
  verifyOAuthState,
  type OAuthStateConsumeStore,
  type OAuthStatePayload,
} from '@open-mercato/core/modules/communication_channels/lib/oauth-state'
import { OAuthGrantError } from '@open-mercato/core/modules/integrations/lib/oauth/descriptor'
import { resolveOAuthRedirectUri } from '@open-mercato/core/modules/integrations/lib/oauth/redirect'
import { MetaConnection } from '../../../data/entities'
import {
  BACKEND_PATH,
  OAUTH_CALLBACK_PATH,
  OAUTH_PROVIDER_KEY,
  OAUTH_STATE_COOKIE,
  type MetaConnectFailureCode,
  type MetaScope,
} from '../../../lib/constants'
import { MetaGraphError, getMetaGraphClient, type MetaGraphClient } from '../../../lib/graph-client'
import { callerHasFeature, runGuards, tryResolve, type RouteContext } from '../../../lib/http'
import { completeMetaOAuth, findMissingScopes, type CompleteMetaOAuthResult } from '../../../lib/oauth'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../../lib/preset'
import { decryptionScope } from '../../../lib/scope'

const MANAGE_FEATURE = 'meta_lead_ads.manage'
const OAUTH_COOKIE_PATH = '/api/meta_lead_ads/oauth'
const CONNECTION_RESOURCE_KIND = 'meta_lead_ads.meta_connection'

const logger = createLogger('meta_lead_ads').child({ component: 'oauth-callback' })

export const metadata = {
  GET: { requireAuth: true, requireFeatures: [MANAGE_FEATURE] },
}

type AuthenticatedContext = NonNullable<AuthContext>
type ConnectResult = 'ok' | MetaConnectFailureCode

type ActionLogger = {
  log: (input: {
    tenantId: string
    organizationId: string
    actorUserId?: string
    commandId: string
    actionLabel?: string
    resourceKind?: string
    resourceId?: string
    context?: Record<string, unknown>
  }) => Promise<unknown>
}

function actsInAnotherTenant(auth: AuthenticatedContext): boolean {
  if (!('actorTenantId' in auth)) return false
  const actorTenantId = typeof auth.actorTenantId === 'string' ? auth.actorTenantId.trim() : ''
  return actorTenantId.length === 0 || actorTenantId !== auth.tenantId
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const segment of header.split(';')) {
    const trimmed = segment.trim()
    if (trimmed.startsWith(`${name}=`)) {
      try {
        return decodeURIComponent(trimmed.slice(name.length + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

function redirectWithResult(req: Request, result: ConnectResult): Response {
  const target = new URL(BACKEND_PATH, getAppBaseUrl(req))
  target.searchParams.set('connect', result)
  const clearCookie = [
    `${OAUTH_STATE_COOKIE}=`,
    `Path=${OAUTH_COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ')
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), 'Set-Cookie': clearCookie, 'Cache-Control': 'no-store' },
  })
}

function reportFailure(err: unknown, code: string): void {
  const errorName = err instanceof Error ? err.name : 'unknown'
  getTelemetryRuntime()?.reportError(err, {
    module: 'meta_lead_ads',
    code,
    attributes: { errorName },
  })
}

function resolveStateStore(ctx: RouteContext): OAuthStateConsumeStore | null {
  const cache = tryResolve<Partial<OAuthStateConsumeStore>>(ctx.container, 'cache')
  if (!cache || typeof cache.has !== 'function' || typeof cache.set !== 'function') return null
  return cache as OAuthStateConsumeStore
}

async function consumeState(ctx: RouteContext, payload: OAuthStatePayload): Promise<boolean> {
  const store = resolveStateStore(ctx)
  if (!store) {
    reportFailure(new Error('[internal] OAuth state store unavailable'), 'meta_lead_ads.oauth_state_store_unavailable')
    return false
  }
  try {
    await consumeOAuthStateOnce(store, payload)
    return true
  } catch (err) {
    if (!(err instanceof OAuthStateError && err.code === 'replay')) {
      reportFailure(err, 'meta_lead_ads.oauth_state_store_failed')
    }
    return false
  }
}

async function upsertConnection(
  ctx: RouteContext,
  scope: MetaScope,
  oauth: CompleteMetaOAuthResult,
): Promise<{ connection: MetaConnection; reconnect: boolean }> {
  const existing = await findOneWithDecryption(
    ctx.em,
    MetaConnection,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, metaUserId: oauth.metaUserId, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
  const connection =
    existing ??
    ctx.em.create(MetaConnection, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      metaUserId: oauth.metaUserId,
      connectedByUserId: ctx.userId,
    })
  connection.metaUserName = oauth.metaUserName
  connection.userAccessToken = oauth.userAccessToken
  connection.tokenExpiresAt = oauth.tokenExpiresAt
  connection.grantedScopes = oauth.grantedScopes
  connection.status = 'active'
  connection.lastError = null
  connection.connectedByUserId = ctx.userId
  ctx.em.persist(connection)
  await ctx.em.flush()
  return { connection, reconnect: existing !== null }
}

async function writeAuditLog(ctx: RouteContext, connection: MetaConnection, reconnect: boolean): Promise<void> {
  const actionLogService = tryResolve<ActionLogger>(ctx.container, 'actionLogService')
  if (!actionLogService) return
  try {
    await actionLogService.log({
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      commandId: 'meta_lead_ads.connection.connect',
      actionLabel: ctx.translate('meta_lead_ads.audit.connectionConnected', 'Meta account connected'),
      resourceKind: CONNECTION_RESOURCE_KIND,
      resourceId: connection.id,
      context: { reconnect, grantedScopes: connection.grantedScopes },
    })
  } catch (err) {
    logger.warn('Audit log write failed', { errorName: err instanceof Error ? err.name : 'unknown' })
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (url.searchParams.get('error')) return redirectWithResult(req, 'access_denied')
  const stateParam = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!stateParam) return redirectWithResult(req, 'state_mismatch')

  try {
    const auth = await getAuthFromRequest(req)
    if (!auth?.sub || !auth.tenantId || actsInAnotherTenant(auth)) {
      return redirectWithResult(req, 'state_mismatch')
    }

    let payload: OAuthStatePayload
    try {
      payload = verifyOAuthState({
        cookie: readCookie(req, OAUTH_STATE_COOKIE),
        expectedUserId: auth.sub,
        expectedProviderKey: OAUTH_PROVIDER_KEY,
        expectedState: stateParam,
      })
    } catch (err) {
      if (!(err instanceof OAuthStateError) || err.code === 'missing_secret') {
        reportFailure(err, 'meta_lead_ads.oauth_state_verify_failed')
      }
      return redirectWithResult(req, 'state_mismatch')
    }
    if (payload.tenantId !== auth.tenantId || !payload.organizationId) {
      return redirectWithResult(req, 'state_mismatch')
    }

    const scope: MetaScope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
    const container = await createRequestContainer()
    const { translate } = await resolveTranslations()
    const ctx: RouteContext = {
      container,
      em: container.resolve<EntityManager>('em').fork(),
      auth,
      userId: auth.sub,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      allowedOrganizationIds: null,
      translate,
    }

    if (!(await consumeState(ctx, payload))) return redirectWithResult(req, 'state_mismatch')
    if (!(await callerHasFeature(ctx, MANAGE_FEATURE))) return redirectWithResult(req, 'state_mismatch')
    if (!code) return redirectWithResult(req, 'exchange_failed')

    const credentials = await resolveAppCredentials(container, scope)
    if (!credentials.appId || !credentials.appSecret) return redirectWithResult(req, 'app_not_configured')

    let redirectUri: string
    try {
      redirectUri = resolveOAuthRedirectUri(req, OAUTH_CALLBACK_PATH)
    } catch (err) {
      if (err instanceof OAuthGrantError) return redirectWithResult(req, 'app_not_configured')
      throw err
    }

    const guard = await runGuards(ctx, req, {
      resourceKind: CONNECTION_RESOURCE_KIND,
      operation: 'custom',
      mutationPayload: { action: 'connect' },
    })
    if (!guard.ok) return guard.response

    let oauth: CompleteMetaOAuthResult
    try {
      oauth = await completeMetaOAuth({
        graph: tryResolve<MetaGraphClient>(container, 'metaGraphClient') ?? getMetaGraphClient(),
        code,
        redirectUri,
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        graphOptions: graphOptionsFromCredentials(credentials),
      })
    } catch (err) {
      if (err instanceof MetaGraphError) {
        logger.warn('Meta OAuth exchange failed', {
          status: err.status,
          graphCode: err.code,
          graphSubcode: err.subcode,
          fbtraceId: err.fbtraceId,
          errorClass: err.classification.errorClass,
        })
      } else {
        reportFailure(err, 'meta_lead_ads.oauth_exchange_failed')
      }
      return redirectWithResult(req, 'exchange_failed')
    }

    if (findMissingScopes(oauth.grantedScopes).length > 0) return redirectWithResult(req, 'missing_scopes')

    const { connection, reconnect } = await upsertConnection(ctx, scope, oauth)
    await guard.runAfterSuccess()
    await writeAuditLog(ctx, connection, reconnect)
    return redirectWithResult(req, 'ok')
  } catch (err) {
    logger.error('OAuth callback failed', { errorName: err instanceof Error ? err.name : 'unknown' })
    reportFailure(err, 'meta_lead_ads.oauth_callback_failed')
    return redirectWithResult(req, 'exchange_failed')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Complete the Meta (Facebook Login for Business) connection flow',
  methods: {
    GET: {
      summary: 'Facebook redirect target: verify state, exchange the code and store the connection',
      description:
        'Always answers with a redirect to /backend/meta-lead-ads?connect=<result>, where result is ok, state_mismatch, access_denied, exchange_failed, missing_scopes or app_not_configured. Tokens never appear in the redirect.',
      responses: [{ status: 302, description: 'Redirect back to the Meta Lead Ads page with the connect result' }],
    },
  },
}
