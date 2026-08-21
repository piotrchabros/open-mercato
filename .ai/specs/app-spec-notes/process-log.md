# Process log — how the Mercato Connect spec reached its current state

**Session:** 2026-08-21 · single cez task on `cez/1d5b5fb2`
**Input:** a Claude Design prototype (`Mercato Connect.dc.html`, 13 screens, Polish UI)
**Output:** App Spec v3 + Phase 1 feature spec + frozen-surface list + 3 review registers

This is the *method*, recorded so it can be repeated or corrected. The headline lesson is at the
bottom and matters more than the sequence.

---

## Sequence

| # | Step | Skill / tool | Outcome |
|---|---|---|---|
| 1 | Task launched | **`/om-app-spec-writing`** (repo-local, `.ai/skills/`) | Framed the whole job. Its template and quality gates drove the document structure |
| 2 | Import the design | **`DesignSync` MCP** (`claude_design`) — `get_project`, `list_files`, `get_file` | Pulled the 1 914-line prototype and the DS bundle. **Later lost to a tmp cleanup mid-review** — see Lesson 2 |
| 3 | Read the method | `om-app-spec-writing/references/` — `app-spec-template.md`, `quality-gates.md`, `challenger-prompt.md` | Section skeleton, ROI bar, story quality bar |
| 4 | Platform gap analysis | Manual: `Grep`/`Read` over `packages/`, root + module `AGENTS.md`, `.ai/specs/` | Established what the platform already provides |
| 5 | **v1 written** | — | All 10 template sections. **Challenger/architect gates skipped** — the session forbade subagents at that point. Flagged honestly as OQ-9 |
| 6 | Round 1 review | **`Agent`** × 3 (DDD, Architect, PM/UX) | 75 findings. Register: `independent-review-register.md` |
| 7 | Owner decisions | **`CEZ:ASK`** — 4 questions, chip-rendered | in-instance only · B2B out · any DPA'd AI provider · nine disableable units |
| 8 | **v2 written** | — | v1 archived; 4→9 modules; phases reordered; formulas fixed |
| 9 | Commit plan | Manual, bottom-up | Building it bottom-up **caught an arithmetic error in v2** (AI Assist double-counted, 214→233) |
| 10 | Phase 1 feature spec | — | 40 commits, four slices |
| 11 | Readiness audit | **`/om-pre-implement-spec`** — *Skill tool returned "Unknown skill"*; executed its workflow manually from `.ai/skills/om-pre-implement-spec/SKILL.md` | BC clean across all 14 surfaces; 4 critical + 6 major canonical-mechanism gaps. Report: `.ai/specs/analysis/ANALYSIS-2026-08-21-connect-phase-1.md` |
| 12 | Round 2 review | **`Agent`** × 3 | 61 findings. Register: `-v2.md`. Prototype **re-fetched via DesignSync and committed** to `app-spec-notes/design-source/` |
| 13 | Mid-flight correction | **`SendMessage`** to a running agent | Re-pointed a reviewer at the restored files after the tmp cleanup |
| 14 | **v3 written** | — | Added §0 Evidence rules; reversed the `planner` decision; §4.6 extend-don't-parallel |
| 15 | Round 3 review | **`Agent`** × 3 | 40+ findings, incl. **19 violations of v3's own §0**. Register: `-v3.md` |
| 16 | Remediation | Manual | `frozen-surfaces.md` (authoritative); Phase 1 body swept to v3 |

Supporting tools throughout: `ToolSearch` (to load `DesignSync` and `SendMessage` schemas — both
deferred), `ListAgents` (monitoring), `Bash`/`Read`/`Write`/`Edit`, and `python3` for every
arithmetic re-derivation.

---

## What the reviewers actually cost and returned

| Round | Reviewers | Sub-agent tokens | Findings | Biggest catch |
|---|---|---:|---|---|
| 1 | 3 | ~560 k | 75 | Contact base was a 7-channel sum quoted as 9 |
| 2 | 3 | ~570 k | 61 | `planner` cannot express business hours — v2 had deleted its own calendar entity on that claim |
| 3 | 3 | ~480 k | 40+ | v3 violated its own evidence rules 19×; adoption credit over-stated ~4× |

Every round found the previous version's *confident* claims wrong. Author confidence was not a
predictor of correctness at any point.

---

## Skills that were available and NOT used

Worth knowing, because several would have caught things earlier:

| Skill | Why it would have helped |
|---|---|
| `om-ds-guardian` | The Inbox is a new custom composite; DS-token compliance was never reviewed |
| `om-auto-qa-scenarios` | `.ai/qa/scenarios/` is empty for Connect; the Phase 1 spec has test scenarios but no QA artefact |
| `om-gap-analysis` | Might have systematised the platform sweep that rounds 2–3 kept correcting by hand |
| `om-spec-writing` | The generic sibling; `om-app-spec-writing` covered this job |
| `om-implement-spec` | The next step, once slice 1a starts |
| `/code-review`, `/security-review` | No code exists yet |

---

## Lessons

**1. The mandated review gates are the load-bearing part of `om-app-spec-writing`, not the
template.** v1 skipped them (session constraint) and every subsequent round was paying that debt.
The template produces a well-shaped document; the gates are what make it *true*.

**2. Working copies in `tmp/` do not survive.** The prototype was deleted by a cleanup mid-review,
which cost one reviewer its entire design-fidelity audit and forced another to reconstruct the
file from session logs. **Commit the source artefact into the repo immediately** — it now lives at
`app-spec-notes/design-source/`.

**3. Repo-local skills are not Skill-tool registered.** `/om-pre-implement-spec` returns
"Unknown skill"; its `SKILL.md` must be read and executed by hand. Its Phase 2 table also says 13
BC surfaces where `BACKWARD_COMPATIBILITY.md` has 14 — the skill is stale, not the doc.

**4. Build estimates bottom-up, twice.** Doing so caught a double-count in v2 and an unreconciled
phase table in v3 that no reviewer had flagged.

**5. The failure that recurred three times was self-verification, not rule quality.**
v1 asserted platform capabilities without checking. v2 checked that artefacts *existed* without
checking they *worked*. v3 wrote explicit rules against exactly that — and broke them 19 times,
because the same author who wrote the claims also verified them. Each version fixed the previous
error and introduced a subtler one a level down: **wrong sum → wrong subtraction → wrong unit.**

> Adding better rules has now failed twice. What would change the outcome is making platform
> claims *mechanically checkable*: every capability assertion carries a `file:line` citation to
> the code path that **performs** the behaviour, confirmed by someone other than the author
> before that claim may carry a commit credit.

**6. Some questions cannot be closed by specifying.** The contact base's *unit* is not resolvable
from the prototype — no fixture separates inbound from outbound. Only operator data closes it, and
Phase 1's counting layer is what produces that data. Recognising this stopped a fourth revision
round that would have produced a fourth variant of the same error.
