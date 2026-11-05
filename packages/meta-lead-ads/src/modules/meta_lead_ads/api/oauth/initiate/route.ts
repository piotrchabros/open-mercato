import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest, type AuthContext } from '@open-mercato/shared/lib/auth/server'
import {
  isExplicitlyEmptyOrganizationScope,
  organizationScopeRequiredResponse,
  resolveActiveOrganizationId,
} from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { readAllowedRequestOrigin } from '@open-mercato/shared/lib/url'
import { createOAuthState } from '@open-mercato/core/modules/communication_channels/lib/oauth-state'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { OAuthGrantError } from '@open-mercato/core/modules/integrations/lib/oauth/descriptor'
import {
  resolveOAuthRedirectUriForOrganization,
  type OrganizationOAuthRedirect,
} from '@open-mercato/core/modules/integrations/lib/oauth/redirect'
import { errorBodySchema } from '../../openapi'
import {
  BACKEND_PATH,
  OAUTH_CALLBACK_PATH,
  OAUTH_PROVIDER_KEY,
  OAUTH_STATE_COOKIE,
  resolveGraphApiVersion,
} from '../../../lib/constants'
import { callerHasFeature, errorResponse, handleRouteError, jsonResponse, type RouteContext } from '../../../lib/http'
import { buildMetaLoginDialogUrl } from '../../../lib/oauth'
import { resolveAppCredentials } from '../../../lib/preset'

const MANAGE_FEATURE = 'meta_lead_ads.manage'
const OAUTH_COOKIE_PATH = '/api/meta_lead_ads/oauth'
const OAUTH_COOKIE_MAX_AGE_SECONDS = 300

export const metadata = {
  GET: { requireAuth: true, requireFeatures: [MANAGE_FEATURE] },
}

type AuthenticatedContext = NonNullable<AuthContext>

function actsInAnotherTenant(auth: AuthenticatedContext): boolean {
  if (!('actorTenantId' in auth)) return false
  const actorTenantId = typeof auth.actorTenantId === 'string' ? auth.actorTenantId.trim() : ''
  return actorTenantId.length === 0 || actorTenantId !== auth.tenantId
}

function buildStateCookie(value: string): string {
  const parts = [
    `${OAUTH_STATE_COOKIE}=${value}`,
    `Path=${OAUTH_COOKIE_PATH}`,
    `Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export async function GET(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await getAuthFromRequest(req)
    if (!auth?.sub || !auth.tenantId) return jsonResponse({ error: 'Unauthorized' }, 401)
    const forbidden = () =>
      jsonResponse({ error: translate('meta_lead_ads.errors.forbidden', 'Forbidden') }, 403)
    if (actsInAnotherTenant(auth)) return forbidden()

    const container = await createRequestContainer()
    const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    if (isExplicitlyEmptyOrganizationScope(organizationScope)) return forbidden()
    const organizationId = resolveActiveOrganizationId(auth)
    if (!organizationId) return organizationScopeRequiredResponse()

    const ctx: RouteContext = {
      container,
      em: container.resolve<EntityManager>('em').fork(),
      auth,
      userId: auth.sub,
      tenantId: auth.tenantId,
      organizationId,
      allowedOrganizationIds: organizationScope.allowedIds ? [...organizationScope.allowedIds] : null,
      translate,
    }
    if (!(await callerHasFeature(ctx, MANAGE_FEATURE))) return forbidden()

    const appNotConfigured = () =>
      errorResponse(
        400,
        'app_not_configured',
        translate('meta_lead_ads.errors.app_not_configured', 'The Meta app is not configured for this organization.'),
      )
    const credentials = await resolveAppCredentials(container, { tenantId: ctx.tenantId, organizationId })
    if (!credentials.appId || !credentials.loginConfigId) return appNotConfigured()

    let redirect: OrganizationOAuthRedirect
    try {
      redirect = await resolveOAuthRedirectUriForOrganization(req, OAUTH_CALLBACK_PATH, { container, organizationId })
    } catch (err) {
      if (err instanceof OAuthGrantError) return appNotConfigured()
      throw err
    }
    const { redirectUri, redirectOrigin } = redirect
    if (redirectOrigin && readAllowedRequestOrigin(req) !== redirectOrigin) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${redirectOrigin}${BACKEND_PATH}?connect=wrong_origin`, 'Cache-Control': 'no-store' },
      })
    }

    const state = createOAuthState({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      organizationId,
      providerKey: OAUTH_PROVIDER_KEY,
      redirectOrigin,
    })
    const dialogUrl = buildMetaLoginDialogUrl({
      appId: credentials.appId,
      loginConfigId: credentials.loginConfigId,
      redirectUri,
      state: state.stateParam,
      graphVersion: resolveGraphApiVersion(credentials.graphVersion),
    })

    return new Response(null, {
      status: 302,
      headers: {
        Location: dialogUrl,
        'Set-Cookie': buildStateCookie(state.cookie),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return handleRouteError(err, translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Start the Meta (Facebook Login for Business) connection flow',
  methods: {
    GET: {
      summary: 'Redirect to the Facebook Login for Business dialog',
      description:
        'Sets the short-lived HttpOnly state cookie and redirects the browser to the Meta login dialog. Requires the organization app credentials or the env preset.',
      responses: [
        {
          status: 302,
          description:
            "Redirect to the Facebook login dialog, or to the organization's own address with connect=wrong_origin when started from another address",
        },
      ],
      errors: [
        { status: 400, description: 'Meta app not configured or no organization selected', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 403, description: 'Missing meta_lead_ads.manage in the active organization', schema: errorBodySchema },
      ],
    },
  },
}
