---
description: "Task list for Per-Organization Application Address"
---

# Tasks: Per-Organization Application Address

**Input**: Design documents from `specs/002-per-organization-app-url/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/organizations-app-url.md, quickstart.md

**Tests**: Included. The constitution (V) and AGENTS.md require unit tests for changed behaviour and Playwright integration tests for every affected API path and key UI path in the same change.

**Organization**: Tasks are grouped by user story. The minimal, permission-guarded write path for `appUrl` sits in Foundational, so that US1 and US2 can be tested independently of the US3 UI.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 = email links, US2 = OAuth return addresses, US3 = superadmin sets the address (spec.md)

Paths are repository-relative (Open Mercato monorepo). Run commands per AGENTS.md "Validation Commands". On this host, use a throwaway `node:24-bookworm` container (`--network none`) for generate/build/test, never the production compose.

---

## Phase 1: Setup

- [X] T001 Create branch `002-per-organization-app-url` from `crm` in a separate worktree `/srv/open-mercato-org-app-url`. Never edit the live checkout `/srv/open-mercato`. Read `BACKWARD_COMPATIBILITY.md` (DB schema, API response, ACL feature and DI key sections) and `packages/core/src/modules/directory` (entities, commands/organizations.ts, api/organizations/route.ts, acl.ts, di.ts) before editing.
- [X] T002 Check `.ai/specs/` and `.ai/specs/enterprise/` for existing specs touching the directory organizations or `APP_URL`/`APP_ALLOWED_ORIGINS`. Add a pointer spec `.ai/specs/2026-11-05-per-organization-app-url.md` that links to `specs/002-per-organization-app-url/` (constitution IV: OSS spec naming).

---

## Phase 2: Foundational (blocks all user stories)

- [X] T003 Add `appUrl?: string | null` to `Organization` in `packages/core/src/modules/directory/data/entities.ts` as `@Property({ name: 'app_url', type: 'text', nullable: true })`. Add the partial unique index `organizations_app_url_uniq` on `(app_url)` where `deleted_at is null and app_url is not null` (data-model.md).
- [X] T004 Generate the migration with `yarn db:generate`. Keep only the directory migration and its `.snapshot-open-mercato.json` change in `packages/core/src/modules/directory/migrations/`, and delete unrelated generated output. The SQL must be additive only: `alter table "organizations" add column "app_url" text null;` plus the partial unique index.
- [X] T005 [P] Add `normalizeOrganizationAppUrl(value: unknown): string | null` and the zod schema `organizationAppUrlSchema` to `packages/core/src/modules/directory/data/validators.ts`. Rules, quoted from data-model.md: "Origin form `scheme://host[:port]` (lower-case, no path or trailing slash). `https` in production. Must be in the operator's allowed origins (`APP_URL`, `NEXT_PUBLIC_APP_URL`, `APP_ALLOWED_ORIGINS`)". `null` or `""` means clear. Use `readConfiguredAppOrigins` from `@open-mercato/shared/lib/url` for the allowed set. Errors map to the i18n keys `directory.errors.appUrlInvalid` and `directory.errors.appUrlNotAllowed`.
- [X] T006 [P] Add the feature `{ id: 'directory.organizations.manage_app_url', title: 'Manage organization address', module: 'directory', dependsOn: ['directory.organizations.manage'] }` to `packages/core/src/modules/directory/acl.ts`. Do not add it to any role in `packages/core/src/modules/directory/setup.ts`. Add its label to the auth ACL i18n files where feature labels live.
- [X] T007 Implement the resolver in `packages/core/src/modules/directory/lib/organizationAppUrl.ts`: `createOrganizationAppUrlResolver({ em, cache })` with `resolve(organizationId)` and `invalidate(organizationId)`.
  - Read with `findOneWithDecryption(Organization, { id, deletedAt: null })`.
  - Return the organization's `appUrl` when it is set and still in `readConfiguredAppOrigins()`. Otherwise return `getSecurityEmailBaseUrl()`, and log a warning once per process when a stored value is no longer allowed.
  - Cache the result through the DI cache with tag `directory:organization:<id>:app_url` and TTL 60 s.
  - Never throw for a missing organization or a null id.
