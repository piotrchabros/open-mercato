# Quickstart & Validation Guide: Mercato Connect

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/](./contracts/)

How to run and prove the feature works end to end. This is a validation guide — implementation belongs in `tasks.md` and the implementation phase.

## Prerequisites

- Node ≥ 20, Yarn 4.17.1, PostgreSQL reachable per `apps/mercato/.env`
- An initialised Open Mercato installation (`yarn initialize`) with the reused modules enabled: `communication_channels`, `messages`, `inbox_ops`, `customers`, `customer_accounts`, `portal`, `notifications`, `integrations`, `dashboards`, `workflows`
- At least one connected non-voice channel for US1 (e-mail or chat is enough — the existing adapters cover both)
- For voice stories: a connected telephony provider. Absent one, US1/2/3/4/6 still validate fully; voice-dependent assertions are expected to report the explicit-degradation path (FR-099), which is itself a test.

## Choosing the runner

Decide once, then keep it for the whole session:

- **Docker mode** — a compose `app` container is running → every `yarn X` below becomes `node scripts/docker-exec.mjs X`
- **Local mode** — otherwise, run `yarn X` directly

Record which mode you used when reporting results.

## Bootstrap

```bash
yarn install
yarn generate                 # discover new modules, events, subscribers, widgets, ACL
yarn build:packages
yarn db:generate              # review generated SQL — do NOT run db:migrate without asking
yarn mercato auth sync-role-acls   # push new ACL features to existing tenants
yarn dev
```

`yarn db:generate` is a schema-diff probe. Keep only migrations for the intended entity change; if unrelated modules emit drift, drop those files and update the affected module's `.snapshot-open-mercato.json` instead. Never run `yarn db:migrate` to silence the generator.

## Validation scenarios

Each maps to a user story and its acceptance criteria. Fixtures are created in setup and removed in teardown — no scenario may depend on seeded demo data (`.ai/qa/AGENTS.md`).

### V1 — Cross-channel thread (US1, P1) · **the gate for everything else**

```bash
yarn test:integration --grep "conversations:cross-channel-thread"
```

Setup: one customer with identifiers on two channels; one delayed order; inbound contacts on both channels referencing it.

Proves: one chronological thread carrying both channels plus bot and system entries (FR-009) · order context visible without navigation (FR-032) · reply on a channel different from inbound lands in the same thread (FR-013) · Enter sends, Shift+Enter newlines (FR-014) · close removes from the open list, writes the summary, advances to the next case (FR-016) · take-next assigns and confirms (FR-012).

Also proves **SC-018** — the same conversation opened through a pre-existing platform surface shows identical history, because both read the same `Message` rows (research R-01).

### V2 — AI assistance (US2, P1)

```bash
yarn test:integration --grep "conversations:ai-assist"
```

Proves: summary, suggestion, next actions with rationale and cited sources all render (FR-018, FR-021) · inserting a suggestion places **editable** text and sends nothing (FR-019) · rejection is recorded (FR-020) · a next action executes and reports outcome (FR-022) · with assistance disabled the panel is absent and the inbox is fully functional (FR-023).

The negative assertion — nothing is ever auto-sent — is the SC-005 test and must run on every build.

### V3 — Cases and SLA (US3, P2)

```bash
yarn test:integration --grep "service_tickets:"
```

Proves: list columns incl. explicit unassigned state (FR-033) · at-risk and breached render distinctly (FR-037) · status advances through the machine and records actor + time (FR-034) · illegal transitions are refused with 422 · export produces a spreadsheet-readable file (FR-035) · ticket ↔ conversation navigable both ways (FR-036).

**Concurrency**: two clients `PUT` the same ticket with the same `x-om-ext-optimistic-lock-expected-updated-at`; the second must receive **409** with the conflict body, never a silent overwrite (FR-038).

### V4 — Customer 360 and identity (US4, P2)

```bash
yarn test:integration --grep "conversations:customer-360"
```

Proves: header metrics and VIP flag (FR-028) · unified timeline across contacts, orders, notifications, bot interactions (FR-029) · four tabs (FR-030) · merged identifiers with confidence, re-check available (FR-026) · consents with state and grant date (FR-031) · **merge is reversible** (FR-027) · returning from the profile lands back on the same conversation.

