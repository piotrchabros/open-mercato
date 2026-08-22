# Spec pipeline runbook — design prototype → implementable slice

How to turn a design prototype (or a feature brief) into a spec an agent can execute, without
shipping a plan built on unverified platform claims.

Derived from a controlled comparison of two independently-produced spec packages for the same
input — [`ANALYSIS-054`](../specs/analysis/ANALYSIS-054-2026-08-21-spec-approach-comparison.md).
Both packages scored ~37/50 with **inverted failure modes**: one produced a complete, file-pathed
task graph on top of an architectural premise that was wrong; the other verified the platform
correctly and produced no executable plan. Every gate below exists because a specific,
reproducible defect got past one or both of them. The defect is named on each gate — if a gate
ever feels like ceremony, re-read what it caught.

> **Not in the Task Router.** Root `AGENTS.md` is already over its byte budget
> (`yarn agents:check-budget` fails at 31635/31232). Link this file from a spec, not from the
> root instruction chain, until that budget is recovered.

## The shape of the problem

Two verification axes exist, and it is easy to run one and believe you ran both.

| Axis | Question | Runs it |
|---|---|---|
| **Internal correspondence** | Does the artifact contradict itself, the checklist, or the rules? | `/speckit-analyze`, `om-pre-implement-spec`, quality checklists |
| **External correspondence** | Does the artifact's claim about the platform match the platform? | Only an agent that re-opens the source |

A pipeline that only closes the first axis produces confidently-wrong specs. The clearest case
from ANALYSIS-054: a spec asserted *"the cross-channel primitive already exists and is unused at
the product level — the unified thread is an aggregation problem, not a storage one"*, survived
**three** review passes, and is wrong. Every strategy in `communication_channels/lib/thread-matcher.ts`
filters by `channelId`; the platform never produces a cross-channel thread. Nothing in that
pipeline was ever pointed at the codebase again after the research step.

## Pipeline

```
0.  PRE-SESSION      install skills · commit the input artifact
1.  SHAPE            om-brainstorm / om-ux-shape → owner decisions via CEZ:ASK
2.  SURVEY           om-gap-analysis → executable coverage verdicts
3.  DRAFT            /speckit-specify + /speckit-plan
4.  ▶ GATE 1         Claims ledger              ◀─┐ loop until threshold met
5.  DECOMPOSE        /speckit-tasks — a detector ◀─┤ (or HALT on divergence)
6.  ▶ GATE 2         Core-edit ledger            ◀─┤
7.  REVIEW           4 agents: DDD · Architect · PM-UX · Implementer ◀─┤
8.  REMEDIATE        once — never in place; obeys HALT ──────────────┘
9.  AUDIT            om-pre-implement-spec + /speckit-analyze
10. ▶ GATE 3         Frozen-surface list (all 14 BC surfaces) ◀─ loop
11. DS               om-ds-guardian on any new UI composite
12. JUDGE            om-judge-agent-session — neutral read of the whole session
```

One review round *by default*, not three. Gates 1 and 2 pre-empt the two classes that repeated
review rounds kept re-finding: wrong platform claims, and requirements with no mechanism. Where a
gate does need more than one pass, it loops against a countable threshold — see below.

## Loops and thresholds

Each gate is a **self-improving loop**: an agent step produces, a command step evaluates a
threshold, and `onFail.retry` sends the agent back until the threshold is met.

```
agent step ──▶ node .ai/scripts/spec-gate-check.mjs <gate>
                     exit 0  threshold met      → advance
                     exit 1  not met            → onFail.retry the agent step
                     exit 2  HALT               → stop looping, escalate to a human
```

| Gate | Threshold — all countable, none subjective | Retries |
|---|---|---|
| `claims` | zero OVERSTATED/REFUTED/UNCITABLE rows carrying a decision · zero unstruck false claims · ledger not UNGATED | 3 |
| `write-path` | every headline requirement has a task that performs its write · zero stale task cross-references | 2 |
| `core-edit` | the repo's rule is quoted · every (d)/(e) row justified and assigned an upstream PR | 2 |
| `review` | all four roles ran · zero unresolved criticals · **2 consecutive rounds with no new findings** | 3 |
| `frozen` | every contract surface covered · zero identifiers disagreeing with another document · zero wildcarded ID groups | 2 |

