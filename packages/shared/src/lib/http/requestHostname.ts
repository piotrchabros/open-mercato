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

import { secretEqual } from './secretCompare'

const FORCE_HOST_HEADER = 'x-force-host'
const FORCE_HOST_SECRET_HEADER = 'x-force-host-secret'

export type HeaderReader = {
  headers: {
    get(name: string): string | null
  }
}

function readForcedHost(req: HeaderReader): string | null {
  // Test-only override. Honored only when `NODE_ENV === 'test'` AND
  // `x-force-host-secret` matches `FORCE_HOST_SECRET` (constant-time compare).
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
