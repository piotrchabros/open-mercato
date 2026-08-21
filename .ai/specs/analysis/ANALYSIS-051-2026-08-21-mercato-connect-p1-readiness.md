# Pre-Implementation Analysis: Mercato Connect — P1 Slice

**Spec**: [`.ai/specs/2026-08-21-mercato-connect-omnichannel.md`](../2026-08-21-mercato-connect-omnichannel.md)
**Artifacts audited**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/*`, `quickstart.md`, `tasks.md` (T001–T079)
**Date**: 2026-08-21 | **Scope**: P1 slice only (US1 + US2, module `conversations`)

> **Task IDs in the body of this report refer to the pre-resolution 79-task numbering.** Closing C1 inserted Phase 2A and renumbered `tasks.md` to 86 tasks. The *Resolution* section at the end uses current IDs.

## Executive Summary

The P1 slice is **close to ready but not yet implementable as written**. Backward compatibility is clean — every new surface is genuinely free, verified by grep against the real tree, and the single existing-surface change is additive. The blocker is architectural: three tasks read another module's tables directly, which `.ai/lessons.md` records as coupling to retire, and the peer module involved (`messages`) exposes no DI surface at all. Two further gaps — no cache invalidation strategy and no undo payloads on write commands — are AGENTS.md requirements the artifact set never addresses.

**Status: C1, C2 and C3 closed 2026-08-21** — see *Resolution* at the end of this report. Original recommendation follows.

**Recommendation: Needs spec updates first.** Resolve C1–C3 (roughly 4 added tasks and one additive change to `messages`), then implement.

### Audit limitation

The skill requires reading `.agents/skills/om-code-review/references/review-checklist.md`. That file **does not exist in this worktree** — `.agents/skills/` is empty because `yarn install-skills` has never been run here. The code-review checklist dimension of this audit is therefore **not covered**. Everything else was verified against source.

## Backward Compatibility

### Violations Found

| # | Surface | Issue | Severity | Proposed Fix |
|---|---------|-------|----------|-------------|
| 1 | #2 Type definitions | `ChannelCapabilities` gains `voice?: boolean` (research R-09) | **Not a violation** | Optional field addition = ADDITIVE-ONLY. `realtimePush?: boolean` (`lib/adapter.ts:50`) is the in-file precedent with identical omit-means-default semantics. No deprecation protocol needed. |

**No BC violations found across all 13 surfaces.** Verification performed against the real tree, not spec text:

| # | Surface | Check | Result |
|---|---------|-------|--------|
| 1 | Auto-discovery conventions | module id `conversations` across 59 `index.ts` | **FREE** |
| 2 | Types/interfaces | only `ChannelCapabilities.voice?` | additive, allowed |
| 3 | Function signatures | no existing signature changed | clean |
| 4 | Import paths | nothing moved | clean |
| 5 | Event IDs | prefix `conversations.` across 34 `events.ts` | **FREE** |
| 6 | Widget spot IDs | 5 new spots, all namespaced `conversations.*` | **FREE** |
| 7 | API route URLs | `/api/conversations/*` | **FREE** — see false positive below |
| 8 | Database schema | tables `conversations_*` | **FREE** |
| 9 | DI service names | `conversation*` registration keys | **FREE** |
| 10 | ACL feature IDs | prefix `conversations.` across 49 `acl.ts` | **FREE** |
| 11 | Notification type IDs | none declared in P1 | n/a |
| 12 | CLI commands | none added | n/a |
| 13 | Generated file contracts | additive registry entries only | clean |

**BC#7 false positive, resolved.** `packages/ai-assistant/src/modules/ai_assistant/api/ai/conversations/` initially looked like a collision. It is not: URL derivation includes the module id, confirmed empirically from call sites (`/api/ai_assistant/ai/conversations`). So `<M>/api/conversations/route.ts` resolves to `/api/conversations/conversations`, exactly as `contracts/rest-api.md` specifies.

**Documentation defect found while resolving it** (worth fixing separately): `packages/core/AGENTS.md` line 76 states `api/<method>/<path>.ts → /api/<path>`, omitting the module-id prefix that the runtime actually applies. Read literally, that line would lead an implementer to the wrong URLs.

### Missing BC Section

The canonical spec has an **"Impact on existing modules"** subsection covering exactly the right ground, but it is not titled *"Migration & Backward Compatibility"* as the deprecation protocol expects. **Low** — rename for discoverability.

## Spec Completeness

### Missing Sections

| Section | Impact | Recommendation |
|---------|--------|---------------|
| Migration & Backward Compatibility | Protocol expects this exact heading; graders and future agents look for it | Rename the existing "Impact on existing modules" subsection |
| UI/UX | Prototype exists and `contracts/ui-extension.md` maps every component, but the spec itself has no UI section | Cross-reference `contracts/ui-extension.md` from the canonical spec |
| Integration Test Coverage | Root `AGENTS.md` requires the spec to **list** integration coverage for all affected API and UI paths; it lives in `quickstart.md` V1–V14 and `tasks.md` T050–T054/T068–T070, unreferenced from the spec | Add a short section cross-referencing both |
| Phasing / Implementation Plan | Present in `plan.md` and `tasks.md`, absent from the spec file | Cross-reference; do not duplicate |

### Incomplete Sections

| Section | Gap | Recommendation |
|---------|-----|---------------|
| Data Models | No cache invalidation strategy for any entity | See C2 |
| Data Models | `ConversationChannelBinding.detached_at` is null-while-active — a natural temptation for a partial unique index. Lesson *"PostgreSQL partial unique indexes are not constraints"* applies | State explicitly that uniqueness here is enforced in the command layer, not by a partial index |
| API Contracts | Per-method route `metadata` (`requireAuth` / `requireFeatures`) never mentioned | See C4 |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|------|----------|-----|
| **Peer-module table access must sit behind a DI service owned by the source module** (lesson: *Cross-module query precedent is not permission to copy storage coupling*) | tasks T019, T036; research R-01 | See **C1** — the blocker |
| **Cache resolved via DI, tags include `tenant:<id>`/`org:<id>`, invalidation declared per write path** (`packages/cache/AGENTS.md`) | Absent from all artifacts | See **C2** |
| **Write operations implemented as undoable commands; `extractUndoPayload()` referenced** | tasks T023–T027, T058 use `runCrudCommandWrite` but never mention undo payloads | See **C3** |
| **API route files export per-method `metadata`** (`requireAuth`/`requireFeatures`) | `contracts/rest-api.md` specifies guards only at the mutation-guard layer | See **C4** |

Compliant and verified: module placement (new workspace package, `packages/enterprise` precedent), auto-discovery layout, `setup.ts` + `defaultRoleFeatures` sync (T013/T017), zod validators (T010), `findWithDecryption` + `encryption.ts` maps (T011), tenant scoping (T052), `makeCrudRoute` + `indexer.entityType` (T028), mutation guards (T029–T034), `CrudForm`/`DataTable`, `apiCall` only (T047), keyboard shortcuts (T065), i18n (T008/T049/T067/T075), DS tokens (T044/T076), events via `createModuleEvents` with `as const` (T007), idempotent persistent subscribers (T036), feature-based guards not `requireRoles` (matches lesson *"Never guard sensitive routes with `requireRoles`"*).

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Storage coupling to `messages` and `communication_channels`** | The whole "compose on top" thesis rests on reading peer tables. If `messages` changes its schema, `conversations` breaks silently — precisely the failure the currencies/dashboard lesson records | C1: source-owned DI read services |
| **`messages` has no `di.ts` at all** | There is no sanctioned surface to read thread messages through. Implementer will either import the `Message` entity across the boundary or write raw SQL — both violations | C1: add `messages/di.ts` with a narrow thread-read service (additive, new DI key) |
| **Thread assembly N+1** | A thread spanning several channels fans out across `ChannelThreadMapping` → `ExternalConversation` → `Message`. Naive implementation issues a query per binding, and SC-003 sets a 2-second budget | Batch reads in the DI service; T073 asserts the budget |

### Medium Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| No cache invalidation strategy | Inbox list is the hottest read in the product; wrong invalidation shows agents stale conversations | C2 |
| Encrypted `CustomerIdentity.identifier` vs search | `search.ts` (T038) indexes customer name; if identifiers reach the index they are indexed post-decryption. Lesson *"Keep fallible document preparation outside encryption guards"* applies | Exclude `identifier` from the search doc; assert in T052 |
| Undo coverage absent | `runCrudCommandWrite` without undo payloads means close/assign/reply cannot be undone; identity reversal (T027) is bespoke rather than the platform's undo path | C3 |
| Renumbering fragility | `tasks.md` was corrupted once during this session by a cascading ID rewrite | Never renumber by regex; regenerate the file |

### Low Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `AGENTS.md:76` URL doc defect | Implementer derives wrong route URLs | Fix the line; C5 |
| Partial unique index temptation on `detached_at` | Silent duplicate active bindings | State command-layer enforcement |
| `.agents/skills/` not installed | Repo automation skills unavailable in this worktree; review-checklist dimension unaudited | Run `corepack yarn install-skills` |

## Gap Analysis

### Critical Gaps (Block Implementation)

- **C1 — No sanctioned read path to peer tables.** T019 (thread aggregation) and T036 (inbound binding) read `messages.Message`, `communication_channels.ExternalConversation` and `ChannelThreadMapping` directly. **Correction (2026-08-21, on closing C1):** an earlier draft of this report called resolving `communication_channels`' registered entity classes "defensible". It is not. Those registrations carry the comment *"Entity class registrations (for EntityManager lookups by string)"* — they are an EM convenience, not a read API, and querying through them is the same storage coupling by another route. The sanctioned precedent in that same file is `communicationChannelsSendAsUser`, an in-process facade. **Both** peers therefore need a read facade, not just `messages`. **`messages` registers nothing** — it has no `di.ts`. Needed: a new `packages/core/src/modules/messages/di.ts` exposing a narrow, batched, scope-aware thread-read service (e.g. `messageThreadReader.getThreadMessages({ threadId, tenantId, organizationId })`), consumed fail-soft via `tryResolve`. This is an additive new DI key (BC surface #9), so it needs no deprecation bridge. **~2 tasks in `messages` + 1 rewrite of T019.**

- **C2 — No cache strategy.** `packages/cache/AGENTS.md` requires DI-resolved cache, `tenant:<id>`/`org:<id>` tags, and invalidation declared per write path. No artifact mentions any of it, yet the inbox list is the highest-frequency read in the feature. Needed: cache tags on the conversations list read and invalidation on every command in T023–T027. **~1 task.**

- **C3 — No undo payloads.** Every write goes through `runCrudCommandWrite`, but no task mentions `extractUndoPayload()` or `emitCrudUndoSideEffects`. Close, assign and reply are all user-reversible operations in principle. Needed: undo payloads on T023–T027, with `indexer: { entityType, cacheAliases }` in both the side-effect and undo-side-effect calls. **~1 task, or fold into T023–T027.**

### Important Gaps (Should Address)

- **C4 — Route metadata.** `contracts/rest-api.md` never specifies per-method `metadata` exports carrying `requireAuth`/`requireFeatures`. Mutation guards cover writes but not read authorisation. Add to the contract and to T028–T035.
- **C5 — `AGENTS.md:76` URL derivation.** Correct the line to include the module-id prefix.
- **C6 — Search doc must exclude encrypted identifiers.** Constrain T038 explicitly.
- **C7 — Integration-coverage section** missing from the canonical spec (root `AGENTS.md` requires the spec to list it).

### Nice-to-Have Gaps

- Rename "Impact on existing modules" → "Migration & Backward Compatibility".
- Cross-reference `contracts/ui-extension.md` as the spec's UI/UX section.
- State command-layer uniqueness for `ConversationChannelBinding`.
- Run `corepack yarn install-skills` so repo automation is available in this worktree.

## Remediation Plan

### Before Implementation (Must Do)

1. **C1** — Add `messages/di.ts` with a batched, scope-aware thread-read service; register a matching read helper for `communication_channels` (or consume its already-registered entity DI keys). Rewrite T019 and T036 to consume them via `tryResolve`.
2. **C2** — Add a cache task: DI-resolved cache, `tenant:`/`org:` tags on the inbox list, invalidation per write path in T023–T027.
3. **C3** — Add undo payloads to T023–T027 with `indexer: { entityType, cacheAliases }` on both side-effect and undo-side-effect paths.

### During Implementation (Add to Spec)

1. **C4** — Per-method route `metadata` in `contracts/rest-api.md` and T028–T035.
2. **C6** — Constrain T038 to exclude `CustomerIdentity.identifier` from the search document.
3. **C7** — Add the integration-coverage cross-reference section to the canonical spec.
4. Rename the BC subsection; cross-reference the UI contract.

### Post-Implementation (Follow Up)

1. **C5** — Fix `packages/core/AGENTS.md:76`; run `corepack yarn agents:check-budget`.
2. Re-run this audit against P2 before generating its tasks — the peer-read service from C1 will have proven itself or not by then.
3. Capture a new lesson if the thread-aggregation read service turns out to be reusable by other consumers.

## Recommendation

**Needs spec updates first.** No backward-compatibility violations and no security or tenancy defects — the design is sound and the F1 fix from `/speckit-analyze` (merge reversal pulled into P1) closed the one correctness hole. But C1 is a real architectural blocker: the feature's central mechanism currently has no sanctioned implementation path, and the lesson record says explicitly that copying the existing raw-query precedent is not permitted.

The three critical gaps are roughly **4–5 added tasks plus one additive change to `messages`**. None requires redesign. Once they are in, the P1 slice is ready to implement.


---

## Resolution — 2026-08-21

All three critical gaps closed in the artifact set. No code was written; these are spec/task changes.

| Gap | Closed by | Where |
|---|---|---|
| **C1** peer-table coupling | New **Phase 2A** (T019–T022): `communicationChannelsThreadReader` + a brand-new `messages/di.ts` exposing `messagesThreadReader`, both source-owned, batched and scope-mandatory. T024/T041 rewritten to consume them via `tryResolve`. Consumer-side violations enumerated explicitly. | `tasks.md` Phase 2A; new [`contracts/peer-read-facades.md`](../2026-08-21-mercato-connect-omnichannel/contracts/peer-read-facades.md); `research.md` R-01 access path; `data-model.md` cross-module map |
| **C2** no cache strategy | T015 defines DI-resolved cache with `tenant:`/`org:` + resource tags and a per-write-path invalidation map; T033 caches the list read and invalidates after commit (never inside `withAtomicFlush`); T060 tests it | `tasks.md` |
| **C3** no undo payloads | T028–T032 carry typed undo payloads with `cacheAliases` on both `emitCrudSideEffects` and `emitCrudUndoSideEffects`; T061 round-trips them through `extractUndoPayload`. T031 (reply) carries a **documented no-undo exemption** — a delivered outbound message cannot be recalled, and that should be explicit rather than inferred | `tasks.md` |

Task count 79 → 86. Four of the 86 land in `packages/core` (Phase 2A) as additive facades on platform modules; the rest are inside `packages/contact-center/`.

**Still open from this report** (non-blocking, tracked): C4 route metadata, C5 `AGENTS.md:76` URL doc defect, C6 search-index identifier exclusion, C7 spec integration-coverage cross-reference, and the nice-to-haves. The code-review-checklist dimension remains unaudited until `corepack yarn install-skills` is run in this worktree.
