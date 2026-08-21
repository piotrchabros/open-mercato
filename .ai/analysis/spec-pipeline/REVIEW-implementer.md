# REVIEW — Implementer lens

**Role:** Implementer reviewer (adversarial spec review, role 3 of 4).
**Target:** [`.ai/specs/2026-08-21-connect-phase-1-merged.md`](../../specs/2026-08-21-connect-phase-1-merged.md)
**Lens:** the task graph as an executable plan — can someone open § Tasks, work top to bottom, and
end with a building, passing, requirement-complete Phase 1?
**Checkout:** worktree `cez/486d110a` at `c0e50a8fa`. `packages/connect` and `packages/channel-webform`
do not exist yet; all platform citations are re-opened in this checkout.
**Independence:** written without reading any other `REVIEW-*.md`. The claims ledger was read; its
verdicts are taken as given and not re-litigated — this review is about the *plan*, not the *claims*.

**Verdict: the task graph is not executable as written.** Slice 1a cannot build, five of eleven API
routes have no task, one of the three settings-bearing tables has no task, and the entire test suite
the Risks and FR-020 lean on has no task at all.

---

## Sweep 1 — Write-path sweep (FR-001…FR-023)

The spec's Readiness table asserts: *"Write-path test — ✅ every FR below names the task that
performs its write."* **That claim is false.** 23 FRs carry arrows; 17 name a task that can
plausibly perform the write, 5 name a task that cannot fully perform it, and 1 names a *test*.

| FR | Named task | Can it write? | Note |
|---|---|---|---|
| FR-001 | T-ING-01, T-ING-04 | ✅ | but reads `case_attach_window_minutes` from an untasked table — see C4 |
| FR-002 | T-DATA-01 | ⚠️ **partial** | entity definition only; nothing allocates `case_number` — see M1 |
| FR-003 | T-DOM-01 | ⚠️ **partial** | `lib/case-state.ts` is a pure machine; nothing persists actor+time per transition — see M2 |
| FR-004 | T-API-04 | ✅ | |
| FR-005 | T-API-05, T-WRK-01 | ⚠️ **partial** | reads `auto_close_after_days` (C4); worker needs a scheduler registration (M11) |
| FR-006 | T-API-06 | ⚠️ **partial** | reads `reopen_window_days` (C4) |
| FR-007 | T-API-02, T-UI-07 | ⚠️ | T-UI-07 exists only positionally inside the range `T-UI-06…09` (M8) |
| FR-008 | T-DATA-02 | ✅ | |
| FR-009 | T-UI-04, T-API-07 | ✅ | |
| FR-010 | T-API-07 | ✅ | |
| FR-011 | T-API-07 | ✅ | |
| FR-012 | T-ING-02 | ✅ | |
| FR-013 | T-ING-03 | ✅ | |
| FR-014 | T-ING-03 | ⚠️ **partial** | "raise a manual-match task" has no writer — see M3 |
| FR-015 | T-API-08 | ✅ | |
| FR-016 | T-DATA-03 | ✅ | |
| FR-017 | T-API-04, T-PROJ-01 | ✅ | split across slices 1c/1d — see m3 |
| FR-018 | T-PROJ-02 | ⚠️ | drain trigger lives in T-API-08, which never mentions it — see M15 |
| FR-019 | T-MET-01 | ✅ | needs a scheduler registration (M11) |
| FR-020 | **T-TEST-05** | ❌ **no** | a test asserts; it does not write — see C2 |
| FR-021 | T-API-01 | ⚠️ **partial** | one route out of eleven — see M4 |
| FR-022 | T-API-09 | ✅ | |
| FR-023 | T-I18N-01 | ⚠️ | wrong slice, wrong locale set — see M7 |

**Result: 17 clean / 5 partial / 1 with no write path at all.** The Readiness ✅ must be downgraded.

## Sweep 2 — Reverse sweep (every T-* → the FR or risk it serves)

Result: **no dangling-purpose tasks that are outright pointless**, but four tasks are *feature work*
with no requirement behind them, which means nothing in the spec defines "done" for them.

| Task | Serves |
|---|---|
| T-SET-01/02, T-DATA-04, T-VAL-01 | infrastructure — legitimate, no FR expected |
| T-DATA-05 | Core-edit ledger row 5 (opt-lock gate) |
| T-DOM-01 | FR-003 |
| T-EVT-01 | § Frozen-surface drift #2 (ten event IDs) |
| T-SRCH-01 | **no FR, no risk, no test** — search is asserted only inside T-TEST-05's "and search" clause |
| T-CH-01 (`channel-webform`) | **no FR, no risk, no test** — an entire new npm package with no requirement and no coverage (M12) |
| T-UP-01…05 | Blocking upstream PRs A/B/C |
| T-UI-01/02/03/05 | § UI (Inbox panes) — no FR names them |
| T-UI-06…09 | § UI (list/detail/360/settings) |
| T-WID-01 | § UI injection — **no FR**; PR B's "four new spots" depends on it |
| T-CMD-01 | § Commands and undo — **no FR**; only T-TEST-13 references it |
| T-MET-01 | FR-019 |
| T-I18N-01 | FR-023 |

