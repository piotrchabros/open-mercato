# Pre-Implementation Analysis: Mercato Connect — Phase 1: One Inbox

**Spec:** `.ai/specs/2026-08-21-connect-phase-1-one-inbox.md`
**Parent:** `.ai/specs/2026-08-21-app-spec-mercato-connect.md` (v2)
**Date:** 2026-08-21 · **Skill:** `om-pre-implement-spec`

## Executive Summary

**Not ready to implement — but close.** Backward compatibility is clean: no violations across
all 14 contract surfaces, and the three changes to modules `connect` does not own are correctly
classified as additive and correctly sequenced as upstream PRs. Structure and test coverage are
strong.

The blockers are all **canonical-mechanism omissions**: six custom write routes with no mutation-guard
wiring, PII columns with no `encryption.ts`, no zod validators, and a module path that does not
match the repo's package convention. None requires redesign — each is spec text that must exist
before implementation so an agent does not invent a substitute. One of them (`hashField`) also
closes the spec's own open question P1-1.

**Recommendation:** apply C1–C4 and M1–M6, then implement. Re-running this analysis is not
necessary if the fixes are applied as described.

---

## Backward Compatibility

### Violations found

**None.** Audited against all 14 surfaces in `BACKWARD_COMPATIBILITY.md`.

| Surface | Change | Verdict |
|---|---|---|
| 1 Auto-discovery (FROZEN) | New module + package IDs | Additive |
| 2 Types (STABLE) | New `customers` export | Additive |
| 3 Signatures (STABLE) | `allowSharedChannel` **optional**, defaults `false` | Additive — existing callers byte-identical, asserted by T17 |
| 5 Event IDs (FROZEN) | 7 new `connect.*` | Additive |
| 6 Spot IDs (FROZEN) | 5 new spots in `customers`/`sales` | Additive — none renamed |
| 7 API routes (STABLE) | New `/api/connect/*`; one new optional body field on `POST /api/communication_channels/send-as-user` | Additive |
| 8 DB schema (ADDITIVE-ONLY) | New tables only | Additive |
| 9 DI names (STABLE) | 4 new prefixed keys | Additive |
| 10 ACL IDs (FROZEN) | 6 new | Additive |
| 4, 11, 12, 13, 14 | No change | N/A |

The spec's own §Migration & BC reached the same conclusions independently, including the
FROZEN-surface pre-merge review. **The upstream PR ordering (A → B → connect) is correct and
should be treated as binding.**

### Notes

