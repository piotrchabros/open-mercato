# Connect Upstream Contract B — Customer Interaction Retraction

## 📝 TLDR

Extend the source-owned customers interaction service with scoped duplicate-key reconciliation for its existing caller-supplied IDs and with tombstone/retraction. This upstream capability lets downstream modules safely project and later retract Customer 360 interactions without importing customer entities or writing customer tables.

## 📝 Problem Statement

Connect can call the existing interaction creation service, but a mistaken identity link also needs a source-owned way to retract the resulting timeline exposure. Hard deletion would destroy audit evidence, and direct downstream ORM access violates module boundaries.

## 📝 Proposed Solution

Register the additive stable DI service `customersInteractionLifecycle` with operations that validate a plain customer reference, reconcile deterministic source keys, and implement source-journaled retraction sagas. `resolveCustomerReference` returns a minimal `{ kind, id }` projection only for an active person/company in the trusted tenant+organization scope. `beginRetractionSaga` validates the complete inventory and hides every interaction in one source transaction or none. A monotonic fenced commit/abort decision controls `finalizeRetractionSaga`/restore. The customers module validates trusted service/actor feature `customers.interactions.retract`, scope, immutable source ownership/payload, and owns persistence semantics.

## 📝 Contract and Security Invariants

- Creation with the same deterministic interaction ID is idempotent only when tenant, customer, source namespace/key, and immutable payload are equivalent.
- Every projected interaction stores immutable source retraction group `(namespace, identityId, associationEpoch)`. `beginRetractionSaga` locks that group and accepts an inventory only when it exactly equals the source's active stored set; an omitted or extra key is a conflict and hides none.
- Begin/list/commit/abort/finalize are saga+epoch idempotent; commit and abort are mutually exclusive monotonic transitions; foreign-scope/source/unauthorized IDs are indistinguishable from missing.
- Ordinary timeline readers exclude pending-hidden and tombstoned interactions; restricted audit readers may retain evidence.
- Trusted server actor/service schema, wildcard-aware `customers.interactions.retract`, reason, tenant+organization, Connect namespace/key, and idempotency key are required for every saga operation.
- Existing `customers.interactions.create` callers retain behavior and signature compatibility.
- `resolveCustomerReference` accepts only `person|company`; wrong kind, deleted/missing, sibling-organization, and foreign-tenant references are all indistinguishable from missing and return no PII.

## 📝 Edge Cases & Failure Scenarios

Create acknowledgement loss resolves via strict-equivalence retry. Retraction responses lost after begin are recovered by source `listRetractions(sagaId, epoch)`. Commit/abort acknowledgement loss is resolved by source saga status; epoch fencing rejects stale recovery workers. Tokens never authorize any operation without revalidated trusted context and scope.

## 📝 Risks & Impact Review

Incorrect tombstone could hide legitimate history, so source-owned authorization, immutable audit, and exact tenant/customer tests are mandatory. Rollback stops accepting new tombstones but must not revive already tombstoned interactions automatically.

## 📝 Migration & Backward Compatibility

DI methods/types and storage fields are additive. Existing create signature stays available; any new arguments are optional or introduced through a sibling method. Document the new public contract. No direct entity relationship or column removal is included.

## 📋 Implementation Plan

- **CUS-UP-01** Add `lib/customer-reference.ts` and `lib/interaction-lifecycle.ts` public types plus stable `customersInteractionLifecycle` service registration in `di.ts` beside the legacy command; its named operations are `resolveCustomerReference`, `createInteraction`, `beginRetractionSaga`, `listRetractions`, `commitRetractionSaga`, `abortRetractionSaga`, and `finalizeRetractionSaga`. Validators require trusted actor/features and immutable source keys; reference validation returns only `{ kind, id }`.
- **CUS-UP-02** Add retraction-saga entity/migration keyed by `(tenant,organization,namespace,saga_id,epoch)` with complete inventory, monotonic decision, tokens/audit; add immutable indexed `(namespace, identity_id, association_epoch)` retraction-group plus interaction source/payload/retraction fields. Begin locks the group, compares the supplied inventory with every active stored member, and updates all-or-none; every ordinary timeline reader/enricher excludes hidden/tombstoned rows.
- **CUS-UP-03** Test wrong kind, deleted/missing customer, sibling-organization and foreign-tenant reference validation before any downstream mutation; also test legacy/duplicate create, omitted/extra/stale retraction-group inventory rejection, atomic all-or-none begin, lost acknowledgements, stale epoch, mutually exclusive decisions, revoked feature/foreign namespace, recovery, tenant+org isolation, and ordinary-read exclusion.
- **CUS-UP-04** Update public contract and backward-compatibility documentation.

## 📝 Final Compliance Report

One deployable capability: source-owned Customer Interaction lifecycle. It does not implement Connect identity, projection workers, or UI host addresses.

## Changelog

- 2026-08-21: Extracted and expanded PR B from the Connect projection umbrella spec to support full owner-approved unlink retraction.