## Sweep 3 — Cross-reference sweep

Every task id referenced anywhere in the document, checked against § Tasks:

**Dangling (referenced as a task, absent from § Tasks):**

- `T-TEST-05` — referenced from **FR-020** and **R8**
- `T-TEST-06` — referenced from **R2**
- `T-TEST-07` — referenced from **R3**
- `T-TEST-08` — referenced from **R5**
- `T-TEST-09` — referenced from **R7**

All five live in § Integration test coverage as *scenario rows*, not tasks. See **C1/C2**.

**Weakly declared (id exists only inside an ellipsis range, with no file path):**
`T-UP-01`, `T-UP-02`, `T-UP-03`, `T-UI-01`, `T-UI-02`, `T-UI-03`, `T-UI-06`, `T-UI-07`, `T-UI-08`,
`T-UI-09`. Of these, **T-UI-07 is load-bearing** — FR-007 arrows to it. See **M8**.

**Numbering gap:** `T-API-03` is skipped (01, 02, 04, 05, 06, 07, 08, 09). Nothing references it, but
the gap sits exactly where the missing `/transfer` route task belongs. See **C3**.

**Dangling *section* reference:** R9's mitigation says *"`yarn i18n:check-hardcoded` in the DoD"*.
**The spec has no Definition of Done section.** See **m1**.

**Clean:** § Architecture → T-UP-04 ✅ declared. § Data model and § API contracts reference no task
ids at all — which is itself the root of C3/C4 (no arrow means no one noticed the gap).

## Sweep 4 — Slice-buildability sweep (does slice 1a compile and pass `yarn generate`?)

Walked T-SET-01/02, T-DATA-01…05, T-ACL-01, T-DOM-01, T-EVT-01, T-API-01/02, T-SRCH-01, T-VAL-01
against `packages/content/` (the named mirror) and the CLI's discovery path.

**It does not.** Three independent blockers:

1. **No module registration.** `packages/cli/src/lib/resolver.ts:47` (`loadEnabledModules`) reads
   `apps/mercato/src/modules.ts`; `pkgDirFor` (`:52-71`) maps `from: '@open-mercato/connect'` →
   `packages/connect/src/modules`. Nothing is discovered until `{ id: 'connect', from:
   '@open-mercato/connect' }` is appended to `enabledModules` in
   `apps/mercato/src/modules.ts:82-148` **and** `"@open-mercato/connect": "workspace:*"` is added to
   `apps/mercato/package.json` dependencies. T-SET-02 says "run `corepack yarn generate`" — it will
   emit nothing, and T-DATA-04's `db:generate` iterates the same `enabledModules`
   (`packages/cli/src/lib/db/commands.ts:258`), so it produces no migration either. **C5.**
2. **Incomplete package scaffold.** T-SET-01 names `package.json` + `tsconfig.json`. `packages/content/`
   also ships `build.mjs`, `watch.mjs`, `tsconfig.build.json`, `jest.config.cjs`, `jest.setup.ts` and
   `src/index.ts`. `packages/content/package.json` wires `"build": "node build.mjs"`,
   `"watch": "node watch.mjs"`, `"test": "jest --config jest.config.cjs"` — and `turbo.json` runs
   `build` / `test` / `watch` across `./packages/*`. Without `build.mjs`, `yarn build:packages` fails
   on the new workspace. **M5.**
3. **Template mirror.** `scripts/template-sync.ts:32` lists `modules.ts` in `SYNC_ROOT_FILES` and
   `:30` mirrors `package.json.template`. Registering `connect` in `apps/mercato` without mirroring
   into `packages/create-app/template/src/modules.ts` puts `yarn template:sync` into drift. **M6.**

**Files slice 1a does not omit (checked, clean):** `index.ts` shape ✅ (T-SET-02, matches
`packages/content/src/modules/content/index.ts`), `data/entities.ts` ✅ (T-DATA-01…03),
migrations ✅ (created by the CLI at `db/commands.ts:259`, so T-DATA-04 suffices), `setup.ts` ✅
(T-ACL-01), `acl.ts` ✅, `search.ts` ✅ (but see M9), `di.ts` — not required for Phase 1 since
`connect` only *consumes* `messagesThreadReader`.

**T-DATA-05 is unimplementable as written — and would break `yarn test`.** See **C6**.

**The T-I18N-01 ordering question is a real defect.** T-ACL-01 (1a) writes feature titles and
descriptions, T-DOM-01 (1a) "rejects illegal transitions **with a field error**", T-API-01 (1a) and
T-API-04…08 (1c) all emit user-facing messages — three slices of strings land before the locale
files exist in 1d. See **M7**.

## Sweep 5 — Test-coverage sweep

**Structural finding first: there is no task that writes a test.** § Tasks has 13 + 5 + 15 + 8 = 41
task lines and not one of them is a test. `.ai/qa/AGENTS.md` requires specs to live at
`packages/<package>/src/modules/<module>/__integration__/*.spec.ts` and root `AGENTS.md` requires the
integration tests to ship *in the same change*. § Integration test coverage names no file path — in
direct contradiction of § Tasks' own opening line, *"Every task names a file path."* **C1.**

