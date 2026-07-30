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

const member = { sub: 'u1', tenantId: TENANT_A, orgId: ORG_A }
const superAdmin = { ...member, isSuperAdmin: true }
const foreignMember = { sub: 'u2', tenantId: TENANT_B, orgId: ORG_B }

describe('conflictsWithHostBinding', () => {
  it('never refuses when the host is unbound', () => {
    expect(conflictsWithHostBinding(superAdmin, null)).toBe(false)
    expect(conflictsWithHostBinding(foreignMember, null)).toBe(false)
  })

  it('allows a member of the bound tenant', () => {
    expect(conflictsWithHostBinding(member, BOUND)).toBe(false)
  })

  it('refuses a session belonging to another tenant', () => {
    // The one case that cannot be silently re-scoped: serving tenant A's
    // organization to a tenant-B session would GRANT scope, not narrow it.
    // Login is host-agnostic, so this is reachable by authenticating on
    // someone else's branded domain.
    expect(conflictsWithHostBinding(foreignMember, BOUND)).toBe(true)
  })

  it('does NOT refuse a super-admin whose scope cookies disagree with the binding', () => {
    // Decision Q2: cookies are discarded, not refused. Discarding narrows -
    // the hostname is authoritative and the scope resolver still checks that
    // the caller may access the bound organization. Refusing would make
    // ordinary navigation between branded domains error out on a stale cookie.
    expect(conflictsWithHostBinding(superAdmin, BOUND)).toBe(false)
  })

  it('allows a session with no tenant rather than inventing one', () => {
    expect(conflictsWithHostBinding({ sub: 'u3', tenantId: null, orgId: null }, BOUND)).toBe(false)
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

describe('readRequestHost', () => {
  it('prefers x-forwarded-host over host, so login and the scope clamp agree', async () => {
    // The two used to disagree: login read `host`, the clamp read
    // `x-forwarded-host`. Behind a proxy that rewrites one but not the other,
    // a session could be minted on a domain the clamp then rejects.
    const { readRequestHost } = await import('@open-mercato/shared/lib/auth/server')
    const req = new Request('https://internal.invalid/x', {
      headers: { host: 'internal.invalid', 'x-forwarded-host': 'crm.acme.com' },
    })
    expect(readRequestHost(req)).toBe('crm.acme.com')
  })

  it('falls back to host when no forwarded header is present', async () => {
    const { readRequestHost } = await import('@open-mercato/shared/lib/auth/server')
    const req = new Request('https://crm.acme.com/x', { headers: { host: 'crm.acme.com' } })
    expect(readRequestHost(req)).toBe('crm.acme.com')
  })
})
