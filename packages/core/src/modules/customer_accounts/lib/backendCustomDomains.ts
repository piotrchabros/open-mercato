import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

/**
 * Backend custom domains (#4271) let an organization serve the admin app on its
 * own hostname. Unlike the portal equivalent, the request Host then determines
 * which organization an operator is acting on — so a forged Host header is a
 * cross-organization escalation, not just a wrong rendering.
 *
 * The base Docker stack publishes the app directly on ${APP_PORT} with the
 * Traefik overlay left opt-in (docker-compose.fullapp.yml), meaning anyone who
 * can reach that port sets Host to whatever they want. The feature therefore
 * stays off unless the operator both opts in AND declares that a trusted proxy
 * terminates requests.
 *
 * This is a containment control, not the authorization itself: the host may
 * only ever NARROW the scope a session already grants, never widen it. That
 * invariant is enforced separately in the auth and organization-scope layers.
 */

export class BackendCustomDomainsMisconfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendCustomDomainsMisconfigured'
  }
}

export function isBackendCustomDomainsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanWithDefault(env.BACKEND_CUSTOM_DOMAINS_ENABLED, false)
}

function hasTrustedProxyAssertion(env: NodeJS.ProcessEnv): boolean {
  const cidrs = env.TRUSTED_PROXY_CIDRS
  return typeof cidrs === 'string' && cidrs.trim().length > 0
}

/**
 * Fails closed when the feature is enabled without the guarantees it depends on.
 *
 * Call at boot and before any host-derived organization binding is trusted.
 * Returns silently when the feature is off, so existing deployments are
 * untouched.
 */
export function assertBackendCustomDomainsConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isBackendCustomDomainsEnabled(env)) return

  if (!hasTrustedProxyAssertion(env)) {
    throw new BackendCustomDomainsMisconfigured(
      'BACKEND_CUSTOM_DOMAINS_ENABLED is on but TRUSTED_PROXY_CIDRS is not set. ' +
        'Host-derived organization scope is only safe behind a proxy that overwrites the Host header; ' +
        'without it any client can select another organization by sending a forged Host.',
    )
  }

  // The forced-host test override lets a caller name any hostname given the
  // shared secret. Harmless while Host only picks a portal rendering; a
  // cross-organization bypass once Host picks the admin scope.
  if (parseBooleanWithDefault(env.OM_ALLOW_FORCED_HOST, false)) {
    throw new BackendCustomDomainsMisconfigured(
      'BACKEND_CUSTOM_DOMAINS_ENABLED and OM_ALLOW_FORCED_HOST must never be enabled together. ' +
        'The forced-host override would let any caller holding FORCE_HOST_SECRET select another organization.',
    )
  }
}

/**
 * True only when backend custom domains are both enabled and safely configured.
 * Never throws, so request-path callers can fail closed without a try/catch.
 */
export function backendCustomDomainsUsable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    assertBackendCustomDomainsConfig(env)
    return isBackendCustomDomainsEnabled(env)
  } catch {
    return false
  }
}
