import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAppBaseUrl, toAbsoluteUrl } from '@open-mercato/shared/lib/url'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getChannelAdapter } from '../../../../../../lib/adapter-registry-singleton'
import { resolveOAuthClientCredentials } from '../../../../../../lib/oauth-client-config'
import {
  COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME,
  OAuthStateError,
  normalizeOAuthReturnUrl,
  verifyOAuthState,
} from '../../../../../../lib/oauth-state'
import { consumeSharedInboxOAuthState } from '../../../../../../lib/shared-inbox-oauth'
import {
  hasActiveOrganizationAdminScope,
  holdsSharedInboxManage,
} from '../../../../../../lib/organization-membership'
import {
  SharedMailboxAlreadyProvisionedError,
  checkSharedMailboxEligibility,
  createSharedInboxChannelRow,
  persistSharedInboxCredentials,
} from '../../../../../../lib/shared-inbox-provisioning'
import type { ChannelAdapterRegistry } from '../../../../../../lib/registry'
import { emitCommunicationChannelsEvent } from '../../../../../../events'

/**
 * Gmail shared-mailbox OAuth callback (Connect upstream Contract E,
 * AUTH-UP-GMAIL-01).
 *
 * Authorization is re-derived here, not carried over from initiate:
 *
 *   1. the encrypted state cookie must decrypt, match this session's user and
 *      the `state` query parameter, and not be expired;
 *   2. the one-time server-side state row must claim successfully — a replayed
 *      or duplicated callback loses that race and provisions nothing;
 *   3. the initiating administrator must STILL hold organization-admin scope and
 *      `communication_channels.shared_inbox.manage`, so consent that completes
 *      after their access was revoked does not create an inbox.
 *
 * Only then are the tokens exchanged, encrypted under the organization with
 * `user_id IS NULL`, and bound to a new shared channel. No token, refresh token
 * or client secret appears in any response or redirect.
 */

const logger = createLogger('communication_channels').child({ component: 'shared-inbox-oauth-callback' })

const PROVIDER_KEY = 'gmail'
const FALLBACK_RETURN_URL = '/backend/communication_channels/shared-inboxes'

export const metadata = {
  path: '/communication_channels/shared-inboxes/gmail/oauth/callback',
  // The state cookie carries the flow identity; the session is still required
  // and re-checked below so the callback is bound to its initiator.
  GET: { requireAuth: true },
}

