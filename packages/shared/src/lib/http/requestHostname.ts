// Resolves the raw (unnormalized) hostname for an incoming request, honoring a
// test-only `x-force-host` override.
//
// Both the Next.js proxy (`apps/mercato/src/proxy.ts`) and the customer-portal
// tenant resolver (`packages/core/src/modules/customer_accounts/lib/resolveTenantContext.ts`)
// duplicated this exact logic: fall back to the `Host` header unless
// `NODE_ENV === 'test'` AND the `x-force-host-secret` header matches
// `FORCE_HOST_SECRET` (checked with a constant-time comparison).
//
// This returns the RAW hostname — callers are responsible for normalizing it
// (e.g. via `tryNormalizeHostname` in `@open-mercato/core/modules/customer_accounts/lib/hostname`).
// Hostname normalization stays in `core` because moving it here would pull the
// custom-domain `HostnameNormalizationError` contract into `shared` for no
// behavioral gain — returning the raw host and letting each call site normalize
// preserves existing behavior with the least code moved.

import { parseBooleanWithDefault } from '../boolean'
import { secretEqual } from './secretCompare'

const FORCE_HOST_HEADER = 'x-force-host'
const FORCE_HOST_SECRET_HEADER = 'x-force-host-secret'

export type HeaderReader = {
  headers: {
    get(name: string): string | null
  }
}

function readForcedHost(req: HeaderReader): string | null {
  // Test-only override, behind THREE independent gates. All must hold.
  //
  // `NODE_ENV` alone is not a trustworthy production discriminator in this
  // repo: docker-compose.fullapp.yml and the Dockerfile both set
  // `NODE_ENV: development` in the production-shaped stack, so several
  // `NODE_ENV === 'production'` branches are already inert there. One env
  // drift to `test` would otherwise turn this test hook into a hostname
  // spoofing primitive — which matters much more once request Host determines
  // backend organization scope (#4271). `OM_ALLOW_FORCED_HOST` must therefore
  // be opted into explicitly, and defaults to false.
  if (!parseBooleanWithDefault(process.env.OM_ALLOW_FORCED_HOST, false)) return null
  if (process.env.NODE_ENV !== 'test') return null
  const expected = process.env.FORCE_HOST_SECRET
  if (!expected) return null
  if (!secretEqual(req.headers.get(FORCE_HOST_SECRET_HEADER), expected)) return null
  const host = req.headers.get(FORCE_HOST_HEADER)
  return host && host.length > 0 ? host : null
}

/**
 * Resolves the raw request hostname: the `x-force-host` override when the
 * test-only secret gate passes, otherwise the `Host` header. Returns `null`
 * when neither is present.
 */
export function resolveRequestHostname(req: HeaderReader): string | null {
  const forced = readForcedHost(req)
  if (forced) return forced
  return req.headers.get('host')
}
