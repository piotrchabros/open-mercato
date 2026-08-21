# Implementation Plan: Mercato Connect — Omnichannel Customer Contact Workspace

**Branch**: `cez/a5fd2e52` | **Date**: 2026-08-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `.ai/specs/2026-08-21-mercato-connect-omnichannel/spec.md`

## Summary

Mercato Connect adds an omnichannel contact-centre workspace to Open Mercato: one thread per customer across nine channels, with commerce context, AI assistance, cases with SLA clocks, live queues, outbound campaigns, bot/IVR configuration, quality review and a customer self-service portal.

Two decisions from the spec's Clarifications drive the whole plan:

- **Compose on top.** The platform already ships `communication_channels` (adapter contract, per-channel `ExternalConversation`/`ExternalMessage`, `ChannelThreadMapping`, contact resolution, credential lifecycle), `messages` (`Message.threadId` grouping, delivery, confirmations), `inbox_ops`, `customers`, `portal`, `integrations`, `dashboards`, `workflows` and the AI assistant package. The delivery therefore adds a **thread-level aggregate** over the existing per-channel records rather than a second messaging stack.
- **Voice via external provider.** A vendor-neutral `TelephonyAdapter` contract mirrors the existing `ChannelAdapter` pattern. Mercato Connect owns routing rules, flow definitions, recording policy, context supply and reporting; a provider package implements transport.

The work is delivered as a new workspace package `@open-mercato/contact-center` hosting eight modules, plus two provider packages. Phasing follows the spec's user-story priorities: P1 (inbox + AI) is independently shippable and is the whole product's proof.

## Technical Context

**Language/Version**: TypeScript 7.0.2 (repo root; `apps/mercato` on ^6.0.3), Node ≥ 20, Yarn 4.17.1 workspaces
**Primary Dependencies**: Next.js 16.2.12 (App Router), React 19.2.8, MikroORM 7.1.8 (PostgreSQL), Zod 4.4.3, Vercel AI SDK 7, Awilix DI, Tailwind v4 (`@theme inline`, OKLCH tokens)
**Platform packages consumed**: `@open-mercato/core` (`communication_channels`, `messages`, `inbox_ops`, `customers`, `customer_accounts`, `portal`, `notifications`, `integrations`, `data_sync`, `dashboards`, `workflows`, `progress`, `attachments`, `audit_logs`), `@open-mercato/ui`, `@open-mercato/shared`, `@open-mercato/events`, `@open-mercato/queue`, `@open-mercato/cache`, `@open-mercato/search`, `@open-mercato/ai-assistant`
**Storage**: PostgreSQL via MikroORM; module-scoped migrations in `src/modules/<module>/migrations/`; query index (`query_index`) for list projections; `@open-mercato/cache` for tenant-scoped read caching
**Testing**: Jest 30 (unit, per-workspace), Playwright 1.62 (integration, headless, `.ai/qa/`), `packages/core/src/__tests__/module-decoupling.test.ts` for absent-module behaviour
**Target Platform**: Server-rendered Next.js admin backend (desktop-first, dense B2B) + customer portal (responsive, single-column)
**Project Type**: Monorepo module suite — new workspace package hosting multiple auto-discovered modules
**Performance Goals**: SC-003 — 90% of conversation views render full cross-channel history and context within 2 s. SC-008 — live queue figures never more than 10 s stale, staleness stated on screen when exceeded.
**Constraints**: Multi-tenant with mandatory `tenant_id`/`organization_id` scoping; no cross-module ORM relations; additive-only changes to the contract surfaces in `BACKWARD_COMPATIBILITY.md`; optimistic locking default-ON on every user-editable entity; no hard-coded user-facing strings (Polish + English locales); no hard-coded DS status colours or arbitrary Tailwind values
**Scale/Scope**: 13 screens, 100 functional requirements, 12 user stories, 9 contact channels, ~28 new entities across 8 new modules + 2 provider packages

