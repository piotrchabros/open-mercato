# Connect Upstream Contract E — Shared-Channel Authorization

## 📝 TLDR

Give each tenant shared channel one non-null owning organization, explicit user membership, and immutable read/send features. This source-owned authorization foundation is consumed by inbound envelope, thread reader, and send contracts; it performs no message read or send itself.

## 📝 Problem Statement

Personal-channel ownership cannot authorize a team inbox, while tenant-wide access violates organization isolation. Read and send contracts need one canonical source-owned answer to “may this actor use this channel in this organization?”

## 📝 Proposed Solution

Add non-null organization ownership for shared channels, an organization-scoped membership record, and wildcard-aware features `communication_channels.shared_inbox.read`, `.send`, and `.manage`. Provision/list/revoke membership through guarded, audited source commands requiring active organization-admin scope plus `.manage`. Provider adapters explicitly advertise additive `sharedMailbox: true`; Phase 1 implements separate Gmail OAuth and IMAP secret provisioning flows, each binding state/credentials/channel atomically to the server-derived organization and never returning secrets. Shared channels also carry immutable projection mode `legacy_customers|connect_managed`: Connect provisioning selects `connect_managed`, and existing Customers message subscribers must skip that mode so Connect/PR B exclusively owns Customer timeline projection and retraction. Existing personal channels keep owner-only semantics.

## 📝 Invariants

- A shared channel has exactly one tenant+organization owner scope; missing scope cannot activate.
- Owning organization becomes immutable once any membership, credential, conversation, or delivery exists. Before first use, reassignment atomically revokes/audits memberships. Rehoming after freeze is out of Phase 1 and requires a fenced history migration.
- Projection mode becomes immutable before first message/delivery. A channel cannot be observed by both legacy Customers subscribers and Connect projection; changing mode after traffic requires an out-of-scope audited history migration.
- Provisioning or activating `connect_managed` requires a source-verified Connect capability handshake covering active Foundation ingest, Contract D, Projection/PR B, registered recovery schedules, and compatible versions. If any capability is unavailable, creation/activation fails before traffic and the channel remains disabled or legacy; cutover to Connect mode and traffic enablement are one guarded transaction.
- Membership is unique by tenant+organization+channel+user and validates active organization membership.
- Read/send authorization requires matching scope, active membership, and the corresponding immutable feature.
- Foreign/missing IDs return indistinguishable 404/missing results.
- Browser payload never supplies trusted features or scope.
- Revoking the last active organization member with effective `.manage` is rejected. Provision/revoke serializes on the organization membership/admin set so concurrent revocations cannot both pass the check.

## 📝 Risks & Impact Review

Incorrect membership can disclose or send mail. Source-owned authorization, mutation guards, organization isolation tests, audit rows, and named maintainer approval are mandatory. Rollback disables dependent shared-inbox contracts before membership/provisioning.

Phase 1 includes an organization-admin settings page/API for channel ownership and member list/add/revoke. It has loading/empty/error/conflict states, first-admin bootstrap through existing org administration, confirmation for revoke, and recovery/audit view for mistaken revocation. Browser/API acceptance covers onboarding, self-escalation denial, last-manager protection, and revoke during queued delivery.

The same page provisions eligible shared email channels. It shows provider eligibility and credential-validation errors without echoing secrets, and clearly distinguishes a disabled legacy channel that must be reprovisioned from a newly owned channel.

Stable guarded admin routes are `GET/POST /api/communication-channels/shared-inboxes` (list/provision), `GET/POST/DELETE /api/communication-channels/shared-inboxes/{channelId}/members` (list/add/revoke, with revoke user ID in validated body), `POST /api/communication-channels/shared-inboxes/{channelId}/gmail/oauth/start`, `GET /api/communication-channels/shared-inboxes/gmail/oauth/callback`, `POST /api/communication-channels/shared-inboxes/{channelId}/imap/rotate`, `POST /api/communication-channels/shared-inboxes/{channelId}/reconnect`, and `POST /api/communication-channels/shared-inboxes/{channelId}/disable`. Provider secrets never appear in responses.

For an existing organization-owned channel, managers can reconnect expired/revoked Gmail consent, rotate and validate an IMAP secret, or disable/disconnect the provider without changing channel identity or erasing audit. Reconnect/rotation uses the same scoped OAuth/secret protections as provisioning. Disable atomically blocks new sends and claims: undispatched queued attempts become terminal `failed:channel_disabled` and require an explicit failed-child retry after reconnect; any attempt that may have crossed provider dispatch becomes `unknown` and is reconciliation-only. Reconnect dispatches only newly created nonterminal attempts, never revives terminal attempts or auto-resends unknown work.

## 📝 Migration & Backward Compatibility

New ACL IDs, membership entity, commands, optional provider capability, and shared-channel organization fields are additive. Existing personal channels/callers remain behaviorally identical. Migration classifies existing `user_id IS NULL AND organization_id IS NULL` channels rather than silently assigning them: tenant-infrastructure push channels remain legacy/non-Connect; email-capable channels are disabled for Connect until an administrator reprovisions them in an organization. Existing encrypted credentials are neither decrypted nor copied across scopes. Rollback disables newly provisioned shared-email channels and restores the pre-migration legacy classification, but does not erase membership/audit history. Once published, ACL/DI/API/entity identifiers follow repository compatibility rules.

