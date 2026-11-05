# Research: Per-Organization Application Address

All Technical Context unknowns are resolved below. Findings come from the code on branch `crm` at `5dc79ff05`.

## R1. Where the installation address is used today

**Decision**: Route these organization-scoped call sites through a new resolver. Leave installation-level and internal call sites on `APP_URL`.

| Call site | Current source | v1 behaviour |
|---|---|---|
| `packages/core/src/modules/auth/api/reset.ts` (password reset link) | `toSecurityEmailUrl(req, ...)` | Organization of the user found by email |
| `packages/core/src/modules/auth/commands/users.ts` (invitation link, ~l.634) | `getSecurityEmailBaseUrl()` | Organization of the invited user |
| `packages/core/src/modules/auth/api/users/resend-invite/route.ts` | `toSecurityEmailUrl` | Organization of the user |
| `packages/core/src/modules/messages/lib/email-sender.ts` | `process.env.APP_URL` | Organization of the message |
| `packages/core/src/modules/notifications/lib/deliveryConfig.ts` | `NOTIFICATIONS_APP_URL`, `NEXT_PUBLIC_APP_URL` or `APP_URL` | Organization of the notification (an explicit `NOTIFICATIONS_APP_URL` keeps priority) |
| `packages/core/src/modules/forms/subscribers/invitation-email.ts` | `process.env.APP_URL` | Organization of the form |
| `packages/core/src/modules/sales/api/quotes/send/route.ts` | `process.env.APP_URL` | Organization of the quote |
| `packages/onboarding/src/modules/onboarding/lib/ready-email.ts` | `toSecurityEmailUrl` | Organization created by onboarding (falls back to the default) |
| `packages/core/src/modules/integrations/lib/oauth/redirect.ts` `resolveOAuthRedirectUri` (used by the grant service and Meta Lead Ads) | `toSecurityEmailUrl` | Organization of the connecting user |
| `packages/core/src/modules/communication_channels/api/{post,get}/oauth/[provider]/{initiate,callback}` | redirect via shared helpers | Organization of the connecting user |

**Unchanged (installation level or internal)**:
- `workflows/lib/activity-executor.ts` CALL_API. It is an SSRF guard on internal API calls and must stay on one origin.
- `documents/lib/entityRegistry.server.ts`. It builds a server-side lookup URL, not a user-facing link.
- `meta-lead-ads/api/data-deletion`. Meta registers it per app, not per organization.
- `customer_accounts` portal URLs and `checkout` pay links. The spec puts portal domains out of scope.
- `cli`, `api_docs`, `ai-assistant` endpoint index, and `apps/mercato/src/app/start`.

**Rationale**: FR-003 and FR-004 cover links sent to users and provider return addresses. Internal URLs must stay single-origin for security reasons (CALL_API SSRF).

**Alternatives considered**: Switching every `APP_URL` read to the resolver. Rejected: it would break the CALL_API SSRF guard and the portal, and enlarge the change for no user value.

## R2. Where the organization address is stored

**Decision**: Add a nullable `app_url` column to `organizations` (directory module). Add a partial unique index on `app_url` where `deleted_at is null and app_url is not null`.

**Rationale**:
- The address is a one-to-one attribute of the organization.
- The directory module owns `Organization`.
- An additive nullable column is allowed by BACKWARD_COMPATIBILITY.md (DB schema is additive-only).
- The organization edit form and command (`directory.organizations.update`) already exist, are audited, and use `updated_at` for optimistic locking.

**Alternatives considered**:
- Reusing `domain_mappings` (customer_accounts). Rejected: that table holds customer-portal custom domains with DNS/TLS verification states, which the spec puts out of scope. Coupling staff links to the portal module would also violate module isolation.
- A separate extension entity. Rejected as unnecessary: the same module owns the entity.

## R3. Who may change it

**Decision**:
- Add a new ACL feature `directory.organizations.manage_app_url`, granted to no role by default. Superadmin passes because of the superadmin bypass.
- The organizations update command ignores `appUrl` unless the caller has this feature or is superadmin. In that case it returns 403 with `directory.errors.appUrlForbidden`.
- The form shows the field read-only to everyone else.