**FR → test map:**

| Covered | FR-001 (T-TEST-01/02) · FR-011 (T-TEST-04) · FR-012 (T-TEST-03) · FR-016 (T-TEST-11) · FR-017/018 (T-TEST-12) · FR-020 (T-TEST-05) · FR-022 (T-TEST-06) · FR-023 (U8) |
|---|---|
| **Partial** | FR-008/009 (incidental) · FR-013/015 (T-TEST-13 covers undo only) · FR-004 (U2 is a UI gate; no API assertion) · FR-007 (U7 is a UI conflict bar; no 409-body assertion) |
| **No test at all** | **FR-002** (case number format/uniqueness) · **FR-003** (status machine, illegal transitions) · **FR-005** (auto-close job) · **FR-006** (reopen window) · **FR-010** (15 s timeout → 422) · **FR-014** (sub-threshold links nothing) · **FR-019** (baseline counting layer) · **FR-021** (404-not-403) |

**Risk → test map:** R2→T-TEST-06 (**mismatched**, see M14) · R3→T-TEST-07 ✅ · R5→T-TEST-08 ✅ ·
R7→T-TEST-09 ✅ · R8→T-TEST-05 ✅ · R9→U8 ✅ · R6 → **no test** (T-TEST-09 asserts `conversation_count`
unchanged on redelivery, not drift reconciliation) · **R1 → no test** (T-TEST-03 covers the
`Auto-Submitted`/`Precedence` header path; the `(channel_id, from_handle_hash)` window — the half the
risk row says cannot be reused from `inbox_ops` — is unasserted). **R1 is rated Critical.** · R4 → n/a.

**Are T-TEST-05 and T-TEST-06 specified precisely enough to write?** No, neither.

- **T-TEST-05** — *"invisible to tenant B on every route, list, search and export"*. "Every route" is
  unbounded and the route inventory is incomplete (C3), so the test cannot be enumerated. It also
  does not state **what tenant B receives** — FR-021 says 404, T-TEST-05 says "invisible". And
  "search" requires the query-index/search document from T-SRCH-01, with no stated scope assertion.
- **T-TEST-06** — titled *"Cross-customer isolation"* but its assert is *"Agent-scoped listing never
  returns another customer's Case via `ids=`"*, which is **FR-022 (cross-agent narrowing)**, not
  cross-customer. **M14.**

## Sweep 6 — Unlisted-prerequisite sweep

| Prerequisite | Needed by | In the plan? |
|---|---|---|
| `apps/mercato/src/modules.ts` entry + `apps/mercato/package.json` dep | every task in 1a | ❌ **C5** |
| Same for `channel_webform` | T-CH-01 | ❌ **C5** |
| `packages/create-app/template/src/modules.ts` + `package.json.template` mirror | `yarn template:sync` | ❌ **M6** |
| `build.mjs` / `watch.mjs` / `jest.config.cjs` / `jest.setup.ts` / `src/index.ts` | `build:packages`, `test`, `watch:packages` | ❌ **M5** |
| Scheduler registration in `setup.ts` (`schedulerService.register`, per `communication_channels/setup.ts:111,134`) | T-WRK-01, T-MET-01 | ❌ **M11** |
| `connect_tenant_settings` entity + migration + defaults seed + `/api/connect/settings` route | FR-001, FR-005, FR-006, `connect.settings.manage` | ❌ **C4** |
| `<M>/api/openapi.ts` module factory (cf. `packages/core/src/modules/customers/api/openapi.ts`) | § API contracts *"documented in `api/openapi.ts`"* | ❌ **m5** |
| `case_number` sequence allocator | FR-002 | ❌ **M1** |
| `aclFeatures` on every searchable entity in `search.ts` | T-SRCH-01 | ❌ **M9** |
| Rewriting `readEntitySource` for workspace packages | T-DATA-05 | ❌ **C6** |
| DI registration for `connect` | none needed in Phase 1 | ✅ n/a |
| `page.tsx` metadata guards | T-UI-06…09 | ⚠️ implied by § API contracts' per-method rule; never stated for pages |

---

# Findings

## Critical

### C1 — No task writes any test; the entire test matrix is unowned work
**Ids:** T-TEST-01…13, U1…U8 (all 21), § Tasks
§ Tasks lists 41 tasks and not one produces a test file. § Integration test coverage gives 21
scenarios with **no file path, no task id, no slice, no owner** — while § Tasks opens with *"Every
task names a file path."* Meanwhile FR-020 and R2/R3/R5/R7/R8 arrow *into* those test ids as if they
were tasks (Sweep 3). Under `.ai/qa/AGENTS.md` and root `AGENTS.md` the integration tests must ship
in the same change, so this is not a "phase 2" deferral — it is ~40% of the work missing from the
plan, and the estimate/slicing is wrong by that margin.
**Fix:** add a test task per slice, each with a path: `T-TEST-A` →
`packages/connect/src/modules/connect/__integration__/TC-CONNECT-{001…013}.spec.ts` (map each
T-TEST-NN to one spec id), and `T-TEST-B` → the eight `U1…U8` Playwright specs in the same folder.
Assign T-TEST-01/02/03/09/11 to slice 1b, 04/07/10/13 to 1c, 05/06/08/12 and U1…U8 to 1d. Renumber
the scenario rows so a test id is never also an FR arrow target.

