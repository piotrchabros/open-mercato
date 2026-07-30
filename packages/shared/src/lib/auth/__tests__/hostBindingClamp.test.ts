/**
 * Host-binding clamp (#4271, task 3.4).
 *
 * Invariant under test: a bound hostname may only ever NARROW the scope a
 * session already grants. It never grants scope, and it never silently serves
 * a different organization than the operator asked for.
 */
import { conflictsWithHostBinding } from '@open-mercato/shared/lib/auth/server'
import {
  registerHostBindingResolver,
  resolveHostBinding,
  resolveHostBindingOutcome,
  hasHostBindingResolver,
  type HostBinding,
} from '@open-mercato/shared/lib/auth/hostBindingStore'

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const ORG_A = 'org-a'
const ORG_B = 'org-b'

const BOUND: HostBinding = { hostname: 'crm.acme.com', tenantId: TENANT_A, organizationId: ORG_A }

const NO_COOKIE = { applied: false, value: null }
const cookie = (value: string | null) => ({ applied: true, value })

const member = { sub: 'u1', tenantId: TENANT_A, orgId: ORG_A }
const superAdmin = { ...member, isSuperAdmin: true }
const foreignMember = { sub: 'u2', tenantId: TENANT_B, orgId: ORG_B }

describe('conflictsWithHostBinding', () => {
  it('never conflicts when the host is unbound', () => {
    // The overwhelming majority of deployments. Every combination must pass.
    expect(conflictsWithHostBinding(superAdmin, cookie(TENANT_B), cookie(ORG_B), null)).toBe(false)
    expect(conflictsWithHostBinding(foreignMember, NO_COOKIE, NO_COOKIE, null)).toBe(false)
  })

  it('allows a member of the bound tenant with no overrides', () => {
    expect(conflictsWithHostBinding(member, NO_COOKIE, NO_COOKIE, BOUND)).toBe(false)
  })

  it('denies a session belonging to another tenant', () => {
    // Login is host-agnostic, so a tenant-B user can authenticate on tenant A's
    // branded domain and receive a first-party session there.
    expect(conflictsWithHostBinding(foreignMember, NO_COOKIE, NO_COOKIE, BOUND)).toBe(true)
  })

  it('denies a super-admin whose tenant cookie points elsewhere', () => {
    expect(conflictsWithHostBinding(superAdmin, cookie(TENANT_B), NO_COOKIE, BOUND)).toBe(true)
  })

  it('denies a super-admin whose org cookie points at another organization', () => {
    expect(conflictsWithHostBinding(superAdmin, NO_COOKIE, cookie(ORG_B), BOUND)).toBe(true)
  })

  it('denies the all-organizations selection on a bound host', () => {
    // `__all__` normalizes to value:null, i.e. a widening - which is exactly
    // what a bound host exists to prevent.
    expect(conflictsWithHostBinding(superAdmin, NO_COOKIE, cookie(null), BOUND)).toBe(true)
  })

  it('allows a super-admin whose cookies agree with the binding', () => {
    expect(conflictsWithHostBinding(superAdmin, cookie(TENANT_A), cookie(ORG_A), BOUND)).toBe(false)
  })

  it('ignores scope cookies for a non-super-admin, since they are never honored', () => {
    // A plain member's cookies do not drive applySuperAdminScope, so they must
    // not be able to lock themselves out either.
    expect(conflictsWithHostBinding(member, cookie(TENANT_B), cookie(ORG_B), BOUND)).toBe(false)
  })

  it('allows a session with no tenant rather than inventing one', () => {
    // A null tenant cannot be compared; the positive binding and its access
    // check belong to the organization-scope resolver, not here.
    expect(conflictsWithHostBinding({ sub: 'u3', tenantId: null, orgId: null }, NO_COOKIE, NO_COOKIE, BOUND)).toBe(
      false,
    )
  })
})

describe('host binding store', () => {
  afterEach(() => registerHostBindingResolver(null))

  it('resolves to null when no resolver is registered', async () => {
    expect(hasHostBindingResolver()).toBe(false)
    await expect(resolveHostBinding('crm.acme.com')).resolves.toBeNull()
  })

  it('does not call the resolver for a blank hostname', async () => {
    const resolver = jest.fn(async () => BOUND)
    registerHostBindingResolver(resolver)
    await expect(resolveHostBinding('   ')).resolves.toBeNull()
    await expect(resolveHostBinding(null)).resolves.toBeNull()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('reports a resolver failure as unavailable, not as unbound (task 3.6)', async () => {
    // The distinction is the whole point. Collapsing a failure into "unbound"
    // would hand the operator their cookie-selected organization under someone
    // else's branded domain - exactly what the binding exists to prevent.
    registerHostBindingResolver(async () => {
      throw new Error('db down')
    })
    await expect(resolveHostBindingOutcome('crm.acme.com')).resolves.toEqual({ kind: 'unavailable' })
  })

  it('distinguishes unbound from bound in the outcome form', async () => {
    registerHostBindingResolver(async (host) => (host === 'crm.acme.com' ? BOUND : null))
    await expect(resolveHostBindingOutcome('crm.acme.com')).resolves.toEqual({ kind: 'bound', binding: BOUND })
    await expect(resolveHostBindingOutcome('app.openmercato.com')).resolves.toEqual({ kind: 'unbound' })
    await expect(resolveHostBindingOutcome(null)).resolves.toEqual({ kind: 'unbound' })
  })

  it('the legacy null-collapsing wrapper still hides a failure', async () => {
    // Kept for callers that genuinely cannot fail closed; documented as such so
    // nobody reaches for it on a new security-relevant path.
    registerHostBindingResolver(async () => {
      throw new Error('db down')
    })
    await expect(resolveHostBinding('crm.acme.com')).resolves.toBeNull()
  })

  it('returns the binding the resolver supplies', async () => {
    registerHostBindingResolver(async () => BOUND)
    await expect(resolveHostBinding('crm.acme.com')).resolves.toEqual(BOUND)
  })
})
