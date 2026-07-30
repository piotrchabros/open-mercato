import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  ensureWarmUp,
  getSharedCustomDomainRouter,
  isPlatformHost,
  type CustomDomainRouter,
} from './lib/customDomainResolver'
import { tryNormalizeHostname } from '@open-mercato/core/modules/customer_accounts/lib/hostname'
import { backendCustomDomainsUsable } from '@open-mercato/core/modules/customer_accounts/lib/backendCustomDomains'
import { resolveRequestHostname } from '@open-mercato/shared/lib/http/requestHostname'

function buildRewrittenPath(orgSlug: string, originalPathname: string): string {
  const trimmed = originalPathname.startsWith('/') ? originalPathname : `/${originalPathname}`
  if (trimmed === '/') return `/${orgSlug}/portal`
  // Avoid double-prefix if a request already targets /{orgSlug}/portal/* on a custom host.
  if (trimmed.startsWith(`/${orgSlug}/portal`)) return trimmed
  return `/${orgSlug}/portal${trimmed}`
}

type CustomHostResolution =
  | { kind: 'portal'; orgSlug: string }
  | { kind: 'backend' }
  | { kind: 'unknown' }
  | { kind: 'error' }

async function resolveForCustomHost(
  router: CustomDomainRouter,
  hostname: string,
): Promise<CustomHostResolution> {
  try {
    const resolution = await router.resolve(hostname)
    if (!resolution) return { kind: 'unknown' }

    // Entries cached by a build older than #4271 carry no target; every
    // mapping that existed then was a portal one.
    if ((resolution.target ?? 'portal') === 'backend') {
      // Fail closed: a backend mapping must not route while the feature is
      // off or misconfigured, otherwise disabling the flag would leave
      // already-registered hosts live.
      if (!backendCustomDomainsUsable()) return { kind: 'unknown' }
      return { kind: 'backend' }
    }

    if (!resolution.orgSlug) return { kind: 'unknown' }
    return { kind: 'portal', orgSlug: resolution.orgSlug }
  } catch (err) {
    console.warn(`[proxy] custom-domain resolve failed for ${hostname}`, err)
    return { kind: 'error' }
  }
}

export async function proxy(req: NextRequest) {
  // Kick off a one-shot warm-up the first time the proxy runs. Failures are
  // logged and ignored — per-request fetches keep working with an empty cache.
  void ensureWarmUp().catch(() => {})

  const rawHost = resolveRequestHostname(req)
  const normalizedHost = rawHost ? tryNormalizeHostname(rawHost) : null
  const platform = !normalizedHost || isPlatformHost(normalizedHost)
  const pathname = req.nextUrl.pathname

  const requestHeaders = new Headers(req.headers)

  if (platform) {
    // Existing behavior preserved: expose the request pathname to layouts
    // sitting above dynamic segments (issue #1083).
    requestHeaders.set('x-next-url', pathname)
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  // Custom domain. The matcher already excludes /api/* so the proxy never sees
  // API requests — they hit the route handlers directly, which resolve the
  // tenant from the Host header (see customer_accounts/lib/resolveTenantContext).
  const router = getSharedCustomDomainRouter()
  const result = await resolveForCustomHost(router, normalizedHost!)

  if (result.kind === 'error') {
    // Cold-miss fetch failed and no stale entry was available. Tell the client
    // to retry shortly while the platform recovers.
    return new NextResponse('Domain temporarily unavailable', {
      status: 503,
      headers: { 'retry-after': '5' },
    })
  }

  if (result.kind === 'unknown') {
    // Hostname is not mapped (or no longer active). Pass through so Next.js
    // surfaces its standard 404, rather than rewriting to a non-existent org.
    requestHeaders.set('x-next-url', pathname)
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  if (result.kind === 'backend') {
    // Backend-target host: serve the app as-is. No portal prefix, so /backend
    // and /login resolve exactly as they do on the platform domain.
    //
    // Routing is all this branch does. The organization binding is NOT applied
    // here: /api/* is excluded from the matcher (see config below), so any
    // header set here is absent on the API surface and trivially forgeable by
    // a client. Auth and organization-scope resolution re-read the Host
    // themselves and clamp there.
    requestHeaders.set('x-next-url', pathname)
    requestHeaders.set('x-custom-domain', '1')
    const backendResponse = NextResponse.next({ request: { headers: requestHeaders } })
    backendResponse.headers.set('x-custom-domain', '1')
    return backendResponse
  }

  if (pathname === '/backend' || pathname.startsWith('/backend/')) {
    // Portal-target host asked for an admin route. Rewriting would produce
    // /{orgSlug}/portal/backend/... and a confusing 404; answer directly so it
    // is obvious the admin app is not served on this hostname.
    return new NextResponse('Not found', { status: 404 })
  }

  const rewrittenPath = buildRewrittenPath(result.orgSlug, pathname)
  const rewrittenUrl = req.nextUrl.clone()
  rewrittenUrl.pathname = rewrittenPath

  // The (frontend) layout reads `x-next-url` to extract the orgSlug — set it
  // to the rewritten path so the existing pathname-matching logic works.
  requestHeaders.set('x-next-url', rewrittenPath)
  requestHeaders.set('x-custom-domain', '1')

  const response = NextResponse.rewrite(rewrittenUrl, { request: { headers: requestHeaders } })
  response.headers.set('x-custom-domain', '1')
  return response
}

// Match app routes while skipping Next internals, API routes, and static assets.
// The x-next-url header lets server layouts above dynamic segments resolve the
// request pathname without receiving params, preventing full client-tree
// remounts on navigation (see issue #1083).
//
// Next.js 16 renamed middleware.ts → proxy.ts and pinned proxy to the Node
// runtime; the `runtime` field is no longer accepted in the config object.
// Custom-domain routing relies on Node so the proxy can call our own
// /api/customer_accounts/domain-resolve endpoint to populate its in-memory
// cache (per spec 2026-04-08-portal-custom-domain-routing.md, Phase 2).
export const config = {
  matcher: [
    '/((?!api/|_next/|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|txt|xml|json|woff|woff2|ttf|eot)$).*)',
  ],
}