- [X] T008 Register `organizationAppUrlResolver` in `packages/core/src/modules/directory/di.ts`, request-scoped like the other directory services (depends on T007).
- [X] T009 [P] Add `resolveAppBaseUrl({ container, organizationId, req })` and `toAppUrl(input, path)` to `packages/shared/src/lib/url.ts` (contracts §4).
  - Soft-resolve `organizationAppUrlResolver` from the container (try/catch around `container.resolve`, the same pattern as other soft-optional DI lookups).
  - With no container, service or organizationId, return exactly `getSecurityEmailBaseUrl(req)`.
  - When `req` is given, always run `assertAllowedAppOrigin(req)` first.
  - Leave the existing exports unchanged.
- [X] T010 Update the command `directory.organizations.update` in `packages/core/src/modules/directory/commands/organizations.ts`:
  - Accept `appUrl` (omitted means unchanged; `null` or `""` clears it) and normalize it with T005.
  - When `appUrl` differs from the stored value and the caller is neither superadmin nor holds `directory.organizations.manage_app_url` (feature check through the RBAC service, wildcard-aware), reject the whole command with 403 `directory.errors.appUrlForbidden`.
  - Map a unique violation on `organizations_app_url_uniq` to 409, with fieldErrors `{ appUrl: directory.errors.appUrlTaken }`.
  - Include `appUrl` in the before/after audit snapshots.
  - After a successful flush, call `organizationAppUrlResolver.invalidate(id)`.
- [X] T011 Expose `appUrl` in `packages/core/src/modules/directory/api/organizations/route.ts` (list and detail items, `null` when unset) and accept it on PUT. Add it to the organization and update schemas in `packages/core/src/modules/directory/api/openapi.ts` (contracts §1).
- [X] T012 [P] Unit tests in `packages/core/src/modules/directory/__tests__/organizationAppUrl.test.ts` covering:
  - resolver set, unset and disallowed (fallback plus single warning) cases
  - cache hit, and invalidate forcing a reread
  - a missing organization
- [X] T013 [P] Unit tests in `packages/core/src/modules/directory/__tests__/appUrlValidator.test.ts` covering:
  - normalization (trailing slash, upper case, path rejected)
  - `http` rejected when `NODE_ENV=production`
  - not-allowed origin rejected
  - clearing with `""` or `null`
- [X] T014 [P] Unit tests in `packages/shared/src/lib/__tests__/url.resolveAppBaseUrl.test.ts` covering:
  - the fallback when there is no container, service or organizationId
  - a resolver value used when present
  - `assertAllowedAppOrigin` still enforced when `req` is passed
- [X] T015 Unit tests in `packages/core/src/modules/directory/commands/__tests__/organizations.appUrl.test.ts` covering:
  - an admin without the feature gets 403 and nothing is persisted
  - superadmin succeeds
  - a duplicate gets 409
  - the audit snapshot contains the old and new `appUrl`
  - invalidate is called
- [X] T016 Run `yarn generate`, then the directory, shared and validator unit tests, then `yarn typecheck` for core and shared. Fix failures before continuing.

**Checkpoint**: an organization address can be stored (API only, permission-guarded) and resolved. No consumer uses it yet, so behaviour is unchanged (FR-011).

---

## Phase 3: User Story 1 - Emails link to the recipient's organization address (P1) 🎯 MVP

**Goal**: every organization-scoped email link uses the recipient organization's address (FR-003).

**Independent Test**: quickstart.md Scenario 2. Set an address for organization A through the API, trigger a password reset for users of A and of B, and check the links.