### V5 — Live queues (US5, P2)

```bash
yarn test:integration --grep "contact_queues:wallboard"
```

Proves: totals and per-queue metrics (FR-040, FR-041) · below-target vs critical are visually distinct · pulling a case assigns it (FR-042) · agent states render (FR-043) · updates arrive over SSE without user action.

**Degradation (SC-021)**: emit `contact_queues.queue.degraded`, then assert the view states the data's age instead of continuing to present it as live (FR-044).

### V6 — Operator configuration (US6, P2)

```bash
yarn test:integration --grep "contact_center:settings"
```

Proves: disabling a module removes it from navigation with no restart (FR-071, SC-009) · disabling the module you are viewing returns you somewhere valid (FR-074) · the inbox refuses to be disabled, with an explanation (FR-072) · dependencies are declared and honoured (FR-073) · channel connect/disconnect updates counts (FR-075) · an expired integration credential names the system, the consequence and offers renewal (FR-077, SC-010) · service rules persist and apply (FR-080).

### V7–V12 — remaining stories (P3)

```bash
yarn test:integration --grep "contact_analytics:"    # US7  — FR-045..048
yarn test:integration --grep "contact_campaigns:"    # US8  — FR-049..053, consent suppression
yarn test:integration --grep "bot_intents:"          # US9  — FR-054..057
yarn test:integration --grep "telephony:flows"       # US9  — FR-058..061, publish drift
yarn test:integration --grep "contact_quality:"      # US10 — FR-062..065, missing recording
yarn test:integration --grep "portal:cases"          # US11 — FR-066..070
yarn test:integration --grep "conversations:ai-programme"  # US12 — FR-025
```

### V13 — Tenancy isolation · **non-negotiable**

```bash
yarn test:integration --grep "contact_center:tenancy"
```

For every new entity: a record created in tenant A must be unreachable from tenant B by id, by list, by search, by export and through the portal. This is SC-016 and FR-082; it is a hard gate, not a nice-to-have.

### V14 — Absent-module degradation

```bash
yarn test --testPathPattern module-decoupling
```

Registers only a subset of modules and asserts each capability degrades with a named explanation rather than throwing (FR-091). Also asserts no platform module imports or hard-requires a contact-centre module — the isomorphism guarantee from the post-design constitution check.

## Manual verification

Automated tests cannot judge whether the workspace is *usable*. After V1–V6 pass, walk the agent path by hand at `http://localhost:3000/backend/inbox`:

1. Take the next case. Can you state what it is about and the order status within 10 seconds (SC-002)?
2. Reply on a different channel than the inbound one. Does it land in the same thread?
3. Close the case. Is the summary editable before it is stored?
4. Open the wallboard. Which queue is most at risk — obvious within 5 seconds (SC-007)?
5. Disable a module in settings. Does navigation update without a reload (SC-009)?

Screenshot the inbox, wallboard and Customer 360 for the PR, per the `screenshots` label convention.

## Validation gate

The full CI-mirroring sequence from `.ai/agentic.config.json`, in order:

```bash
yarn build:packages
yarn generate
yarn build:packages
yarn i18n:check-sync
yarn i18n:check-usage
yarn typecheck
yarn test
yarn build:app
```

Advisory but worth running for this feature specifically:

```bash
yarn i18n:check-hardcoded   # the prototype is Polish-only — nothing may ship hard-coded
yarn i18n:check-values      # Polish locale coverage
yarn agents:check-budget    # if any AGENTS.md is touched
```

## Definition of done

- [ ] V1 and V2 pass — the P1 slice is independently shippable and demonstrable
- [ ] V13 passes — no cross-tenant leak on any new entity
- [ ] V14 passes — every capability degrades explicitly, no platform module depends on the suite
- [ ] Validation gate green in the recorded runner mode
- [ ] `yarn i18n:check-hardcoded` shows no new user-facing string outside locale files
- [ ] No hardcoded DS status colours or arbitrary Tailwind values in new `.tsx`
- [ ] Every user-editable new entity has `updated_at` and returns `updatedAt`; 409 conflict path tested
- [ ] Migrations + `.snapshot-open-mercato.json` committed; `yarn db:migrate` **not** run without explicit approval
- [ ] Manual walkthrough done, screenshots attached
