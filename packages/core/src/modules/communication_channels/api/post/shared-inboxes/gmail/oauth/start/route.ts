import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { toAbsoluteUrl } from '@open-mercato/shared/lib/url'
import { getChannelAdapter } from '../../../../../../lib/adapter-registry-singleton'
import { resolveOAuthClientCredentials } from '../../../../../../lib/oauth-client-config'
import {
  COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME,
  createOAuthState,
  encryptOAuthState,
  isSafeOAuthReturnUrl,
  normalizeOAuthReturnUrl,
} from '../../../../../../lib/oauth-state'
import {
  SHARED_INBOX_OAUTH_STATE_TTL_MS,
  createSharedInboxOAuthState,
} from '../../../../../../lib/shared-inbox-oauth'
import { authorizeSharedInboxAdmin } from '../../../../../../lib/shared-inbox-authorization'
import { checkSharedMailboxEligibility } from '../../../../../../lib/shared-inbox-provisioning'
import type { ChannelAdapterRegistry } from '../../../../../../lib/registry'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../../lib/shared-inbox-route-context'

/**
 * Start the Gmail shared-mailbox OAuth flow (Connect upstream Contract E,
 * AUTH-UP-GMAIL-01).
 *
 * Distinct from the per-user "connect my mailbox" flow in every way that
 * matters for authorization: it is gated on organization administration, its
 * `redirect_uri` is the shared callback, and it records a one-time server-side
 * state row carrying the tenant, organization, initiating administrator and
 * expiry that the callback re-derives rather than trusting from the browser.
 */

export const SHARED_INBOX_GMAIL_RETURN_URL = '/backend/communication_channels/shared-inboxes'

export const metadata = {
  path: '/communication_channels/shared-inboxes/gmail/oauth/start',
  POST: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

const bodySchema = z.object({
  displayName: z.string().min(1).max(255),
  returnUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine(isSafeOAuthReturnUrl, { message: 'returnUrl must be a same-origin path' })
    .optional(),
  /** Optional pre-filled shared mailbox address — Google `login_hint`. */
  loginHint: z.string().email().optional(),
})

const PROVIDER_KEY = 'gmail'

export async function POST(req: Request): Promise<Response> {
  const resolved = await resolveSharedInboxAdminContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context
  if (!authorizeSharedInboxAdmin(actor)) return sharedInboxDenialResponse()

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const registry = container.resolve('channelAdapterRegistry') as ChannelAdapterRegistry
  const eligibility = checkSharedMailboxEligibility(registry, PROVIDER_KEY)
  if (!eligibility.eligible) {
    return NextResponse.json(
      { error: 'Gmail is not available as a shared inbox provider.', code: eligibility.reason },
      { status: 400 },
    )
  }

  const adapter = getChannelAdapter(PROVIDER_KEY)
  if (!adapter || typeof adapter.buildOAuthAuthorizeUrl !== 'function') {
    return NextResponse.json(
      { error: 'Gmail does not support OAuth in this installation.', code: 'oauth_unsupported' },
      { status: 400 },
    )
  }

  const clientCredentials = await resolveOAuthClientCredentials(
    (() => {
      try {
        return container.resolve('integrationCredentialsService') as never
      } catch {
        return null
      }
    })(),
    PROVIDER_KEY,
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
  )
  if (!clientCredentials) {
    return NextResponse.json(
      {
        error:
          'Gmail is not configured for this workspace yet. An administrator must add the OAuth Client ID and Secret under Integrations first.',
        code: 'oauth_client_not_configured',
      },
      { status: 409 },
    )
  }

  const returnUrl = normalizeOAuthReturnUrl(body.returnUrl, SHARED_INBOX_GMAIL_RETURN_URL)
  // A dedicated redirect URI, separate from the per-user callback: the two
  // flows create structurally different channels, and Google must be able to
  // distinguish them.
  const redirectUri = toAbsoluteUrl(
    req,
    '/api/communication_channels/shared-inboxes/gmail/oauth/callback',
  )

  const stateEnvelope = createOAuthState({
    userId: actor.userId,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    providerKey: PROVIDER_KEY,
    returnUrl,
  })

  let authorize
  try {
    authorize = await adapter.buildOAuthAuthorizeUrl({
      state: stateEnvelope.stateParam,
      nonce: stateEnvelope.payload.nonce,
      redirectUri,
      credentials: clientCredentials,
      scope: { tenantId: actor.tenantId, organizationId: actor.organizationId },
      loginHint: body.loginHint,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build authorize URL' },
      { status: 502 },
    )
  }

  // Persist the one-time state only AFTER the provider accepted the request, so
  // a failed authorize-URL build leaves no claimable row behind.
  const em = (container.resolve('em') as EntityManager).fork()
  await createSharedInboxOAuthState({
    em,
    state: stateEnvelope.stateParam,
    nonce: stateEnvelope.payload.nonce,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    initiatedByUserId: actor.userId,
    providerKey: PROVIDER_KEY,
    displayName: body.displayName,
    returnUrl,
  })

  const cookie = authorize.extra
    ? encryptOAuthState({
        ...stateEnvelope.payload,
        extra: { ...(stateEnvelope.payload.extra ?? {}), ...authorize.extra },
      })
    : stateEnvelope.cookie

  const response = NextResponse.json({ authorizeUrl: authorize.authorizeUrl })
  response.cookies.set({
    name: COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME,
    value: cookie,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SHARED_INBOX_OAUTH_STATE_TTL_MS / 1000),
  })
  return response
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Start the Gmail shared-mailbox OAuth flow',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Authorize URL + one-time state issued' },
        { status: 400, description: 'Gmail ineligible or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Not authorized to administer shared inboxes' },
        { status: 409, description: 'Gmail OAuth client not configured' },
        { status: 422, description: 'Invalid request body' },
        { status: 502, description: 'Adapter failed to build the authorize URL' },
      ],
    },
  },
}

export default POST