- [X] T017 [P] [US1] Password reset in `packages/core/src/modules/auth/api/reset.ts`. After looking up the user by email, build the reset URL template with `toAppUrl({ container, organizationId: user.organizationId, req }, '/reset/__token__')`. When the user is not found, keep the response and timing identical (no account enumeration), and keep using `toSecurityEmailUrl(req, ...)` for the template.
- [X] T018 [P] [US1] Invitations in `packages/core/src/modules/auth/commands/users.ts` (around the `getSecurityEmailBaseUrl()` call at ~l.634). Use `resolveAppBaseUrl({ container: ctx.container, organizationId: <invited user's organizationId> })`.
- [X] T019 [P] [US1] Resend invite in `packages/core/src/modules/auth/api/users/resend-invite/route.ts`. Resolve the base URL for the target user's `organizationId` with `toAppUrl`.
- [X] T020 [P] [US1] Message emails in `packages/core/src/modules/messages/lib/email-sender.ts`. Replace the `process.env.APP_URL` read with `resolveAppBaseUrl({ container, organizationId: message.organizationId })`. Keep the "link omitted" debug path when nothing resolves (no APP_URL in dev).
- [X] T021 [P] [US1] Notification emails in `packages/core/src/modules/notifications/lib/deliveryConfig.ts`. Add an async variant that takes `{ container, organizationId }`. An explicit `NOTIFICATIONS_APP_URL` keeps top priority; otherwise use `resolveAppBaseUrl`. Update its callers in the notifications delivery code to pass the notification's organizationId. Keep the sync export for backward compatibility.
- [X] T022 [P] [US1] Form invitations in `packages/core/src/modules/forms/subscribers/invitation-email.ts`. Build `<base>/i/<rawToken>` from `resolveAppBaseUrl` for the form's organizationId.
- [X] T023 [P] [US1] Quote send in `packages/core/src/modules/sales/api/quotes/send/route.ts`. Replace `process.env.APP_URL || ''` with `resolveAppBaseUrl` for the quote's organizationId.
- [X] T024 [P] [US1] Onboarding ready email in `packages/onboarding/src/modules/onboarding/lib/ready-email.ts`. Use the address of the newly created organization (it falls back to the default because a new organization has none). (CUT in implementation brief: no effect, a new organization has no address)
- [X] T025 [P] [US1] Unit tests, one per call site above (T017–T024), in each module's existing `__tests__` folder. Mock `organizationAppUrlResolver` and assert that the link uses the organization's address when set and `APP_URL` when not. For reset, assert identical responses for unknown emails.
- [X] T026 [US1] Integration test `packages/core/src/modules/directory/__integration__/TC-DIR-APPURL-002.spec.ts`, self-contained:
  - Create organization A with an address from the allowed origins of the test env, organization B without one, and a user in each through API fixtures. A superadmin token sets A's address.
  - Request password resets and read the captured emails with the existing auth integration mail-capture helper.
  - Assert A's link starts with A's address and B's with `APP_URL`.
  - Change A's address and assert the next email uses it without a restart.
  - Clean up the users and organizations in `finally`.

**Checkpoint**: US1 complete. Email links are organization-specific (SC-001).

---

## Phase 4: User Story 2 - Connecting an external service from the organization's own address (P1)

**Goal**: OAuth return addresses use the connecting organization's address, and a flow cannot complete on another organization's host (FR-004, FR-005, FR-009).

**Independent Test**: quickstart.md Scenario 3.

- [X] T027 [US2] `packages/core/src/modules/integrations/lib/oauth/redirect.ts`: give `resolveOAuthRedirectUri(req, path, scope?: { container, organizationId })` an optional third parameter that builds the URI from `resolveAppBaseUrl`. Make it async-compatible by adding `resolveOAuthRedirectUriForOrganization` (async) and keeping the sync function unchanged for existing callers. Map errors to the same `OAuthGrantError` codes.
- [X] T028 [US2] `packages/core/src/modules/integrations/lib/oauth/grant-service.ts`: (CUT in implementation brief: the grant service has no state or callback)
  - Use the organization-aware resolver for connect and initiate.
  - Store `redirectOrigin` (the origin of the built `redirect_uri`) in the state payload.
  - In the callback, reject with the existing state-mismatch outcome when the request origin differs from `redirectOrigin`. A missing `redirectOrigin` on states issued before the deploy keeps today's check.
  - The inspection (`baseUrlMissing`, ~l.623) checks the organization's base URL.