### C2 — FR-020's write path is a test, falsifying the Readiness "write-path test ✅"
**Id:** FR-020 → T-TEST-05
*"Every row and every route MUST be scoped to tenant and organisation"* is a **production
requirement**. It arrows at `T-TEST-05`, an assertion. Nothing in § Tasks is named as the code that
*applies* tenant/org scoping to `connect`'s rows and routes. The Readiness table's *"✅ every FR below
names the task that performs its write"* is therefore false on its own terms, and this is the single
FR most likely to be assumed-satisfied-by-the-framework and never explicitly implemented.
**Fix:** repoint FR-020 at a new **T-DATA-06** — `<M>/data/entities.ts`: every entity declares
`organization_id`/`tenant_id` NOT NULL with the scoped index set from § Data model — plus **T-API-10**
— `<M>/api/**/route.ts`: every handler derives scope from the auth context and filters on it, never
from the request body. Keep T-TEST-05 as the *assertion*, listed under the new test task from C1.
Downgrade the Readiness row to ⬜ until both exist.

### C3 — Five of eleven API routes in § API contracts have no task
**Ids:** § API contracts vs T-API-01…09
Cross-walking the eleven-row route table against § Tasks:

| Route | Task |
|---|---|
| `/api/connect/cases` (GET/POST/PUT/DELETE) | T-API-01 ✅ |
| `POST /cases/{id}/resolve` | T-API-04 ✅ |
| `POST /cases/{id}/close` | T-API-05 ✅ |
| `POST /cases/{id}/reopen` | T-API-06 ✅ |
| **`POST /cases/{id}/transfer`** | ❌ **none** |
| `POST /cases/{id}/messages` | T-API-07 ✅ |
| **`GET /cases/{id}/conversations`** | ❌ **none** |
| **`GET /contact-identities`** | ❌ **none** |
| `POST /contact-identities/{id}/link\|unlink` | T-API-08 ✅ |
| **`GET/PUT /settings`** | ❌ **none** |
| **`GET /metrics/baseline`** | ❌ **none** (T-MET-01 is the worker, not the route) |

`T-API-03` is conspicuously skipped in the numbering — the transfer route's slot. This also breaks
two downstream claims: § API contracts says *"The six mutating action endpoints"* and T-TEST-10 says
*"Mutation guards on all six action routes"*, but only **five** exist as tasks. And § Frozen surfaces
freezes `connect.settings.manage`, whose only consumer is the untasked `/settings` route.
**Fix:** add **T-API-03** `<M>/api/cases/[id]/transfer/route.ts` (emits `connect.case.transferred`,
guard op `update`), **T-API-11** `<M>/api/cases/[id]/conversations/route.ts`, **T-API-12**
`<M>/api/contact-identities/route.ts`, **T-API-13** `<M>/api/settings/route.ts` (GET/PUT, guarded on
`connect.settings.manage`), **T-API-14** `<M>/api/metrics/baseline/route.ts` (guarded on
`connect.cases.view.all` per the drift reconciliation). Place 03/11/12 in slice 1c, 13 in 1a (1b
reads settings), 14 in 1d.

### C4 — `connect_tenant_settings` has no task, yet three FRs read from it
**Ids:** FR-001, FR-005, FR-006; § Data model; T-DATA-01/02/03
§ Data model lists `connect_tenant_settings` (*"typed columns, not key/value"*). T-DATA-01 covers
`connect_case`; T-DATA-02 covers `connect_conversation`, `connect_case_reopen`,
`connect_pending_projection`, tags; T-DATA-03 covers `connect_contact_identity`. **`connect_tenant_settings`
is in none of them.** Three requirements read values that live only there —
`case_attach_window_minutes` (FR-001/T-ING-04), `auto_close_after_days` (FR-005/T-WRK-01),
`reopen_window_days` (FR-006/T-API-06) — so slices 1b and 1c both depend on a table slice 1a never
creates. There is also no task seeding per-tenant defaults, and T-ING-04's *"floor 60"* has nowhere
to be enforced.
**Fix:** extend **T-DATA-02** to include `connect_tenant_settings` with the explicit column list
(`case_attach_window_minutes` default 60 with a floor, `auto_close_after_days`, `reopen_window_days`),
add **T-SET-03** — seed per-tenant defaults from `<M>/setup.ts` `seedDefaults`/`onTenantCreated` —
and add **T-DOM-02** `<M>/lib/settings.ts` as the single scoped reader the three consumers call.

