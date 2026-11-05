# Implementation Plan: Per-Organization Application Address

**Branch**: `002-per-organization-app-url` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-per-organization-app-url/spec.md`

## Summary

The organization gets an optional `appUrl`, settable only by a superadmin and restricted to the operator's allowed origins. A DI resolver with caching returns the organization's address, or the installation `APP_URL` as a fallback. Organization-scoped user-facing links and OAuth return addresses are switched to the resolver:
- password reset
- invitations
- message, notification, form and quote emails
- onboarding
- the integrations OAuth grant service
- Meta Lead Ads
- communication-channel OAuth

The OAuth state records the origin it was issued for, so a flow cannot complete on another organization's host. Everything is additive. With no organization addresses configured, behaviour is identical to today.

## Technical Context

**Language/Version**: TypeScript (Node 24), Next.js app router

**Primary Dependencies**:
- MikroORM v7 (directory `Organization` entity)
- Awilix DI
- `@open-mercato/cache` for tag-invalidated caching
- zod validators
- CrudForm for the organization edit page

**Storage**: PostgreSQL. A nullable `organizations.app_url` column with a partial unique index (see [data-model.md](./data-model.md)).

**Testing**:
- Jest unit tests in `packages/core`, `packages/shared`, `packages/onboarding` and `packages/meta-lead-ads`
- Playwright integration tests TC-DIR-APPURL-001..003

**Target Platform**: Linux server (Docker compose `open-mercato` in production)

**Project Type**: Web application (modular monorepo: platform packages plus the `apps/mercato` host app)

**Performance Goals**: no extra DB query per email in steady state (cached; 60 s TTL; invalidated on change)

**Constraints**:
- Changes take effect in ≤ 60 s without a restart.
- No cross-organization address leakage.
- Additive contracts only.
- The CALL_API SSRF guard stays on `APP_URL`.

**Scale/Scope**: a handful of organizations per installation. About 10 call sites in 5 packages.

No NEEDS CLARIFICATION remain; see [research.md](./research.md) R1–R8.

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Module isolation | PASS | The column lives on the directory module's own entity. Other modules reach it only through the DI service, soft-resolved by a `shared` helper; there are no ORM relations. |
| II. Tenant isolation and security | PASS | The resolver is keyed by organization id from the auth/record context. A new feature id gates changes (no role names). Input is validated in `data/validators.ts`. The OAuth origin is bound in the state (FR-009). Reset responses stay identical for unknown emails. |
| III. Backward-compatible contracts | PASS | The column, response field, request field, ACL feature, DI key, helper and optional parameter are all additive. Existing `url.ts` exports are unchanged. |
| IV. Spec-first | PASS | spec.md and plan exist. Touches several modules (directory, auth, messages, notifications, forms, sales, onboarding, integrations, communication_channels, meta_lead_ads); this is covered by this spec and needs maintainer confirmation before implementation. |
| V. Verified changes and tests | PASS (planned) | Unit tests per call site. Integration tests TC-DIR-APPURL-001..003 are self-contained (fixtures created and cleaned up). |
| VI. Data integrity | PASS | The schema change goes through `yarn db:generate`, with only the directory migration and snapshot kept. Optimistic locking is reused through the existing organization update. |
| VII. Design system and i18n | PASS (planned) | New strings go in directory i18n (`en`, `pl`, `de`, `es`, `ko`). The field uses DS primitives inside CrudForm; no hardcoded status colours. |
| VIII. Simplicity | PASS | One column, one resolver, one helper. Internal URLs are deliberately left alone. |

Post-design re-check: PASS. No violations, so Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/002-per-organization-app-url/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/organizations-app-url.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
packages/shared/src/lib/url.ts                          # + resolveAppBaseUrl, toAppUrl (additive)
packages/core/src/modules/directory/
├── data/entities.ts                                    # Organization.appUrl
├── data/validators.ts                                  # appUrl normalization + allowed-origin check
├── acl.ts                                              # + directory.organizations.manage_app_url
├── di.ts                                               # + organizationAppUrlResolver
├── lib/organizationAppUrl.ts                           # resolver + cache tags
├── commands/organizations.ts                           # permission check, uniqueness, cache invalidation, audit snapshot
├── api/organizations/route.ts + api/openapi.ts         # appUrl in responses and update
├── backend/directory/organizations/[id]/page.tsx       # form field (read-only without feature)
├── i18n/*.json                                         # labels and errors
├── migrations/                                         # additive migration + snapshot
└── __integration__/TC-DIR-APPURL-00{1,2,3}.spec.ts
packages/core/src/modules/auth/{api/reset.ts,commands/users.ts,api/users/resend-invite/route.ts}
packages/core/src/modules/messages/lib/email-sender.ts
packages/core/src/modules/notifications/lib/deliveryConfig.ts
packages/core/src/modules/forms/subscribers/invitation-email.ts
packages/core/src/modules/sales/api/quotes/send/route.ts
packages/core/src/modules/integrations/lib/oauth/{redirect.ts,grant-service.ts}
packages/core/src/modules/communication_channels/api/{post,get}/oauth/[provider]/...
packages/onboarding/src/modules/onboarding/lib/ready-email.ts
packages/meta-lead-ads/src/modules/meta_lead_ads/api/oauth/{initiate,callback}/route.ts (+ detail widget return-address row)
```

**Structure Decision**: modular monorepo. The feature is owned by the directory module (core package). The consuming modules call the shared helper.

## Phasing (input for /speckit-tasks)

1. **Foundation**
   - entity column and migration
   - validator
   - ACL feature
   - resolver, cache and DI registration
   - shared helper
   - unit tests
2. **US3, setting the address**
   - command permission, uniqueness, invalidation and audit
   - API and OpenAPI
   - form field and i18n
   - TC-DIR-APPURL-001
3. **US1, email links**
   - migrate reset, invite, resend-invite, messages, notifications, forms, quotes and onboarding
   - TC-DIR-APPURL-002
4. **US2, OAuth**
   - `resolveOAuthRedirectUri` organization parameter
   - grant service, communication channels and Meta Lead Ads initiate/callback
   - `redirectOrigin` in the state
   - return-address rows in the UI
   - TC-DIR-APPURL-003
5. **Rollout**
   - update docs (`apps/docs` deployment env notes)
   - in production: set BlueBee, Bespokesoft and Staffinit addresses
   - register each organization's Meta and OAuth return URL with the providers
   - optionally set `APP_URL` back to a neutral host

## Complexity Tracking

None.