**Constitution source**: this repository has no `.specify/memory/constitution.md`. The governing documents are the root [`AGENTS.md`](../../../AGENTS.md) (Always / Ask First / Never), [`BACKWARD_COMPATIBILITY.md`](../../../BACKWARD_COMPATIBILITY.md), [`.ai/ds-rules.md`](../../ds-rules.md) and the per-package `AGENTS.md` files. The Constitution Check below is derived from them.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| # | Rule (source) | Initial | Post-design | How the design satisfies it |
|---|---|---|---|---|
| 1 | No direct ORM relationships between modules (`AGENTS.md` § Architecture) | PASS | PASS | `ServiceConversation` references `thread_id`, `customer_id`, `queue_id` as plain UUIDs with denormalised snapshots. No `@ManyToOne` crosses a module boundary. |
| 2 | Always filter by `tenant_id` / `organization_id`; never expose cross-tenant data | PASS | PASS | Every new entity carries both columns with a composite index; every list route goes through `makeCrudRoute` which enforces scope; SC-016 is an integration test. |
| 3 | Never edit generated files; run `yarn generate` after adding discovered files | PASS | PASS | All new `events.ts`, `subscribers/`, `workers/`, `widgets/`, `acl.ts`, `setup.ts`, `ce.ts`, `translations.ts` files are auto-discovered; `yarn generate` is step 2 of the validation gate. |
| 4 | No code under `apps/mercato/src/` except committed `*.generated.ts` registries | PASS | PASS | All code lands in `packages/contact-center/`, `packages/channel-meta/`, `packages/telephony-<vendor>/`. |
| 5 | Never bypass mutation guards, command side effects, encryption helpers, RBAC wildcard matching, shared UI data-call helpers | PASS | PASS | Writes go through commands (`runCrudCommandWrite`); custom write routes wire `runMutationGuards`; reads of encrypted entities use `findWithDecryption`; UI writes use `apiCall` + `CrudForm`/`useGuardedMutation`. |
| 6 | Never hard-code user-facing strings or DS status colours | PASS | PASS | `i18n/pl.json` + `i18n/en.json` per module; SLA/queue/score health states map to `{property}-status-{status}-{role}` tokens, never `text-red-*`. Verified by `yarn i18n:check-sync` / `check-usage` in the gate. |
| 7 | Backward compatibility: additive-only on the 13 contract surfaces | PASS | PASS | New event IDs, ACL features, DI keys, API routes, widget spot IDs and entity IDs are all **new**. The one shared-surface change — `ChannelCapabilities` gaining `voice?: boolean` — is an optional field (ADDITIVE-ONLY, allowed). See [research.md](./research.md) R-09. |
| 8 | Optimistic locking default-ON for user-editable entities (`updated_at` + `updatedAt` in responses) | PASS | PASS | Every user-editable new entity carries `updated_at`; append-only entities (`ConversationEvent`, `CallEvent`, `CampaignAttempt`) take the documented append-only exemption. See [data-model.md](./data-model.md). |
| 9 | Optional peers resolved via local `tryResolve`, never a hard `requires` | PASS | PASS | Every reused peer except `communication_channels` and `customers` is resolved through a module-local `tryResolve`; FR-091 (explicit degradation) is the behavioural contract. Verified by `module-decoupling.test.ts`. |
| 10 | Every module participating in tenant init declares `setup.ts` with `defaultRoleFeatures` | PASS | PASS | Each of the eight modules ships `setup.ts`; new `acl.ts` features are mirrored into `defaultRoleFeatures` and synced with `yarn mercato auth sync-role-acls`. |
| 11 | Integration coverage for all affected API paths and key UI paths ships in the same change (`.ai/qa/AGENTS.md`) | PASS | PASS | Per-story Playwright specs listed in [quickstart.md](./quickstart.md); fixtures created in setup, cleaned in teardown, no reliance on seeded demo data. |
| 12 | Ask before adding production dependencies / touching multiple modules outside an existing spec | PASS | PASS | No new production dependency is proposed. The multi-module scope **is** this spec. The vendor choice behind `packages/telephony-<vendor>` is an open decision recorded in research.md R-10 and deferred to `/speckit-tasks`. |

**Result**: no violations. Complexity Tracking below records the two deliberate structural choices that need justification rather than exception.

## Project Structure

### Documentation (this feature)