- **N1 (minor).** The skill's Phase 2 table lists 13 surfaces; `BACKWARD_COMPATIBILITY.md` has
  **14** (#12 "AI Agent, Tool, UI Part, and Override IDs" was added later). The spec audited all
  14. The skill's own table is stale — worth a follow-up to the skill, not to this spec.
- **N2.** `sendAsUser` is reachable both as `lib/send-as-user.ts` and as
  `POST /api/communication_channels/send-as-user`. The spec covers the function signature;
  confirm the **route's zod schema** marks `allowSharedChannel` `.optional()` so the API surface
  stays additive too.

---

## Spec Completeness

### Missing sections

| Section | Impact | Recommendation |
|---|---|---|
| **Final Compliance Report** | The spec-writing checklist results are not recorded, so reviewers cannot see which checks were run | Add a short section listing the checklist outcomes, as the sibling specs in `.ai/specs/` do |

All other required sections are present: TLDR, Problem Statement, Proposed Solution,
Architecture, Data Models, API Contracts, UI/UX, Risks & Impact Review, Phasing, Implementation
Plan, Integration Test Coverage, Changelog.

### Incomplete sections

| Section | Gap | Recommendation |
|---|---|---|
| Data Models | No `search.ts` configuration for `connect_case` | The App Spec's persistent chrome specs a global search over "klienta, zamówienia, **zgłoszenia**". Shipping Cases in Phase 1 without search config breaks a specced surface. Add a `search.ts` and the `makeCrudRoute` `indexer: { entityType }` binding |
| API Contracts | No `indexer` on `makeCrudRoute`; no cache strategy or invalidation tags | Declare `indexer: { entityType: 'connect_case' }`; declare cache tags `tenant:<id>` / `org:<id>` and the invalidation path per write |
| Architecture | No command-pattern / undo story | Root `AGENTS.md` forbids bypassing command side effects. State which writes are undoable commands and reference `extractUndoPayload()` — resolve and transfer are the obvious candidates |
| Risks | No N+1 or denormalization risk | See G1, G2 below |

---

## AGENTS.md Compliance

### Critical

| # | Rule | Location | Fix |
|---|---|---|---|
| **C1** | **"Never bypass mutation guards."** Custom write routes must map to `create`/`update`/`delete`, collect registered guards, append `bridgeLegacyGuard(container)`, call `runMutationGuards(...)` with `{ userFeatures }` before mutating, merge `modifiedPayload`, and run `afterSuccessCallbacks` after (catching and logging callback failures) | API Contracts — **six** action endpoints: `/resolve`, `/transfer`, `/messages`, identity `/link`, identity `/unlink`, `PUT /settings` | Add the guard-registry wiring to each. Mechanism: `packages/shared/src/lib/crud/mutation-guard.ts` + `route-mutation-guard.ts`. Action endpoints usually map to `update` |
| **C2** | **Encryption maps mechanism.** Every PII column must be declared in `<module>/encryption.ts` exporting `defaultEncryptionMaps` (type `ModuleEncryptionMap`); equality-lookup columns declare a sibling `hashField`. "Use the platform encryption helpers" is the encrypt-later stub the rule names | Data Models — `connect_conversations.contact_handle`, `connect_contact_identities.handle_value` | Add `packages/connect/src/modules/connect/encryption.ts` with both columns mapped, and `handle_value` carrying `{ field: 'handle_value', hashField: 'handle_value_hash' }`. **This closes the spec's open question P1-1** — the platform already answers it; `auth`, `customer_accounts` and `messages` all use exactly this pattern for e-mail lookups. Add the `handle_value_hash` column to the unique index instead of the encrypted column |
| **C3** | **"Validate all inputs with zod; place validators in `data/validators.ts`; derive types via `z.infer`."** No `any` | Spec never mentions zod or validators | Add `data/validators.ts` to the module layout and reference the schemas in the API Contracts table |
| **C4** | **Module placement convention** is `packages/<pkg>/src/modules/<module>/` | Architecture — "new `packages/connect`" | Correct to `packages/connect/src/modules/connect/` and `packages/channel-webform/src/modules/channel_webform/`, matching `channel-gmail`/`channel-imap`. Note the module id is snake_case (`channel_webform`) while the package is kebab-case |

### Major

| # | Rule | Location | Fix |
|---|---|---|---|
| **M1** | Backend pages that cannot use `CrudForm` must wrap every write in `useGuardedMutation(...).runMutation(...)` and include `retryLastMutation` in the injection context | UI/UX — the Inbox is a custom composite; R7 mentions only the lock headers | Add `useGuardedMutation` explicitly for send, resolve, transfer and link |
| **M2** | HTTP via `apiCall` / `apiCallOrThrow` / `readApiResultOrThrow`; never raw `fetch`. Read JSON with `readJsonSafe` | UI/UX | State it, so the three-pane composite does not hand-roll fetches |
| **M3** | New events declared with `createModuleEvents()` and `as const` | API Contracts — events listed as bare strings | State the declaration mechanism in `events.ts` |
| **M4** | API route files export **per-method** `metadata` (`requireAuth` / `requireFeatures`); a top-level `export const requireAuth` is a violation | API Contracts | State per-method metadata explicitly |
| **M5** | Subscribers must be idempotent | Architecture — only the *projection* is asserted idempotent | The **inbound subscriber** is the higher risk: a redelivered `ExternalMessage` must not open a second Case. Assert it, and add a test (see G3) |
| **M6** | Cache resolved via DI with `tenant:` / `org:` tags and a declared invalidation path | Not mentioned | Declare the caching decision even if Phase 1's answer is "no caching yet" — an unstated decision invites `new Redis(...)` |

### Minor

| # | Rule | Location | Fix |
|---|---|---|---|
| m1 | No arbitrary Tailwind values (`w-[336px]`, `text-[13px]`) | UI/UX specifies 336px / 660px / 344px pane widths | Those are layout dimensions from the prototype; note they must be expressed via the DS spacing scale or a documented layout token, not `w-[336px]` |
| m2 | Icons are lucide-react in the page body, never inline `<svg>`; `aria-label` on icon-only buttons | Not stated | Add a line; the prototype embeds inline SVGs and a literal port would violate the rule |
| m3 | `LoadingMessage` / `ErrorMessage` / `EmptyState` primitives | Empty states specced; loading and error states are not | Add loading and error states for each pane |

**Compliant already:** `makeCrudRoute` for CRUD ✓ · `DataTable` for lists ✓ ·
`defaultRoleFeatures` in `setup.ts` + `sync-role-acls` ✓ · `findWithDecryption` ✓ · tenant
scoping on every table and route ✓ · `Cmd/Ctrl+Enter` / `Escape` ✓ · i18n keys, no hardcoded
strings ✓ · no cross-module ORM relations ✓ · `pageSize ≤ 100` ✓ · optimistic locking with
`surfaceRecordConflict` ✓ · migrations reviewed with the snapshot ✓.

---

## Risk Assessment

### High

| Risk | Impact | Mitigation |
|---|---|---|
| **G1 — N+1 on the Inbox list** | Each conversation row needs customer, order context and identity. At 300 open Cases the list becomes 900+ queries | Batch-resolve per page through the query engine; assert a query-count ceiling in T-perf. **Not in the spec's risk table** |
| **G2 — `conversation_count` denormalization drifts** | It is the FCR input. A failed attach or a merge leaves it wrong, and FCR is a headline KPI from Phase 2 | Maintain in the same transaction as the attach/detach; add a reconciliation check to the baseline metrics job |
| R1 (spec) Auto-responder loop | Correctly identified as critical | Adequate — header checks + rate cap, gating the phase's own criterion |
| R2 (spec) Wrong identity link | Correctly identified | Adequate — sub-threshold links nothing, plus T15 |

### Medium

| Risk | Impact | Mitigation |
|---|---|---|
| **G3 — Redelivered inbound opens a duplicate Case** | Providers redeliver on timeout; a non-idempotent subscriber violates Phase 1's own "exactly one Case" criterion | Key idempotency on `external_message_id`; add a test asserting redelivery is a no-op (M5) |
| **G4 — Search index backfill** | Cases created before `search.ts` lands are invisible to global search | Ship `search.ts` in slice 1a, before ingest |
| **G5 — Demo seed cross-tenant leakage** | SD-1…3 create users, queues and Cases; an unscoped seed is a tenant-isolation defect in the shipped artefact | Seed through the same scoped commands as production writes; T14 must run against seeded data too |
| R4 (spec) Upstream projection rejected | Correctly identified with a fallback | Adequate |
| R10 (spec) Encrypted lookup | **Now resolved by C2** — `hashField` is the platform mechanism | Close P1-1 |

### Low

| Risk | Impact | Mitigation |
|---|---|---|
| R5 (spec) Host-spot conflicts | Additive; coordinate timing | Adequate |
| R9 (spec) `case_number` contention | Reuses a solved pattern | Adequate |
| **G6 — `merged_into_case_id` / `split_from_case_id` ship unused** | Dead columns until Phase 3 | Deliberate and justified in the spec (avoids a later migration on a hot table); no action |

---

## Gap Analysis

| # | Missing | Needed for |
|---|---|---|
| 1 | `data/validators.ts` with zod schemas | Every route (C3) |
| 2 | `encryption.ts` with `defaultEncryptionMaps` + `hashField` | PII at rest, and the identity unique index (C2) |
| 3 | Mutation-guard wiring for 6 action routes | Guard enforcement (C1) |
| 4 | `search.ts` + `indexer: { entityType }` | Global search over Cases, which §3.5 specs |
| 5 | Cache strategy and invalidation tags | M6 |
| 6 | Command/undo declaration for resolve and transfer | Command-pattern rule |
| 7 | Error-handling contract per route | 422 vs 409 vs 403 shapes are implied but not tabulated |
| 8 | Loading and error states per Inbox pane | m3 |
| 9 | Query-count ceiling test | G1 |
| 10 | Redelivery idempotency test | G3 |
| 11 | Final Compliance Report section | Completeness |

**Not gaps** (verified present and adequate): entity definitions with types, nullability and
indexes; API endpoint list with features; 19 API + 8 UI test scenarios including both isolation
tests; ACL IDs; i18n planning; event list; phasing with per-slice mergeability; upstream PR
ordering.

---

## Recommendation

**Apply before implementation:**

1. **C1** mutation-guard wiring on all six action routes — the one rule root `AGENTS.md` marks "never bypass"
2. **C2** `encryption.ts` with `hashField` — also closes P1-1
3. **C3** zod validators
4. **C4** module paths
5. **M1–M6** canonical UI/HTTP/event/subscriber mechanisms
6. **G1–G5** the five risks the spec's own table missed
7. Add the Final Compliance Report section

Then implement. Slice 1a should also pull `search.ts` forward (G4).

**Do not change:** the BC analysis, the upstream PR ordering, the test matrix, or the
deliberately-unused merge/split columns. Those are all correct as written.