### C5 — No task registers either new package with the app; slice 1a cannot generate, migrate or serve
**Ids:** T-SET-01, T-SET-02, T-DATA-04, T-CH-01
`packages/cli/src/lib/resolver.ts:47` loads modules from `apps/mercato/src/modules.ts`; `pkgDirFor`
(`:52-71`) resolves `from: '@open-mercato/connect'` → `packages/connect/src/modules`. Until
`{ id: 'connect', from: '@open-mercato/connect' }` is appended to `enabledModules`
(`apps/mercato/src/modules.ts:82-148`) and `"@open-mercato/connect": "workspace:*"` added to
`apps/mercato/package.json`, `yarn generate` (T-SET-02) emits nothing, `db:generate`
(`packages/cli/src/lib/db/commands.ts:258`, iterating the same list) produces no migration for
T-DATA-04, and no `/api/connect/*` route mounts. Slice 1a is claimed to be *"blocked by nothing"*;
in fact it cannot complete. T-CH-01 has the identical gap for `channel_webform`.
**Fix:** add **T-SET-03a** — append `{ id: 'connect', from: '@open-mercato/connect' }` to
`apps/mercato/src/modules.ts` and `"@open-mercato/connect": "workspace:*"` to
`apps/mercato/package.json` — as the *first* item of slice 1a, before T-SET-02. Add the same two
lines for `channel_webform` to T-CH-01's description.

### C6 — T-DATA-05 as written fails `yarn test` outright
**Id:** T-DATA-05
The task says *"Add every `connect` entity to the curated map in
`packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts`."* That file's
`readEntitySource` resolves
`join(__dirname, '..', 'modules', moduleId, 'data', 'entities.ts')`
(`packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts:68-73`) — i.e.
`packages/core/src/modules/<id>/data/entities.ts`, **core only**, exactly as the spec's own Core-edit
ledger notes. It is called at *describe-collection time* (`:86`), outside any `it()`. Adding a
`connect:` key makes it read `packages/core/src/modules/connect/data/entities.ts`, which will never
exist → `ENOENT` throws during collection and **the whole test file fails**, taking `yarn test` red.
The spec identified the constraint and then wrote a task that trips over it.
**Fix:** restate T-DATA-05 as two steps: (a) change `readEntitySource` to accept a package root —
e.g. a `moduleSources: Record<string, string>` map defaulting to `packages/core/src/modules`, with
`connect` pointing at `packages/connect/src/modules/connect` — and (b) then add the `connect` entity
list. Note in the task that this edits a `packages/core` test file, so it belongs in the Core-edit
ledger row it already occupies, now as an (a)+(b) change rather than (a).

## Major

### M1 — FR-002's `case_number` has no allocator task
`case_number` is *"`ZG-<seq>`, unique per tenant, via the `sales.SalesDocumentSequence` pattern"*
(§ Data model) with a unique `(tenant_id, case_number)` index. T-DATA-01 defines the column. Nothing
allocates the value, and `SalesDocumentSequence` (`packages/core/src/modules/sales/data/entities.ts:794`)
is a *pattern*, not a shared helper — it is a `sales`-owned entity `connect` may not reach into.
**Fix:** add **T-DATA-07** `<M>/data/entities.ts` + `<M>/lib/case-number.ts` — a `connect`-owned
`ConnectCaseSequence` entity and a transaction-scoped allocator mirroring the `sales` pattern; call
it from T-ING-01. Point FR-002 at T-DATA-01 **and** T-DATA-07.

### M2 — FR-003's "every transition MUST record actor and time" has no table and no task
T-DOM-01 builds `<M>/lib/case-state.ts` — a pure legality check. The audit surface does not exist:
§ Data model gives `connect_cases` only `first_agent_touch_at`/`last_agent_touch_at`/`resolved_at`/
`closed_at` (latest-state columns, not per-transition), and the only history table is
`connect_case_reopens`. Nothing records *who* moved `new → in_progress` or `in_progress →
waiting_customer`, or when.
**Fix:** add `connect_case_transitions` (`case_id`, `from_status`, `to_status`, `actor_user_id`,
`reason`, `occurred_at`) to § Data model and to **T-DATA-02**, and add **T-DOM-03**
`<M>/lib/record-transition.ts` writing that row in the same transaction as the status change, called
from T-API-03/04/05/06 and T-ING-01. Repoint FR-003 at T-DOM-01 + T-DOM-03.

### M3 — FR-014's "manual-match task" has no writer
FR-014 requires the system to *"raise a manual-match task"* below threshold. T-ING-03 builds
`<M>/lib/identity-resolver.ts`, which can set `link_state='unresolved'` but has nowhere to raise
anything: `connect` declares no `notifications.ts`, no task/todo entity, and no notification IDs in
§ Migration & BC (which lists *no* new notification IDs on surface 11).
**Fix:** decide the mechanism and task it — either **T-NOT-01** `<M>/notifications.ts` + a
`connect.identity.unresolved` notification raised from T-ING-03 (and add the ID to § Frozen surfaces
and the BC additive list), or scope FR-014 down to *"surfaced in the Inbox identity panel's
unresolved filter"* and point it at T-UI-03.

