# Architect checkpoints — App Spec: Mercato Connect

**Spec:** `.ai/specs/2026-08-21-app-spec-mercato-connect.md`
**Date:** 2026-08-21
**Reviewer:** the spec author, running the architect checkpoints inline (see the process note in
the spec header and **OQ-9**).

Platform surface surveyed before scoring: `packages/core/src/modules/*` (40 modules),
`packages/*` (23 packages), and `.ai/specs/` (201 specs). Evidence paths are cited per finding
so the next reader can verify rather than trust.

---

## Checkpoint #1 — Workflow-to-platform mapping (§4)

### Capability discoveries that reduced the build

| Assumed gap | Actually exists | Evidence | Commits avoided |
|---|---|---|---|
| A polling loop for the wallboard | DOM Event Bridge: `clientBroadcast: true` on an `EventDefinition` + `useAppEvent` | `packages/events` AGENTS.md → DOM Event Bridge | ~3 |
| A bespoke SLA/escalation timer per case | `workflows.UserTask` already tracks assignment, SLA, escalation and completion | `packages/core/src/modules/workflows/data/entities.ts:481` | ~3 |
| Hard-coded handoff/routing predicates | `business_rules` rule engine with `executeRules` / `BusinessRule` | `packages/core/src/modules/business_rules/index.ts` | ~2 |
| A Connect-local transcript store | `call_transcripts` module, already spec'd, with a provider registry and ingest pipeline | `.ai/specs/2026-04-21-crm-call-transcriptions.md` | ~5 (moved upstream) |
| A new inbound-webhook route per provider | Shared `/api/webhooks/inbound/[endpointId]` with `WebhookEndpointAdapter` | `.ai/specs/2026-03-23-inbound-webhook-handlers.md` | ~2 |
| A Connect message store | `messages.Message` + `MessageChannelLink` + `ExternalMessage` already model inbound/outbound over channels | `packages/core/src/modules/messages/data/entities.ts`, `communication_channels/data/entities.ts:264` | ~4 |
| A bespoke contact resolver | `communication_channels/lib/contact-resolver.ts` + `thread-matcher.ts` | same module, `lib/` | ~2 |
| A saved-views system for Inbox filters | `perspectives` module (views panel) | `.ai/specs/SPEC-070-2026-04-04-perspectives-views-panel.md` | ~2 |
| An adapter contract for new channels | `ChannelAdapter` + `registerChannelAdapter`, with capability negotiation and validation at registration | `communication_channels/lib/adapter.ts`, `lib/registry.ts` | contract work avoided on all 6 channel packages |
| An "inbound customer message" author problem (`Message.sender_user_id` is non-nullable) | `communication_channels/lib/system-user.ts` already solves it | same | ~1 |

Total avoided: **≈ 24 commits** plus the entire adapter contract.

### Gaps confirmed as genuine (no platform equivalent found)

| Gap | Search performed | Conclusion |
|---|---|---|
| Service Case with a first-response SLA clock | `grep` for `sla` across all `data/entities.ts`; only `workflows` mentions it, in a `UserTask` doc comment. No entity named `*Ticket*` or `*Case*` anywhere in `packages/*/src/modules/*/data/entities.ts`. | Genuine. `UserTask` is a generic human task, not a channel-aware case. |
| Routing offer / accept / expire state machine | `grep` for `routing` across module `lib/`; hits are all unrelated (`customFieldRouting`, hostname routing, `send-as-user`). | Genuine. |
| Live agent presence | `planner` models availability schedules and rulesets, not live state. | Genuine — and deliberately not folded into `planner`; see challenger R-3. |
| Business-hours calendar | No calendar entity found outside `customers` calendar UI (`customers/backend/calendar`, a CRM meeting calendar). | Genuine. Kept inside `connect`; see OQ-5. |
| Voice / CTI | `grep` for `webrtc|SIP|twilio|voip|softphone` across `packages/*/src` returns exactly one false positive (`ui/src/primitives/color-picker.tsx`). `.ai/specs/2026-04-21-crm-call-transcriptions.md` puts "CTI / PBX / phone-call events" explicitly out of scope. | Genuine, and there is **no upstream artefact at all** — the only `platform`-scoped gap in the spec without one. Raised as **OQ-2**. |

### Overengineering removed

- Wallboard: SSE via the documented bridge, not polling.
- Escalation: bound to `workflows.UserTask` rather than a new timer subsystem.
- Handoff and sampling: `business_rules`, not conditionals in application code.
- Transcripts: consumed from `call_transcripts`, not duplicated.
- IVR: an annotated step list, not a node-graph editor (OQ-6).
- Channel packages: pushed *out* of the app modules into `packages/channel-*`, matching the
  existing `channel-gmail` / `channel-imap` precedent — they carry zero Connect domain logic.

