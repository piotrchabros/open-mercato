import { parseBooleanToken } from '../boolean'

/**
 * Whether session cookies should carry the `Secure` attribute.
 *
 * Previously derived from `NODE_ENV === 'production'`, which is not a
 * trustworthy production discriminator in this repo: `docker-compose.fullapp.yml`
 * and the Dockerfile both run the production-shaped stack with
 * `NODE_ENV: development`, so session cookies shipped there WITHOUT `Secure`.
 * The Traefik overlay redirects http→https, but the redirect fires only after
 * the plaintext request carrying the cookie has already left the client.
 *
 * Order: an explicit `COOKIE_SECURE` wins; otherwise the request scheme decides;
 * otherwise default to secure. Defaulting ON is the safe direction — the failure
 * mode is a cookie rejected over plain http in local development, not a session
 * token sent in the clear in production.
 */
export function shouldUseSecureCookies(input?: {
  request?: { url?: string; headers?: { get(name: string): string | null } } | null
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = input?.env ?? process.env

  const explicit = parseBooleanToken(env.COOKIE_SECURE)
  if (explicit !== null) return explicit

  const request = input?.request ?? null
  if (request) {
    const forwardedProto = request.headers?.get('x-forwarded-proto')
    if (forwardedProto) return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https'
    if (typeof request.url === 'string') {
      try {
        return new URL(request.url).protocol === 'https:'
      } catch {
        // Fall through to the default below.
      }
    }
  }

  return true
}