Three design rules make this converge rather than drift.

**1. Loop on gates, not on the document.** A gate loop is convergent — a ledger row is CONFIRMED or
it is not. A document-quality loop is divergent, because every revision introduces new claims that
were never verified. This is not theory: the engagement this pipeline came from ran three rounds on
one document and produced **wrong sum → wrong subtraction → wrong unit**. Each round fixed the
previous defect and introduced a subtler one a level down, and each felt like progress from the
inside. Its own retrospective concluded *"a v4 written the same way will produce a fourth variant."*

**2. Thresholds are counted, never scored.** "Zero uncitable rows carrying a decision" is checkable
by a script. "Quality ≥ 8/10" is a number the judge re-invents each round, so the loop can satisfy
it without improving anything. Every figure in `gate-state.json` is COUNTED from the ledger
artifacts — the same engagement propagated a miscounted headline entity figure across four
documents before anyone recounted it.

**3. The loop can conclude that looping is wrong.** `spec-gate-check` exits **2** and writes a
`HALT` marker when either:

- a round **introduces more unverified claims than it resolves** — the divergence signature above,
  caught by comparing this round's `newClaimsIntroduced` against `rowsResolved`; or
- the round budget is spent with the threshold still unmet.

On HALT the `remediate` step does not revise. It reports what is unresolved, names what would
settle it and who produces that, and asks the owner. Some questions genuinely cannot be closed by
specifying — a contact-volume baseline that depends on operator data no fixture contains is not a
writing problem — and recognising that is what stopped a fourth revision round from being attempted.

`review` uses **loop-until-dry** rather than a fixed count: two consecutive rounds with no new
finding. Fixed counts stop while the tail is still producing; a dry-round counter stops when
discovery is actually exhausted.

### Loop state

The agent maintains `.ai/analysis/spec-pipeline/gate-state.json`. Before re-entering a failed gate
it copies the current `gates` block to `previous.gates` and increments `round` — without those two
fields the divergence detector cannot distinguish a converging loop from a diverging one, and the
loop loses the only control that stops it going wrong slowly.

Two budgets apply, deliberately: the script's `--max-rounds` (soft, needs the agent to increment
`round`) and cezar's `onFail.max` (hard, enforced by the runner regardless).

Run `node .ai/scripts/spec-gate-check.mjs all` at any point for the full picture; it prints one
line per gate and each unmet condition beneath it.

---

## 0. Pre-session

```bash
sh scripts/install-skills.sh     # BEFORE the session opens
git add <the design prototype>   # first commit of the branch
```

Invoke the installer as a script, not as `corepack yarn install-skills`. A cezar run starts in a
fresh worktree with no `node_modules`, and Yarn 4 resolves `yarn <script>` through the install
state, so the yarn form dies before the installer runs — with `Couldn't find the node_modules
state file`, which reads like a broken installer rather than a missing install. The pipelines'
`setup` steps call `.ai/scripts/pipeline-setup.sh`, which does this plus the gate-state reset,
and installs dependencies too when the pipeline's later steps run yarn scripts (`--deps`).

**The skill registry loads at session start.** Skills installed mid-session are invisible to the
Skill tool — one package had to hand-execute three review passes by reading `SKILL.md` directly,
and its first readiness audit reported the code-review checklist dimension as *not covered*. When
that checklist finally became available, it immediately produced three majors the first pass
"structurally could not have found". A whole review dimension is lost to a 30-second command.

**Commit the input artifact.** One package lost its prototype to a `tmp/` cleanup mid-review,
costing a reviewer its entire design-fidelity audit. The other never committed it at all, so its
traceability is to a URL nobody can re-check. A committed prototype is also *data*: reading it as
a fixture rather than a picture is what caught an inverted KPI (a first-response SLA regression
presented as a gain), a screen count that disagreed with the nav config, and a chart that
reconciles against no denominator.

