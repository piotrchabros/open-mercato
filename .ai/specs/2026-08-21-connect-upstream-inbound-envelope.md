# Connect Upstream Contract D — Authorized Inbound Envelope

| Depends on | Upstream Shared-Channel Authorization |

## 📝 TLDR

Expose a narrow source-owned `communication_channels` facade that lets Connect ingest read normalized inbound sender, subject, and classification evidence referenced by `communication_channels.message.received`. The persistent event remains identifier-only, avoiding raw PII in event storage.

## 📝 Problem Statement

The current event carries message/conversation/channel/provider/scope IDs but no sender, headers, subject, or body. Connect cannot classify loops, hash/encrypt an identity, or set a Case subject without unlawfully querying peer tables.

## 📝 Proposed Solution

Register `communicationChannelsInboundEnvelopeReader` in the hub DI surface. Input is the exact tenant, organization, channel, conversation, message, external-message, and link tuple from one event. The hub verifies the tuple refers to one inbound record under the channel's non-null owning organization and returns its immutable event-time projection mode/traffic-enabled snapshot. Only `connect_managed+enabled` results include normalized sender handle/type, bounded subject, derived auto-responder/bounce flags/reason codes, and an opaque immutable `replyTargetRef` with masked display. A sibling `resolveInboundReplyTarget` operation revalidates that reference at send enqueue/dispatch and applies source-owned Reply-To precedence; raw recipient/header data never enters Connect storage or browser payload.

## 📝 Contract and Security Invariants

- The complete tuple must match; mixed/foreign tuples return missing without identifying the failed component.
- Legacy/disabled channels return typed `not_connect_managed|channel_disabled` with the event-time mode snapshot and no PII projection. A later reprovision/reconnect never changes how an already emitted event is classified.
- Direction and historical tenant+organization+channel ownership are validated from the immutable ingest record; later channel deactivation/disconnect does not invalidate a legitimate event.
- Sender handle is available only over this server-only DI contract, immediately encrypted/hashed by Connect, never logged or persisted in events. Open Mercato modules share one trusted server process and DI is not a sandbox against malicious installed code; this class (e) contract explicitly enlarges the trusted computing base and does not pretend a caller-supplied module ID is authorization.
- Output has strict lengths/enums and excludes raw headers, HTML, body, attachments, credentials, and ORM entities.
- Reply-target output exposes only an opaque reference and masked label to Connect. Resolution is tenant+organization+channel+conversation scoped, rejects stale/wrong references, and explicitly classifies `reply_to|sender|ambiguous_multi_party|unavailable` without letting the browser choose an address.
- External requests cannot invoke the reader; exact tuple/scope validation limits accidental misuse by trusted modules. This class (e) boundary contract requires named maintainer/security approval of that threat model.

## 📝 Risks & Impact Review

The facade exposes PII to an in-process consumer. Full-tuple verification, bounded projection, immediate encryption, secrecy tests, and maintainer approval are mandatory. Rollback disables Connect ingest before removing the DI key.

Envelope result is typed `found|missing|not_connect_managed|channel_disabled|transient_error|permanent_invalid`. Reply resolution input repeats trusted tenant+organization+channel+conversation+opaque ref+source version and returns `resolved:{kind:'reply_to'|'sender',canonicalRecipientInternal,maskedLabel}|transient_error|stale_or_wrong_ref|ambiguous_multi_party|unavailable`. Missing/invalid/stale/ambiguous/unavailable is definitive before provider invocation; transient source/decryption failure retains queued state with bounded retry. No reply-resolver outcome becomes `unknown`, which is reserved for possible provider dispatch. Foundation activation health reports contract availability, and a bounded reconciliation worker replays uncompleted receipts after recovery.

## 📝 Migration & Backward Compatibility

The DI key and plain schemas are additive STABLE surfaces. Document exact fields/limits in the hub public-contract table. Existing events/storage remain unchanged.

## 📋 Implementation Plan

- **ENV-UP-01** Define envelope and opaque reply-target schemas/types with source-owned tuple authorization and Reply-To/multi-party policy.
- **ENV-UP-02** Implement envelope reader plus `resolveInboundReplyTarget` and existing hub `di.ts` registrations.
- **ENV-UP-03** Test every envelope/reply union member, legacy/disabled/reprovisioned and late event-time mode, wrong/stale reply target, Reply-To precedence, ambiguous multi-recipient failure, transient-before-provider retry, historical ownership after channel deactivation, mixed tuple, cross-scope, bounds/excluded fields, masked display, and logging secrecy. Foundation owns retry/exception integration tests.
- **ENV-UP-04** Document contract and obtain named class (e) maintainer sign-off.

## 📝 Final Compliance Report

One deployable capability: bounded inbound metadata projection. It does not create Cases, identities, or UI.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| ENV-UP-01 — envelope + opaque reply-target schemas and Reply-To policy | Done | 2026-08-22 | `lib/inbound-envelope.ts`; references are HMAC-signed and carry a source version so a policy change invalidates them |
| ENV-UP-02 — reader + `resolveInboundReplyTarget` + hub DI registration | Done | 2026-08-22 | `communicationChannelsInboundEnvelopeReader`; event-time classification backed by new `projection_mode_at_ingest` / `traffic_enabled_at_ingest` columns on `message_channel_links` (`Migration20260822180000_communication_channels`) |
| ENV-UP-03 — union, tuple, mode, reply and secrecy tests | Partial | 2026-08-22 | Unit coverage for every envelope and reply union member, each mixed-tuple component returning an undifferentiated `missing`, ingest-time vs current mode, pre-contract rows read as legacy, Reply-To precedence, ambiguous multi-party refusal, stale/forged/wrong-scope references, transient-before-provider retry, bounded fields, excluded fields and masked display. Foundation owns the retry/exception integration tests |
| ENV-UP-04 — contract documentation + class (e) sign-off | Partial | 2026-08-22 | Documented in `apps/docs/docs/framework/modules/communication-channels.mdx` § Inbound envelope reader, including the explicit trusted-computing-base statement. **Named maintainer/security sign-off is still outstanding.** |

## Changelog

- 2026-08-22: Implemented ENV-UP-01 and -02; unit coverage for -03 landed; docs written and sign-off outstanding for -04.
- 2026-08-21: Added after implementer review proved the identifier-only event cannot support ingest decisions.
