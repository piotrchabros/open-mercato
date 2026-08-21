# REVIEW — Implementer lens, round 2

**Role:** Implementer reviewer (adversarial spec review, round 2 of 4).
**Target:** [`.ai/specs/2026-08-22-connect-phase-1-v2.md`](../../specs/2026-08-22-connect-phase-1-v2.md)
**Round-1 file:** [`REVIEW-implementer.md`](REVIEW-implementer.md) (6C/15M/5m against the now-frozen
`2026-08-21-connect-phase-1-merged.md`).
**Lens (unchanged):** the task graph as an executable plan — can someone open § Tasks, work top to
bottom, and end with a building, passing, requirement-complete Phase 1?
**Checkout:** worktree `cez/486d110a` at `4e0cdfb69`. `packages/connect` and `packages/channel-webform`
still do not exist; every platform citation below was re-opened in this checkout.
**Independence:** written without reading `REVIEW-ddd.md`, `REVIEW-architect.md`, `REVIEW-pm-ux.md`
or any `*-r2.md`.

**Verdict.** v2 is a large, real improvement: the test tasks exist, the API table now resolves
end-to-end, module registration is tasked, and T-DATA-05 is finally coherent. But **slice 1a still
cannot be executed as written** (it installs a workspace dependency on a package that slice 1b
creates), and **the send path has no worker** — the single most load-bearing verb in the phase
("the agent replies") has no task that talks to a provider.

---

## 1. Regression table — round-1 findings vs v2

| # | Round-1 finding | Verdict | Reason (v2 text) |
|---|---|---|---|
| **C1** | No task writes any test | **RESOLVED** | § Tasks slice 1e adds `T-TEST-01…16 <M>/__integration__/*.spec.ts` and `T-UITEST-01…08 <M>/__integration__/ui/*.spec.ts`; § Integration test coverage now says "Every scenario is a task in slice 1e with a file path" |
| **C2** | FR-020's write path was a test | **RESOLVED** | FR-020 → T-API-01, T-API-11; T-API-11 is `<M>/lib/scope.ts`, a real file that performs the scoping |
| **C3** | 5 of 11 routes had no task | **RESOLVED** | § API contracts gained a Task column; all 12 rows resolve, and T-API-03/10/12/13/14/15 all exist in § Tasks |
| **C4** | `connect_tenant_settings` untasked | **PARTIAL** | The table is now in T-DATA-02, but **no task seeds its per-tenant defaults** and no scoped reader exists — see M-C |
| **C5** | No task registers the packages | **PARTIAL** | T-SET-03 exists and is first in 1a, but it names **root `package.json`** (a workspaces glob, not a dependency list), omits `package.json.template`, and registers `channel_webform` a whole slice before its package is created — see C-C, M-A |
| **C6** | T-DATA-05 reds `yarn test` | **RESOLVED** | See the dedicated verification below |
| **M1** | No `case_number` allocator | **RESOLVED** | T-SEQ-01 `<M>/lib/case-number.ts`; FR-002 → T-DATA-01, T-SEQ-01 |
| **M2** | No per-transition audit | **RESOLVED** | `connect_case_transitions` in § Data model, T-DATA-06 creates it, FR-003 requires the row, § Consistency puts it inside each write's transaction |
| **M3** | FR-014's "manual-match task" had no writer | **RESOLVED** | `connect_manual_match_tasks` (T-DATA-07) + T-API-10 + T-UI-10 + FR-026 |
| **M4** | FR-021 mapped to one route | **RESOLVED** | FR-021 → T-API-11, "the shared 404-not-403 scope resolver every route uses" |
| **M5** | T-SET-01 omits build/test files | **PARTIAL** | Adds `build.mjs`, `jest.config.cjs`; still omits `watch.mjs`, `jest.setup.ts`, `tsconfig.build.json`, `src/index.ts`, and invents `.eslintrc.cjs` — see M-B |
| **M6** | Template mirror untasked | **PARTIAL** | T-SET-03 mirrors `template/src/modules.ts` but not `template/package.json.template` (`scripts/template-sync.ts:29-30`) |
| **M7** | Wrong locale set, wrong slice | **RESOLVED** | T-I18N-01 `<M>/i18n/{en,pl,es,de,ko}.json`, explicitly "**slice 1a, not 1d**"; FR-023 cites `scripts/i18n-check-sync.ts:25` correctly |
| **M8** | Range-declared tasks, no paths | **PARTIAL** | T-UI-01…03 and the former T-UI-06…09 now carry paths; **T-UP-01…03 is still one bare bullet for three ids**, and T-TEST-01…16 / T-UITEST-01…08 are ranges over a glob |
| **M9** | T-SRCH-01 omits `aclFeatures` / scan roots | **RESOLVED** | T-SRCH-01 now says "declare `aclFeatures`" and "Widen `global-search-acl.test.ts` scan roots to `packages/connect`" (roots verified at `packages/search/src/modules/search/__tests__/global-search-acl.test.ts:73-78`) |
| **M10** | `connect.case.assigned` has no writer | **PARTIAL → new Critical** | § Frozen surfaces now claims T-API-03 + "assignment on the CRUD route", but FR-024/T-API-01 **exclude `assignee_user_id` from the updatable set**. The two statements contradict — see C-B |
| **M11** | No scheduler registration | **RESOLVED** | T-WRK-03 `<M>/setup.ts` — "register T-WRK-01/02/T-MET-01 with the scheduler; without this none of them ever run" (pattern verified `communication_channels/setup.ts:103,111,134`) |
| **M12** | `channel-webform` has no FR, risk or test | **UNRESOLVED** | v2 added FR-024…FR-027 — none is about web forms. No risk row, no `T-TEST-*`, no scaffold. § TLDR still promises "and web-form submission becomes a Case" |
| **M13** | 8 FRs + R1 untested | **PARTIAL** | T-TEST-14/15/16 close R1, FR-003, FR-006, FR-024. FR-002, FR-005, FR-015, FR-019, FR-025, FR-026, R6, R10 still have none — see M-F |
| **M14** | T-TEST-06 tested the wrong thing | **RESOLVED** | T-TEST-06 rewritten: "An agent-scoped list never returns another customer's Case; an unresolved identity never attaches" → FR-022, **R2** |
| **M15** | FR-018 drain trigger orphaned | **PARTIAL** | § Consistency's link/unlink row names "projection drain" inside the boundary, but **T-API-08 still does not mention it** and T-API-10 (FR-026, "resolving it … drains any staged projection") is a second uncoordinated call site |
| **m1** | R9 cites a DoD that doesn't exist | **RESOLVED** | § Definition of done added; `.ai/scripts/spec-gate-check.mjs` verified present |
| **m2** | Missing checklist sections | **UNRESOLVED** | `.ai/specs/AGENTS.md` § Spec Content Checklist wants Overview, Problem Statement, Proposed Solution, **Final Compliance Report**. "Why this document exists" + TLDR substitute for two; there is still no Final Compliance Report |
| **m3** | FR-017 straddles 1c/1d | **UNRESOLVED** | T-API-04 is 1c, T-PROJ-01 is 1d; no note that 1c ships a resolve that does not project |
| **m4** | T-API-02 is a policy, not a file | **UNRESOLVED** | Still "T-API-02 Optimistic locking on every mutating route" with no path, while FR-007 arrows at it |
| **m5** | No `api/openapi.ts` task | **RESOLVED** | T-OAS-01 `<M>/api/openapi.ts`, slice 1a |