**Rationale**: the spec requires superadmin-only changes. The existing `directory.organizations.manage` is granted to the admin role in production (seen in `sync-role-acls` output), so it is not strict enough. A feature id (not a role name) follows the constitution.

**Alternatives considered**: a role-name check (prohibited), or reusing `directory.tenants.manage` (wrong semantics).

## R4. Validation

**Decision**:
- `appUrl` is normalized to the origin form `scheme://host[:port]`: lower-case, no path, query, fragment or trailing slash.
- It must be in `readConfiguredAppOrigins(process.env)` (`APP_URL`, `NEXT_PUBLIC_APP_URL`, `APP_ALLOWED_ORIGINS`).
- It must be unique across organizations. A violation returns 409 with `directory.errors.appUrlTaken`.
- In production it must be `https`.

**Rationale**: FR-007. The allowed list stays under operator control. Picking only from origins the installation already accepts keeps the origin checks (`assertAllowedAppOrigin`) consistent.

## R5. Resolution and caching

**Decision**:
- **Resolver.** Add a DI service `organizationAppUrlResolver` in the directory module with `resolve(organizationId | null): Promise<string>`. It returns `organization.app_url` when set and still allowed, otherwise `getSecurityEmailBaseUrl()`.
- **Cache.** Results are cached through the cache package with tag `directory:organization:<id>:app_url` and a 60 s TTL. The update command invalidates the tag.
- **Shared helper.** Add `resolveAppBaseUrl({ container, organizationId, req? })` in `packages/shared/src/lib/url.ts`. It soft-resolves the DI service (`tryResolve`). When the service is missing it falls back to `getSecurityEmailBaseUrl(req)`, so modules without the directory module keep today's behaviour.
- **Allowed list.** If an `app_url` is no longer in the allowed list (an operator removed it), the resolver falls back to the default and logs a warning once per process.

**Rationale**:
- FR-008: within one minute, without a restart. Invalidation makes changes immediate in practice; the TTL bounds staleness for multi-process deployments.
- Soft resolution keeps `shared` free of a directory dependency, following the constitution's cross-module coupling rules.

**Alternatives considered**: reading the DB on every email (works, but adds a query per email in bulk sends), or an env-var map per organization (needs a restart and does not satisfy US3).

## R6. OAuth flows across hosts

**Decision**:
- The OAuth initiate step computes `redirect_uri` from the address of the caller's selected organization.
- The callback step accepts requests only on that same address: it compares the request origin with the state payload's recorded `redirectOrigin`. On a mismatch it returns `state_mismatch`.
- Connection screens show the exact return URL to register: `<org address><callback path>`.

**Rationale**:
- Session cookies are host-scoped. Returning to the organization's own address keeps the user signed in (US2).
- Recording the origin in the state prevents a flow started for one organization from completing on another organization's host (FR-009, edge case "address changed mid-flow").

**Alternatives considered**: a single shared callback host with a cross-domain session handoff. Rejected as more complex and a larger attack surface.

## R7. Reset password and account emails

**Decision**:
- **Reset.** The user record has `organization_id`, so the reset route resolves that organization's address after looking up the user. The response stays identical whether or not the email exists (auth error minimality).
- **Several organizations.** Users who can switch organizations get the address of their home organization (`users.organization_id`).

**Rationale**: matches the spec's edge-case rule. It needs no new data.

## R8. Testing approach

**Decision**:
- **Unit tests:**
  - resolver: set, unset, disallowed and cached cases
  - validator normalization
  - command permission checks
  - each migrated call site with a mocked resolver
- **Integration tests (Playwright, self-contained):**
  - TC-DIR-APPURL-001: a superadmin sets and clears the address (API and form), including the forbidden case for an admin and the duplicate and disallowed cases.
  - TC-DIR-APPURL-002: a password reset email for a user of an organization with an address contains that address. Uses the test mail capture.
  - TC-DIR-APPURL-003: OAuth initiate returns a `redirect_uri` on the organization's address, and the callback on another host is rejected.

**Rationale**: the constitution (V) and AGENTS.md require integration coverage for affected API paths and key UI paths.