**Repo-local skills are not Skill-tool registered.** `/om-pre-implement-spec`, `/om-ds-guardian`,
`/om-gap-analysis` and friends live in `.ai/skills/` and return "Unknown skill". Read
`.ai/skills/<name>/SKILL.md` and execute it. Only `.agents/skills/` entries are registered.

## 1. Shape — `om-brainstorm` / `om-ux-shape`

Divergent pass **before** any artifact exists: alternatives including building nothing, converging
on a routing decision and a handoff brief.

Both packages deferred their scope decisions and paid for it. One blocked mid-`/speckit-specify`
on two clarifications; the other wrote an entire v1 on guessed answers and then reversed four
product decisions after the first review round. Surface them at step 1 and emit them as a single
`CEZ:ASK` so the owner answers in one tap.

`om-ux-shape` instead when the input is a vague UI/UX idea rather than a scoped feature.

## 2. Survey — `om-gap-analysis`

> "every coverage verdict is re-run by **executable gates** against a validated checkout of the
> platform"

This is the reuse-vs-build boundary, and it is the step both packages did by hand with
`Grep`/`Read`. One of them spent two entire review rounds correcting that hand-rolled sweep — it
deleted its own business-calendar entity on the claim that `planner` could serve it, then had to
reinstate it after discovering `planner` steps weekly recurrence as `cursor + 7 * DAY_MS`, never
parses `BYDAY`, and contains the string `timezone` zero times.

Output feeds Gate 1 directly: every "the platform already does X" verdict arrives with its
evidence attached.

## 3. Draft — `/speckit-specify` + `/speckit-plan`

Numbered FRs, success criteria, edge cases, data model, contracts. This is what speckit is good
at and it is worth keeping: 100 traceable FRs beat a beautifully-argued document with no
requirement list.

Note that the repo has no `.specify` scaffolding — no `setup-plan.sh`, no
`memory/constitution.md`, no templates. Derive the Constitution Check from root `AGENTS.md` +
`BACKWARD_COMPATIBILITY.md` + `.ai/ds-rules.md`, and relocate output from `specs/NNN-*/` to
`.ai/specs/{YYYY-MM-DD}-{kebab}.md` per `.ai/specs/AGENTS.md`.

Add on top of the FR list, from the DDD tradition: **numbered invariants**, each naming *who
writes the constrained column*, *in which transaction*, and *what happens when that module is
absent*. That form catches whole classes an FR list cannot express — for example that a
containment metric whose numerator omits "≥1 bot outbound message" scores an unanswered case as
contained, so containment **rises as the queue backs up**.

---

## ▶ Gate 1 — Claims ledger

> **Run `om-verify-spec-claims`** (`.ai/skills/om-verify-spec-claims/SKILL.md`, `core` tier — not
> Skill-tool registered, read and execute it). It carries the procedure, the four verdicts and the
> ten anti-evidence patterns. The summary below is the *why*; the skill is the *how*.

**Every sentence asserting that the platform already provides something gets a row.** No prose.

| Claim | Code path that *performs* it (`file:line`) | What would falsify it | Verified by |
|---|---|---|---|
| Hub already binds N channels to one thread | `communication_channels/lib/thread-matcher.ts` | any strategy filtering by `channelId` | — |

Three rules, enforced by the skill:

1. The citation is to the code that **performs** the behaviour — not the column, type, filename or
   test that suggests it. A passing test under a pinned environment is not evidence.
2. The falsifier column is mandatory. "What would make this false?" is the question that turns a
   claim into a check.
3. **Verified by ≠ author.** This is the only rule that has ever worked. Three rounds of review on
   one package established that author confidence did not predict correctness at any point — and
   its v3 wrote explicit evidence rules against exactly this failure, then broke them 19 times,
   because the same author who wrote the claims also verified them.