### M4 — FR-021 (404-not-403) is mapped to one route out of eleven
FR-021 is a cross-cutting contract; its arrow names only **T-API-01** (`<M>/api/cases/route.ts`).
The other ten routes in § API contracts — including the two identity routes that are exactly where a
cross-tenant id probe would be tried — carry no such instruction.
**Fix:** repoint FR-021 at a new cross-cutting **T-API-10** ("every `connect` route resolves records
through a scope-filtered read and returns 404 on miss; a scope mismatch is never distinguished from a
missing row"), listed alongside T-API-02 in slice 1a.

### M5 — T-SET-01 omits the files that make the package build, test and watch
T-SET-01 names `package.json` + `tsconfig.json` only. `packages/content/` — the mirror the task
names — also ships `build.mjs`, `watch.mjs`, `tsconfig.build.json`, `jest.config.cjs`, `jest.setup.ts`
and `src/index.ts`. `packages/content/package.json` wires `"build": "node build.mjs"`,
`"watch": "node watch.mjs"`, `"test": "jest --config jest.config.cjs"`, and `turbo.json` fans `build`
/ `test` / `watch` across `./packages/*`. Without `build.mjs`, `yarn build:packages` fails on the new
workspace; without `jest.config.cjs`, `yarn test` fails.
**Fix:** restate T-SET-01 as *"`packages/connect/{package.json, tsconfig.json, tsconfig.build.json,
build.mjs, watch.mjs, jest.config.cjs, jest.setup.ts}` + `src/index.ts` barrel, copied from
`packages/content/` with the name swapped"*. Apply the same to T-CH-01 for `packages/channel-webform`.

### M6 — the create-app template mirror is untasked
`scripts/template-sync.ts:32` lists `modules.ts` in `SYNC_ROOT_FILES` and `:30` mirrors
`package.json.template`. Registering `connect`/`channel_webform` in `apps/mercato` (C5) without the
matching template edit puts `yarn template:sync` into permanent drift, and root `AGENTS.md`'s Task
Router requires the mirror "in the same task".
**Fix:** fold into T-SET-03a: also update `packages/create-app/template/src/modules.ts` and
`packages/create-app/template/package.json.template`, then run `yarn template:sync`.

### M7 — T-I18N-01 ships the wrong locale set, in the wrong slice
Two defects. (a) **Locale set:** `scripts/i18n-check-sync.ts:24-25` sets `REFERENCE_LOCALE = 'en'`
and `TARGET_LOCALES = ['pl', 'es', 'de', 'ko']`, and `:133-146` counts a missing `<locale>.json` as
an issue. T-I18N-01 ships `{pl,en}.json` only → `yarn i18n:check-sync` reports three missing files.
(`packages/core/src/modules/customers/i18n/` carries all five.) FR-023's *"`pl` and `en` ship
complete"* is a *translation-quality* statement; the *file* set is five. (b) **Slice:** T-I18N-01 is
in 1d, but T-ACL-01 (feature titles/descriptions), T-DOM-01 (*"illegal transitions rejected with a
field error"*) and T-API-01 in **1a**, plus T-API-04…08 in 1c, all emit user-facing strings first.
That is three slices of strings to back-fill, and `yarn i18n:check-hardcoded` fails from 1a onward.
**Fix:** restate T-I18N-01 as `<M>/i18n/{en,pl,es,de,ko}.json` (es/de/ko generated with
`yarn i18n:fix`, EN values as placeholders) and **move it to slice 1a**, with a standing rule in
§ Tasks that every later slice adds its keys in the same commit. Keep `yarn i18n:check-hardcoded` as
a per-slice gate rather than a 1d one-off.

### M8 — range-declared tasks carry no file paths; FR-007 arrows into one of them
`T-UP-01…03`, `T-UI-01…03`, `T-UI-06…09` declare ten task ids across three bullets. `T-UI-01…03`
happens to enumerate three filenames, but `T-UP-01…03` gives three ids for one undivided bullet
("Upstream PR A") and `T-UI-06…09` gives four ids for a bare list ("Cases list · Case detail ·
Customer 360 · settings") with no paths. **FR-007 arrows at T-UI-07**, whose identity is inferable
only by counting positions. This violates § Tasks' own *"Every task names a file path."*
**Fix:** expand all three ranges into one line per id with a path — e.g. T-UP-01 shared-channel
creation command, T-UP-02 tenant-scoped credential provisioning, T-UP-03 sender identity through
`SendMessageInput` + both adapters; T-UI-06 `<M>/backend/cases/page.tsx`, T-UI-07
`<M>/backend/cases/[id]/page.tsx`, T-UI-08 `<M>/backend/customers/[id]/page.tsx`, T-UI-09
`<M>/backend/settings/page.tsx`, each with its `page.meta.ts` `requireFeatures` guard.

### M9 — T-SRCH-01 omits `aclFeatures`, and the guard that would catch it does not scan `packages/connect`
`packages/search/src/modules/search/__tests__/global-search-acl.test.ts:73-78` scans only
`packages/core`, `packages/checkout`, `apps/mercato` and the create-app template. Its purpose
(`:39-42`): *"Every searchable entity therefore has to name the owning module's view feature in
`aclFeatures`, or the global-search route fails closed and its results silently disappear."*
`packages/connect` is outside that scan, and T-SRCH-01 never mentions `aclFeatures` — so
`connect_case` will index and then vanish from global search for every non-superadmin, with no test
failing. This is the exact sibling of the gap T-DATA-05 exists to close; the spec caught one and
missed the other.
**Fix:** extend T-SRCH-01 to *"…every entity config declares `aclFeatures: ['connect.inbox.view']`"*,
and add **T-SRCH-02** — add `join(repoRoot, 'packages', 'connect', 'src', 'modules')` to
`findSearchConfigFiles()`'s `roots` — with a matching row in the Core-edit ledger (class (a)).

### M10 — `connect.case.assigned` is frozen with no emitter task and no endpoint
`frozen-surfaces.md:42-49` and T-EVT-01 freeze ten `connect.*` IDs, and § Frozen-surface drift #2
justifies ten on the grounds that *"every ID has a writer."* Walking the ten: `created`←T-ING-01,
`status_changed`←T-DOM-01/routes, `transferred`←(the missing transfer route, C3),
`resolved`←T-API-04, `closed`←T-API-05, `reopened`←T-API-06, `conversation.attached`←T-ING-01,
`identity.linked`/`unlinked`←T-API-08 — and **`connect.case.assigned` has no writer**. § API
contracts has no assign endpoint, and § Requirements never says how a Case acquires an owner
(FR-002 only says it must carry one). Freezing an ID with no writer is precisely what drift #2 says
must not happen.
**Fix:** either add the assignment path (an `assignee_user_id` write in T-API-01's PUT plus the event
emit, named explicitly in the task) or drop `connect.case.assigned` to the "later phases" list in
`frozen-surfaces.md` and restate the count as nine.

### M11 — T-WRK-01 and T-MET-01 need a scheduler registration nobody owns
Both are recurring jobs. The platform pattern is `schedulerService.register({ …, scheduleType,
scheduleValue })` from the module's `setup.ts` (`packages/core/src/modules/communication_channels/setup.ts:111`
interval, `:134,142` cron `'0 4 * * *'`), guarded by `hasRegistration('schedulerService')` (`:103`).
`<M>/setup.ts` is owned by T-ACL-01, whose description covers `defaultRoleFeatures` only. Without
this, both workers exist and never run — and FR-005's auto-close and FR-019's counting layer silently
never fire.
**Fix:** add **T-WRK-02** — register the `connect:auto-close` and `connect:baseline-metrics`
schedules in `<M>/setup.ts`, per-org, skipped when `schedulerService` is unregistered — and make
T-WRK-01/T-MET-01 depend on it.

### M12 — `channel-webform` is an entire package with no FR, no risk and no test
T-CH-01 ships `packages/channel-webform/src/modules/channel_webform/` — a new npm workspace and a new
`ChannelAdapter`. § Scope lists it as In. But **no FR-0NN describes web-form behaviour**, no risk row
mentions it, and no T-TEST/U scenario exercises it (T-TEST-01 is *"Inbound e-mail → Case"*). Nothing
defines done, and the § TLDR's *"Every inbound e-mail **and web-form submission** becomes a Case"* is
untraceable.
**Fix:** add **FR-024** ("A web-form submission MUST become a Case through the same shared inbound
route as e-mail, with `handle_type='email'` resolved from the form's e-mail field → T-CH-01") and a
**T-TEST-14** row asserting it, plus the package-scaffold files from M5.

### M13 — eight FRs and the Critical risk R1 have no test
No test asserts **FR-002** (case number), **FR-003** (status machine / illegal transitions),
**FR-005** (auto-close job), **FR-006** (reopen window), **FR-010** (15 s timeout → 422), **FR-014**
(sub-threshold links nothing), **FR-019** (counting layer), **FR-021** (404 not 403). FR-004 and
FR-007 are asserted only in the UI layer (U2, U7), never at the API. **R1 — rated Critical — has no
test for the half of its mitigation the risk row says cannot be reused** (the
`(channel_id, from_handle_hash)` window); T-TEST-03 covers only the `Auto-Submitted`/`Precedence`
headers. R6 (`conversation_count` drift) likewise has no reconciliation test.
**Fix:** add scenario rows — T-TEST-14 auto-responder *loop* (same sender, N messages inside the
window → one Case, and **no** tenant-wide suppression of a second sender); T-TEST-15 illegal
transition rejected with a field error; T-TEST-16 auto-close after `auto_close_after_days`, and *not*
when an inbound arrived; T-TEST-17 reopen inside/outside `reopen_window_days`; T-TEST-18 provider
timeout → 422 naming the channel, draft preserved; T-TEST-19 sub-threshold resolution links nothing
and leaves `customer_entity_id` null; T-TEST-20 cross-tenant id returns **404, not 403**, on every
route. Fold them into the C1 test tasks.

### M14 — R2's named test does not test R2
R2 (*Critical* — *"Wrong identity link exposes another customer's orders"*) is mitigated by *"T-TEST-06
asserts cross-customer isolation."* T-TEST-06's actual assert is *"Agent-scoped listing never returns
another customer's Case via `ids=`"* — that is FR-022, cross-**agent** narrowing through the
interceptor. It never exercises a mis-linked `connect_contact_identity`, and never looks at the
right-hand order-context pane where the R2 leak would actually surface.
**Fix:** either retitle T-TEST-06 to *"Agent-scoped listing (FR-022)"* and add a new row —
*"A `connect_contact_identity` linked to customer A never surfaces customer B's orders in
`GET /cases/{id}` context; relinking the identity re-scopes the context in the same request"* — or
rewrite T-TEST-06 to that scenario and give FR-022 its own row. As it stands a Critical risk is
carried by a test that cannot fail on it.

### M15 — FR-018's drain trigger is orphaned across slices
T-PROJ-02 (`<M>/lib/pending-projection.ts`, slice **1d**) *"stage and drain on link"*. The link that
triggers the drain is written by **T-API-08** (slice **1c**), whose description — *"`unlink` gated on
`connect.identities.manage`, audited, row never deleted"* — never mentions calling the drain. So
either the drain hook is silently added to a slice-1c file during slice 1d (an unrecorded edit), or
it is never wired.
**Fix:** state the call site explicitly in T-PROJ-02 (*"…invoked from `<M>/api/contact-identities/[id]/link/route.ts`
after a successful link, inside the same command"*) and add a forward reference in T-API-08's
description so the 1c implementer leaves the seam.

## Minor

### m1 — R9 references a "DoD" section the spec does not have
R9's mitigation reads *"`yarn i18n:check-hardcoded` in the DoD"*. There is no Definition of Done
section anywhere in the document, so the phase has no stated exit gate, no validation-command list,
and no statement of which of T-TEST-01…13 must be green to ship.
**Fix:** add a § Definition of Done naming the ordered validation gate (`yarn generate`,
`build:packages`, `typecheck`, `lint`, `test`, `build:app`, plus `i18n:check-sync`,
`i18n:check-hardcoded`, `template:sync`, `test:integration`) and the hard-gate test list.

### m2 — three spec-checklist sections are absent
`.ai/specs/AGENTS.md` § Spec Content Checklist requires *"TLDR, Overview, Problem Statement, Proposed
Solution, Architecture, Data Models, API Contracts, Risks & Impact Review, Final Compliance Report,
Changelog."* Missing: **Overview**, **Problem Statement**, **Final Compliance Report**.
**Fix:** add the three headings; Problem Statement can be lifted from § TLDR's first paragraph.

### m3 — FR-017 straddles slices, so slice 1c ships a resolve that does not project
FR-017 arrows at T-API-04 (slice 1c) and T-PROJ-01 (slice 1d). At the end of 1c, resolving a Case
writes a wrap-up and no `CustomerInteraction` — an observable half-behaviour if 1c is releasable.
**Fix:** say so explicitly in § Tasks (*"slice 1c is internally releasable; the Customer 360
projection lands in 1d"*) or move T-PROJ-01/02 into 1c and keep only the UI surfaces in 1d.

### m4 — T-API-02 is a policy, not a file, but is arrowed like a task
*"T-API-02 Optimistic locking on every mutating route; `updatedAt` in list and detail responses"* names
no file path — deliberately, since it is cross-cutting — yet FR-007 arrows at it as a discrete unit
of work. It cannot be checked off independently of T-API-01/03…08.
**Fix:** either give it a path (`<M>/lib/optimistic-lock.ts` — the shared reader/guard helper the
routes call) or reclassify it as a § Tasks standing rule rather than a numbered task.

### m5 — no task creates `<M>/api/openapi.ts`
§ API contracts says routes are *"documented in `api/openapi.ts`"*; T-API-01 folds it into "+ OpenAPI".
`packages/core/src/modules/customers/api/openapi.ts` is a module-level factory
(`createCrudOpenApiFactory` with a `defaultTag`) shared by every route in the module, so it is one
file, not per-route work.
**Fix:** add **T-API-15** `<M>/api/openapi.ts` — a `connect` CRUD OpenAPI factory with
`defaultTag: 'Connect'` — to slice 1a, ahead of T-API-01.

---

## Sweep results at a glance

| Sweep | Result |
|---|---|
| 1. Write-path | **FAIL** — 17 clean, 5 partial, 1 (FR-020) names a test. Readiness ✅ is false. |
| 2. Reverse | **PASS with notes** — no pointless tasks; T-SRCH-01, T-CH-01, T-WID-01, T-CMD-01 have no requirement. |
| 3. Cross-reference | **FAIL** — 5 dangling `T-TEST-*` refs, 10 range-only ids (T-UI-07 load-bearing), `T-API-03` gap, dangling "DoD" section ref. |
| 4. Slice buildability | **FAIL** — slice 1a cannot build: no module registration, incomplete scaffold, T-DATA-05 reds the suite. T-I18N-01 ordering is a real defect. |
| 5. Test coverage | **FAIL** — no task writes any test; 8 FRs and Critical risk R1 untested; T-TEST-05 underspecified, T-TEST-06 tests the wrong thing. |
| 6. Unlisted prerequisites | **FAIL** — 9 unlisted prerequisites, 6 of them blocking. |

FINDINGS: 6C/15M/5m
