import {
  AppOriginConfigurationError,
  AppOriginRejectedError,
  assertAllowedAppOrigin,
  resolveOrganizationAppUrl,
  toSecurityEmailUrl,
  type AppUrlScope,
} from '@open-mercato/shared/lib/url'
import { OAuthGrantError } from './descriptor'

/**
 * Builds an OAuth redirect URI from `APP_URL` only (keeping its path prefix), never from the
 * request origin; outside production without `APP_URL` it falls back to `http://localhost:3000`.
 * When given, `req` must come from an allowed app origin (`Host`, `X-Forwarded-Host`, URL).
 * `path` must start with `/`.
 * Throws `OAuthGrantError('oauth_base_url_not_configured')` in production without `APP_URL`
 * and `OAuthGrantError('connect_origin_rejected')` for a request from another origin.
 */
export function resolveOAuthRedirectUri(req: Request | undefined, path: string): string {
  if (!path.startsWith('/')) throw new TypeError('[internal] OAuth redirect path must start with "/"')
  try {
    return toSecurityEmailUrl(req, path)
  } catch (error) {
    if (error instanceof AppOriginConfigurationError) throw new OAuthGrantError('oauth_base_url_not_configured', { cause: error })
    if (error instanceof AppOriginRejectedError) throw new OAuthGrantError('connect_origin_rejected', { cause: error })
    throw error
  }
}

export type OrganizationOAuthRedirect = { redirectUri: string; redirectOrigin: string | null }

/**
 * Like `resolveOAuthRedirectUri`, but prefers the organization's own address when one is set.
 * `redirectOrigin` is non-null only when that address was used; otherwise the result equals the
 * `APP_URL`-based redirect URI. A given `req` must always come from an allowed app origin.
 */
export async function resolveOAuthRedirectUriForOrganization(
  req: Request | undefined,
  path: string,
  scope: AppUrlScope,
): Promise<OrganizationOAuthRedirect> {
  if (!path.startsWith('/')) throw new TypeError('[internal] OAuth redirect path must start with "/"')
  const own = await resolveOrganizationAppUrl(scope)
  if (!own) return { redirectUri: resolveOAuthRedirectUri(req, path), redirectOrigin: null }
  if (req) {
    try {
      assertAllowedAppOrigin(req)
    } catch (error) {
      if (error instanceof AppOriginConfigurationError) throw new OAuthGrantError('oauth_base_url_not_configured', { cause: error })
      if (error instanceof AppOriginRejectedError) throw new OAuthGrantError('connect_origin_rejected', { cause: error })
      throw error
    }
  }
  return { redirectUri: `${own}${path}`, redirectOrigin: own }
}
