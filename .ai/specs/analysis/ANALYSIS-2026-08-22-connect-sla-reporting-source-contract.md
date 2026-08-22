# Pre-Implementation Analysis: Mercato Connect — SLA Reporting Source Contract

## Executive Summary

**Ready after named maintainer approval and SLA clock implementation.** The owner-selected split yields one cohesive, read-only SLA-owned formula/query/ACL/DI projection with no adapter dependency. Actual code has no reader yet; the specification is exact enough to add it without exposing entities or duplicating semantics.

Verified against actual absence of SLA/reporting code, SLA clock contract, root/spec/Core/QA/BC guidance and all 13 categories. No code changed; canonical review-checklist path is absent.

## Backward Compatibility

No violations. Full audit: (1) additive modifications/discovery; (2) exact additive DTO; (3) additive summarize signature; (4) no moves; (5) no events; (6) no widget; (7) no API; (8) no DB; (9) additive `connectSlaAnalyticsReader`; (10) additive `connect_sla.report.view`; (11) no notification; (12) no CLI; (13) additive generated DI/ACL facts. BC section is present; formula/DTO/DI/ACL freeze after approval and evolve additively/v2.

## Spec Completeness and AGENTS Compliance

All required applicable sections pass: scope/architecture, exact Zod-derived DTO/formula/cohort/percentiles, source-owned tenant+organization+actor ACL, performance/no-cache, file plan, self-contained tests, risks, BC, compliance/review/changelog. Read-only correctly requires no commands/undo/guards/locking/entity/migration/encryption/event/worker/UI/i18n. No cross-module ORM or PII exists.

## Risks

High formula error: exact versioned equation and exhaustive source tests. Critical scope disclosure: source-owned feature plus dual predicates. Medium query load/late history: 92-day bounded aggregate, generatedAt and no cache. Low future formula correction: introduce v2 rather than mutate v1.

## Gap Analysis and Remediation

No critical or important gaps. Before implementation approve DI/ACL/formula DTO and complete SLA clocks. During implementation preserve one-query/snapshot and source authorization, run scope/DST/formula/generated/decoupling/harness/build tests. Post-deploy monitor p95/error without PII.

## Recommendation

**Ready to implement after named approval and SLA clock implementation.**

## Re-Audit Changelog

- 2026-08-22: Created after owner SPLIT; all 13 categories and source ownership verified Ready.
