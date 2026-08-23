# Pre-Implementation Analysis: Mercato Connect — SLA Reporting Adapter

## Executive Summary

**Ready after named maintainer approval and source-contract implementation.** The narrowed spec is a pure optional `connect_sla_reporting` activation/API/UI layer: it parses/maps a versioned source DTO, never computes SLA, and leaves core analytics unchanged. No current code/surface conflicts exist.

Verified against actual Connect discovery/API/UI patterns, the separate source contract, root/spec/Core/UI/CLI/QA/BC guidance and all thirteen categories. No code changed; canonical review-checklist path is absent.

## Backward Compatibility

### Violations Found

None.

| # | Surface | Result |
|---:|---|
| 1 | Discovery | Additive conventional module/API/backend files. |
| 2 | Types | Exact additive adapter availability/query/error schemas. |
| 3 | Signatures | Internal soft resolver only; no existing change. |
| 4 | Imports | No moves/entity import; structural source contract only. |
| 5 | Events | None. |
| 6 | Widget | None; page discovery only. |
| 7 | API | Additive report URL; core operational byte shape unchanged. |
| 8 | DB | None. |
| 9 | DI | Consumes prerequisite key; adds no public adapter key. |
| 10 | ACL | Additive `connect_sla_reporting.view`. |
| 11 | Notifications | None. |
| 12 | CLI | None. |
| 13 | Generated | Additive module/API/page/ACL facts. |

BC section is present; new module/route/ACL/envelope freeze after approval.

## Spec Completeness

No missing/incomplete applicable sections: optional architecture, strict schemas, API/errors/timeout, ACL ordering, activation/disable, server/client UI boundary, i18n/DS/a11y/performance, manifest, integration tests, risks, BC, compliance/review/changelog are exact. Formula/query tests correctly moved to source spec.

## AGENTS.md Compliance

No violations. Conventional placement/discovery; soft optional DI and no ORM; server-derived scope; adapter ACL before source call; source authorization remains source-owned; OpenAPI/per-method metadata/Zod/apiCall; server-first UI with one justified client file/shared primitives/five locales/semantic tokens; self-contained package tests. Storage/encryption/commands/undo/locking/events/cache/search/worker are N/A.

## Risk Assessment

High false success is prevented by discriminated unavailable/no numeric defaults. Critical disclosure is prevented by adapter guard plus source scope/ACL. Medium outage/version skew is two-second fail-soft/strict parse. Low bundle risk has <20kB budget and browser evidence.

## Gap Analysis

No critical or important gaps. Nice-to-have: record exact bundle-analysis command in PR evidence.

## Remediation Plan

Before implementation approve additive adapter identifiers and land source contract. During implementation record generated/live disable matrix, strict parse, ACL/privacy/timeout/core-shape and UI evidence. Post-deploy monitor source timeout/error and avoid cache until evidence warrants it.

## Recommendation

**Ready to implement after named approval and source-contract implementation.**

## Re-Audit Changelog

- 2026-08-22: Owner selected SPLIT; re-audited adapter-only scope across all 13 categories and retained Ready verdict.
## External-Extension Re-Audit — 2026-08-22

Ready after its source. The adapter remains package-local and independently activatable; explicit host/template module registration closes the prior discovery gap without adding platform business logic.
