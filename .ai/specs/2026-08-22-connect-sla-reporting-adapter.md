# Mercato Connect — SLA Reporting Adapter

## TLDR

Add independently activatable, read-only `connect_sla_reporting`. It soft-resolves the separately specified `connectSlaAnalyticsReader`, maps its strict DTO without recomputation, and owns only a guarded API/page/navigation/activation layer. Missing SLA is explicit unavailable, never numeric zero; core analytics remains byte-identical.

Non-goals: formula/query/ACL ownership inside SLA, clocks/calendars/policies, persisted reports, core operational formulas, drilldown, routing or cost.

## Overview, Problem and Solution

An optional adapter must disappear independently, never import SLA entities, and never extend core analytics' strict response. Create `packages/connect/src/modules/connect_sla_reporting`, separate `/api/connect_sla_reporting/report` and `/backend/connect/analytics/sla`. Automatic page discovery composes navigation; no registry/widget/core response extension.

The module imports only the public structural source DTO, soft-resolves the reader, and does not call `connect_analytics`. Missing/disabled/old source maps to explicit availability reasons. The separate source contract owns all formula, query and `connect_sla.report.view` authorization.

## Exact Adapter Schemas

The source DTO is the exact `connect_sla.attainment.v1` schema from `2026-08-22-connect-sla-reporting-source-contract.md`. Adapter parses it strictly before returning:

```ts
type Available={capability:'available';formulaVersion:'connect_sla_reporting.adapter.v1';source:SlaSourceSummary}
type Unavailable={capability:'unavailable';formulaVersion:'connect_sla_reporting.adapter.v1';reason:'module_disabled'|'reader_unavailable'|'not_authorized'|'source_initializing'|'source_timeout'|'source_error';source:null}
type Response=Available|Unavailable
```

Strict query dates are inclusive completed UTC days, from≤to, max 92; adapter clamps to yesterday. If clamp empties range, return available empty only with a compatible/authorized reader, otherwise the mapped unavailable envelope. It never recomputes formula, fills dates, substitutes zeros, averages percentiles, or caches source data.

## API and Access Control

`GET /api/connect_sla_reporting/report?from=YYYY-MM-DD&to=YYYY-MM-DD` exports OpenAPI and per-method auth plus additive `connect_sla_reporting.view`. Setup grants/synchronizes manager/admin defaults. Server derives tenant/organization/actor; adapter feature is checked before resolving/calling source. Source independently checks `connect_sla.report.view`; denial maps to `not_authorized` and leaks no distinction. Wildcards use consolidated RBAC.

200 returns available/unavailable. Errors: 400 organization required, 401, 403 adapter denied, 422 invalid/oversized. Absence/init/timeout/error fail-soft 200; two-second timeout with cancellation where supported. Core operational route/schema remains unchanged.

## Activation and Module Boundary

Conventional `index/acl/setup/di`, API, backend metadata/page, components and locales make a real discovered module. Disabled adapter removes generated/live API/page/nav and leaves SLA/source/core analytics functional; stored grants remain inert. Enabled adapter with absent SLA remains live/unavailable. Re-enable converges without migration. Adapter has no entity/migration/event/queue/cache/search/notification/command/undo.

## UI/UX, i18n and Frontend Contract

Page `/backend/connect/analytics/sla`, metadata auth/adapter view, group `connect.nav.group`, order 32, timer icon. Server component loads initial report. The sole client file `SlaReport.client.tsx` owns date refresh via `apiCall`; no provider/bootstrap expansion. Use Page/Header/Body, KpiCard, SectionHeader, Alert, EmptyState, Loading/Error, semantic table, semantic tokens and Lucide labels. Show equation, eligible/met/breached/open/exclusions, daily samples, both formula versions, UTC cohort and freshness; every visual has text/table equivalent. Five locales en/de/es/ko/pl; keyboard/screen-reader/high-contrast/hydration tests. Incremental client budget <20kB gzip and response ≤250kB.

## Implementation Plan and File Manifest

1. Scaffold `connect_sla_reporting/{index,acl,setup,di}.ts` and run generation.
2. Add strict adapter/query/error validators and soft resolver/reason mapping.
3. Add guarded/OpenAPI `api/report/route.ts`.
4. Add backend page/meta, one client component and five locales.
5. Add package-local integration/browser tests and run generate, focused tests, package/root typecheck/build/lint/i18n/DS/harness with recorded runner.
6. Install `{ id: 'connect_sla_reporting', from: '@open-mercato/connect' }` in the host app's `modules.ts`, run `yarn template:sync:fix`, and verify generated/live enable-disable behavior. These two composition-file edits are installation wiring; all feature runtime code remains inside the external package.

No file under `connect_sla` is modified by this spec.

## Integration Coverage

Self-contained package `__integration__` fixtures with `finally` cleanup cover exact passthrough/strict parse; all unavailable reasons/timeout; adapter disabled live/generated removal; source absent/re-enabled; tenant/sibling-org/guessed scope; adapter ACL/wildcard and no source call before check; source authorization mapping; forbidden-field scan; route prefix/metadata/manifests; core operational byte shape; navigation coexistence; states/equation/table; keyboard/screen-reader/high contrast/hydration/bundle. Source formula cases belong only to the source-contract suite.

## Risks and Impact Review

False success is High and mitigated by discriminated availability/no defaults. Cross-scope disclosure is Critical and mitigated by adapter guard plus source-owned scope/ACL. Source outage/version skew is Medium and bounded/fail-soft. Bundle regression is Low and budgeted. Residual risk is visible unavailability until compatible source deploys.

## Migration & Backward Compatibility — All 13 Surfaces

Additive module discovery and exact adapter types/functions; no import moves/events/widgets/DB/DI public key/notifications/CLI; additive API URL, adapter ACL and generated module/API/page/ACL facts. Source DI/formula/ACL belong exclusively to prerequisite spec. Existing SLA/core analytics unchanged. New module/route/ACL/formula envelope become stable after approval. No migration/backfill.

## Final Compliance Report — 2026-08-22

Owner-selected adapter-only scope, optional coupling, server scope, adapter/source authorization order, strict API, activation, server-first UI, DS/i18n/accessibility/performance, tests and all 13 BC categories pass. Storage/encryption/commands/events are correctly N/A.

## Review — 2026-08-22

Owner selected SPLIT. Formula/reader/ACL/query moved to source contract; adapter is a pure optional API/UI activation layer. Verdict: Ready after named approval and source contract implementation.

## Changelog

- 2026-08-22: Replaced core response extension with optional adapter.
- 2026-08-22: Owner selected SPLIT; moved SLA formula/reader/ACL/query/tests to source contract and narrowed adapter to activation/API/UI.