```
.ai/specs/2026-08-21-mercato-connect-omnichannel/
├── spec.md              # Feature specification (input)
├── plan.md              # This file
├── research.md          # Phase 0 — decisions, rationale, alternatives
├── data-model.md        # Phase 1 — entities, fields, relationships, state machines
├── quickstart.md        # Phase 1 — runnable validation guide
├── contracts/
│   ├── README.md            # Contract index and conventions
│   ├── rest-api.md          # HTTP surface per module
│   ├── telephony-adapter.md # Vendor-neutral voice provider contract
│   ├── events.md            # Event IDs, payloads, broadcast flags
│   ├── acl.md               # ACL features per module and default role grants
│   └── ui-extension.md      # Widget spot IDs, DataTable ids, portal pages
└── checklists/
    └── requirements.md  # Spec quality checklist (16/16)
```

### Source Code (repository root)

```
packages/contact-center/                     # NEW workspace package @open-mercato/contact-center
├── package.json
└── src/modules/
    ├── conversations/                       # P1 — unified cross-channel thread, assignment, routing
    │   ├── acl.ts  ce.ts  di.ts  events.ts  encryption.ts  index.ts  setup.ts  search.ts
    │   ├── translations.ts  notifications.ts  notifications.client.ts
    │   ├── data/{entities.ts,validators.ts,extensions.ts,enrichers.ts}
    │   ├── commands/{conversation.ts,assignment.ts,identity.ts}
    │   ├── lib/{thread-aggregator.ts,identity-merge.ts,routing.ts,sla-clock.ts,tryResolve.ts}
    │   ├── api/{conversations,conversations/[id],conversations/take-next,conversations/reply,identities}
    │   ├── backend/inbox/{page.tsx,components/}
    │   ├── frontend/[orgSlug]/portal/cases/{page.tsx,page.meta.ts}
    │   ├── subscribers/  workers/  widgets/  i18n/  migrations/  __tests__/  __integration__/
    ├── service_tickets/                     # P2 — cases, SLA clock, status machine
    ├── contact_queues/                      # P2 — queues, routing config, wallboard, agent sessions
    ├── contact_analytics/                   # P3 — KPI aggregation + dashboard widgets
    ├── contact_campaigns/                   # P3 — outbound campaigns, retry/callback rules
    ├── bot_intents/                         # P3 — shared intent set, containment, knowledge gaps
    ├── telephony/                           # P2/P3 — adapter contract, call events, IVR flows, publish
    └── contact_quality/                     # P3 — recordings index, scorecards, review queue
packages/channel-meta/                       # NEW provider package — Messenger + Instagram adapters
└── src/modules/{channel_messenger,channel_instagram}/
packages/telephony-<vendor>/                 # NEW provider package — implements TelephonyAdapter
└── src/modules/telephony_<vendor>/
```

**Structure Decision**: a dedicated workspace package hosting several modules, following the `packages/enterprise` precedent (`record_locks`, `security`, `sso`, `system_status_overlays` as sibling modules under one package) rather than adding eight modules to `packages/core`. Channel and telephony providers get their own packages per the root `AGENTS.md` rule that every external integration provider lives in a dedicated workspace package.

## Phase 0 — Research

Complete. See [research.md](./research.md). Twelve decisions were investigated: ten resolved, and two (R-10, R-12) deliberately deferred to `/speckit-tasks` because each depends on information that does not exist yet — a vendor choice and measured cardinality. Neither appears in Technical Context, and neither blocks task generation; both are recorded with the criteria that will settle them.

Headline outcomes:

- **R-01 Unified thread**: reuse `Message.threadId` as the join key and `ChannelThreadMapping` as the per-channel binding. A new `ServiceConversation` aggregate keys on `thread_id` and owns assignment, queue, SLA and open/closed state. No new messaging stack.
- **R-02 Identity merge**: layer a `CustomerIdentity` + `IdentityMergeAudit` pair over the existing `contact-resolver`, giving confidence scoring, agent-visible inspection and reversal (FR-026, FR-027).
- **R-04 Live wallboard**: DOM Event Bridge SSE (`clientBroadcast: true`) with a client-side staleness guard, not polling — satisfies SC-008 within the existing 4096-byte payload and 30 s heartbeat budget.
- **R-06 Telephony**: a `TelephonyAdapter` contract mirroring the shape and lifecycle of the existing `ChannelAdapter`, so vendor swap is an integrations-surface change only (FR-100, SC-022).
- **R-09 Voice as a channel**: `ChannelCapabilities` gains an optional `voice?: boolean`; additive, so no existing adapter breaks.