**Caught by this gate, from the comparison:** the thread-primitive claim above (one minute to
kill); *"nothing writes a `user_id IS NULL` row"* (`integration_credentials.user_id` is
`nullable: true` with a partial unique index deliberately permitting them); *"`page.meta.visible`
removes nav **and API surface**"* (consumed at exactly one site, `ui/src/backend/utils/nav.ts:307` —
the URL and the API stay reachable); *"the 60 s interval floor"* (`Math.max(10, … ?? 60)` — default
60, floor 10); and a fabricated *"the tests pass only because they pin `TZ=UTC`"* clause on a file
with zero local-time accessors.

**When a skill's checklist enumerates a contract surface, re-derive it from the source document.**
Both packages hit the same trap: `om-pre-implement-spec` says 13 BC surfaces,
`BACKWARD_COMPATIBILITY.md` has **14**. The one that trusted the doc was right. The one that
trusted the skill silently skipped surface #12 (AI Agent/Tool/UI Part/Override IDs, FROZEN) —
which its own slice added to.

## 5. Decompose — `/speckit-tasks`, as a detector

Scope to one slice. Every task names a **file path**. Then use the graph as an instrument:

> **The write-path test** — for every headline requirement, name the task that performs the write.
> If no task writes it, the requirement has no mechanism.

Decomposition finds things prose cannot, and both packages discovered this accidentally: one found
a missing entity because `FR-020`/`SC-004` had nothing to be measured from; the other caught a
double-counted arithmetic error by building its commit plan bottom-up. Do it deliberately, and do
it *before* review so reviewers have file paths to check.

The write-path test is what kills the thread-binding defect for good: *"which task writes
`ChannelThreadMapping.messageThreadId`?"* — none, and the read-only facade contract forbids it.

**Regenerate task IDs; never renumber.** A regex sweep corrupted one `tasks.md` once and left six
stale cross-references behind after the recovery — four pointing at a task that had become
something else entirely. The package's own audit had logged "renumbering fragility" as a risk two
passes earlier.

---

## ▶ Gate 2 — Core-edit ledger

**Enumerate every file outside the new package the plan touches. Classify each.**

| File | Class | Sanctioned alternative considered | Ships as |
|---|---|---|---|
| `communication_channels/di.ts` | (b) additive registration | n/a | same PR |
| `auth/data/entities.ts` — new column | **(d) entity/table change** | `EntityExtension` keyed on `auth:user` — **rejected because…** | **separate upstream PR** |

Classes:

- **(a)** new file in an existing module
- **(b)** additive DI / registry entry
- **(c)** additive optional field on a public type
- **(d)** entity or table change ← must justify + separate PR
- **(e)** function signature or behaviour change ← must justify + separate PR

**Rows (d) and (e) must each state why the sanctioned extension route was rejected, and must ship
as a separate upstream PR merged before the consuming PR.**

### What the rule actually says

The repo's written rule is narrower than "never edit core":

> `packages/core/AGENTS.md` § Extensions — "When extending another module's data, add a separate
> extension entity — **never mutate core entities**."

