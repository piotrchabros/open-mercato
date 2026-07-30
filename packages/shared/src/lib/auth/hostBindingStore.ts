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

let resolver: HostBindingResolver | null = null

export function registerHostBindingResolver(next: HostBindingResolver | null): void {
  resolver = next
}

export function hasHostBindingResolver(): boolean {
  return resolver !== null
}

/**
 * Resolves the organization a hostname is bound to, or null when the hostname
 * is unbound, the feature is off, or resolution fails.
 *
 * Fails OPEN to null on a resolver error, and that is deliberate: a null
 * binding means "apply no host constraint", which leaves the pre-existing
 * cookie-scoped behavior in place rather than locking every operator out of the
 * admin panel during a database blip. The security property this feature adds
 * is enforced by the *denials* built on top of a present binding — it never
 * depends on a binding appearing.
 */
export async function resolveHostBinding(hostname: string | null | undefined): Promise<HostBinding | null> {
  if (!resolver) return null
  if (typeof hostname !== 'string' || hostname.trim().length === 0) return null
  try {
    return await resolver(hostname)
  } catch {
    return null
  }
}
