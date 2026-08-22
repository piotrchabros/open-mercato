# Pre-Implementation Analysis: Mercato Connect — SLA Source Facts Contract

## Executive Summary

**Ready after named maintainer approval and the Connect principal-classification prerequisite.** The owner-selected split yields one independently deployable Connect capability: immutable evidence, generation/lifecycle facts, delivery serialization and a scoped reader. Actual code lacks these additions, but the spec gives exact implementation contracts and introduces no SLA dependency.

## Evidence

Verified against the full spec, `BACKWARD_COMPATIBILITY.md`, root/spec/Core/Connect/Events/CLI/QA guidance, matching migration/concurrency/flush/decoupling lessons, and actual Connect entities, enqueue, ingest, transition, delivery outcome, events/outbox, DI, migrations and tests. The canonical review-checklist path is absent. No code was changed.

## Backward Compatibility — All 13 Categories

| # | Surface | Verdict |
|---:|---|---|
| 1 | Discovery | Additive entity/DI/events/migration files; generate required. |
| 2 | Types | Exact additive evidence/DTO/cursor V1 types. |
| 3 | Signatures | Existing route/command contracts retained; trusted normalization/new facade additive. |
| 4 | Imports | No moves; Auth through DI; no consumer import. |
| 5 | Events | Five additive exact IDs; existing events unchanged. |
| 6 | Widget | None. |
| 7 | API | No new/changed public URL or response. |
| 8 | DB | Additive generation/evidence columns and fact tables with safe backfill. |
| 9 | DI | Additive exact `connectCaseSlaReader`. |
| 10 | ACL | None. |
| 11 | Notifications | None. |
| 12 | CLI | None. |
| 13 | Generated | Additive registries only; inspect/harness refresh. |

No violation or missing BC section exists. New identifiers require approval and freeze on release.

## Spec Completeness and AGENTS Compliance

All required sections are present. Scope, data checks/indexes, Zod/trusted inputs, exact lock/conditional update, lifecycle emission, reader cursor/watermark, migration/rollback, file manifest, integration tests, risks, compliance/review/changelog are executable. Tenant+organization predicates, scalar peer IDs, identifier-only events, transactional outbox, no PII, soft Auth dependency, no cross-module ORM, no user-facing/API surface, no reversible historical-fact deletion, and intended-only migration workflow comply.

## Actual-Code Reconciliation

| Existing gap | Contract resolution |
|---|---|
| No principal snapshot | Exact immutable enqueue evidence/fail-closed derivation. |
| Unlocked legacy timestamp | Scoped Case lock plus conditional returning winner. |
| No generation | Persisted Case generation and outbound enqueue snapshot. |
| Missing wait stream | Exact transactional start/end rules. |
| No reader | Exact methods/DTOs/cursor/watermark/scope/errors. |
| Historical ambiguity | Explicit unknown backfill; no present-day lookup. |

## Risks

High: false human credit, wrong late-send generation and missed wait boundary; mitigated by immutable evidence, generation key and atomic facts. Medium: large-table migration/Auth absence; mitigated by bounded rollout and unknown-without-send-failure. Low: append-only fact growth; indexed keyset reads and later retention measurement.

## Gap Analysis and Remediation

No critical or important specification gaps remain. Before implementation obtain approval and land Auth/remediation. During implementation keep exact transaction ordering, use true PostgreSQL two-attempt races, generate/review intended SQL/snapshot, run decoupling/harness/build/typecheck and self-contained tests. Post-deploy monitor unknown evidence and fact lag without PII.

## Recommendation

**Ready to implement after named maintainer approval and Connect principal-classification prerequisite implementation.**

## Re-Audit Changelog

- 2026-08-22: Created after owner-selected split; all thirteen BC categories and actual source seams verified ready.
