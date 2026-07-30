# Open Mercato — Plans.md

作成日: 2026-07-30
Issue: [#4271 — feat(routing/directory): per-organization custom domains for the backend app](https://github.com/open-mercato/open-mercato/issues/4271)
Branch base: `crm`

---

## Planning context

**Kernkonstatierung.** The repo already ships a complete, working **portal** custom-domain stack
(`DomainMapping` + DNS/TLS workers + Traefik on-demand ACME + `proxy.ts` + admin UI). Issue #4271
un-defers `.ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md:37`
("**Deferred:** Custom domain for the back office panel"). The work is an **extension** of that
stack, not a parallel one.

**Two findings reshape the issue's scope:**

1. **The feature is a server-side authorization clamp, not routing.** Serving `/backend` on a bound
   host is cosmetic; the deliverable is that `om_selected_org` / `om_selected_tenant` cookies can no
   longer override the host's organization. `applySuperAdminScope`
   (`packages/shared/src/lib/auth/server.ts:127-158`) rewrites `auth.tenantId`/`auth.orgId` from
   those cookies at three call sites **before** any scope resolver runs, and there are ~1223 direct
   `auth.tenantId` + ~881 direct `auth.orgId` reads that never reach
   `resolveOrganizationScopeForRequest`. Clamping only the scope resolver ships a false sense of
   isolation.
2. **The link migration is one function, not 51 call sites.** `resolveSafeRedirectLocation`
   (`auth/lib/requestRedirect.ts:22-27`) already falls back to host-relative paths, so
   logout/autologin/session-refresh are host-correct today. The single function that discards the
   request host is `getSecurityEmailBaseUrl` (`packages/shared/src/lib/url.ts:252-263`). Only ~6
   genuinely queue/CLI-scoped senders need an `orgId` lookup.

**team_validation_mode: `subagent`** — 4 research + 3 review perspectives (Architecture, Security,
QA/Skeptic) run via Task subagents. Consensus recorded in the phases below; conflicts resolved in
"Escalations".

**Lint/formatter baseline:** present (`yarn lint`, `yarn typecheck`, `yarn test`,
`yarn test:integration`). No setup task required.

---

## unknown_data

Not observed ≠ absent. These are unverified, not established as false:

- `unknown` — whether Playwright can drive **browser-level** navigation to a second hostname against
  this dev server. `.ai/qa/tests/playwright.config.ts:70` has a single `baseURL`; no wildcard-DNS
  strategy (`nip.io`, `localtest.me`, `/etc/hosts`) appears anywhere in the repo. Acceptance bullet
  "login lands in the Staffinit org context" may only be assertable at API level. **Resolved by task 2.5.**
- `unknown` — whether CI runners can resolve wildcard-DNS services, if that strategy is chosen.
- `unknown` — whether any production reverse proxy in actual use (Dokploy, Railway edge) normalizes
  or rewrites the `Host` header before the app sees it.
- `unknown` — whether `notifications` `config.appUrl` (`lib/deliveryConfig.ts:124`, via
  `moduleConfigService`) already provides a per-tenant override that makes task 4.2's notifications
  branch a configuration change rather than a code change. **Check before writing code.**
- `unknown` — whether one organization may bind more than one backend hostname. Planned as exactly
  one active backend host per org; needs maintainer confirmation.
- `unknown` — whether Terraform for `.ai/specs/2026-06-04-aws-terraform-deployment-playbook.md`
  exists outside this repo.
- `unknown` — whether a slugify helper exists for `Organization.slug` outside the directory module.

---

## Stage gates

| Stage | Covered by |
|---|---|
| 1. 検証・調査 | Complete — this planning pass (7 subagents, evidence inline below) |
| 2. 実装計画確定 | Phase 1 (spec + maintainer escalation) |
| 3. 実装(TDD) | Phases 2–4 |
| 4. レビュー | Phase 5 tasks 5.3, 5.4 |
| 5. PR closeout | Phase 5 task 5.5 |

---

## Phase 1: Spec & maintainer decisions

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 1.1 | `[lane:gate][tdd:skip:docs-only]` Write `.ai/specs/2026-07-30-organization-backend-custom-domains.md` with all sections required by `.ai/specs/AGENTS.md:89-94` (TLDR, Overview, Problem Statement, Proposed Solution, Architecture, Data Models, API Contracts, Risks & Impact Review, Final Compliance Report, Changelog) **plus** the mandatory "Migration & Backward Compatibility" section per `BACKWARD_COMPATIBILITY.md:11` | File exists at that path; every listed section present and non-empty; Risks table names concrete failure scenario + severity + affected area + mitigation + residual risk for each of the 8 security findings in Phase 3; spec amends (does not silently supersede) `.ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md:37`; integration coverage listed for every affected API path per `AGENTS.md:160` | - | cc:完了 |
| 1.2 | `[lane:fast][tdd:skip:docs-only]` Post the three open decisions to issue #4271 as a comment: (a) `hostBinding` as a first-class `AuthContext` field vs per-layer patching, (b) hard-deny (403) vs silent clamp when a super-admin's cookie disagrees with the bound host, (c) one vs many backend hosts per org | Comment posted on #4271 containing all three questions with the file:line evidence for each; comment links to the spec from 1.1 | 1.1 | cc:TODO |
| 1.3 | `[lane:fast][tdd:skip:docs-only]` Record in the spec that the portal spec's promised tests (`2026-04-08-portal-custom-domain-routing.md:1627-1659`, `:1892`, `:1921-1922`) were **never written**, and that Phase 2 delivers them | Spec contains a "Pre-existing test debt" subsection listing each promised-but-missing test with its spec line anchor | 1.1 | cc:完了 |

---

## Phase 2: Make the existing custom-domain layer testable (independently shippable hardening)

> Ships alone as hardening for the already-implemented April feature. Phase 3 is gated on this.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 2.1 | `[lane:gate][tdd:required]` Extract a single `resolveRequestHostname(req)` in `packages/shared`; replace the two duplicated forced-host readers at `apps/mercato/src/proxy.ts:15-21` and `customer_accounts/lib/resolveTenantContext.ts:41-51` | Both call sites import the shared function; `grep -rn "x-force-host" packages apps --include=*.ts` returns only the shared implementation + tests; unit test covers secret match, secret mismatch, and absent secret | - | cc:TODO |
| 2.2 | `[lane:gate][tdd:required]` Add a third independent gate `OM_ALLOW_FORCED_HOST` (default off) to the forced-host bypass, keeping the existing `NODE_ENV==='test'` + `FORCE_HOST_SECRET` conditions; make it reachable from the integration harness (`scripts/dev-ephemeral.ts` currently never sets `NODE_ENV=test` — only `scripts/test-create-app-integration.ts:72,215` does) | An integration spec can set `x-force-host` and observe host-dependent behavior; unit test asserts the header is ignored when any one of the three conditions is unmet; `OM_ALLOW_FORCED_HOST` documented in **both** `apps/mercato/.env.example` and `packages/create-app/template/.env.example` | 2.1 | cc:TODO |
| 2.3 | `[lane:gate][tdd:required]` First unit test for `apps/mercato/src/proxy.ts` (no test exists today) | Test file covers: platform-host passthrough (`:64-68`), unknown-host passthrough to 404 (`:86-91`), resolver-error 503 + `retry-after` (`:77-84`), `buildRewrittenPath` output shape for `/`, already-prefixed, and arbitrary paths (`:29-35`), and forced-host ignored outside test conditions; all assertions pass | 2.1 | cc:TODO |
| 2.4 | `[lane:gate][tdd:required]` Unit tests for `urlForCustomerOrg` (`customer_accounts/lib/customerUrl.ts:35`, zero tests today) and `getCustomerAuthForHost` (`customer_accounts/lib/customerAuthServer.ts:104`, zero tests today) | `customerUrl` tests cover: active-mapping branch, slug fallback, no-slug fallback, production throw when `PLATFORM_PORTAL_BASE_URL` unset (`:22-27`). `getCustomerAuthForHost` tests cover: platform host, active mapping, inactive mapping → null, and the fail-open catch at `:119-122` (asserting current behavior, flagged in the spec as not-to-be-copied) | - | cc:TODO |
| 2.5 | `[lane:gate][tdd:required]` Baseline integration spec pinning **today's** portal-on-custom-host behavior, and resolve the browser-vs-API `unknown` | `packages/core/src/modules/customer_accounts/__integration__/TC-PORTAL-0NN-custom-host-baseline.spec.ts` exists and passes; spec file records whether browser-level multi-host navigation is possible (`possible` with the chosen DNS strategy, or `api-level-only`); `unknown_data` entry above updated with the answer | 2.2 | cc:TODO |
| 2.6 | `[lane:gate][tdd:required]` Fix the latent Railway bug: `packages/cli/src/lib/deploy/railway/env.ts:74-78` injects `APP_URL`/`NEXT_PUBLIC_APP_URL` but never `PLATFORM_DOMAINS`, so a Railway deploy falls back to the default `localhost,openmercato.com` (`customer_accounts/lib/platformDomains.ts:9-13`) and treats its own host as a custom domain — a DB resolve on every page request | Railway deployer sets `PLATFORM_DOMAINS` from the provisioned domain; unit test asserts the env map contains it; `apps/docs/docs/deployment/railway.mdx:282-292` documents it | - | cc:TODO |
| 2.7 | `[lane:gate][tdd:required]` Decouple cookie `Secure` from `NODE_ENV`. `auth/api/login.ts:212-218` sets `secure: NODE_ENV === 'production'`, but `docker-compose.fullapp.yml:151` and `Dockerfile:77,134` run with `NODE_ENV: development` — the shipped fullapp stack serves session cookies without `Secure`. Also add `Secure` + `SameSite=Strict` to `om_selected_org`/`om_selected_tenant` (`OrganizationSwitcher.tsx:155,170`, currently neither `secure` nor `httponly`) | `Secure` derives from request scheme or a `COOKIE_SECURE` env defaulting to on, not from `NODE_ENV`; both scope cookies carry `Secure` when the page origin is `https:`; unit test covers http vs https origin; `docker-compose.fullapp.yml:151` either fixed or explicitly annotated as non-production | - | cc:TODO |
| 2.8 | `[lane:fast][tdd:required]` `hostname-unique` guard (`customer_accounts/data/guards.ts:66`) calls `resolveByHostname`, which matches `status:'active'` only — a hostname held by a `dns_failed`/`pending` mapping falls through the guard and fails on the DB unique index (`entities.ts:320`) as an opaque 500 instead of the deliberate non-disclosing 409 at `:74-79` | Guard queries all statuses; cross-tenant claim against a `dns_failed` incumbent returns 409 with the tenant-agnostic message; test added (existing `guards.test.ts:172-192` covers only the `active` case); DB unique index retained as defense-in-depth | - | cc:TODO |

---

## Phase 3: Backend-scoped domains + host-bound org clamp (the feature)

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 3.1 | `[lane:gate][tdd:required]` Additive `target: 'portal' \| 'backend'` NOT NULL DEFAULT `'portal'` on `DomainMapping` (`customer_accounts/data/entities.ts:319`). Make `resolveByHostname` (`:162`), `isAllowedForTls` (`:183`) and `resolveActiveByOrg` (`:195`) target-aware. Add the partial unique `(organization_id) WHERE target='backend' AND status='active'` — `resolveActiveByOrg` currently does `findOne` with **no uniqueness guarantee**, so without this it can return a backend host to a portal email builder | Migration + `migrations/.snapshot-open-mercato.json` updated via `yarn db:generate` (unrelated generator output deleted per `AGENTS.md:241`); existing rows backfilled to `'portal'`; `yarn db:generate` re-reports no changes for the module; unit tests assert a portal query never returns a backend row and vice versa; `yarn db:migrate` **not** run | 1.1 | cc:TODO |
| 3.2 | `[lane:gate][tdd:required]` Feature flag `BACKEND_CUSTOM_DOMAINS_ENABLED` (default off) + boot-time assertions: hard-fail if enabled without a trusted-proxy assertion (`TRUSTED_PROXY_CIDRS` or a proxy-injected shared secret, same pattern as `DOMAIN_CHECK_SECRET` in `api/domain-check.ts:32-43`), and hard-fail if `OM_ALLOW_FORCED_HOST` is on. Rationale: base compose exposes the app directly (`docker-compose.fullapp.yml:142-143`) with the Traefik overlay opt-in (`:144`), so `Host:` is client-controlled | Flag documented in **both** `.env.example` files; app refuses to boot when the flag is on without the trusted-proxy assertion; settings UI hides backend-target registration when the flag is off; unit tests cover both boot-failure paths | 3.1 | cc:TODO |
| 3.3 | `[lane:gate][tdd:required]` Proxy: add `target` to `DomainResolution` (`apps/mercato/src/lib/customDomainCache.ts:3-9`); backend-target hosts **pass through unrewritten** (`NextResponse.next()` with `x-next-url` = original path) instead of hitting `buildRewrittenPath` (`proxy.ts:29-35`); wrong-target host → 404. **No matcher change** — `/api/` stays excluded and continues resolving the host itself | Backend host serves `/backend/*`; portal host still rewrites to `/{orgSlug}/portal`; platform host byte-identical to before; `packages/create-app/template/src/proxy.ts` synced (CI enforces template parity per `apps/mercato/src/lib/dev-origins.ts:1-6`); proxy unit tests from 2.3 extended and passing | 2.3, 3.1 | cc:TODO |
| 3.4 | `[lane:gate][tdd:required]` **The load-bearing clamp.** Plumb the host binding into `applySuperAdminScope` (`packages/shared/src/lib/auth/server.ts:127-158`) and apply it **before** the cookie override is written to `next.tenantId`/`next.orgId`, at all three call sites (`:305` cookies, `:346` token, `:373` API key). `resolveAuthFromCookiesDetailed` (`:290`) takes no arguments today and needs the host. **Hard-deny (403), not silent clamp** — matching the `selectionRejected` precedent at `organizationScope.ts:20-26` ("writes MUST fail loudly") | On a bound host, a super-admin with `om_selected_tenant`/`om_selected_org` outside the binding gets 403 with an explicit "switch host to change organization" message on **both** a read and a write endpoint; API-key path covered identically; unit tests for all three call sites; platform host behavior unchanged | 3.2 | cc:TODO |
| 3.5 | `[lane:gate][tdd:required]` Clamp `resolveOrganizationScopeForRequest` (`directory/utils/organizationScope.ts:441-467`): on a bound host, discard both scope cookies and force the mapping's org/tenant into `effectiveTenantId` and `normalizedSelectedId` **before** the cache key is built at `:472`. Add the bound org (or `null`) as an explicit cache-key component — `buildOrgScopeCacheKey` (`:53`) has no host component today, so a poisoned entry would be shared between platform-host and bound-host requests. `__all__` on a bound host is a hard 4xx, never a silent widening. Fail **closed** (`{selectedId:null, filterIds:[], allowedIds:[]}`), never a home-org fallback | Cache key varies by bound org; `__all__` on a bound host returns 4xx (existing specs `TC-AUTH-041:32`, `TC-AUTH-052:69`, `TC-DIR-004:31` prove `__all__` is an accepted value today — each gains a "platform host unchanged" assertion); a user without access to the bound org gets an empty scope, not their home org; unit tests cover the concurrency case (two requests, different hosts, same user) | 3.4 | cc:TODO |
| 3.6 | `[lane:gate][tdd:required]` Backend cross-host token-replay defense, **fail closed**. Login (`auth/api/login.ts:85-115`) is host-agnostic today: a tenant-A user can authenticate on `crm.staffinit.com` and get a first-party session on Staffinit's host. Add the backend equivalent of the portal's `expectedTenantId` check (`customerAuthServer.ts:63-68`). On domain-resolution failure for a non-platform host return 503 — do **not** copy the portal's fail-open catch at `:119-122` | Token minted for tenant A is rejected on a host bound to tenant B; login on a bound host rejects credentials outside that host's tenant using the existing uniform error message (preserving the non-oracle behavior at `login.ts:105-112`); resolver failure on a bound host returns 503, not an unconstrained session; tests for all three | 3.4 | cc:TODO |
| 3.7 | `[lane:gate][tdd:required]` Admin UI: register/verify a `backend`-target domain, reusing the existing stepper components in `customer_accounts/backend/customer_accounts/settings/domain/components/*`. New ACL feature id + `setup.ts` `defaultRoleFeatures` | Feature id added to `acl.ts`, granted in `setup.ts`, `yarn mercato auth sync-role-acls` documented in `UPGRADE_NOTES.md`; page hidden when `BACKEND_CUSTOM_DOMAINS_ENABLED` is off; a user without the feature gets 403; DS-token compliant (no hardcoded status colors, no arbitrary values) | 3.2 | cc:TODO |
| 3.8 | `[lane:fast][tdd:required]` Render the organization switcher as a locked single-org indicator on a bound host. **Decoration only** — `om_selected_org` is a client-set cookie (`OrganizationSwitcher.tsx:170`); hiding the dropdown is not a security control. The control is 3.4 + 3.5 | Switcher shows the bound org, non-interactive, on a bound host; unchanged on the platform host; component test asserts both | 3.5 | cc:TODO |
| 3.9 | `[lane:gate][tdd:required]` Integration coverage for the clamp. **The decisive test:** a bound `Host` plus a deliberately conflicting `om_selected_org` cookie hitting an `/api/*` route — `/api` sits outside the proxy matcher, so this is what separates "shipped" from "half-bound" | `packages/core/src/modules/directory/__integration__/TC-DIR-0NN-backend-custom-domain.spec.ts` passes and covers: bound host + conflicting cookie → response scoped to the host's org; `__all__` on bound host → 4xx; super-admin cross-tenant cookie → 403; platform host unchanged; portal host unchanged; wrong-target host → 404. Self-contained fixtures created in setup and cleaned up in `finally` per `AGENTS.md:161`. `TC-DIR-014-stale-selected-org-orphan.spec.ts` extended rather than duplicated | 3.3, 3.5, 3.6 | cc:TODO |

---

## Phase 4: Host-aware outbound links

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 4.1 | `[lane:gate][tdd:required]` Make `getSecurityEmailBaseUrl` (`packages/shared/src/lib/url.ts:252-263`) host-aware. It currently asserts the origin then returns `env.APP_URL`, discarding the request host — which is why `auth/api/session/refresh.ts:70,78,82` bounces a user off their branded host mid-session. Keep `assertAllowedAppOrigin` **synchronous** by passing a pre-resolved allowed host rather than making the allowlist DB-backed. Only `status:'active'` mappings are ever allowlisted — do **not** reuse `isAllowedForTls`, which accepts `verified` too (`domainMappingService.ts:187-190`) | All request-carrying callers become host-correct with no signature change at the call site: `auth/api/reset.ts:45`, `auth/api/users/resend-invite/route.ts:135`, `customer_accounts/api/signup.ts:95`, `onboarding/api/post/onboarding.ts:141`, `onboarding/lib/verify-base-url.ts:63`. The 7 existing `APP_URL` assertions in `auth/lib/__tests__/requestRedirect.test.ts` updated. Session refresh on a bound host returns the user to that host. Staleness window of the resolver cache (60 s, `customDomainCache.ts:54-62`, no cross-process invalidation) documented in the spec | 3.5 | cc:TODO |
| 4.2 | `[lane:gate][tdd:required]` `urlForOrgBackend(orgId, path, opts?)` — async, container-based, **target-filtered** (`resolveActiveByOrg(orgId, 'backend')`, or an admin invite email points at the customer portal), null orgId → platform URL, error → platform URL **logged at warn** (not silently swallowed as `customerUrl.ts:50` does). Migrate only the genuinely job/CLI-scoped senders | Applied to: `messages/lib/email-sender.ts:33` (worker payload already carries `organizationId` — `workers/send-email.worker.ts:21,29`), `notifications/subscribers/deliver-notification.ts:139` (**first verify** whether `config.appUrl` via `moduleConfigService` already solves this — `lib/deliveryConfig.ts:124`), `auth/commands/users.ts:470`, `onboarding/lib/ready-email.ts:28`, `workflows/lib/activity-executor.ts:1190`, `enterprise/security/subscribers/enforcement-deadline-notification.ts:52`. Unit tests cover target filter, null-org fallback, and error fallback. Raw `process.env.APP_URL` reads in `sales/api/quotes/{send,accept}/route.ts` use the request host (they have `req`), not an orgId lookup | 4.1 | cc:TODO |
| 4.3 | `[lane:fast][tdd:required]` Emit a **relative** OpenAPI `servers` URL (`/api`) from `api_docs/lib/resources.ts:64-65` instead of an absolute `APP_URL`-derived one — correct on every host, one line, strictly better than an org lookup that is impossible at build time | API docs resolve against the serving host; `api_docs/lib/__tests__/resources.test.ts` updated; no behavior change on the platform host | - | cc:TODO |

---

## Phase 5: Docs, review, closeout

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|
| 5.1 | `[lane:gate][tdd:required]` WebAuthn: keep `rpId` request-derived (`enterprise/security/lib/security-config.ts:149-171`) and add a boot assertion **forbidding** `OM_SECURITY_WEBAUTHN_RP_ID` from being pinned to a registrable suffix shared by registered backend mappings — that would make every tenant host a valid RP for every other tenant's passkey. Add a "register a passkey for this domain" flow for a user arriving on a new bound host | Boot fails when the pin is a proper suffix of a registered mapping and the feature flag is on; a passkey user on an unenrolled host sees the enrollment prompt, not a generic auth failure; documented that recovery codes (`MfaService.ts:102,224-226`) are burned on each host switch | 3.2 | cc:TODO |
| 5.2 | `[lane:gate][tdd:skip:docs-only]` Docs: state plainly that backend custom domains are supported **only** on self-hosted Docker Compose with the opt-in Traefik overlay. Railway registers a single domain per service (`deploy/railway/index.ts:818,872`); AWS defers custom-domain ingress (`.ai/specs/2026-06-04-aws-terraform-deployment-playbook.md:17,1277`) | `apps/docs/docs/deployment/railway.mdx` and `docker/traefik/README.md` updated; `PLATFORM_DOMAINS`, `DOMAIN_CHECK_SECRET`, `DOMAIN_RESOLVE_SECRET` documented outside `docker/traefik/README.md` for the first time; all new env vars present in **both** `.env.example` files | 3.2 | cc:TODO |
| 5.3 | `[lane:gate][tdd:skip:mechanical]` `BACKWARD_COMPATIBILITY.md` per-feature row + `UPGRADE_NOTES.md` entry for: new `target` column (additive, defaulted), new ACL feature id, new optional env vars, new API routes | Both files updated; every change classified against the 13 contract-surface categories; no FROZEN or STABLE surface broken | 3.7 | cc:TODO |
| 5.4 | `[lane:gate][tdd:skip:review-artifact]` Full review pass: `harness-review` (or `om-code-review`) + `om-ds-guardian` for the new UI | Review artifact produced with an explicit verdict; every REQUEST_CHANGES item either fixed or recorded in the spec's Risks table with residual risk | 4.2, 5.1 | cc:TODO |
| 5.5 | `[lane:gate][tdd:skip:mechanical]` Validation gate + PR. Runner decision recorded (Docker if a compose `app` container is up, else local). Labels: `feature`, exactly one `priority-*`, exactly one `risk-*`, `needs-qa` (the automated-verification exemption does **not** apply — this ships `.tsx`, changes DB structure, and adds API surface) | `yarn generate`, `yarn build:packages`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn test:integration`, `yarn build:app` all pass; runner named in the PR body; PR body links the spec and #4271; `needs-qa` applied and the QA-approval merge gate respected (`AGENTS.md:151`) | 5.4 | cc:TODO |

---

## Explicitly out of scope (rejected, with reasons)

| Rejected | Why |
|---|---|
| Extending the `proxy.ts` matcher to `/api/` | API routes already resolve the host themselves (`resolveTenantContext.ts:85-153`). Extending the matcher puts a Node-runtime, DB-fetching proxy in front of **every API call in the product** for no gain. Highest blast radius available. |
| "Migrate ~28 helper call sites + 23 direct `APP_URL` reads" | Counts call sites instead of counting functions that discard the host. `resolveSafeRedirectLocation` already falls back host-relative; logout/autologin/refresh are correct today. One function (`getSecurityEmailBaseUrl`) + ~6 worker senders is the real surface. |
| Attachments client components (`AttachmentLibrary.tsx:50`, `AttachmentMetadataDialog.tsx:112`) | Module-scope `const` in client components, evaluated at bundle time. Their `window.location.origin` fallback is **already** org-correct on a custom domain. Restructuring two components for a cosmetic URL is not this feature. |
| A general DB-backed dynamic origin allowlist | `assertAllowedAppOrigin` is the repo's host-header-injection / open-redirect defense. Making it DB-driven inherits a 60 s staleness window with no cross-process invalidation — a CSRF window, not a 404 window. Task 4.1 passes a pre-resolved host instead. A real allowlist rewrite needs its own threat review. |
| Railway / AWS multi-host support | Railway: one registered domain per service. AWS: explicitly deferred by its own spec. Document the supported target; don't build it here. |
| Browser-level multi-host E2E as an acceptance criterion | `unknown` whether Playwright can navigate a second hostname here; the portal spec deliberately chose a header bypass to avoid the DNS question. Task 2.5 resolves this before anything depends on it. |

**Deferred, worth its own issue:** there is no Origin / `Sec-Fetch-Site` check in the API dispatcher
and no CSRF module in `packages/shared/src/lib`. With `SameSite=Lax` cookies, state-changing POSTs
are unprotected against same-site-different-subdomain requests — and this feature gives every tenant
its own hostname. Task 2.7 (`SameSite=Strict` on scope cookies) is a partial mitigation; a real CSRF
check is a separate change with its own threat review.

---

## Escalations for the maintainer

1. **`hostBinding` on `AuthContext` vs per-layer patching.** The clamp must land before the org-scope
   cache key (`organizationScope.ts:472`), while `applySuperAdminScope` runs earlier still, in a
   different package, through a function with no host access (`resolveAuthFromCookiesDetailed`,
   `server.ts:290`). Getting the ordering or the cache key wrong **fails silently** — a cached
   cross-org scope served to the wrong host, visible only under concurrency. A first-class
   `hostBinding` field makes the clamp assertable at every consumer, including the ~102 request-less
   scope calls and direct readers like `attachments/lib/requestScope.ts:26`. Per-layer patching is
   faster and leaves permanent holes.
2. **Hard-deny vs silent clamp** on a super-admin cookie/host disagreement. Plan assumes hard-deny,
   matching `selectionRejected`'s "writes MUST fail loudly" precedent.
3. **One backend host per org, or many?** Plan assumes exactly one active backend host per org
   (partial unique in 3.1).

---

## 事前確認

- 事項: external-send — `git push` + `gh pr create` to `open-mercato/open-mercato`
  理由: Phase 5 task 5.5 DoD requires opening the PR upstream
  scope: Phase 5 / Task 5.5

- 事項: external-send — `gh issue comment` on issue #4271
  理由: Phase 1 task 1.2 DoD requires posting the three maintainer decisions to the issue
  scope: Phase 1 / Task 1.2

- 事項: destructive — `yarn db:generate` rewrites `packages/core/src/modules/customer_accounts/migrations/.snapshot-open-mercato.json`
  理由: Task 3.1 adds the `target` column; `AGENTS.md:240` mandates the generate-and-review workflow
  scope: Phase 3 / Task 3.1

- 事項: destructive — deleting unrelated migration files emitted by `yarn db:generate`
  理由: `AGENTS.md:241` coding-agent exception: keep only the intended SQL for this entity change
  scope: Phase 3 / Task 3.1

- 事項: external-send — `yarn test:integration` starts an ephemeral app + database and drives it over HTTP
  理由: DoD of tasks 2.5, 3.9 and 5.5
  scope: Phase 2,3,5 / Tasks 2.5, 3.9, 5.5

**Not requested:** no `.env`, secret, key or credential read is planned. `yarn db:migrate` is **not**
run (`AGENTS.md:28` — ask first); migration files and snapshots ship in the PR instead.