### Double-counting corrected

The portal channel adapter appeared in both the WF5 matrix and the channel-coverage matrix.
Counted once (in the channel matrix); WF5's net contribution is 0 for that row. Noted inline in
§4 so the totals reconcile.

### Upstream (`platform`-scoped) dependency register

| Item | Upstream artefact | Status | Blocks |
|---|---|---|---|
| `packages/channel-whatsapp` | SPEC-056 (`2026-02-22-whatsapp-ai-chat-integration.md`) | Exists but AI-chat-oriented; must be folded into the `ChannelAdapter` contract or superseded | Phase 4 |
| `packages/channel-{webchat,messenger,instagram,sms}` | None needed — the `ChannelAdapter` contract is established and `channel-gmail`/`channel-imap` are the precedent | No new contract required | Phase 4 |
| `packages/channel-voice-*` | **None** | No spec, no issue, no PR found | Phase 7 — **OQ-2** |
| `call_transcripts` | `.ai/specs/2026-04-21-crm-call-transcriptions.md` | Spec'd, not implemented (no module directory exists) | Phase 7 voice quality only |

---

## Checkpoint #2 — Story-to-platform mapping (§6)

Each of the 27 stories was re-checked for a simpler platform-native solution. Three were
simplified:

| Story | Original approach | Simplified to | Saved |
|---|---|---|---|
| US-3.3 (review low-confidence matches) | A bespoke review screen with its own filtering and pagination | `DataTable` with a filter and a bulk action — the platform's standard list surface | ~2 commits |
| US-4.4 (breach notification) | A scheduled job per case, cancelled and rescheduled on every case change | One idempotent worker that reads stored timestamps each tick and catches up after an outage | ~2 commits, and it fixed the outage bug from challenger C-5 |
| US-5.3 (reply-channel preference) | A customer-preferences sub-system | A single field on the Case that pre-selects the composer's channel | ~2 commits |

Everything else was already at the simplest platform-native shape. Notable confirmations:
US-1.2 rides the existing `messages` + adapter send path with no new storage; US-1.4's
projection reuses the `CustomerInteraction` command pattern that `call_transcripts` established;
US-4.2's live updates are the documented event bridge; US-0.1/0.2 are the standard `setup.ts`
tenant-init and seed-defaults hooks.

### Cross-module boundary audit

Verified against the project rules in `AGENTS.md` ("No direct ORM relationships between
modules") and `packages/core/src/modules/staff/AGENTS.md`:

- Every cross-module reference in §1.4.2 is a plain `uuid` FK column, never a `@ManyToOne`.
  `communication_channels/data/entities.ts:1-13` documents this exact rule and is the model
  Connect follows.
- `customers` is reached only through the `CustomerInteraction` projection command and declared
  widget injections.
- `staff` is reached only through `availabilityAccessResolver` (DI, `allowUnregistered`) and
  `GET /api/staff/team-members/assignable` — its two declared public surfaces. Connect degrades
  gracefully when `staff` is absent, as `planner` already does.
- `sales` is read-only for context and writes only through existing commands.
- No Connect module imports another module's entity classes.

### Optimistic locking

Every user-editable Connect entity carries `updated_at` and is covered by the platform's
default-ON optimistic locking. The Inbox and Case detail are the highest-risk surfaces (two
agents on one case) and are called out in WF1 edge case 2 and US-1.5's failure path, surfacing
conflicts through `surfaceRecordConflict`. Non-`CrudForm` handlers (send, transfer, resolve)
must wrap with `withScopedApiRequestHeaders(buildOptimisticLockHeader(...))` — noted here so it
is not rediscovered at implementation time.

---

## Residual architectural risk

| Risk | Severity | Mitigation in the spec |
|---|---|---|
| Voice has no upstream path and is 30% of contact volume | **High** | OQ-2 raised as a blocker for Phase 7; Phases 1–6 deliver a complete product without voice |
| `call_transcripts` is spec'd but unimplemented | Medium | Phase 7 voice quality depends on it; chat/e-mail quality ships without it |
| SPEC-056 and `packages/channel-whatsapp` could be built twice | Medium | §8 assigns ownership to this spec and requires SPEC-056 to be updated or superseded before Phase 4 |
| Six new `packages/channel-*` packages is a large surface to maintain | Medium | They are transport-only with no domain logic, they follow an existing precedent, and each ships independently |
| The Case aggregate is the single point of coupling for four modules | Medium | All coupling is command-based; no shared state, no invariant spans modules (§4.5) |
| Self-review only — no independent architectural challenge | **High** | **OQ-9** |