## 📋 Implementation Plan

- **AUTH-UP-01** Add ACL features, shared-channel organization/membership and immutable projection-mode fields+validators+migration; update both Customers message-received/message-sent subscribers to skip `connect_managed` channels while preserving legacy behavior.
- **AUTH-UP-02** Add guarded/audited provision/list/revoke membership commands requiring `.manage` plus active org-admin scope, source authorization service, and atomic Connect-capability handshake/cutover that cannot enable traffic without an active projection owner.
- **AUTH-UP-EMAIL-01** Add the `sharedMailbox` provider capability and source-owned shared-email provisioning service/types. Implement IMAP's guarded organization-admin credential route using provider validation, existing credential encryption, `userId:null`, atomic organization-owned credential/channel creation, and secret-free responses.
- **AUTH-UP-GMAIL-01** Extend the Gmail provider's OAuth initiate/callback/state path for shared mailboxes: initiate stores nonce, initiating admin, tenant+organization and expiry server-side; callback verifies one-time state, rechecks active admin+`.manage`, exchanges/encrypts tokens, and atomically creates `userId:null` organization-owned credential/channel. Test state/scope tampering, duplicate/expired callback, admin revocation during OAuth, secret non-return, and final scope.
- **AUTH-UP-RECOVER-01** Add guarded/audited Gmail reconnect, IMAP rotate/validate, and provider disable APIs that preserve channel identity; atomically classify undispatched queued work as terminal failed, possibly dispatched work as unknown, and reject new sends while disabled. Test every queued/leased/sending boundary, explicit child retry after reconnect, terminal non-revival, unknown non-resend, expired consent, invalid/rotated secret, admin revocation, and accessible browser recovery states.
- **AUTH-UP-03** Test legacy personal and tenant-infrastructure channels, email-channel disable/reprovision migration and rollback, credential non-copying, missing org, inactive/foreign membership, wildcard features, cross-org/tenant isolation, and two concurrent last-manager revocations under the organization lock. Prove activation is rejected when Connect ingest/projection/contracts/scheduler are unavailable, atomic cutover admits no traffic gap, legacy mode still projects, while Connect-managed inbound/outbound/retry never invokes legacy Customers subscribers and unlink retracts the sole projection inventory.
- **AUTH-UP-UI-01** Organization-admin ownership/membership/shared-email setup page and guarded APIs with onboarding, provider eligibility, secret-safe validation errors, legacy reprovision guidance, revoke confirmation/recovery, audit, conflicts, and accessibility/browser tests.
- **AUTH-UP-04** Document public authorization contract and obtain maintainer approval.

## 📝 Final Compliance Report

One deployable capability: shared-channel scope and authorization. It neither reads message content nor sends/reconciles delivery.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| AUTH-UP-01 — ACL, ownership/membership/projection-mode schema, customers subscriber skip | Done | 2026-08-22 | Migration `Migration20260822120000_communication_channels` + snapshot; DB check constraints make an ambiguous shared-inbox scope unrepresentable |
| AUTH-UP-02 — membership commands, authorization service, capability handshake/cutover | Done | 2026-08-22 | `communicationChannelsSharedInboxAuthorization` DI key; per-channel write lock; last-manager protection |
| AUTH-UP-EMAIL-01 — `sharedMailbox` capability + IMAP shared provisioning | Done | 2026-08-22 | Fail-closed: no channel is created when the credential cannot be stored |
| AUTH-UP-GMAIL-01 — Gmail shared OAuth initiate/callback | Done | 2026-08-22 | One-time server-side state claimed by a single conditional UPDATE; admin access re-checked after consent |
| AUTH-UP-RECOVER-01 — disable / reconnect / rotate | Done | 2026-08-22 | `dispatching` marker added to the delivery command so undispatched and possibly-dispatched work are distinguishable |
| AUTH-UP-03 — isolation, wildcard, concurrency and migration tests | Partial | 2026-08-22 | Unit coverage shipped for authorization, capability handshake, provisioning eligibility, membership, recovery, cutover, OAuth state and the customers projection skip. Integration tests (cross-tenant/org API isolation, two concurrent last-manager revocations under the DB lock, migration + rollback) still pending |
| AUTH-UP-UI-01 — organization-admin page | Done | 2026-08-22 | Ownership/membership/provisioning/recovery page with loading, empty, error and conflict states; complete locales |
| AUTH-UP-04 — public contract documentation | Done | 2026-08-22 | `apps/docs/docs/framework/modules/communication-channels.mdx` § Shared inboxes. **Named maintainer sign-off for this class (e) change is still outstanding.** |

## Changelog

- 2026-08-22: Implemented AUTH-UP-01, -02, -EMAIL-01, -GMAIL-01, -RECOVER-01, -UI-01 and -04; unit coverage for -03 landed, integration coverage and maintainer sign-off outstanding.
- 2026-08-21: Extracted common organization/membership/ACL ownership from send and thread-reader specs after scope review.