That is scoped to **entities/data**. Root `AGENTS.md`'s `Never` list has no general core-edit item;
editing core sits under **`Ask First`** ("changing public contracts… or touching multiple modules in
a way not covered by an existing spec"), and `BACKWARD_COMPATIBILITY.md` governs *how* a surface may
change, not whether.

The sanctioned mechanism ships and is in use. `communication_channels/data/extensions.ts` declares
`{ base: 'auth:user', extension: 'communication_channels:communication_channel', join: { baseKey: 'id',
extensionKey: 'user_id' } }` — the extending module owns the extension entity; the core entity is
untouched. That file also documents the one legitimate exception pattern: *"the hub spec owns the
EXTENSION declaration; the integrations module owns the COLUMN — coordinated change shipped in the
same PR."*

**Caught by this gate:** one package proposed a new `principal_kind` column on `auth.User` — the
precise thing the rule forbids — without recording that the extension route existed, in a module
that already extends `auth:user` that way. There is a real counter-argument (hot-path read, must
fail closed for a sentinel UUID with no `auth.users` row, and cross-link lookups go through the
query engine); the defect is taking the forbidden route without pricing the sanctioned one. The
other package edited `packages/core/AGENTS.md` on its spec branch and never flagged it as a core
change at all.

### The gap this rule does not cover

The platform has a sanctioned mechanism for extending core **data** (`EntityExtension`) and core
**UI** (injection spots), but **none for reading a core module's data from outside it** — `messages`
has no `di.ts` at all. So "only new modules extend core" is unachievable for reads: either you edit
core to add a source-owned read facade (which `.ai/lessons.md` →
*"Cross-module query precedent is not permission to copy storage coupling"* mandates), or you couple
to core's tables (which the same lesson forbids). Adding a read facade is a legitimate (a)+(b)
core edit. Say so in the ledger rather than letting it pass unremarked.

---

## 7. Review — four agents, one round

Run them in parallel, each blocked from reading the others until it has written its own findings.

| Role | Reads | Catches |
|---|---|---|
| **DDD** | invariants, formulas, glossary, cardinality | contradictions between invariants and derived values; gameable metrics |
| **Architect** | platform claims vs source | claims that survive Gate 1's ledger but fail on behaviour |
| **PM-UX** | the committed prototype **as a fixture** | ROI arithmetic, inverted KPIs, screens with no requirement |
| **Implementer** ← *the missing one* | the task graph | requirements with no write path; unpathed work; stale task refs |

The first three are a proven split — in the comparison, PM-UX reading the prototype as data
produced findings no other role could. **Implementer is the role neither process had**, and it is
the one that targets the executability dimension both packages lost points on.

Adjudicate disagreement, do not average it. When two reviewers conflict, one has usually gone a
level deeper: verifying that arithmetic reproduces is not the same as testing whether the *unit* is
right.

Budget: three reviewers × three rounds cost ~1.6M subagent tokens in the comparison. Four
reviewers × one round is ~700k.

## 8. Remediate — once, never in place

**Do not revise the same document three times in place.** One package's v3 became a delta against a
v2 that had been overwritten and no longer existed, with seven sections simply missing. That single
mechanical choice cost more score than any content defect. Either rewrite whole, or freeze v1 and
write the *next* artifact (the phase spec) instead of v2 of the same one.

**Never ship a claim you know is false, even under a banner.** Strike the sentence and leave
`[RETRACTED — see <review file> §N]`. Costs nothing, preserves the audit trail, removes the
falsehood from the implementer's path.

**Some questions cannot be closed by specifying.** When a number depends on operator data no
fixture contains, publishing a fourth revision produces a fourth variant of the same error. Say so,
name what would close it, and ship the measurement layer that produces it.

## 9. Audit — `om-pre-implement-spec` + `/speckit-analyze`

Now, not earlier. These close the *internal* axis: canonical-mechanism omissions (mutation-guard
wiring on custom write routes, `encryption.ts` maps, zod validators, module paths), cross-artifact
consistency, and coverage. They are good at it — one run produced four criticals and six majors,
all real, and closed the spec's own open question in passing.

They are not a substitute for Gates 1 and 2 and will not catch a wrong premise.

---

## ▶ Gate 3 — Frozen-surface list

One file, declared authoritative, covering **all 14** `BACKWARD_COMPATIBILITY.md` surfaces:
module/package IDs · event IDs · ACL feature IDs (enumerated, never behind a `<key>` wildcard —
they are DB-stored and renaming needs a data migration) · widget spot IDs (checked against the
shipped host regex) · DB tables and enums · DI names · notification IDs · AI agent/tool IDs ·
import paths · query-index entity types and DataTable ids.

Two rules that make it work: **"where any other document disagrees with this file, this file wins"**,
and a decision log recording *why* each choice was made.

**Caught by this gate:** event IDs frozen at three different values across three documents; widget
spots named to a `sales` pattern whose shipped regex is `kind ∈ {order,quote}` /
`surface ∈ {tabs,details}` and rejects both `return` and `sidebar`; ten FROZEN DB-stored ACL IDs
hidden inside one wildcard line; a module with zero declared features; four BC categories missing
entirely.

Even the package that produced this artifact still had residual drift between it and its own phase
spec on six Phase-1 ACL IDs. Reconcile before commit 1 — after the first migration these cost a
deprecation cycle each.

## 11. DS — `om-ds-guardian`

Run it on any new custom composite **before** implementation locks the patterns in. Neither package
ran it; one only scheduled it as a late task. Design prototypes reliably violate the
hardcoded-status-colour, arbitrary-value and raw-`<button>` rules throughout, and a literal port
carries all three into the codebase.

## 12. Judge — `om-judge-agent-session`

A neutral LLM-as-judge read of the finished session: validation evidence, project guards,
code-review findings, DS compliance. Both packages asked for independent sign-off in their own
words — one flagged it as an explicit caveat on its Critical finding, the other tracked it as an
open question for the whole engagement — and neither got it. This is the cheapest way to get it.

## Implementation — the second pipeline

The spec phase ends where `implement-slice` begins:
`.ai/cezar/workflows/implement-slice.yaml`, with bars in `.ai/scripts/impl-gate-check.mjs`.

Same three properties as the spec loops — loop on gates not on the artifact, count don't score,
and let the loop conclude that looping is wrong — applied to code.

**Parallelism is derived from file disjointness, not from optimism.** One implementer subagent per
group of tasks whose file sets do not overlap; tasks sharing a file are sequential within a group.
Two agents editing one file is a merge conflict wearing a parallelism costume.

**Four specialised critics, spawned in parallel, each blind to the others until it has written its
own findings.**

| Critic | Bar | Reads for |
|---|---|---|
| Architecture | 0 unresolved critical/high | boundary violations, cross-module ORM relations, missing ledger entries, degradation that throws instead of explaining |
| Security | 0 unresolved critical/high | tenancy scope, guard wiring, encryption maps and hash lookups, 404-not-403 |
| Code review | 0 unresolved critical/major **+ validation gate green** | check-then-act races, missing timeouts, cache invalidation on subscriber-driven writes, silent catch |
| Tests | 0 unresolved critical/major | declared tests exist and pass, both isolation tests, negative paths, no skipped or assertion-free tests |

**Each bar needs two kinds of evidence, and this is the load-bearing design choice.** A critic can
be argued with; a grep cannot. `impl-gate-check` runs its own mechanical checks over the module —
peer entity imports, top-level `requireAuth`, raw `fetch`, `console.*`, `any`, hardcoded status
colours, arbitrary Tailwind values, `dark:` on semantic tokens, `window.confirm`, skipped tests —
**and** counts critic findings by severity. Both must be clean. Critic sign-off alone would let a
loop terminate on "an agent said it looked fine", which is the subjective bar the spec pipeline
already rejects.

**Calibration matters more than coverage.** These rules were tested against shipped modules
(`planner`, `progress`, `currencies`) before being trusted. Two were wrong and were fixed: the
route-metadata rule flagged `api/openapi.ts` and `api/helpers.ts`, so a route is now defined as a
file that *exports an HTTP method handler*; and a "scope-free query" rule fired 31× on `currencies`
because scope routinely lives in a filter variable — ungreppable, so it was **deleted** and handed
to the security critic as judgement. A rule that cannot separate correct from incorrect code is
worse than no rule: it teaches people to ignore the gate.

The mechanical bars target **new** code. Existing modules predate several of these rules and will
show real-but-pre-existing findings; scope the gate to the module under construction.

**Divergence, in code.** If a round leaves more unresolved findings than the round before, the
build is getting worse and `impl-gate-check` exits 2. `review-round` then escalates instead of
fixing — the code equivalent of refusing to write a fourth variant.

## Definition of done for the spec phase

- [ ] Claims ledger complete; every row has a `file:line` and a non-author verifier
- [ ] Core-edit ledger complete; every (d)/(e) row justified and assigned to an upstream PR
- [ ] Every headline requirement has a named task that performs its write
- [ ] Frozen-surface list covers all 14 BC surfaces and is reconciled with every other document
- [ ] One review round complete with all four roles; findings remediated once, not in place
- [ ] No known-false claim remains unstruck
- [ ] Open questions state what would close them, and who produces that
- [ ] `node .ai/scripts/spec-gate-check.mjs all` exits 0, and no `HALT` marker remains
