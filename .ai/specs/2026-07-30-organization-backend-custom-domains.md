# Per-Organization Custom Domains for the Backend App

- **Status:** Draft (pending implementation)
- **Scope:** OSS
- **Author:** harness-plan (auto)
- **Date:** 2026-07-30
- **Issue:** [#4271](https://github.com/open-mercato/open-mercato/issues/4271)
- **Related:**
  - `.ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md` — **amended by this spec**; its "Deferred: Custom domain for the back office panel" (`:37`) is what this spec un-defers
  - `.ai/specs/implemented/2026-05-29-org-scope-fail-open-authorization-hardening.md` — org-scope fail-open hardening; this spec must not weaken it
  - `.ai/specs/implemented/2026-06-05-tenant-ownership-and-module-acl-authorization.md` — tenant/org authorization boundaries
  - `.ai/specs/2026-05-19-superadmin-users-list-context-scope.md` — superadmin cross-org context, which a bound host deliberately restricts
  - `.ai/specs/2026-05-12-railway-one-command-deploy.md` — single `--domain` / single `APP_URL` assumption
  - `.ai/specs/2026-06-04-aws-terraform-deployment-playbook.md` — custom-domain ingress explicitly deferred (`:17`, `:1277`)
  - `.ai/specs/2026-07-07-integration-auth-login-redirect-loop.md` — prior art on redirect loops when login host ≠ app host

## TLDR

A single Open Mercato instance can host several organizations, but the backend/admin app is
reachable on exactly one hostname (`APP_URL`). This spec lets an organization bind its own hostname
— `crm.staffinit.com` → organization "Staffinit" — on the same instance, reusing the **existing**
portal custom-domain subsystem (`DomainMapping`, DNS verification, Traefik on-demand TLS,
`proxy.ts`) rather than building a parallel one.

The headline design point, and the thing most likely to be got wrong: **this feature is a
server-side authorization clamp, not a routing change.** Serving `/backend` on a branded hostname is
cosmetic. The deliverable is that on a bound host the `om_selected_org` / `om_selected_tenant`
cookies can no longer determine which organization the operator is acting on. Those cookies are
client-set (`OrganizationSwitcher.tsx:170` writes `document.cookie`), and they are consumed by
`applySuperAdminScope` (`packages/shared/src/lib/auth/server.ts:127-158`) **before** any scope
resolver runs. Hiding the organization switcher is decoration; the clamp is the feature.

Scope is deliberately narrower than the issue as filed. Two reductions are load-bearing:

1. **The proxy matcher is not extended to `/api/`.** API routes already resolve the host themselves
   (`customer_accounts/lib/resolveTenantContext.ts:85-153`). Extending the matcher would put a
   Node-runtime, DB-fetching proxy in front of every API call in the product for no gain.
2. **The outbound-link migration is one function, not ~51 call sites.**
   `resolveSafeRedirectLocation` (`auth/lib/requestRedirect.ts:22-27`) already falls back to
   host-relative paths, so logout / autologin / session-refresh are host-correct today. The single
   function that discards the request host is `getSecurityEmailBaseUrl`
   (`packages/shared/src/lib/url.ts:252-263`). Only ~6 genuinely queue/CLI-scoped senders need an
   `orgId` lookup.

The feature is flag-gated (`BACKEND_CUSTOM_DOMAINS_ENABLED`, default off) and supported on
self-hosted Docker Compose with the opt-in Traefik overlay only.

## Overview

Today a tenant running three businesses as three organizations — a software house, a recruitment
agency, a marketing agency — reaches the admin app through one hostname for all three, and every
absolute link the platform generates points at that one hostname. This spec lets each organization
bind its own: `crm.bespokesoft.pl`, `crm.staffinit.com`, `crm.bluebee.marketing`, all on the same
instance.

The mechanism already exists. The April 2026 portal custom-domain work shipped a `DomainMapping`
entity with a DNS-verification lifecycle, a TLS-retry worker, Traefik on-demand ACME gated by a
ForwardAuth endpoint, an in-process stale-while-revalidate host cache, and an admin stepper UI. It
resolves a hostname to `(tenantId, organizationId, orgSlug)` and rewrites the request into the
customer portal. What it does not do — by explicit deferral at
`.ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md:37` — is serve the back office.

This spec adds a `target` discriminator to that mapping, teaches the proxy to pass backend-target
hosts through unrewritten, and — the substantive part — makes the resolved organization
**authoritative** over the `om_selected_org` / `om_selected_tenant` cookies for the duration of that
request. Everything else (URL helpers, admin UI, docs) follows from those three.

The work divides into four independently shippable slices: hardening and testing the existing
subsystem (which is currently untested and whose test hook cannot fire); the binding itself; the
outbound-link corrections; and the guardrails around WebAuthn plus documentation. Only the second
slice is user-visible, and it is deliberately not shippable without the first.

## Locked Decisions

| # | Question | Decision |
|---|----------|----------|
| D1 | Where do backend domain mappings live? | **Additive `target: 'portal' \| 'backend'` column on the existing `DomainMapping`** in `customer_accounts`. Rationale in "Alternatives considered". |
| D2 | Does the proxy handle `/api/`? | **No.** Matcher unchanged. API routes read the host themselves, as they already do. |
| D3 | Where is the host binding enforced? | Two load-bearing layers: `applySuperAdminScope` (`shared/lib/auth/server.ts:127-158`) and `resolveOrganizationScopeForRequest` (`directory/utils/organizationScope.ts:441-467`), the latter **before** the cache key is built at `:472`. |
| D4 | Is the feature on by default? | **No.** `BACKEND_CUSTOM_DOMAINS_ENABLED` defaults off and hard-fails at boot if enabled without a trusted-proxy assertion. |
| D5 | Which outbound links become org-aware? | `getSecurityEmailBaseUrl` (request-scoped, one function) + a new `urlForOrgBackend` for ~6 queue/CLI senders. OpenAPI `servers` becomes **relative**. Attachments client components are out of scope. |
| D6 | Origin allowlist | **Not** made DB-backed. `assertAllowedAppOrigin` stays synchronous; callers pass a pre-resolved allowed host. Only `status:'active'` mappings are ever allowlisted. **Consequence, documented in UPGRADE_NOTES and the Traefik README:** a hostname registered through the self-service admin UI must ALSO be added to `APP_ALLOWED_ORIGINS` before request-scoped outbound links follow it. Queue/CLI senders use the DB-backed `urlForOrgBackend` and are unaffected. |

## Open Questions (escalated to the maintainer on #4271)

These block Phase 3, not Phase 2. Recorded here so the answer lands in the spec rather than in a
comment thread.

| # | Question | Why it matters | Default assumed by this spec |
|---|----------|----------------|------------------------------|
| Q1 | Does `AuthContext` gain a first-class `hostBinding` / `boundOrgId` field, or is each layer patched independently? | The clamp must land before the org-scope cache key (`organizationScope.ts:472`), while `applySuperAdminScope` runs earlier still, in a different package, through a function with no host access (`resolveAuthFromCookiesDetailed`, `server.ts:290`). Getting the ordering or the key wrong **fails silently** — a cached cross-org scope served to the wrong host, visible only under concurrency. A first-class field makes the clamp assertable at every consumer, including the ~102 request-less scope calls and direct readers like `attachments/lib/requestScope.ts:26`. | First-class `hostBinding` on `AuthContext`. |
| Q2 | On a bound host, when a super-admin's `om_selected_tenant`/`om_selected_org` disagrees with the binding: hard-deny (403) or silently clamp? | **ANSWERED 2026-07-30: silently clamp.** The cookie is a preference; the hostname is authoritative. Discarding it NARROWS scope, and the scope resolver still enforces that the caller may access the bound organization, so nothing is granted. Refusing would make ordinary navigation between branded domains error out on a stale cookie. **A foreign-tenant session is still refused** — silently serving it the host's organization would GRANT scope rather than narrow it, and that case keeps the 403. | **Silent clamp for cookie mismatches; 403 retained for cross-tenant sessions.** |
| Q3 | May one organization bind more than one backend hostname? | Determines whether the partial unique in D-M1 is `(organization_id) WHERE target='backend' AND status='active'` or absent. | **Exactly one** active backend host per organization. |

## Problem Statement

### P1 — No host → organization binding for the backend

`DomainMapping` resolution is wired only to the portal rewrite. `apps/mercato/src/proxy.ts:29-35`
(`buildRewrittenPath`) prefixes **everything** on a non-platform host with `/{orgSlug}/portal`, so
`https://crm.staffinit.com/backend/directory/organizations` today rewrites to
`/{orgSlug}/portal/backend/directory/organizations` → 404. Nothing maps a hostname to an
organization for `/backend` routes.

### P2 — Organization selection is a client-set cookie, not the host

Backend org scope derives from `om_selected_org` / `om_selected_tenant`, written client-side by
`OrganizationSwitcher.tsx:155,170` via `document.cookie` (no `Secure`, no `HttpOnly`). They are read
by `applySuperAdminScope` (`shared/lib/auth/server.ts:127-158`), which rewrites `auth.tenantId` and
`auth.orgId` and returns the mutated `AuthContext` from three call sites: `:305`
(`resolveAuthFromCookiesDetailed`), `:346` (token path), `:373` (API-key path).

**This is why constraining only the scope resolver is insufficient.** There are ~1223 direct
`auth.tenantId` references and ~881 direct `auth.orgId` references across `packages/` + `apps/`;
each is a call site that reads the cookie-rewritten context without passing through
`resolveOrganizationScopeForRequest`. `attachments/lib/requestScope.ts:8-17` documents that split
explicitly and falls back to `auth.orgId`. Additionally, the scope resolver *specifically exempts*
super-admins from its own tenant clamp (`organizationScope.ts:451-453`).

### P3 — Outbound absolute links ignore the request host

`getSecurityEmailBaseUrl` (`packages/shared/src/lib/url.ts:252-263`) asserts the request origin and
then returns `env.APP_URL`, discarding the host. Consequence today, independent of this feature:
`auth/api/session/refresh.ts:70,78,82` bounces a user off a branded host mid-session.

Note the issue's inventory overstates the surface. `resolveSafeRedirectLocation`
(`auth/lib/requestRedirect.ts:22-27`) already falls back to a host-relative path when the origin is
not allowlisted, so `auth/api/autologin.ts` (4 sites), `auth/api/logout.ts:41` and
`auth/api/session/refresh.ts` are correct on any host once `getSecurityEmailBaseUrl` is fixed.

### P4 — The custom-domain subsystem is untested, and its test hook cannot fire

The April portal spec promises tests at `:1627-1659`, `:1892`, `:1921-1922` that were **never
written**. There is no test for `apps/mercato/src/proxy.ts`, none for `urlForCustomerOrg`
(`customer_accounts/lib/customerUrl.ts:35`), none for `getCustomerAuthForHost`
(`customer_accounts/lib/customerAuthServer.ts:104`), and no `__integration__` spec anywhere
references `X-Force-Host`, `domain-resolve`, `domain-check` or `DomainMapping`.

Worse, the `X-Force-Host` bypass is **unreachable** from the integration harness: `proxy.ts:16` gates
on `NODE_ENV !== 'test'`, and `NODE_ENV=test` is set only by
`scripts/test-create-app-integration.ts:72,215` — the standalone create-app harness.
`scripts/dev-ephemeral.ts` never sets it. Building host-bound tests on that hook requires re-plumbing
it first.

### P5 — Pre-existing defects this feature would amplify

| ID | Defect | Evidence | Why it matters here |
|---|---|---|---|
| P5.1 | Railway deployer never injects `PLATFORM_DOMAINS` | `packages/cli/src/lib/deploy/railway/env.ts:74-78` sets only `APP_URL`/`NEXT_PUBLIC_APP_URL`; default is `localhost,openmercato.com` (`customer_accounts/lib/platformDomains.ts:9-13`) | A Railway deploy treats its own host as a custom domain, triggering a DB resolve on every page request. Amplified from "portal only" to "the whole backend". |
| P5.2 | Session cookies lack `Secure` in the shipped fullapp stack | `auth/api/login.ts:212-218` sets `secure: NODE_ENV === 'production'`; `docker-compose.fullapp.yml:151` and `Dockerfile:77,134` run `NODE_ENV: development` | Several `NODE_ENV === 'production'` security branches are inert in the stack the Traefik overlay is designed to sit on. |
| P5.3 | `hostname-unique` guard misses non-active incumbents | `customer_accounts/data/guards.ts:66` calls `resolveByHostname`, which matches `status:'active'` only (`domainMappingService.ts:466`) | A cross-tenant claim against a `dns_failed` incumbent falls through the guard and dies on the DB unique index (`entities.ts:320`) as an opaque 500 instead of the deliberate non-disclosing 409 at `:74-79`. Not a takeover vector — the unique index holds — but a UX/observability defect with no test (`guards.test.ts:172-192` covers only the `active` case). |
| P5.4 | `resolveActiveByOrg` has no uniqueness guarantee | `domainMappingService.ts:195` does `findOne({organizationId, status:'active'})` | Becomes a correctness bug the moment two targets coexist: it would cheerfully return a **backend** host to a customer-portal email builder. |

## Goals / Non-Goals

**Goals**

- One instance, N organizations, N backend hostnames, each serving `/backend` scoped to its org.
- A bound host constrains organization scope server-side; the scope cookies cannot override it.
- The platform domain and all existing portal custom domains behave byte-identically.
- Emails triggered in an organization's context link to that organization's backend domain.
- Opt-in per organization; opt-in per deployment via a flag.

**Non-Goals**

- Cross-domain SSO or shared sessions between hosts. Cookies are host-only and stay that way.
- Serving `/api/` through the Next proxy.
- Making `assertAllowedAppOrigin` DB-backed.
- Railway or AWS support.
- Per-organization theming/branding beyond the hostname (`Organization.logoUrl` already exists; out of scope).
- Automatic subdomain provisioning.

## Proposed Solution

### S1 — `target` discriminator on `DomainMapping`

Additive `target: 'portal' | 'backend'` NOT NULL DEFAULT `'portal'`. All existing rows backfill to
`'portal'`. `resolveByHostname` (`:162`), `isAllowedForTls` (`:183`) and `resolveActiveByOrg`
(`:195`) become target-aware.

### S2 — Proxy pass-through for backend-target hosts

`DomainResolution` (`apps/mercato/src/lib/customDomainCache.ts:3-9`) gains `target`. A backend-target
host takes `NextResponse.next()` with `x-next-url` set to the original path — it never reaches
`buildRewrittenPath`. A request whose path does not match the host's target returns 404. The matcher
is unchanged; `/api/` continues to resolve the host itself.

`packages/create-app/template/src/proxy.ts` is synced in the same change — CI enforces template
parity (`apps/mercato/src/lib/dev-origins.ts:1-6`). Note the template copy is currently a stale,
pre-custom-domain version and needs reconciling.

### S3 — The clamp (the actual feature)

Two layers, both load-bearing:

**S3a — `applySuperAdminScope`.** Takes the host binding as an input and applies it **before** the
cookie override is written to `next.tenantId` / `next.orgId`, at all three call sites (`:305`,
`:346`, `:373`). `resolveAuthFromCookiesDetailed` (`:290`) takes no arguments today and needs the
host plumbed in. On a bound host, a conflicting scope cookie is **discarded** (Q2); a session
belonging to another tenant is a **403**, because serving it the host's organization would grant
scope rather than narrow it. Not a quiet
rewrite.

**S3b — `resolveOrganizationScopeForRequest`.** On a bound host, discard both scope cookies and force
the mapping's org/tenant into `effectiveTenantId` and `normalizedSelectedId` — **before** the cache
key is built at `:472`. `buildOrgScopeCacheKey` (`:53`) has no host component today, so a poisoned
entry would be shared between a platform-host and a bound-host request; the bound org (or `null`)
becomes an explicit key component so an implementation slip cannot collapse the two. `__all__` on a
bound host is a hard 4xx, never a silent widening. Fail **closed**
(`{selectedId:null, filterIds:[], allowedIds:[]}`) — never a home-org fallback, which is precisely
the "half-bound" failure where a user on `acme.example.com` silently operates on their own org.

### S4 — Cross-host token replay defense

Login is host-agnostic today (`auth/api/login.ts:85-115` resolves by email with no reference to the
Host), so a tenant-A user can authenticate on Staffinit's host and receive a first-party session
there. `resolveCanonicalStaffAuthContext` (`auth/lib/sessionIntegrity.ts:98-107`) prevents a token
from *claiming* a foreign tenant, but the resulting valid-but-foreign context is still served under
an org-branded host.

Add the backend equivalent of the portal's `expectedTenantId` check
(`customer_accounts/lib/customerAuthServer.ts:63-68`), **failing closed**. The portal's fail-open
catch at `:119-122` — which degrades the replay defense to nothing on a resolver blip — is
explicitly **not** to be copied. On domain-resolution failure for a non-platform host, return 503.

### S5 — Outbound links

- `getSecurityEmailBaseUrl` becomes host-aware; `assertAllowedAppOrigin` stays synchronous and
  receives a pre-resolved allowed host. Only `status:'active'` mappings are allowlisted — do **not**
  reuse `isAllowedForTls`, which also accepts `verified` (`domainMappingService.ts:187-190`).
- `urlForOrgBackend(orgId, path, opts?)` — async, container-based, **target-filtered**, null orgId →
  platform URL, error → platform URL **logged at warn** (not silently swallowed as
  `customerUrl.ts:50` does).
- OpenAPI `servers` becomes relative (`/api`) — correct on every host, and an org lookup is
  impossible at build time anyway.

### Alternatives considered

**A sibling `BackendDomainMapping` entity in `directory`.** Rejected. The global hostname UNIQUE
(`entities.ts:320`) is the safety property, and Postgres cannot span a UNIQUE across two tables
without a trigger or a third registry table — at which point the `target` column has been rebuilt
badly. The Traefik ForwardAuth gate is one query (`api/domain-check.ts:57` → `isAllowedForTls`); two
tables mean a UNION on the TLS hot path plus a window where the same hostname gets a certificate
issued for two different organizations. The lifecycle machinery — `replaces_domain_id` chain, three
partial indexes (`entities.ts:326-341`), DNS and TLS workers — is entirely target-agnostic.

The "`customer_accounts` may be optional for a backend-only deployment" objection is real but is a
*dependency-direction* problem, not a table-shape problem. It is solved the way `urlForCustomerOrg`
already solves it (`customerUrl.ts:44-52`): `directory` resolves `domainMappingService` from the
container in a try/catch and never imports the entity class. Module absent → backend custom domains
unavailable, platform host unaffected. Precedent for a cross-module *read* exists at
`customer_accounts/lib/resolveTenantContext.ts:22`, which queries `directory`'s `Organization` via
`em.findOne` — `AGENTS.md:36,228` forbids ORM *relationships* (FK / `@ManyToOne`), not reads.

**Lifting a shared domain subsystem into `packages/shared`.** Rejected: `shared` has no `migrations/`
directory and `packages/shared/src/modules/entities.ts` is types-only, so it cannot own a table
without inventing a migration home. If a backend-only deployment ever genuinely needs this, extract
`entities.ts:319-384` plus service and workers into a `domains` core module later — a mechanical
one-table move, not worth pre-paying.

**A `backend_hostname` column on `Organization`.** Rejected: no status lifecycle, no DNS-verification
state, no domain-swap support, and it modifies a core entity the April spec deliberately left
untouched (`portal-custom-domain-routing.md:1441`).

## Architecture

```
                    ┌────────────────────────────────────────────┐
   HTTPS            │ Traefik (opt-in overlay)                   │
   any hostname ───►│  platform router  Host(PLATFORM_PRIMARY)   │  priority 100, no gate
                    │  catch-all router HostRegexp({any:.+})     │  priority 1
                    │    └─ ForwardAuth → /api/customer_accounts/domain-check
                    └──────────────────┬─────────────────────────┘
                                       │ passhostheader=true
                    ┌──────────────────▼─────────────────────────┐
                    │ Next.js app                                │
                    │                                            │
   /backend/*  ────►│ proxy.ts  (matcher: NOT /api/, NOT /_next/)│
                    │   platform host  → next()                  │
                    │   target=portal  → rewrite /{slug}/portal  │
                    │   target=backend → next() (NEW)            │
                    │   wrong target   → 404      (NEW)          │
                    │                                            │
   /api/*      ────►│ (bypasses proxy entirely — reads Host)     │
                    │                                            │
                    │ ┌────────────────────────────────────────┐ │
                    │ │ applySuperAdminScope   (server.ts:127) │ │ ◄── CLAMP 1 (403)
                    │ │   ↓                                    │ │
                    │ │ resolveOrganizationScopeForRequest     │ │ ◄── CLAMP 2 (fail closed,
                    │ │   :441-467 inputs → :472 cache key     │ │      before cache key)
                    │ └────────────────────────────────────────┘ │
                    └────────────────────────────────────────────┘
```

**Host resolution for API routes.** Because `/api/` is outside the matcher, any header the proxy
injects is spoofable on the API surface. API routes read `Host` / `X-Forwarded-Host` off the
`Request` themselves, using the single `resolveRequestHostname(req)` helper introduced in Phase 2 —
the pattern already exists at `api/domain-check.ts:49` and `resolveTenantContext.ts:41-52`.
Application code MUST NOT be able to pass a host in; that would recreate the cookie problem one layer
up.

**Request-scoped host context.** A `runWithHostBinding(binding, fn)` in `packages/shared`, modeled on
`packages/cache/src/tenantContext.ts` — **including its `Symbol.for` globalThis trick (`:12`)**. The
duplicate-module-chunk hazard documented there is real in this repo, and for a security clamp a
silently-empty `AsyncLocalStorage` store is fail-**open**. ALS is used only as the fallback for the
~102 request-less scope calls; every boundary holding a `Request` or `headers()` re-reads the host
(cheap — `resolveByHostname` is cache-backed at `domainMappingService.ts:167-179`).

**Enforcement layers, ranked.**

| Layer | Role |
|---|---|
| `applySuperAdminScope` (`shared/lib/auth/server.ts:127-158`) | **Load-bearing.** Not redundant with the scope resolver — ~2100 call sites read `auth.tenantId`/`auth.orgId` directly. |
| `resolveOrganizationScopeForRequest` (`organizationScope.ts:441-467`) | **Load-bearing.** The chokepoint for scoped reads/writes. Clamp inputs before the cache key at `:472`. |
| Organization switcher | **UX only.** No server API exists; the cookie is written client-side. Decoration. |
| Proxy header injection | **Routing only.** Never trust `x-custom-domain` or an injected org header inside a handler. |
| Per-route checks | **Anti-pattern** at this scale (223 `resolveOrganizationScopeForRequest` call sites, only ~121 passing `request`). Acceptable only for the handful that bypass the resolver entirely. |

## Data Models

### D-M1 — `DomainMapping` (modified)

`packages/core/src/modules/customer_accounts/data/entities.ts:319-384`

| Column | Change | Notes |
|---|---|---|
| `target` | **NEW** `text` NOT NULL DEFAULT `'portal'` | Values `'portal' \| 'backend'`. Existing rows backfill to `'portal'`. |

New index:

```
domain_mappings_backend_active_org_uniq
  UNIQUE (organization_id) WHERE target = 'backend' AND status = 'active'
```

This closes P5.4. It encodes Q3's assumption (one active backend host per organization); if Q3 is
answered "many", the index is dropped and `resolveActiveByOrg` must return a list.

Unchanged: the global `domain_mappings_hostname_unique` on `hostname` (`:320`) spans both targets —
one hostname, one mapping, regardless of target. Also unchanged: `replaces_domain_id` swap chain, the
three partial status indexes (`:326-341`), the hostname-normalization CHECK (`:338-341`), and the
absence of `deletedAt` (deletes are hard).

Migration: generated via `yarn db:generate`, with
`packages/core/src/modules/customer_accounts/migrations/.snapshot-open-mercato.json` updated in the
same commit. Unrelated generator output is deleted per `AGENTS.md:241`. `yarn db:migrate` is **not**
run (`AGENTS.md:28`).

### D-M2 — `AuthContext` (modified, pending Q1)

`packages/shared/src/lib/auth/server.ts:11`

| Field | Change | Notes |
|---|---|---|
| `hostBinding` | **NEW**, optional | `{ hostname, tenantId, organizationId } \| null`. Present only when the request arrived on an active backend-target mapping. Server-derived only — never read from a JWT claim, never settable by application code. |

### D-M3 — `DomainResolution` (modified)

`apps/mercato/src/lib/customDomainCache.ts:3-9`

| Field | Change |
|---|---|
| `target` | **NEW** `'portal' \| 'backend'` |

### D-M4 — No change to `Organization`

`directory/data/entities.ts:29-78` is untouched, preserving the April spec's decision
(`portal-custom-domain-routing.md:1441`). Note `Organization.slug` is unique **per tenant**
(`entities.ts:29`), so it cannot serve as a hostname uniqueness key; `DomainMapping.hostname` remains
the globally unique identifier.

## API Contracts

### Modified — `GET /api/customer_accounts/domain-resolve`

`packages/core/src/modules/customer_accounts/api/domain-resolve.ts:49-56`

Response gains `target`. Additive optional field — permitted by `BACKWARD_COMPATIBILITY.md:157`.

```jsonc
{
  "ok": true,
  "tenantId": "…",
  "organizationId": "…",
  "orgSlug": "…",        // null for backend-target mappings
  "status": "active",
  "target": "backend"    // NEW; absent-or-"portal" for pre-existing consumers
}
```

`GET /api/customer_accounts/domain-resolve/all` gains the same field in each list entry, so the
proxy warm-up primes targets.

### Modified — `GET /api/customer_accounts/domain-check`

`api/domain-check.ts:32-61`. Unchanged shape. `isAllowedForTls` becomes target-aware but remains
target-**agnostic in effect** — both portal and backend mappings are eligible for certificate
issuance. Stated explicitly so a future reader does not "tighten" it and break TLS for backend hosts.

### New — backend domain administration

Mirrors the existing admin surface (`api/admin/domain-mappings.ts`, `POST`/`DELETE` only; hostname is
immutable post-create because `hostname-format` and `hostname-unique` are `operations: ['create']`,
`guards.ts:24,51`). Backend-target registration is exposed only when
`BACKEND_CUSTOM_DOMAINS_ENABLED` is on.

| Route | Methods | ACL |
|---|---|---|
| `/api/…/admin/domain-mappings` (extended with `target` in the create payload) | POST, DELETE | New feature id, granted in `setup.ts` `defaultRoleFeatures` |
| `/api/…/admin/domain-mappings/[id]/verify` | POST | same |
| `/api/…/admin/domain-mappings/[id]/health-check` | POST | same |

Post-deploy: `yarn mercato auth sync-role-acls` (recorded in `UPGRADE_NOTES.md`).

### Behavioral contract changes on a bound host

| Condition | Before | After |
|---|---|---|
| `om_selected_org` disagrees with the host's org | Cookie wins | Scope forced to host's org; super-admin override → **403** |
| `om_selected_org=__all__` | Widens to all orgs | **4xx**, no widening |
| Session token minted for a different tenant | Accepted | Rejected as unauthenticated |
| Domain resolution fails on a non-platform host | n/a | **503** (fail closed) |
| Path does not match the host's target | Portal rewrite | **404** |

Existing integration specs that set `om_selected_org` — `TC-AUTH-041:32`, `TC-AUTH-052:69`,
`TC-DIR-004:31` — are unaffected on the platform host and each gains an explicit "platform host
unchanged" assertion.

## Environment Variables

All new variables are optional with defaults, and must land in **both** `apps/mercato/.env.example`
and `packages/create-app/template/.env.example` (`packages/create-app/AGENTS.md` template-sync rule).

| Variable | Default | Purpose |
|---|---|---|
| `BACKEND_CUSTOM_DOMAINS_ENABLED` | `false` | Master flag. Hard-fails at boot if on without a trusted-proxy assertion, or if `OM_ALLOW_FORCED_HOST` is also on. |
| `TRUSTED_PROXY_CIDRS` | unset | Trusted-proxy assertion. Alternative: a proxy-injected shared secret, same pattern as `DOMAIN_CHECK_SECRET` (`api/domain-check.ts:32-43`). |
| `OM_ALLOW_FORCED_HOST` | `false` | Third gate on the `X-Force-Host` bypass, alongside the existing `NODE_ENV==='test'` and `FORCE_HOST_SECRET`. |
| `COOKIE_SECURE` | `true` | Decouples the cookie `Secure` flag from `NODE_ENV` (P5.2). |

Two pre-existing documentation gaps closed while here: `NEXT_PUBLIC_APP_URL` and
`PLATFORM_PORTAL_BASE_URL` are read by 12+ files (the latter *throws in production* when unset,
`customerUrl.ts:22-27`) yet appear in neither `.env.example`.

## Risks & Impact Review

| # | Failure scenario | Severity | Affected area | Mitigation | Residual risk |
|---|---|---|---|---|---|
| R1 | **Forged `Host` selects admin org scope.** Base compose exposes the app directly on `${APP_PORT:-3000}` (`docker-compose.fullapp.yml:142-143`) with the Traefik overlay opt-in (`:144`). `curl -H 'Host: crm.staffinit.com'` with a valid session for another org selects Staffinit scope. ForwardAuth answers "is this hostname registered", not "is this caller entitled"; `passhostheader=true` preserves the client Host verbatim. | **Critical** | All backend routes | Feature flag + boot-time trusted-proxy assertion (hard-fail if enabled without one). Invariant, tested: **the host may only narrow the scope the token already grants, never grant scope.** Correct the now-misleading comment at `directory/api/get/organizations/lookup.ts:49-54`. | Operator misconfiguration of `TRUSTED_PROXY_CIDRS`. Documented; boot assertion cannot validate CIDR correctness, only presence. |
| R2 | **`x-force-host` becomes an org-scope spoof primitive.** Gate is `NODE_ENV==='test'` + `FORCE_HOST_SECRET` (`proxy.ts:15-21`), but this project does not treat `NODE_ENV` as a reliable prod discriminator — `docker-compose.fullapp.yml:151`, `Dockerfile:77,134` all set `development`. | **Critical** | Proxy, tenant resolution | Third independent gate `OM_ALLOW_FORCED_HOST`, default off; boot assertion that it is never on together with `BACKEND_CUSTOM_DOMAINS_ENABLED`. Forced host is **never** honored for backend org-scope resolution — restricted to the portal path it was built for. Test asserts this even with the correct secret. | None if the boot assertion holds. |
| R3 | **Super-admin escapes the binding via `om_selected_tenant`.** `applySuperAdminScope` rewrites the whole `AuthContext` before any resolver runs; ~2100 direct `auth.tenantId`/`auth.orgId` reads bypass the scope resolver; the resolver itself exempts super-admins (`organizationScope.ts:451-453`). | **Critical** | Cross-tenant read/write | Clamp inside `applySuperAdminScope`, all three call sites (`:305`, `:346`, `:373`), applied before the override is written. Conflicting cookies discarded, cross-tenant sessions 403 (Q2). API-key path covered identically. | Depends on Q1's answer: per-layer patching leaves the ~102 request-less scope calls unasserted. |
| R4 | **Cached cross-org scope served to the wrong host.** `buildOrgScopeCacheKey` (`organizationScope.ts:53`) has no host component; the `WeakMap` memo (`:141`, read at `:481`) is per-request-safe only if the key includes the clamped values. Fails **silently**, visible only under concurrency. | **High** | Org scope resolution | Clamp inputs before `:472` **and** add the bound org as an explicit key component — belt and braces, so an implementation slip cannot collapse the two. Concurrency test: two requests, different hosts, same user. | Cache TTL defaults to 0 (disabled) today (`ORG_SCOPE_DEFAULT_TTL_MS`, `:43`), which masks the bug until someone enables `OM_ORG_SCOPE_CACHE_TTL_MS`. Test must run with the cache on. |
| R5 | **Cross-host token replay.** Login is host-agnostic (`login.ts:85-115`); tokens replayable via `Authorization: Bearer` (`server.ts:333`) against any host. | **High** | Auth | Backend `expectedTenantId` enforcement, **fail closed**; 503 on resolver failure for a non-platform host; login on a bound host rejects out-of-tenant credentials using the existing uniform error (preserving the non-oracle behavior at `login.ts:105-112`). | Cookies are host-only, so browser-driven replay is not automatic; manual replay is fully covered. |
| R6 | **Proxy change regresses the platform host or existing portal domains.** `proxy.ts:64-68` is the fast path for 100% of today's traffic; `buildRewrittenPath` (`:29-35`) is the one function all portal routing depends on; **no test exists** (P4). Template parity is CI-enforced, so every proxy edit is a double edit. | **High** | All traffic | Phase 2 lands proxy unit tests and a baseline integration spec pinning today's behavior **before** any proxy edit. Explicit "platform host byte-identical" and "portal host unchanged" assertions in Phase 3. `packages/create-app/template/src/proxy.ts` synced in the same change. | The template copy is currently stale and needs reconciling, which is itself a behavior change for scaffolded apps. |
| R7 | **A revoked or `pending` mapping stays a trusted origin.** The resolver cache is 60 s positive TTL with **no cross-process invalidation** (`customDomainCache.ts:54-62`). For routing that is a 404 window; for an origin allowlist it is a CSRF window. `isAllowedForTls` accepts `verified` as well as `active` (`domainMappingService.ts:187-190`). | **High** | Origin validation, redirects | D6: the allowlist is not made DB-backed. Callers pass a pre-resolved host; only `status:'active'` is ever allowlisted; `isAllowedForTls` is explicitly **not** reused for this purpose. Staleness window documented. | 60 s window remains for the host-aware `getSecurityEmailBaseUrl` path. Accepted: worst case is an email link to a just-revoked host. |
| R8 | **Passkey lockout / RP-suffix sharing.** `rpId` is request-derived (`enterprise/security/lib/security-config.ts:149-171`), so a passkey registered on host A does not work on host B. The tempting fix — pinning `OM_SECURITY_WEBAUTHN_RP_ID` to a shared registrable suffix — would make every tenant host a valid RP for every other tenant's passkey. | **High** (as a footgun) / Medium (as UX) | Enterprise MFA | Keep `rpId` request-derived. Boot assertion **forbidding** the pin from being a proper suffix of a registered mapping while the flag is on. Explicit per-host "register a passkey for this domain" flow rather than a generic auth failure. | Users burn a single-use recovery code (`MfaService.ts:102,224-226`) on each host switch until enrolled. Bounded, documented. |
| R9 | **No CSRF check in the API dispatcher.** There is no Origin / `Sec-Fetch-Site` check and no CSRF module in `packages/shared/src/lib`; `assertAllowedAppOrigin` has exactly one non-test caller outside its own module (`onboarding/api/get/onboarding/status.ts:67`). With `SameSite=Lax`, state-changing POSTs are unprotected against same-site-different-subdomain requests — and this feature gives every tenant its own hostname. | **High** | All mutating API routes | Partial mitigation here: `SameSite=Strict` + `Secure` on the scope cookies, `Secure` decoupled from `NODE_ENV`. **A real CSRF check is deferred to its own issue with its own threat review** — it is a security-control addition, not a bullet inside a routing feature. | Accepted and explicitly out of scope. Must be filed before this feature is enabled on a shared-suffix domain set. |
| R10 | **Feature enabled on an unsupported deployment target.** Railway registers one domain per service (`deploy/railway/index.ts:818,872`) and never injects `PLATFORM_DOMAINS` (P5.1); AWS defers custom-domain ingress. A Railway user enabling backend mappings gets an unroutable host plus per-request resolver fetches. | Medium | Deployment | Flag defaults off; settings UI hides backend registration when off; docs name self-hosted Compose + Traefik overlay as the only supported target; P5.1 fixed independently in Phase 2. | Operators can still force the flag on an unsupported target. Documented, not prevented. |
| R11 | **Backend host returned to a portal email builder.** `resolveActiveByOrg` has no uniqueness guarantee (P5.4). | Medium | Portal emails | Target-filtered `resolveActiveByOrg` + the partial unique in D-M1. Unit tests assert a portal query never returns a backend row and vice versa. | None once the index lands. |
| R12 | **Acceptance criterion cannot be verified.** Browser-level multi-host navigation may be impossible here: `.ai/qa/tests/playwright.config.ts:70` has a single `baseURL`, Playwright cannot set `Host` for a top-level navigation, and no wildcard-DNS strategy exists in the repo. The April spec chose `X-Force-Host` precisely to avoid this. | Medium | QA | Phase 2 task 2.5 resolves this **before** anything depends on it, and records the answer. If browser-level proves impossible, the acceptance criterion is restated as an API-level assertion rather than claiming coverage that cannot be produced. | Open (`unknown`) until 2.5 completes. |

## Migration & Backward Compatibility

Required by `BACKWARD_COMPATIBILITY.md:11`. Contract surfaces touched:

| Surface | Category | Change | Classification |
|---|---|---|---|
| DB schema | §8 ADDITIVE-ONLY (`:161-174`) | New `target` column, NOT NULL with default; new partial unique index; no existing column altered | ✅ Additive |
| API routes | §7 STABLE (`:150-159`) | New optional response field `target`; new create-payload field; no method or existing-field change | ✅ Additive |
| ACL features | §10 FROZEN (`:185-191`) | New feature id ("MAY add new feature IDs freely") | ✅ Additive. Requires `setup.ts` `defaultRoleFeatures` + post-deploy `yarn mercato auth sync-role-acls` |
| Types | §2 | `AuthContext.hostBinding` optional; `DomainResolution.target` — a required field on an internal type, all producers updated in the same change | ✅ Additive for `AuthContext`; internal for `DomainResolution` |
| Env vars | Precedent rows (`:300`) | Four new **optional** vars with defaults | ✅ Additive. A *required* var would be breaking for existing deployments — none introduced |
| Signatures | §3 | `applySuperAdminScope`, `resolveAuthFromCookiesDetailed` gain a parameter. **Module-private** — not exported from the package's public surface | ✅ Internal. Verify before implementation that no consumer imports them |
| Behavior | — | On a bound host, cookies no longer override org scope | ⚠️ **Intentional behavior change, opt-in only.** Zero effect when `BACKEND_CUSTOM_DOMAINS_ENABLED` is off or no backend mapping exists |

**Rollback.** The `target` column is additive with a default, so a rollback that leaves the column in
place is safe — pre-change code ignores it. Reverting the code without dropping the column leaves
backend-target rows inert (no proxy branch reads them), which degrades to "hostname registered but
not routed", not to a security hole. Dropping the column requires deleting backend-target rows first;
document as forward-preferred.

**Deprecations.** None. No existing surface is removed, renamed, or narrowed.

**UPGRADE_NOTES.md** gains: the new ACL feature id and the `sync-role-acls` step; the four env vars;
the statement that the feature is off by default and supported on self-hosted Traefik only.

## Testing Strategy

Per `AGENTS.md:160-161`, integration coverage for every affected API path ships in the same change,
self-contained, with fixtures created in setup and cleaned up in `finally`.

### Pre-existing test debt (delivered by Phase 2, not previously written)

The April spec promised these and they do not exist:

| Promised at | Test |
|---|---|
| `portal-custom-domain-routing.md:1627` | `X-Force-Host` ignored in non-test builds |
| `:1629-1634` | Custom-domain login without body `tenantId` |
| `:1892` | JWT cross-host replay rejection |
| `:1921-1922` | Host-only cookie scope |
| `:254`, `:1917` | `customerUrl.test.ts` — emails must not hard-code the platform host |

### Unit

| Target | Coverage |
|---|---|
| `resolveRequestHostname` (new, Phase 2) | Secret match / mismatch / absent; all three forced-host gates |
| `apps/mercato/src/proxy.ts` (**no test today**) | Platform passthrough (`:64-68`); unknown-host passthrough (`:86-91`); resolver-error 503 + `retry-after` (`:77-84`); `buildRewrittenPath` shapes (`:29-35`); backend-target passthrough; wrong-target 404 |
| `urlForCustomerOrg` (**no test today**) | Active-mapping branch; slug fallback; no-slug fallback; production throw when `PLATFORM_PORTAL_BASE_URL` unset (`:22-27`) |
| `getCustomerAuthForHost` (**no test today**) | Platform host; active mapping; inactive → null; the fail-open catch at `:119-122` (asserting current behavior, flagged as not-to-be-copied) |
| `domainMappingService` | Target filtering on `resolveByHostname` / `isAllowedForTls` / `resolveActiveByOrg`; portal query never returns a backend row and vice versa |
| `applySuperAdminScope` | All three call sites; 403 on out-of-binding override; unchanged on platform host |
| `resolveOrganizationScopeForRequest` | Cache key varies by bound org; `__all__` → 4xx; fail-closed empty scope for a user without access; **concurrency case with the cache enabled** (R4) |
| `getSecurityEmailBaseUrl` / `urlForOrgBackend` | Host-aware base; target filter; null-org fallback; error fallback logged at warn |
| `hostname-unique` guard | Cross-tenant claim against a `dns_failed` incumbent → 409 (P5.3) |
| Cookie `Secure` | http vs https origin; independent of `NODE_ENV` (P5.2) |
| Railway env | `PLATFORM_DOMAINS` present in the injected map (P5.1) |

Existing suites to update: `auth/lib/__tests__/requestRedirect.test.ts` (7 `APP_URL` assertions pin
today's non-host-relative behavior), `customer_accounts/lib/__tests__/resolveTenantContext.test.ts`,
`services/__tests__/domainMappingService.test.ts`, `data/__tests__/guards.test.ts`,
`api_docs/lib/__tests__/resources.test.ts`,
`enterprise/security/lib/__tests__/security-config.test.ts`.

### Integration

| Spec | Asserts |
|---|---|
| `customer_accounts/__integration__/TC-PORTAL-0NN-custom-host-baseline.spec.ts` (Phase 2) | Today's portal-on-custom-host behavior, as the regression baseline for the proxy edit |
| `directory/__integration__/TC-DIR-0NN-backend-custom-domain.spec.ts` (Phase 3) | **The decisive test:** bound `Host` + a deliberately conflicting `om_selected_org` cookie against an `/api/*` route → response scoped to the host's org. Plus: `__all__` on bound host → 4xx; super-admin cross-tenant cookie → 403; platform host unchanged; portal host unchanged; wrong-target host → 404; ACL denial without the new feature |

`TC-DIR-014-stale-selected-org-orphan.spec.ts` is the closest existing analogue to "cookie disagrees
with host" and is **extended**, not duplicated. `TC-AUTH-*` login specs each gain a "platform host
behavior unchanged" assertion.

**The `/api/*` case is the one that matters.** `/api/` sits outside the proxy matcher, so it is
precisely where a routing-only implementation would leave the binding unenforced. That single test
separates "shipped" from "half-bound".

**Browser-level coverage is `unknown`** pending Phase 2 task 2.5 (R12).

## Implementation Phases

Tracked in `Plans.md`. Summary:

| Phase | Content | Independently shippable? |
|---|---|---|
| 1 | This spec + maintainer escalation (Q1–Q3) | — |
| 2 | Make the custom-domain layer testable; fix P5.1–P5.4 | **Yes** — hardening for the already-shipped April feature |
| 3 | `target` column, proxy branch, both clamps, replay defense, admin UI, integration tests | **Yes** — the customer-visible feature |
| 4 | Host-aware `getSecurityEmailBaseUrl`; `urlForOrgBackend` for queue/CLI senders; relative OpenAPI `servers` | **Yes** — independent correctness improvement |
| 5 | WebAuthn guardrails, docs, BC notes, review, PR closeout | — |

Phase 3 is gated on Phase 2: without a reachable forced-host hook and a proxy regression baseline,
Phase 3's tests cannot be written and its riskiest edit is unguarded.

## Out of Scope (explicit rejections)

| Rejected | Reason |
|---|---|
| Extending the proxy matcher to `/api/` | API routes already resolve the host themselves (`resolveTenantContext.ts:85-153`). Puts a Node-runtime, DB-fetching proxy in front of every API call for no gain — the highest blast radius available. |
| "Migrate ~28 helper call sites + 23 direct `APP_URL` reads" | Counts call sites rather than functions that discard the host. One function (`getSecurityEmailBaseUrl`) plus ~6 worker senders is the real surface. |
| Attachments client components (`AttachmentLibrary.tsx:50`, `AttachmentMetadataDialog.tsx:112`) | Module-scope `const` in client components, evaluated at bundle time. Their `window.location.origin` fallback is **already** org-correct on a custom domain. |
| A DB-backed dynamic origin allowlist | `assertAllowedAppOrigin` is the repo's host-header-injection / open-redirect defense. Making it DB-driven inherits a 60 s staleness window with no cross-process invalidation (R7). Needs its own threat review. |
| Railway / AWS multi-host support | Railway: one domain per service. AWS: deferred by its own spec. Document the supported target. |
| Cross-domain SSO | Out of scope in the April spec (`:47`, `:112`, `:1772`); unchanged here. |
| Browser-level multi-host E2E as an acceptance criterion | `unknown` whether it is possible here (R12). Resolved by task 2.5 before anything depends on it. |

## Final Compliance Report

To be completed at implementation. Gate items:

- [ ] Q1–Q3 answered by the maintainer and folded into "Locked Decisions"
- [ ] `yarn generate`, `yarn build:packages`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn test:integration`, `yarn build:app` all pass; runner (Docker vs local) recorded
- [ ] Migration + `.snapshot-open-mercato.json` committed; `yarn db:generate` re-reports no changes; `yarn db:migrate` not run
- [ ] `packages/create-app/template/src/proxy.ts` synced; template `.env.example` mirrored
- [ ] `BACKWARD_COMPATIBILITY.md` per-feature row + `UPGRADE_NOTES.md` entry
- [ ] Every R1–R12 mitigation has a corresponding test or a recorded residual risk
- [ ] DS review passed for the new admin UI (no hardcoded status colors, no arbitrary values)
- [ ] PR labelled `feature`, one `priority-*`, one `risk-*`, `needs-qa` — the automated-verification exemption does **not** apply (ships `.tsx`, changes DB structure, adds API surface)

## Changelog

| Date | Change |
|------|--------|
| 2026-07-30 | Initial draft. Scope reduced from the issue as filed on two axes: `/api/` stays outside the proxy matcher, and the link migration is one function rather than ~51 call sites. Four pre-existing defects (P5.1–P5.4) folded into Phase 2. Q1–Q3 escalated to the maintainer. |
