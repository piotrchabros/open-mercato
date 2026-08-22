# Connect Upstream Contract A — Shared-Channel Send

| Depends on | Upstream Shared-Channel Authorization |

## 📝 TLDR

Add the smallest source-owned `communication_channels` contract required for a tenant shared inbox to send as an authenticated agent and reconcile an indeterminate send without resending. This is a separate upstream release and a class (e) authorization change; it lands this cycle before Connect Inbox.

## 📝 Problem Statement

The existing send-as-user path rejects actors who do not own a channel. A shared service mailbox needs authorized tenant agents to send without letting arbitrary DI callers bypass the ownership check. Earlier proposals also tried to relax `messages.Message.senderUserId`; verified code shows that change is unnecessary.

## 📝 Proposed Solution

Extend the hub-level `SendAsUserInput`/actor contract with additive caller correlation/idempotency fields, then thread them internally to adapter `SendMessageInput`. Delegate authorization to Contract E. The existing hub worker remains the sole provider caller. It emits a correlated persistent delivery-outcome event and exposes read-only status lookup. Do not expose an `allowSharedChannel` boolean and do not change `messages.sender_user_id`.

## 📝 Contract and Security Invariants

- Existing callers compile and behave identically when new optional fields are absent.
- The authenticated actor, tenant, features, channel, and credential scope are resolved server-side; browser payload cannot grant shared-channel authority.
- Cross-tenant channel/credential IDs return 404.
- Shared credentials use tenant+organization scope and `user_id IS NULL`; personal credentials keep existing ownership semantics.
- Caller supplies stable correlation ID, immutable attempt ID, plus canonical recipient/subject/body/thread fingerprint before enqueue. The first accepted submission atomically binds correlation to attempt; hub uniqueness `(tenant,organization,channel,correlation)` returns the winner only when attempt and fingerprint are identical. Reused/swapped attempt or different fingerprint is deterministic conflict and never overwrites/re-enqueues.
- Persistent hub outcome event `communication_channels.delivery.outcome_recorded` has schema `{ tenantId, organizationId, channelId, correlationId, attemptId, deliveryRevision, providerMessageId?, status:'sent'|'failed'|'unknown', reasonCode?, occurredAt }`; only the hub delivery worker writes it. Revision is monotonic per attempt, terminal `sent|failed` is fenced against regression/conflict, and subscribers match the complete scope plus attempt rather than correlation alone.
- A source-owned lookup requires server-derived tenant+organization+channel+trusted service/actor/features plus correlation/provider/idempotency evidence, reports adapter support (`supported|unsupported`), and returns only conclusive `sent|failed` or `unknown`; foreign correlations are indistinguishable from missing and lookup never sends.
- Every send/correlation mutation runs registered and legacy mutation guards; Contract E owns provisioning/membership guards.

## 📝 API and Type Changes

- Add optional sender authorization/correlation/idempotency fields at the hub `SendAsUserInput`/actor boundary and thread required subsets to adapter `SendMessageInput`, with deprecation-safe defaults.
- Add the fully tenant+organization+channel-scoped send correlation/outcome and read-only send-status reconciliation facade; its result echoes that scope and shared-channel provisioning/membership belongs to Contract E.
- Keep `communicationChannelsSendAsUser` as the DI owner; no caller-supplied bypass flag.

## 📝 Edge Cases & Failure Scenarios

The delivery intent persists trusted actor/channel scope. Contract E authorization is re-run immediately before adapter/provider invocation; revoke-between-enqueue-and-dispatch produces a definitive `failed:authorization_revoked` outcome without provider call. Inactive/foreign scope likewise fails. A provider timeout after dispatch is indeterminate; Connect owns reconciliation.

## 📝 Risks & Impact Review

This widens who may send through a shared credential and is class (e). It requires human maintainer approval, security tests for every scope/actor combination, and explicit label rationale. Rollback disables the new shared-send/correlation path after draining outcomes; Contract E owns authorization rollback.

## 📝 Migration & Backward Compatibility

STABLE exported input types change additively only. No existing required field or behavior is removed. Document the optional fields and authorization semantics in the module public-contract table; no database contract is narrowed.

## 📋 Implementation Plan

- **SND-UP-01** Extend hub/adapter types additively; add immutable scoped correlation-to-attempt/idempotency persistence+migration while keeping legacy callers byte-identical.
- **SND-UP-02** Update `commands/deliver-outbound-message.ts` to classify/emit persistent `communication_channels.delivery.outcome_recorded`; add event definition, status-lookup service/types, and `di.ts` registration. Contract E owns authorization/provisioning.
- **SND-UP-03** Add mutation-guard, tenant-isolation, legacy-caller, provider-evidence/idempotency, lookup support-matrix, and no-resend reconciliation tests, including swapped/reused attempt IDs rejected against their immutable correlation binding, the same correlation value used concurrently in two organizations/channels without cross-application, and duplicate/reversed unknown/sent/failed revisions that cannot regress or conflict with a terminal decision.
- **SND-UP-04** Update public contract docs and obtain named maintainer sign-off.

## 📝 Final Compliance Report

One deployable capability: authorized shared-channel send. It does not implement Connect UI, delivery workers, or thread reads.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| SND-UP-01 — additive hub/adapter types + scoped correlation persistence | Done | 2026-08-22 | `ChannelDeliveryAttempt` + `Migration20260822150000_communication_channels`; uniqueness is an expression index so `organization_id IS NULL` rows deduplicate too. Callers that omit `correlation` are byte-identical |
| SND-UP-02 — outcome classification, event, status lookup, DI | Done | 2026-08-22 | `communication_channels.delivery.outcome_recorded` written only by the delivery worker; `communicationChannelsSendStatusLookup` registered. Retry exhaustion is recorded by the worker, which is the only component that knows there will be no later attempt |
| SND-UP-03 — guard, isolation, idempotency and no-resend tests | Partial | 2026-08-22 | Unit coverage for fingerprint canonicalization, swapped/reused attempts, cross-tenant/organization/channel correlation isolation, terminal fencing, the identifier-only event payload, indeterminate-dispatch classification, dispatch-time re-authorization, and status-lookup masking. Integration tests (two organizations using the same correlation value concurrently, revoke-during-queued-delivery end to end) still pending |
| SND-UP-04 — public contract docs + maintainer sign-off | Partial | 2026-08-22 | Documented in `apps/docs/docs/framework/modules/communication-channels.mdx` § Send correlation and delivery outcomes. **Named maintainer sign-off for this class (e) change is still outstanding.** |

## Changelog

- 2026-08-22: Implemented SND-UP-01 and -02; unit coverage for -03 landed; docs written and maintainer sign-off outstanding for -04.
- 2026-08-21: Extracted PR A from the Connect Inbox umbrella spec; retained class (e) sign-off and dropped the false sender-column change.