**Regression tally: 14 RESOLVED · 8 PARTIAL · 4 UNRESOLVED** (of 26).

### C6 verification — is "widen the resolver first" coherent?

Yes. Opened `packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts`:

- `readEntitySource` (`:70-75`) joins `__dirname/'..'/'modules'/<moduleId>/'data'/'entities.ts'` —
  core-only, exactly as v2's Core-edit ledger says (it cites `:72`, the `join` line — correct).
- It is called at `:88`, inside the `describe` callback but **outside** any `it()`, so a throw is a
  collection-time throw that reds the whole file. v2's T-DATA-05 states this verbatim and orders
  "widen first, then add". **The instruction is executable.**
- The widening is small and obvious (a `moduleId → package modules root` map defaulting to
  `packages/core/src/modules`), and `entityHasDeletedAt` (`:165-168`) reuses the same helper, so it
  is fixed by the same edit.

One residual the task does not mention: the *second* guard resolves route files with an independent
core-only join at `:204` (`join(__dirname, '..', 'modules', route)`). It is only reached when the
entity has no `deleted_at` (`:196` early-returns otherwise). Every `connect` table carries
`deleted_at` (§ Data model), so `:204` is never reached — the task works, but by a coincidence it
never states. See m-f.

### C5 verification — can slice 1a register the module?