- [X] T029 [P] [US2] Communication channels in `packages/core/src/modules/communication_channels/api/post/oauth/[provider]/initiate/route.ts` and `packages/core/src/modules/communication_channels/api/get/oauth/[provider]/callback/route.ts`. Build the redirect URI from the caller's organization (`auth.orgId` or the selected organization), record `redirectOrigin` in the state (`packages/core/src/modules/communication_channels/lib/oauth-state.ts`), and enforce it in the callback.
- [X] T030 [P] [US2] Meta Lead Ads in `packages/meta-lead-ads/src/modules/meta_lead_ads/api/oauth/initiate/route.ts` and `packages/meta-lead-ads/src/modules/meta_lead_ads/api/oauth/callback/route.ts`. Build `redirect_uri` with `resolveOAuthRedirectUriForOrganization` for the caller's organization, store `redirectOrigin` in the state, and in the callback use the same redirect URI for the code exchange and reject on an origin mismatch. Leave `api/data-deletion/route.ts` unchanged (installation level, research R1).
- [X] T031 [P] [US2] Show the return address. Add a read-only "Return address to register with the provider" row with a copy button (key `integrations.oauth.returnAddress`) to the integration OAuth provider tab in `packages/core/src/modules/integrations/backend/integrations/[id]` and to the Meta Lead Ads detail widget `packages/meta-lead-ads/src/modules/meta_lead_ads/widgets/injection/integration-detail/widget.client.tsx`. The value comes from a small authenticated GET that returns `{ returnAddress }` for the caller's organization, added to the integration's existing detail API response as an additive field. Add i18n keys in en, pl, de, es and ko.
- [X] T032 [P] [US2] Unit tests for T027–T030:
  - the redirect URI uses the organization's address when set and `APP_URL` when not
  - the state carries `redirectOrigin`
  - the callback on another origin gives `state_mismatch` and stores no connection
  - a legacy state without `redirectOrigin` still works

  Place them in the existing `__tests__` folders of integrations, communication_channels and meta_lead_ads.
- [X] T033 [US2] Integration test (moved to `packages/meta-lead-ads/src/modules/meta_lead_ads/__integration__/TC-META-010-org-app-url.spec.ts`, per the implementation brief), self-contained:
  - Create an organization with an address and an admin user.
  - Call the OAuth initiate of a test or mock provider (or Meta Lead Ads initiate when configured in the test env; otherwise the integrations grant-service test provider).
  - Assert the `redirect_uri` origin equals the organization's address.
  - Call the callback with that state on a different allowed origin (`Host`/`X-Forwarded-Host`) and assert the `state_mismatch` redirect.
  - Assert the return-address row value through the detail API.
  - Clean up.

**Checkpoint**: US2 complete. Each organization connects services from its own address (SC-002, SC-003).

---

## Phase 5: User Story 3 - A super administrator sets an organization's address (P2)

**Goal**: superadmins manage the address in the UI. Others see it read-only (FR-006, FR-007, FR-010).

**Independent Test**: quickstart.md Scenario 1.

- [X] T034 [US3] Organization edit form `packages/core/src/modules/directory/backend/directory/organizations/[id]/page.tsx`: add the "Organization address" field to the CrudForm.
  - The field is a select. Its options are the allowed origins (from a new additive field `allowedAppUrls: string[]` in the organization detail response, filled server-side from `readConfiguredAppOrigins()` only for callers with `directory.organizations.manage_app_url` or superadmin) plus "Use installation default" (empty value).
  - The field is read-only (plain text) when the caller lacks the feature.
  - Add help text. Keep the optimistic locking already handled by CrudForm `initialValues.updatedAt`.
  - Use DS primitives only, with no hardcoded colours or arbitrary values.
- [X] T035 [P] [US3] Add `allowedAppUrls` (permission-gated, as above) to `packages/core/src/modules/directory/api/organizations/route.ts` and to `packages/core/src/modules/directory/api/openapi.ts`.
- [X] T036 [P] [US3] i18n keys in `packages/core/src/modules/directory/i18n/{en,pl,de,es,ko}.json`:
  - `directory.organizations.form.appUrl`
  - `directory.organizations.form.appUrlHelp`
  - `directory.organizations.form.appUrlDefault`
  - `directory.errors.appUrlInvalid`, `directory.errors.appUrlNotAllowed`, `directory.errors.appUrlTaken`, `directory.errors.appUrlForbidden`

  Run `yarn i18n:check-hardcoded` for the directory module.