function redirectWithFlash(
  req: Request,
  returnUrl: string,
  flash: { type: 'connected' | 'error'; code?: string; channelId?: string },
): Response {
  const target = new URL(normalizeOAuthReturnUrl(returnUrl, FALLBACK_RETURN_URL), getAppBaseUrl(req))
  target.searchParams.set('flash', flash.type)
  if (flash.code) target.searchParams.set('code', flash.code)
  if (flash.channelId) target.searchParams.set('channelId', flash.channelId)
  const response = NextResponse.redirect(target.toString(), 302)
  response.cookies.set({
    name: COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return response
}

function parseCookie(header: string, name: string): string | null {
  if (!header) return null
  for (const segment of header.split(';')) {
    const trimmed = segment.trim()
    if (trimmed.startsWith(`${name}=`)) return decodeURIComponent(trimmed.slice(name.length + 1))
  }
  return null
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code') ?? ''
  const stateParam = url.searchParams.get('state') ?? ''
  const providerError = url.searchParams.get('error')

  if (providerError) {
    return redirectWithFlash(req, FALLBACK_RETURN_URL, { type: 'error', code: providerError })
  }
  if (!code || !stateParam) {
    return redirectWithFlash(req, FALLBACK_RETURN_URL, {
      type: 'error',
      code: 'missing_code_or_state',
    })
  }

  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth?.tenantId) {
    return redirectWithFlash(req, FALLBACK_RETURN_URL, { type: 'error', code: 'unauthorized' })
  }

  let statePayload
  try {
    statePayload = verifyOAuthState({
      cookie: parseCookie(req.headers.get('cookie') ?? '', COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME),
      expectedUserId: auth.sub as string,
      expectedProviderKey: PROVIDER_KEY,
      expectedState: stateParam,
    })
  } catch (err) {
    return redirectWithFlash(req, FALLBACK_RETURN_URL, {
      type: 'error',
      code: err instanceof OAuthStateError ? err.code : 'invalid_state',
    })
  }
  if (statePayload.tenantId !== auth.tenantId) {
    return redirectWithFlash(req, FALLBACK_RETURN_URL, { type: 'error', code: 'tenant_mismatch' })
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()

  // One-time claim. Everything below runs at most once per authorization.
  const claim = await consumeSharedInboxOAuthState(em, stateParam)
  if (claim.status !== 'consumed') {
    return redirectWithFlash(req, FALLBACK_RETURN_URL, { type: 'error', code: claim.status })
  }
  const sharedState = claim.state
  const returnUrl = normalizeOAuthReturnUrl(sharedState.returnUrl, FALLBACK_RETURN_URL)

  // The server-side row is authoritative for scope; the cookie only proves the
  // browser completed the same flow.
  if (
    sharedState.tenantId !== (auth.tenantId as string) ||
    sharedState.initiatedByUserId !== (auth.sub as string)
  ) {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'state_scope_mismatch' })
  }

  const scope = { tenantId: sharedState.tenantId, organizationId: sharedState.organizationId }

  // Re-check authorization AFTER consent: an administrator whose access was
  // revoked while the Google screen was open must not be able to complete.
  const isOrganizationAdmin = await hasActiveOrganizationAdminScope(container, auth.sub as string, scope)
  const holdsManage = await holdsSharedInboxManage(container, auth.sub as string, scope)
  if (!isOrganizationAdmin || !holdsManage) {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'authorization_revoked' })
  }

  const registry = container.resolve('channelAdapterRegistry') as ChannelAdapterRegistry
  const eligibility = checkSharedMailboxEligibility(registry, PROVIDER_KEY)
  if (!eligibility.eligible) {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: eligibility.reason })
  }
  const { adapter } = eligibility
  const oauthAdapter = getChannelAdapter(PROVIDER_KEY)
  if (!oauthAdapter || typeof oauthAdapter.exchangeOAuthCode !== 'function') {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'oauth_unsupported' })
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
    scope,
  )
  if (!clientCredentials) {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'oauth_client_not_configured' })
  }

  // Must byte-for-byte match the redirect_uri sent at authorize time.
  const redirectUri = toAbsoluteUrl(
    req,
    '/api/communication_channels/shared-inboxes/gmail/oauth/callback',
  )

  let exchange
  try {
    exchange = await oauthAdapter.exchangeOAuthCode({
      code,
      redirectUri,
      credentials: clientCredentials,
      scope,
      stateExtra: statePayload.extra,
    })
  } catch (err) {
    // Never log the code or any token material.
    logger.warn('shared mailbox code exchange failed', { err })
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'exchange_failed' })
  }

  const externalIdentifier = exchange.externalIdentifier?.toLowerCase() ?? null
  if (!externalIdentifier) {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'missing_mailbox_address' })
  }

  const credentialsRefId = await persistSharedInboxCredentials(
    container,
    em,
    PROVIDER_KEY,
    {
      ...exchange.credentials,
      expiresAt: exchange.expiresAt ? exchange.expiresAt.toISOString() : undefined,
    },
    scope,
  )
  // Fail closed — a shared inbox is never created without a usable credential.
  if (!credentialsRefId) {
    return redirectWithFlash(req, returnUrl, { type: 'error', code: 'credentials_unavailable' })
  }

  let channelId: string
  try {
    const channel = await createSharedInboxChannelRow({
      em,
      adapter,
      providerKey: PROVIDER_KEY,
      displayName: sharedState.displayName ?? exchange.displayName ?? externalIdentifier,
      externalIdentifier,
      credentialsRefId,
      scope,
    })
    channelId = channel.id
  } catch (err) {
    if (err instanceof SharedMailboxAlreadyProvisionedError) {
      return redirectWithFlash(req, returnUrl, { type: 'error', code: 'already_provisioned' })
    }
    throw err
  }

  await emitCommunicationChannelsEvent(
    'communication_channels.shared_inbox.provisioned',
    {
      channelId,
      providerKey: PROVIDER_KEY,
      externalIdentifier,
      provisionedByUserId: auth.sub as string,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    },
    { persistent: true },
  )

  return redirectWithFlash(req, returnUrl, { type: 'connected', channelId })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    GET: {
      summary: 'Gmail shared-mailbox OAuth callback',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 302, description: 'Redirect back to the shared-inbox admin page with a flash code' },
      ],
    },
  },
}

export default GET