## Phase 1 — Design & Contracts

Complete. Artifacts generated:

| Artifact | Contents |
|---|---|
| [data-model.md](./data-model.md) | 28 entities across 8 modules — fields, types, scoping columns, indexes, FK-id + snapshot boundaries, optimistic-lock applicability, and 4 state machines (ticket status, conversation lifecycle, campaign run state, call lifecycle) |
| [contracts/rest-api.md](./contracts/rest-api.md) | HTTP surface per module: CRUD routes via `makeCrudRoute` with `indexer.entityType`, custom action routes with their mutation-guard operation mapping, request/response schemas, and the 409 optimistic-lock contract |
| [contracts/telephony-adapter.md](./contracts/telephony-adapter.md) | Vendor-neutral `TelephonyAdapter` interface — capabilities, call lifecycle events, routing-context supply, flow publish/verify, recording policy, agent-state reconciliation |
| [contracts/events.md](./contracts/events.md) | Event IDs per module with payload shapes, `category`, `clientBroadcast` / `portalBroadcast` flags, and persistent-vs-ephemeral subscriber guidance |
| [contracts/acl.md](./contracts/acl.md) | ACL features per module and the `defaultRoleFeatures` mapping for admin / employee / portal customer roles |
| [contracts/ui-extension.md](./contracts/ui-extension.md) | Widget spot IDs the suite exposes and consumes, DataTable table ids, CrudForm entity ids, portal page metadata and nav entries |
| [quickstart.md](./quickstart.md) | Prerequisites, bootstrap, per-story validation scenarios mapped to acceptance criteria, and the ordered validation-gate commands |

### Post-Design Constitution Re-Check

Re-evaluated after the design above: **PASS on all 12 rules** (see the Post-design column). Two points worth naming explicitly:

1. The only contract-surface change to an existing module is `ChannelCapabilities.voice?: boolean` — an optional field addition, which `BACKWARD_COMPATIBILITY.md` classifies as ADDITIVE-ONLY and therefore permitted without the deprecation protocol. Nothing is renamed, removed or narrowed.
2. Cross-module reach is one-directional throughout: Mercato Connect modules resolve platform peers, never the reverse. No platform module gains an import of, or a `requires` on, a contact-centre module — preserving upstream isomorphism.

## Complexity Tracking

Recorded for review; neither is a constitution violation, both are structural choices that could reasonably have gone the other way.

| Choice | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| Eight new modules rather than one | Modularity is a hard product requirement, not packaging taste — FR-071 to FR-074 require each capability to be independently enableable with declared dependencies, and SC-009 requires navigation to reflect a toggle with no restart. One module cannot satisfy that; the module boundary *is* the toggle boundary. | A single `contact_center` module would make every capability all-or-nothing, breaking FR-071/072/073 and the operator story (US6) outright. |
| A new workspace package rather than modules inside `packages/core` | Keeps the suite optional and independently versionable, matching the platform's stated direction (the `staff` module is already slated for extraction to `official-modules` for exactly this reason). | Adding eight business modules to `packages/core` grows the mandatory install surface for every tenant that will never run a contact centre, and moves against the existing decoupling work. |

## Open decisions carried into `/speckit-tasks`

Neither blocks task generation; both are recorded in research.md.

- **R-10** — which telephony vendor the first `packages/telephony-<vendor>` implements. The `TelephonyAdapter` contract is vendor-neutral by construction (FR-100), so this changes only the provider package, not the plan.
- **R-12** — whether contact-centre reporting aggregates through the existing `query_index` projections or a purpose-built rollup table. The decision depends on measured list latency against SC-003 and is best taken with real cardinality.
