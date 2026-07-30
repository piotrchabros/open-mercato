/**
 * Host → organization binding seam (#4271).
 *
 * `packages/shared` cannot import `customer_accounts`, where `DomainMapping`
 * and its resolver live, so the binding is registered INTO shared at bootstrap
 * rather than resolved here. Same shape as the optimistic-lock and mutation-guard
 * stores.
 *
 * When no resolver is registered — every deployment with the feature off, plus
 * fresh installs and unit tests — `resolveHostBinding` returns null and the auth
 * path behaves exactly as it did before this existed.
 *
 * The binding may only ever NARROW the scope a session already grants. Nothing
 * here grants access: a bound host can reject a session, never widen one.
 */

export type HostBinding = {
  hostname: string
  tenantId: string
  organizationId: string
}

export type HostBindingResolver = (hostname: string) => Promise<HostBinding | null>

/**
 * Tri-state on purpose. "This hostname is not bound" and "we could not find out
 * whether it is bound" must not collapse into one value.
 *
 * - `unbound`  — no resolver, blank host, or the host maps to nothing. Every
 *                deployment with the feature off lands here, and it proceeds
 *                exactly as before.
 * - `bound`    — the host serves a specific organization; the clamp applies.
 * - `unavailable` — resolution threw. On a bound-capable deployment this MUST
 *                fail closed: treating it as `unbound` would silently hand the
 *                operator their cookie-selected organization under someone
 *                else's branded domain, which is the whole failure this feature
 *                exists to prevent.
 */
export type HostBindingOutcome =
  | { kind: 'unbound' }
  | { kind: 'bound'; binding: HostBinding }
  | { kind: 'unavailable' }

let resolver: HostBindingResolver | null = null

export function registerHostBindingResolver(next: HostBindingResolver | null): void {
  resolver = next
}

export function hasHostBindingResolver(): boolean {
  return resolver !== null
}

/**
 * Resolves whether a hostname is bound to an organization.
 *
 * Distinguishes "unbound" from "could not determine" so callers can fail closed
 * on the latter — the portal equivalent (customerAuthServer.ts) collapses both
 * into an unconstrained session, which is acceptable for a storefront but not
 * for an admin console.
 */
export async function resolveHostBindingOutcome(
  hostname: string | null | undefined,
): Promise<HostBindingOutcome> {
  if (!resolver) return { kind: 'unbound' }
  if (typeof hostname !== 'string' || hostname.trim().length === 0) return { kind: 'unbound' }
  try {
    const binding = await resolver(hostname)
    return binding ? { kind: 'bound', binding } : { kind: 'unbound' }
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * Convenience wrapper that collapses `unavailable` into `null`.
 * Only for callers that genuinely cannot fail closed — prefer the outcome form.
 */
export async function resolveHostBinding(hostname: string | null | undefined): Promise<HostBinding | null> {
  const outcome = await resolveHostBindingOutcome(hostname)
  return outcome.kind === 'bound' ? outcome.binding : null
}
