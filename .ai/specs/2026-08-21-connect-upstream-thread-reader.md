# Connect Upstream Contract C — Authorized Thread Reader

| Depends on | Upstream Shared-Channel Authorization |

## 📝 TLDR

Add a narrowly authorized, batched `communication_channels` thread-reader facade for downstream inbox modules. It reads only explicitly allowlisted external conversations in one tenant and returns plain projections. Because system-authored inbound rows fall outside the existing sender-or-recipient participant predicate, this is a class (e) boundary change requiring maintainer sign-off.

## 📝 Problem Statement

Connect must render inbound thread bodies and direction without importing peer ORM entities or querying peer tables. `communication_channels` owns the message-link direction and transport metadata, so a facade in `messages` cannot produce the projection without reversing dependency direction. A general unscoped reader would weaken the participant boundary globally.

## 📝 Proposed Solution

Register `communicationChannelsThreadReader` in the existing hub DI entry. Contract E supplies immutable read feature and source-owned membership. Input carries server-derived tenant/organization/user/features, channel ID, and an allowlist of `externalConversationId`s. The hub uses Contract E authorization, proves every conversation belongs to that channel/scope, then returns plain ordered records. Missing bindings and valid empty threads are distinct; the allowlist narrows an already authorized channel and is never the grant itself.

## 📝 Contract and Security Invariants

- Require tenant ID, authenticated actor context, authorized channel ID, and a non-empty bounded allowlist.
- Require `communication_channels.shared_inbox.read`, source-authorize channel membership, and verify every conversation-to-channel binding; caller membership assertions are ignored.
- Reject or omit every conversation outside the tenant; never return partial data that reveals an ID exists elsewhere.
- The reader is batched and page-bounded; no arbitrary filter/query interface.
- Output contains only IDs, direction, bounded source-sanitized plain text, display-only attachment name/type/size metadata, timestamp, channel type, delivery state, and an opaque signed cursor. Every cursor binds tenant, organization, authorization epoch, channel, normalized allowlist, ordering and page shape; continuation revalidates current authorization and reapplies the current allowlist. Phase 1 has no attachment download/open URL or affordance.
- Raw ORM entities, entity managers, query callbacks, and cross-tenant error distinctions never cross DI.
- Existing participant-scoped message APIs remain unchanged. This facade is the explicit, separately reviewed exception.

## 📝 Edge Cases & Failure Scenarios

Mixed-scope allowlists fail closed. Missing hub binding is distinguishable from a bound empty thread without exposing foreign IDs. A decrypt/render failure yields a stable-position `{ kind:'unavailable', code:'content_unavailable', retryable }` placeholder; other authorized items and the page cursor remain valid, and Inbox offers item retry. Ciphertext never leaves the source. HTML, links, attachments, oversized bodies, and control characters have explicit sanitization/bounds tests.

## 📝 Risks & Impact Review

The facade relaxes a security boundary for system-authored inbound messages. The compensating controls are source ownership, tenant validation, server-derived actor context, strict conversation allowlist, bounded projection, and exhaustive cross-tenant tests. A human maintainer must approve the class (e) change. Rollback removes the new DI registration before any Connect Inbox release depends on it.

## 📝 Migration & Backward Compatibility

The DI key and input/output types are additive STABLE surfaces. Document them in `communication_channels/AGENTS.md`. No existing API, entity, event, or participant-scope behavior changes.

## 📋 Implementation Plan

- **THR-UP-01** Define bounded input/output schemas and public types.
- **THR-UP-02** Implement the source-owned reader and existing-DI registration.
- **THR-UP-03** Test revoked channel membership, sibling organization, wildcard and mixed feature scope, mixed tenants, foreign IDs, allowlist/page-size bounds, stable unavailable placeholders, empty vs missing, ordering/cursor paging and retry, cursor reuse after source-authorization revocation, changed normalized allowlist, projection sanitization, ciphertext safety, and attachment metadata that never exposes a URL/download handle. Case transfer/cross-Case cursor policy belongs to the Inbox wrapper because Contract C does not know Case identity.
- **THR-UP-04** Add public-contract documentation and obtain named maintainer sign-off.

## 📝 Final Compliance Report

One deployable capability: an authorized thread projection. It does not implement Connect Cases, Inbox UI, or outbound send.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| THR-UP-01 — bounded input/output schemas and public types | Done | 2026-08-22 | `lib/thread-reader.ts`; allowlist capped at 200, page at 100, body at 20 000 chars |
| THR-UP-02 — source-owned reader + existing-DI registration | Done | 2026-08-22 | `communicationChannelsThreadReader`; HMAC-signed cursor binds scope, authorization epoch, allowlist, ordering and page shape |
| THR-UP-03 — isolation, bounds, placeholder, paging and sanitization tests | Partial | 2026-08-22 | Unit coverage for revoked membership, sibling organization, foreign tenant, wildcard and missing features, allowlist/page bounds, unbound-vs-empty, stable `unavailable` placeholders, HTML/control-character sanitization, attachment metadata carrying no URL, deterministic paging, and cursor refusal on changed allowlist / changed authorization / changed page size / forgery. Integration tests for mixed-tenant allowlists against a real database still pending |
| THR-UP-04 — public-contract documentation + maintainer sign-off | Partial | 2026-08-22 | Documented in `apps/docs/docs/framework/modules/communication-channels.mdx` § Authorized thread reader. **Named maintainer sign-off for this class (e) change is still outstanding.** |

## Changelog

- 2026-08-22: Implemented THR-UP-01 and -02; unit coverage for -03 landed; docs written and maintainer sign-off outstanding for -04.
- 2026-08-21: Extracted PR C from the Inbox umbrella spec and recorded the owner-approved class (e) model.