Partly. T-SET-03 is correctly placed (before T-SET-02's `yarn generate`) and correctly identifies
`apps/mercato/src/modules.ts` `enabledModules` (AST-parsed at
`packages/cli/src/lib/agentic-setup.ts:96-101`; consumed by `packages/cli/src/lib/resolver.ts`
`pkgDirFor:52-71`, which maps `from: '@open-mercato/connect'` → `packages/connect/src/modules`).
But the dependency edit it names is the wrong file (M-A), and its "both packages" clause makes
slice 1a depend on a slice-1b artifact (C-C). Slice 1a therefore still does not complete.

---

## 2. Sweep 1 — Write-path (FR-001…FR-027)

v2 says "each names the task that performs its write." Verified row by row; **every FR names at
least one task that exists and can plausibly write**, which is a genuine improvement over the frozen
spec. Four rows are still partial:

| FR | Task(s) | Writes? | Note |
|---|---|---|---|
| FR-001 · 002 · 003 · 004 · 006 · 008 · 012 · 013 · 014 · 015 · 016 · 017 · 019 · 020 · 021 · 022 · 023 · 024 · 026 · 027 | as arrowed | ✅ | all resolve to a file-bearing task |
| FR-005 | T-API-05, T-WRK-01 | ⚠️ | reads `auto_close_after_days` from a table nobody seeds — M-C |
| FR-009 | T-UI-04, T-API-07 | ⚠️ | "reply on any connected channel" terminates at an enqueue; **no worker consumes it** — C-A |
| FR-010 | T-API-07 | ⚠️ | 202 + `queued` is writable; the queue has no consumer — C-A |
| FR-011 | T-WRK-02 | ⚠️ | reconciles a status that nothing ever advances past `queued` — C-A |
| FR-025 | T-ING-05 | ⚠️ | slice 1b; the send path it needs lands in 1c — M-E |
| FR-002 | T-DATA-01, T-SEQ-01 | ⚠️ | `case_number_prefix` comes from `connect_tenant_settings`, unseeded — M-C |
| FR-018 | T-PROJ-02 | ⚠️ | drain has two call sites (T-API-08, T-API-10); neither task mentions it — M15 |

Also: **`assignee_user_id` has no writer at all** (C-B). FR-002 requires the Case to carry an owner
and § Status machine's `new → in_progress` trigger is "assign"; no task assigns.

**Result: FAIL (marginal) — 20 clean, 7 partial, 1 field with no writer.**

## 3. Sweep 2 — Reverse (every T-* → an FR or risk)

Every task in v2 maps to something. Orphans, in the sense of *no requirement defines their done*:

| Task | Serves | Orphan? |
|---|---|---|
| T-SET-01/02/03, T-DATA-04/05, T-OAS-01, T-VAL-01, T-EVT-01 | infrastructure | legitimate |
| T-CH-01 `channel-webform` | § Scope "In", § TLDR | **orphan — no FR, no risk, no test** (M12 unresolved) |
| T-API-12 `GET /cases/{id}/conversations` | § API table only | **orphan — no FR arrows at it, no test** |
| T-API-13 `GET /contact-identities` | § API table only | **orphan — same** |
| T-SRCH-01 | T-TEST-05's "and search" clause | weak, acceptable |
| T-CMD-01 | § Commands and undo → T-TEST-13 | acceptable |
| T-WID-01 | § UI Customer 360 → U5 | acceptable |
| T-UI-11 `useInboxRefresh` | § Inbox freshness | acceptable (new, and correctly motivated) |
| T-UP-01…05 | Blocking upstream PRs A/B/C | acceptable |
| all others | an FR each | ✅ |

**Result: PASS with notes** — three orphans (T-CH-01, T-API-12, T-API-13).

## 4. Sweep 3 — Cross-reference

Every task id referenced in § Success criteria, § Requirements arrows, § API contracts (Task
column), § Frozen surfaces, § Risks, § Consistency and § Integration test coverage was checked
against § Tasks.

- **§ Requirements** — 30 distinct arrow targets across FR-001…FR-027. **All resolve.**
- **§ API contracts Task column** — 12 rows naming T-API-01/03/04/05/06/07/08/10/12/13/14/15.
  **All 12 resolve**, and T-API-02/09/11 also exist. **No numbering gap** (the frozen spec's
  `T-API-03` hole is filled by the transfer route). ✅
- **§ Risks** — T-ING-02, T-TEST-05/06/07/08/09/14. All inside the declared `T-TEST-01…16`. ✅
- **§ Success criteria** — T-TEST-05, T-TEST-06. ✅
- **§ Consistency** — T-PROJ-01, T-MET-01, T-ING-01. ✅
- **§ Frozen surfaces** — T-API-03. ✅ (but the accompanying "and by assignment on the CRUD route"
  contradicts T-API-01 — C-B).
- **§ Definition of done** — `.ai/scripts/spec-gate-check.mjs`: **exists**, verified.
- **§ Data model → § Tasks:** every table named in § Data model has a creating task **except** the
  reverse direction — T-DATA-02 creates `connect_case_reopen`, which § Data model **no longer
  defines** (v2 replaced it with `connect_case_transitions`). See M-G.

**Result: PASS with one defect** — zero dangling task refs (the round-1 failure mode is gone); one
dangling *table* ref in the opposite direction.

## 5. Sweep 4 — Slice buildability (can 1a build, generate, migrate, `yarn test`?)

Walked T-SET-01/02/03, T-DATA-01…08, T-SEQ-01, T-ACL-01, T-DOM-01, T-EVT-01, T-API-01/02/11,
T-OAS-01, T-SRCH-01, T-VAL-01, T-I18N-01 against `packages/content/` (the named mirror) and the CLI
discovery path.

**Still NO**, on two independent blockers, both new-in-v2 rather than carried:

1. **T-SET-03 installs a dependency on a package that does not exist yet.** It says "Register **both
   packages**" in slice **1a**; `packages/channel-webform` is created by T-CH-01 in slice **1b**. A
   `"@open-mercato/channel-webform": "workspace:*"` entry pointing at a non-existent workspace fails
   `yarn install` outright, and an `enabledModules` entry for `channel_webform` resolves (via
   `pkgDirFor`) to a directory that isn't there. → **C-C**
2. **The dependency edit names the wrong file.** Root `package.json:9-13` is
   `"workspaces": ["apps/*", "packages/*", "external/official-modules/packages/*"]` — a glob, with
   no dependency list. The edit that makes `@open-mercato/connect` importable from the Next app is
   in `apps/mercato/package.json` `dependencies`, where every peer package is listed explicitly
   (`"@open-mercato/content": "workspace:*"`, `"@open-mercato/channel-gmail": "workspace:*"`, …).
   → **M-A**

Scaffold completeness (T-SET-01), checked file-by-file against `packages/content/`:

| File | In T-SET-01? | Consequence if missing |
|---|---|---|
| `package.json`, `tsconfig.json`, `build.mjs`, `jest.config.cjs` | ✅ | — |
| `watch.mjs` | ❌ | `packages/content/package.json` wires `"watch": "node watch.mjs"` and `turbo.json` fans a `watch` task across `packages/*` → `yarn watch:packages` fails |
| `jest.setup.ts` | ❌ | `packages/content/jest.config.cjs` sets `setupFilesAfterEach: ['<rootDir>/jest.setup.ts']` → jest fails to boot |
| `tsconfig.build.json` | ❌ | present in every package alongside `build.mjs` |
| `src/index.ts` | ❌ | `package.json` `"main": "./dist/index.js"` has nothing to build |
| `.eslintrc.cjs` | **invented** | **no package in the repo has one** — `ls packages/*/.eslintrc.cjs` returns nothing; the task claims to mirror `packages/content/`, which does not contain it |

Clean: T-DATA-04 migration flow ✅, T-DATA-05 ✅ (see C6 above), T-I18N-01 slice/locale set ✅,
T-ACL-01's `sync-role-acls` ✅, `<M>/index.ts` ✅.

**Result: FAIL.**

## 6. Sweep 5 — Test coverage (FR-001…FR-027, R1…R10)

| Status | FRs |
|---|---|
| **Covered** | FR-001 (T-TEST-01/02) · FR-003 (15) · FR-006 (16) · FR-010+011 (04) · FR-012 (03) · FR-016 (11) · FR-017+018+027 (12) · FR-020+021 (05) · FR-022 (06) · FR-023 (U8) · FR-024 (15) |
| **UI-only / partial** | FR-004 (U2 only — no API assertion of the wrap-up gate) · FR-007 (U7 only — no 409-body assertion) · FR-008 (incidental in T-TEST-01) · FR-009 (U1) · FR-013 (T-TEST-11 covers hash lookup, nothing covers confidence or `match_method`) · FR-014 (T-TEST-06 covers "never attaches"; nothing asserts the `connect_manual_match_task` row) |
| **No test at all** | **FR-002** (case-number format/uniqueness) · **FR-005** (auto-close job) · **FR-015** (unlink audit history + task re-open) · **FR-019** (counting layer) · **FR-025** (exactly one auto-ack) · **FR-026** (manual-match screen) — plus web form, which has no FR *and* no test |

| Status | Risks |
|---|---|
| **Covered** | R1 (T-TEST-14 — the round-1 Critical gap, now closed and correctly scoped: "other senders on the same channel are unaffected") · R2 (T-TEST-06, rewritten) · R3 (07) · R5 (08) · R7 (09) · R8 (05) · R9 (U8) |
| **No test** | **R6** — T-TEST-09 asserts `conversation_count` *unchanged on redelivery*; nothing exercises the nightly reconciliation the mitigation rests on · **R10** (pepper rollout / dual hash format) · R4 is n/a (schedule risk) |

Structural improvement confirmed: `T-TEST-05` and `T-TEST-06` are now precise enough to write
(T-TEST-05 states the expected status — "each returns 404" — which round 1 flagged as absent).

**Result: PARTIAL FAIL** — 6 FRs and 2 risks with zero coverage; 6 FRs UI-only.

## 7. Sweep 6 — Unlisted prerequisites

| Prerequisite | Needed by | In the plan? |
|---|---|---|
| `apps/mercato/src/modules.ts` `enabledModules` entry | all of 1a | ✅ T-SET-03 |
| `apps/mercato/package.json` dependency | module resolution at runtime | ❌ **M-A** (T-SET-03 names root `package.json`) |
| `packages/create-app/template/src/modules.ts` | `template:sync` | ✅ T-SET-03 |
| `packages/create-app/template/package.json.template` | `template:sync` (`scripts/template-sync.ts:30`) | ❌ **M-A** |
| `packages/connect/{watch.mjs, jest.setup.ts, tsconfig.build.json}` + `src/index.ts` | `build:packages`, `test`, `watch` | ❌ **M-B** |
| `packages/channel-webform/` scaffold (same file set) | `yarn install`, `build:packages` | ❌ **C-C** |
| **Outbound send worker + queue name** | FR-009/010/011/025, § Consistency "Send" row | ❌ **C-A** |
| `connect_tenant_settings` defaults seed (`setup.ts` `onTenantCreated`/`seedDefaults`) | FR-001, FR-005, FR-006, T-SEQ-01's prefix | ❌ **M-C** |
| A scoped settings reader all three consumers share | T-ING-04, T-WRK-01, T-API-06 | ❌ **M-C** |
| Notification type ID + `<M>/notifications.ts` + renderer + i18n | T-API-03 "notifies the receiving agent" | ❌ **M-D** (BC surface 11, `BACKWARD_COMPATIBILITY.md:205`, is FROZEN and unlisted in § Migration) |
| Scheduler registration | T-WRK-01/02, T-MET-01 | ✅ T-WRK-03 |
| `<M>/api/openapi.ts` | § API contracts | ✅ T-OAS-01 |
| Generated registry refresh | discovery | ✅ T-SET-03 (`corepack yarn generate`) |
| DI registration for `connect` | Phase 1 only *consumes* `communicationChannelsThreadReader` | ✅ n/a |
| Delivery-status event | UI learns status via polling (T-UI-11) | ⚠️ decision unstated — **m-d** |
| `page.meta.ts` `requireFeatures` guards | T-UI-06/08/09/10/12 | ❌ **m-b** (§ API contracts states the per-method rule for routes only) |

**Result: FAIL — 8 unlisted prerequisites, 3 of them blocking.**

---

# Fresh findings

## Critical

### C-A — Nothing sends. FR-010's queue has no consumer task
**Ids:** FR-009, FR-010, FR-011, FR-025, T-API-07, § Consistency "Send" row
FR-010: *"The route MUST enqueue and return 202 … it MUST NOT block on the provider."*
§ Consistency: *"Send — route transaction writes `connect_message` in `queued` only | **Provider
call happens in the worker** (FR-010)."* § Tasks declares exactly three workers: **T-WRK-01**
(`workers/auto-close.ts`), **T-WRK-02** (`workers/reconcile-delivery.ts`), **T-MET-01**
(`workers/baseline-metrics.ts`). None of them calls a provider. T-API-07 says "enqueue, return 202"
without naming a queue, a payload shape or a consumer.

Consequence: every `connect_message` stays in `queued` forever. FR-009 ("the agent MUST be able to
reply") is unsatisfied, FR-011 reconciles a status that never advances, FR-025's auto-ack never
leaves, T-TEST-04 ("worker reports `sent` then `failed`") has no worker to drive, and § Status
machine's `in_progress → waiting_customer` trigger ("outbound `sent`") is unreachable. This is the
phase's headline verb with no implementation task — the same defect class v2 was written to repair
(the frozen spec's "requirement with no mechanism").
**Fix:** add **T-WRK-04** `<M>/workers/send-message.ts` — consumes `connect:send-message`, resolves
`communicationChannelsSendAsUser`, writes `connect_message.message_id`/`sent_at` or
`failure_reason`/`retry_count`, and hands off to the FR-011 reconcile path. Name the queue id in
T-API-07, add it to T-WRK-03's scheduler/worker registration, and state whether the
`connect.case.status_changed` emit happens in the worker or the reconciler.

### C-B — `assignee_user_id` has no writer, and § Frozen surfaces contradicts FR-024
**Ids:** FR-002, FR-024, T-API-01, § Status machine, § Frozen surfaces
FR-002 requires a Case to carry *"owner (or an explicit unassigned state)"*. § Status machine's
first row makes **`new → in_progress`** trigger on *"assign, or first agent action"*. § Frozen
surfaces states *"`connect.case.assigned` is emitted by T-API-03 (transfer) **and by assignment on
the CRUD route**"*.

But FR-024 says *"The generic CRUD route MUST NOT be able to change … `assignee_user_id`"*, and
T-API-01 repeats it: *"`status`/`resolved_at`/`closed_at`/`assignee_user_id` excluded from the
updatable set."* The two statements are directly contradictory, and there is **no assign endpoint**
in the twelve-row API table. So in v2 a Case can only acquire an owner through `/transfer` — which
transfers *from* someone — and T-TEST-15 ("every legal transition succeeds") cannot pass for the
`new → in_progress` row.
**Fix:** add **T-API-16** `<M>/api/cases/[id]/assign/route.ts` (feature `connect.inbox.handle`,
guard op `update`, emits `connect.case.assigned`, writes the transition row), point FR-002 and the
§ Status machine row at it, delete the "and by assignment on the CRUD route" clause from § Frozen
surfaces, and add an assign row to T-TEST-15.

### C-C — Slice 1a installs a workspace dependency on a package slice 1b creates
**Ids:** T-SET-03 (1a), T-CH-01 (1b), T-SET-01
T-SET-03 is in slice 1a and says *"Register **both packages**: … `enabledModules` entry + …
workspace dep + … template mirror; then `corepack yarn generate`"*. `packages/channel-webform` is
created by **T-CH-01, in slice 1b**. A `workspace:*` dependency on a workspace that does not exist
fails `yarn install`; an `enabledModules` entry whose `from: '@open-mercato/channel-webform'`
resolves (`packages/cli/src/lib/resolver.ts:64-68`) to a missing
`packages/channel-webform/src/modules` gives the generator nothing to discover. Slice 1a is declared
*"blocked by nothing"* and cannot complete.

Compounding it, **T-CH-01 has no scaffold task at all** — it names only
`packages/channel-webform/src/modules/channel_webform/`, so the new npm workspace has no
`package.json`, `build.mjs`, `tsconfig.json` or `jest.config.cjs`. And it remains the round-1 M12
orphan: no FR, no risk row, no `T-TEST-*`, while § TLDR promises *"Every inbound e-mail **and
web-form submission** becomes a Case."*
**Fix:** split T-SET-03 into **T-SET-03a** (`connect` only, slice 1a) and **T-SET-03b**
(`channel_webform`, slice 1b, immediately after T-CH-01). Restate T-CH-01 to include the full
package scaffold from M-B. Add **FR-028** ("A web-form submission MUST become a Case through the
same shared inbound route as e-mail, with `handle_type='email'` resolved from the form's e-mail
field → T-CH-01") and a **T-TEST-17** row asserting it.

## Major

### M-A — T-SET-03 edits the wrong `package.json` and skips the template mirror
**Id:** T-SET-03
The task says *"`apps/mercato/src/modules.ts` `enabledModules` entry + **root `package.json`**
workspace dep + `packages/create-app/template/src/modules.ts` mirror"*. Root `package.json:9-13` is
`"workspaces": ["apps/*", "packages/*", …]` — a glob that **already** covers `packages/connect`, so
the named edit is a no-op. The edit that actually matters is `apps/mercato/package.json`
`dependencies`, which lists every peer package explicitly
(`"@open-mercato/content": "workspace:*"`, `"@open-mercato/channel-gmail": "workspace:*"`, …); without it the app cannot import
`@open-mercato/connect`. Separately, `scripts/template-sync.ts:29-30` mirrors
`apps/mercato/package.json` → `packages/create-app/template/package.json.template`, which T-SET-03
does not mention — so `yarn template:sync` goes into permanent drift the moment the app dependency
lands.
**Fix:** restate as *"add `{ id: 'connect', from: '@open-mercato/connect' }` to
`apps/mercato/src/modules.ts` `enabledModules`; add `"@open-mercato/connect": "workspace:*"` to
**`apps/mercato/package.json`** `dependencies`; mirror both into
`packages/create-app/template/src/modules.ts` and
`packages/create-app/template/package.json.template`; run `corepack yarn install` then
`corepack yarn generate`."*

### M-B — T-SET-01 still omits four required files and invents one that does not exist
**Id:** T-SET-01 (and T-CH-01 by extension)
T-SET-01 names `{package.json, tsconfig.json, build.mjs, jest.config.cjs, .eslintrc.cjs}`, *"mirroring
`packages/content/`"*. `packages/content/` contains: `package.json`, `tsconfig.json`,
**`tsconfig.build.json`**, `build.mjs`, **`watch.mjs`**, `jest.config.cjs`, **`jest.setup.ts`**,
`src/`, `README.md`, `AGENTS.md` — and **no `.eslintrc.cjs`**; no package in the repo has one.
Concretely: `packages/content/jest.config.cjs` sets
`setupFilesAfterEach: ['<rootDir>/jest.setup.ts']`, so `yarn test` cannot boot without it;
`packages/content/package.json` wires `"watch": "node watch.mjs"` and `turbo.json` fans a `watch`
task across `packages/*`; `"main": "./dist/index.js"` needs a `src/index.ts` for `build.mjs`
(`scripts/build-package.mjs`) to emit.
**Fix:** restate as *"`packages/connect/{package.json, tsconfig.json, tsconfig.build.json,
build.mjs, watch.mjs, jest.config.cjs, jest.setup.ts}` + `src/index.ts` barrel, copied verbatim from
`packages/content/` with the name swapped. No `.eslintrc.cjs` — packages inherit the root flat
config."* Apply the same list to T-CH-01.

### M-C — No task seeds `connect_tenant_settings`, and there is no shared reader
**Ids:** FR-001, FR-002, FR-005, FR-006, T-DATA-02, T-ACL-01, T-SEQ-01, T-ING-04, T-WRK-01, T-API-06
v2 fixed half of round-1 C4: the table is now created by T-DATA-02. But **nothing populates it**.
T-ACL-01 owns `<M>/setup.ts` and its description covers `defaultRoleFeatures` only; the platform
hooks for exactly this are `onTenantCreated` / `seedDefaults`
(`packages/core/AGENTS.md` § Module Setup Convention; `communication_channels/setup.ts` is the live
precedent). Four consumers read from the empty table: `case_attach_window_minutes` (FR-001 /
T-ING-04, including its "floor 60" which has nowhere to be enforced), `auto_close_after_days`
(FR-005 / T-WRK-01), `reopen_window_days` (FR-006 / T-API-06), **`case_number_prefix`** (FR-002 /
T-SEQ-01 — without it `case_number` has no prefix and the unique `(tenant_id, case_number)` index
collides on the first two Cases of any tenant). There is also no single scoped reader, so four
call sites will each re-derive scope and defaults.
**Fix:** extend T-ACL-01 (or add **T-SET-04**) — *"`<M>/setup.ts` `onTenantCreated` inserts the
`connect_tenant_settings` row with documented defaults, idempotently"* — and add **T-DOM-02**
`<M>/lib/settings.ts`, the tenant-scoped reader that applies the floor and the
`reopen_window_days <= auto_close_after_days` invariant (T-VAL-01) on read. Make T-ING-04, T-WRK-01,
T-API-06 and T-SEQ-01 depend on it.

### M-D — T-API-03's notification has no type ID, no file and no BC entry
**Id:** T-API-03; § Migration & backward compatibility
T-API-03 says *"emits `connect.case.assigned`, **notifies the receiving agent**"*. An in-app
notification needs a **Notification Type ID** — `BACKWARD_COMPATIBILITY.md:205` `### 11.
Notification Type IDs (FROZEN)` — declared in `<M>/notifications.ts`, plus a
`notifications.client.ts` renderer and `<module>.notifications.*` i18n keys
(`packages/core/AGENTS.md` § Notifications). § Tasks has no notifications file, `app-spec-notes/frozen-surfaces.md`
freezes no `connect` notification ID, and v2's § Migration additive list enumerates surfaces
1/5/6/7/8/9/10/14 — **surface 11 is absent**. So either the transfer silently does not notify, or a
FROZEN surface is added off-plan.
**Fix:** add **T-NOT-01** `<M>/notifications.ts` + `<M>/notifications.client.ts` +
`widgets/notifications/CaseTransferredRenderer.tsx` declaring `connect.case.transferred` as a
notification type; add the ID to `frozen-surfaces.md` and to § Migration's additive list under
surface 11; add its keys to T-I18N-01.

### M-E — T-ING-05 (slice 1b) needs a send path that does not exist until slice 1c
**Ids:** FR-025, T-ING-05, T-API-07, T-UP-01…03
FR-025 requires *"exactly one auto-acknowledgement to the customer"* on the first inbound.
T-ING-05 is `<M>/lib/auto-acknowledge.ts` in **slice 1b**, which § Tasks declares *"blocked by 1a"*.
Every outbound mechanism lands in **slice 1c**: `communicationChannelsSendAsUser`'s widened actor
(PR A / T-UP-01…03), the send route (T-API-07) and — per C-A — a send worker that does not exist at
all. Slice 1b as scoped therefore ships a lib that cannot send, and the FR it serves is unsatisfiable
at the slice boundary.
**Fix:** either move T-ING-05 to slice 1c and note it in FR-025, or state explicitly that 1b ships
the suppression decision only and the actual dispatch lands with T-WRK-04 in 1c. Update the slice
header's "blocked by" line either way.

### M-F — Six FRs and two risks have no test; six more are asserted only in the UI
**Ids:** FR-002, FR-005, FR-015, FR-019, FR-025, FR-026; R6, R10; T-TEST-01…16
Mapping the sixteen scenarios onto FR-001…FR-027 (Sweep 6) leaves **FR-002** (case-number format and
per-tenant uniqueness), **FR-005** (the auto-close job — T-TEST-16 is *reopen*, not auto-close),
**FR-015** (the `connect_identity_link_audit` history and unlink re-opening a manual-match task),
**FR-019** (the counting layer), **FR-025** (exactly one auto-ack on the happy path — T-TEST-03 only
asserts *no* ack for suppressed senders) and **FR-026** (manual-match resolution) with no assertion
at all. **R6**'s mitigation is the nightly reconciliation, which nothing exercises (T-TEST-09 asserts
`conversation_count` *unchanged*, a different property). **R10** (pepper rollout / dual hash format)
is stated in § Data model and never tested. FR-004, FR-007, FR-009 and FR-013 are asserted only in
Playwright UI specs, so the API contracts behind them (wrap-up gate, 409 body, `match_method`) are
unpinned.
**Fix:** add **T-TEST-17** web form (see C-C) · **T-TEST-18** auto-close after
`auto_close_after_days`, and *not* when an inbound arrived inside the window · **T-TEST-19**
case-number format + a second Case in the same tenant getting a distinct number · **T-TEST-20**
unlink writes an audit row, leaves the identity row present, sets `link_state='unresolved'` and
re-opens a manual-match task · **T-TEST-21** exactly one auto-ack per opened Case · **T-TEST-22**
manual-match resolve links the identity and drains the staged projection · **T-TEST-23** the
baseline job reports `conversation_count` drift rather than correcting it. Add API-level assertions
for FR-004 and FR-007 to T-TEST-15 and T-TEST-10.

### M-G — T-DATA-02 creates a table the data model no longer defines
**Ids:** T-DATA-02, § Data model
T-DATA-02 lists *"`connect_conversation`, `connect_message`, **`connect_case_reopen`**,
`connect_pending_projection`, `connect_tenant_settings`, tags"*. § Data model defines
`connect_conversations`, `connect_messages`, `connect_case_transitions`,
`connect_contact_identities`, `connect_identity_link_audit`, `connect_manual_match_tasks`,
`connect_pending_projections`, `connect_metric_daily`, `connect_tenant_settings`,
`connect_case_tags` — **`connect_case_reopens` is gone**, correctly replaced by the general
transition table (round-1 M2's fix). The task is a leftover from the frozen spec, and it would have
the implementer author an entity with no column list, no index spec, no FR and no test — which then
lands in the T-DATA-04 migration and the `.snapshot-open-mercato.json` permanently.
**Fix:** delete `connect_case_reopen` from T-DATA-02. FR-006's `reopen_count` lives on
`connect_cases` and its history in `connect_case_transitions`, both already tasked.

## Minor

### m-a — T-WRK-03 (slice 1c) registers a worker that lands in slice 1d
T-WRK-03 is in slice **1c** and registers *"T-WRK-01/02/**T-MET-01**"*, but T-MET-01
(`<M>/workers/baseline-metrics.ts`) is in slice **1d**. At the end of 1c the scheduler holds a
registration whose target queue has no consumer, so jobs accumulate and fail.
**Fix:** split the registration (1c registers auto-close + reconcile; T-MET-01's own task registers
its schedule in 1d), or move T-WRK-03 to 1d and say 1c's workers are inert until then.

### m-b — no task states the page-metadata guards
§ API contracts states the per-method `metadata` rule for **routes** only. T-UI-06, T-UI-08, T-UI-09,
T-UI-10 and T-UI-12 name `page.tsx` files with no `page.meta.ts` and no `requireFeatures`, so five
backoffice screens are unguarded unless the implementer infers it.
**Fix:** append *"+ `page.meta.ts` with `requireAuth` and `requireFeatures: ['connect.…']`"* to each
of the five, naming the feature per screen (`connect.settings.manage` for T-UI-12,
`connect.cases.view.all` for T-UI-09, etc.).

### m-c — the test tasks are a range over a glob, not file paths
§ Tasks opens with *"Every task names a file path."* `T-TEST-01…16 <M>/__integration__/*.spec.ts`
and `T-UITEST-01…08 <M>/__integration__/ui/*.spec.ts` are two bullets covering 24 ids with two globs.
`.ai/qa/AGENTS.md:282` fixes the convention as
`packages/<package>/src/modules/<module>/__integration__/TC-{CATEGORY}-{XXX}.spec.ts`.
**Fix:** state the mapping once — `T-TEST-NN → <M>/__integration__/TC-CONNECT-0NN.spec.ts`,
`T-UITEST-NN → <M>/__integration__/ui/TC-CONNECT-UI-0NN.spec.ts` — and assign each to the slice
whose FR it covers, as the slice-1e header promises but does not enumerate.

### m-d — delivery status has no event, and the ten IDs freeze in Phase 1
§ Architecture stores `delivery_status` on `connect_message`, and the UI learns about it by polling
(T-UI-11). None of the ten frozen `connect.*` IDs covers a message lifecycle
(`frozen-surfaces.md:46-49`), and surface 5 is FROZEN — so `connect.message.sent` / `.failed` cannot
be added in a later phase without a freeze amendment. Poll-only is a defensible decision (it matches
§ Inbox freshness), but unlike the `clientBroadcast` deferral it is not stated.
**Fix:** add one line to § Inbox freshness — *"delivery status is polled, not evented; no
`connect.message.*` ID is reserved in Phase 1"* — or reserve the two IDs now in `frozen-surfaces.md`
with an "emitted from Phase 1" note.

### m-e — T-API-12 and T-API-13 serve no requirement and no test
`GET /cases/{id}/conversations` and `GET /contact-identities` appear only in the § API contracts
table. No FR arrows at them, no `T-TEST-*` covers them, and neither is named by a UI task (T-UI-02/03
render the panes that would consume them). Nothing defines their response shape, paging or done
condition.
**Fix:** point FR-008 at T-API-12 and FR-013 at T-API-13 in addition to their data tasks, and name
both routes as the data sources in T-UI-03 and T-UI-02.

### m-f — T-DATA-05's widening covers one of the file's two path resolvers
The task widens `readEntitySource` (`:70-75`) only. The second guard resolves route files with an
independent core-only join at
`packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts:204`
(`join(__dirname, '..', 'modules', route)`), reached whenever an audited entity has no `deleted_at`
(`:196`). Every `connect` table carries `deleted_at` (§ Data model), so the branch is never taken —
the task passes by a property it never states, and stops passing the day a `connect` entity ships
without soft delete.
**Fix:** add half a sentence — *"widen both path resolvers (`:72` and `:204`); `connect` entities all
carry `deleted_at`, so the second guard short-circuits, but the resolver must not assume core"*.

---

## Sweep results at a glance

| Sweep | Round 1 | v2 | Note |
|---|---|---|---|
| 1. Write-path | FAIL | **FAIL (marginal)** | every FR names a real task; 7 partial, and `assignee_user_id` has no writer |
| 2. Reverse | PASS w/ notes | **PASS w/ notes** | 3 orphans: T-CH-01, T-API-12, T-API-13 |
| 3. Cross-reference | FAIL | **PASS w/ one defect** | zero dangling task refs; the API Task column resolves 12/12; one dangling table (`connect_case_reopen`) |
| 4. Slice buildability | FAIL | **FAIL** | 1a installs a dep on a 1b package; wrong `package.json`; scaffold still short 4 files |
| 5. Test coverage | FAIL | **PARTIAL FAIL** | tests are tasked and R1/R2 are properly covered; 6 FRs + R6/R10 still untested |
| 6. Unlisted prerequisites | FAIL | **FAIL** | 8 unlisted, 3 blocking (send worker, settings seed, webform scaffold) |

FINDINGS: 3C/7M/6m