- [X] T037 [US3] Integration test `packages/core/src/modules/directory/__integration__/TC-DIR-APPURL-001.spec.ts`, self-contained:
  - API: a superadmin sets and clears the address. A tenant admin gets 403 and the value is unchanged. A duplicate gets 409. A non-allowed origin gets 422. The audit log has an entry with the old and new values.
  - UI: a superadmin selects an address on the edit page and saves. An admin sees the field read-only.
  - Clean up the created organizations in `finally`.

**Checkpoint**: all three stories complete.

---

## Phase 6: Polish and cross-cutting

- [X] T038 [P] Documentation in `apps/docs/docs/deployment/` (the page that documents `APP_URL`/`APP_ALLOWED_ORIGINS`): explain the per-organization address, that it must be in `APP_ALLOWED_ORIGINS`, the superadmin-only feature, and registering each organization's OAuth return URL with providers. Mirror any `apps/mercato/.env.example` comment change into the create-app template (`yarn template:sync:fix`).
- [X] T039 [P] Update `packages/core/src/modules/directory/AGENTS.md` (if present) or the integrations OAuth docs with: "user-facing links must use `resolveAppBaseUrl` with the organization id; internal URLs stay on `APP_URL`". Run `yarn agents:check-budget`.
- [X] T040 Full gate: `yarn generate`, `yarn build:packages`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build:app`, then `yarn test:integration -g "TC-DIR-APPURL"` and the existing auth, notifications and OAuth integration suites (SC-005). Report the failures as they are. (2026-11-05: all offline steps pass; Playwright integration specs written and typechecked but not run, because the offline container cannot start the app stack)
- [ ] T041 Production rollout. Each step needs the user's confirmation, and each is a production change: back up first (pg_dump plus a rollback image tag) and follow the deploy notes in memory.
  1. Deploy.
  2. As superadmin set BlueBee to `https://crm.bluebee.marketing`, Bespokesoft to `https://crm.bespokesoft.pl` and Staffinit to `https://crm.staffinit.com` (add it to `APP_ALLOWED_ORIGINS` first if it is missing).
  3. Register `https://crm.bespokesoft.pl/api/meta_lead_ads/oauth/callback` and the BlueBee callback in the Meta app.
  4. Optionally decide the neutral default `APP_URL`.

---

## Dependencies and execution order

- Setup (T001–T002) comes before Foundational (T003–T016), which blocks every story.
- T003 → T004. T005, T006 and T009 can run in parallel. T007 → T008. T010 depends on T005 and T008. T011 depends on T010. Tests T012–T015 follow their subjects. T016 closes the phase.
- **US1 (T017–T026)** depends only on Foundational. T017–T024 touch different files and can run in parallel. T025 follows them, then T026.
- **US2 (T027–T033)** depends only on Foundational. T027 → T028. T029 and T030 depend on T027 and run in parallel. T031 can run in parallel with T029/T030. T032 and T033 come last.
- **US3 (T034–T037)** depends only on Foundational. T035 and T036 can run in parallel, then T034, then T037.
- Polish (T038–T041) comes after the chosen stories.
- US1, US2 and US3 are independent of each other once Foundational is done.

## Parallel examples

- Foundational: T005 (validators.ts), T006 (acl.ts) and T009 (shared url.ts) together. Then T012, T013 and T014 together.
- US1: T017, T018, T019, T020, T021, T022, T023 and T024 together (8 different files).
- US2: after T027, run T029 (communication_channels), T030 (meta-lead-ads) and T031 (UI rows) together.
- US3: T035 (API) and T036 (i18n) together.

## Implementation strategy

1. **MVP**: Setup, Foundational and US1. Addresses are set through the API by a superadmin, and every email links to the right organization. This fixes the visible problem from 2026-11-05: Bespokesoft and Staffinit users currently get BlueBee links.
2. Add US2 so that each organization can connect Meta and other OAuth services from its own address. This removes the need for a single shared `APP_URL`.
3. Add US3 for the UI.
4. Finish with Polish and the production rollout (T041), each step confirmed by the user.
