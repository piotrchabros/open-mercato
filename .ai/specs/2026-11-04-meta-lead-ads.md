# Meta Lead Ads integration (`meta_lead_ads`)

Detail source of truth: [`specs/001-meta-lead-ads/`](../../specs/001-meta-lead-ads/) (`spec.md`, `plan.md`, `data-model.md`, `research.md`, `quickstart.md`, `tasks.md`, `contracts/`). This spec summarizes scope, architecture and contract surface; it links to those files rather than duplicating them.

## TLDR

A new provider workspace package `packages/meta-lead-ads` (`@open-mercato/meta-lead-ads`, module id `meta_lead_ads`) turns every Meta Instant Form lead (Facebook and Instagram) into a CRM person, a `meta_lead` interaction and, optionally, a company and a deal, within about a minute of submission. It replaces Make/Zapier flows, deduplicates people by email and phone, notifies the owning rep, and gives admins a log with retry, backfill and nightly reconciliation. It registers with the `integrations` module and writes to the CRM only through `customers` commands.

## Overview

Leads submitted through Meta Instant Forms sit in Meta Leads Center or pass through paid automation tools. That adds delay and per-operation cost, offers no deduplication, and leaves the CRM without lead origin. The module is reusable across installations (BlueBee, SiteSpector, agency clients) and leaves room for further lead sources as separate adapters.

## Problem Statement

- First-contact speed decides lead-ads conversion; manual CSV exports and third-party automations add minutes to days of delay.
- No dedup: repeat submitters create duplicate CRM people.
- No attribution: campaign, ad set, ad, form and platform are lost.
- Non-technical admins cannot connect Pages without a developer.

## Proposed Solution

Scope (full FR-001..FR-046 and nine user stories in [`spec.md`](../../specs/001-meta-lead-ads/spec.md)):

- Facebook Login for Business OAuth, long-lived user token, Page selection and assignment to exactly one organization, Page subscription to `leadgen`, Page status (active, missing permissions, token expired, no leads access).
- Form discovery, default and custom field mapping (person, company, custom fields, note), consent capture, per-form deal rules (pipeline, stage, fixed or round-robin owner), "needs attention" flag when a form changes.
- Public signed webhook, durable store plus enqueue before ack, per-entry independent processing, idempotency on Meta lead id.
- Dedup by normalized email then E.164 phone, fill-empty-only updates.
- Monitoring: lead event log, retry with backoff (60 s, 5 m, 15 m, 40 m) and dead-lettering, token health, alerts, backfill (<= 90 days) and nightly reconciliation (48 h window).
- Rep notification (in-app and email), `lead.received` domain event, "Meta leads" tab on the person record.
- Privacy: encrypted tokens and payloads, retention purge, purge on person deletion, Meta data-deletion callback.

Non-goals: other lead sources (Google Ads, LinkedIn, TikTok), writing conversions back to Meta, managing ads or campaigns, direct ORM access to customers entities, a custom retry queue beyond the platform queue contract.

## Architecture

Detail: [`plan.md`](../../specs/001-meta-lead-ads/plan.md), [`research.md`](../../specs/001-meta-lead-ads/research.md).

- Provider package `packages/meta-lead-ads`; discovery files (`index.ts`, `acl.ts`, `events.ts`, `setup.ts`, `di.ts`, `notifications.ts`, `integration.ts`, `cli.ts`, `api/`, `backend/`, `workers/`, `subscribers/`, `widgets/`, `i18n/`).
- Webhook route verifies `X-Hub-Signature-256` over the raw body, stores a `MetaLeadEvent` per `changes[]` entry (status `received`), enqueues `meta-lead-ads-process`, and acks within 1 s.
- Process worker fetches the lead from the Graph API (version from `META_GRAPH_API_VERSION`, env override `OM_META_LEAD_ADS_GRAPH_VERSION`), applies mapping, dedups, then runs customers commands through `commandBus` with `systemActor: true`. Queues use `attempts: 1`; retry and dead-letter are module-owned status transitions.
- Scheduler (soft-optional via DI) registers per-organization reconcile (`0 2 * * *`), token health (`0 6 * * *`) and retention purge (`30 3 * * *`) jobs.
- Cross-module coupling only through events, widget injection, FK ids plus snapshots, and soft-optional `tryResolve` (scheduler, data_sync, notifications). Public routes read `meta_lead_ads_pages.meta_page_id` across tenants only to route a notification to its owner organization.

## Data Models

Detail: [`data-model.md`](../../specs/001-meta-lead-ads/data-model.md). All tables are tenant and organization scoped, prefixed `meta_lead_ads_`.

| Entity | Table | Lock |
|--------|-------|------|
| MetaConnection | `meta_lead_ads_connections` | yes |
| MetaPage | `meta_lead_ads_pages` | yes |
| MetaForm | `meta_lead_ads_forms` | yes |
| MetaLeadEvent | `meta_lead_ads_lead_events` | exempt (log, status machine) |
| MetaPersonKey | `meta_lead_ads_person_keys` | exempt (hashed dedup index) |
| MetaConsent | `meta_lead_ads_consents` | exempt (append-only) |
| MetaSettings | `meta_lead_ads_settings` | yes |
| MetaSyncRun | `meta_lead_ads_sync_runs` | exempt |
| MetaDeletionRequest | `meta_lead_ads_deletion_requests` | exempt |

Tokens, app secret, `raw_notification` and `raw_payload` are encrypted with tenant-scoped keys; email and phone keys are stored hashed. No ORM relations cross module boundaries.

## API Contracts

Detail: [`contracts/http-api.md`](../../specs/001-meta-lead-ads/contracts/http-api.md), [`contracts/webhook-payloads.md`](../../specs/001-meta-lead-ads/contracts/webhook-payloads.md). All under `/api/meta_lead_ads/`, with `openApi` exported per route. Authenticated routes require `meta_lead_ads.manage` or `meta_lead_ads.view_logs`, answer 404 (never 403) for foreign records, and use the standard optimistic-lock 409 on connections, pages, forms and settings.

| Route | Guard |
|-------|-------|
| `GET/POST webhook` | public, rate limited |
| `POST data-deletion`, `GET data-deletion/[code]` | public |
| `GET oauth/initiate`, `GET oauth/callback` | manage |
| `GET connections`, `GET connections/[id]/available-pages` | view_logs / manage |
| `DELETE connections/[id]` | manage |
| `GET/POST pages`, `DELETE pages/[id]`, `POST pages/[id]/check`, `POST pages/[id]/sync-forms` | view_logs (GET) / manage |
| `GET/PUT forms`, `POST forms/[id]/test-lead` | view_logs (GET) / manage |
| `GET lead-events`, `GET lead-events/[id]`, `POST lead-events/retry` | view_logs / manage |
| `POST backfill`, `GET sync-runs` | manage / view_logs |
| `GET/PUT settings` | view_logs / manage |
| `GET people/[personId]/submissions` | view_logs |

## Events, ACL, Notifications

Detail: [`contracts/events-and-jobs.md`](../../specs/001-meta-lead-ads/contracts/events-and-jobs.md).

- Events (PII-free payloads): `meta_lead_ads.lead.received`, `meta_lead_ads.lead.failed`, `meta_lead_ads.lead.dead_lettered`, `meta_lead_ads.page.status_changed`, `meta_lead_ads.connection.token_invalid`.
- ACL features: `meta_lead_ads.manage`, `meta_lead_ads.view_logs`; defaults `admin`/`superadmin` get `meta_lead_ads.*`, `employee` gets `view_logs`.
- Notification types: `meta_lead_ads.lead.assigned`, `.lead.unassigned`, `.connection.token_invalid`, `.lead.fetch_failed`, `.lead.dead_lettered`, `.page.no_leads_access`, `.api_version.deprecated` (channels in_app and email).
- Queues: `meta-lead-ads-process`, `-backfill`, `-reconcile`, `-token-health`, `-retention-purge`.
- Widgets: `meta_lead_ads.injection.person-submissions` (spot `detail:customers.person:tabs`), `meta_lead_ads.injection.integration-detail`.
- Subscribers: `purge-on-person-deleted` (`customers.person.deleted`), `notify-on-lead-received` (`meta_lead_ads.lead.received`). CLI: `configure-from-env`, `backfill`, `reconcile`.

## Integration Coverage

Suites live in `packages/meta-lead-ads/src/modules/meta_lead_ads/__integration__/`, self-contained, using a fake Graph HTTP server and API fixtures with teardown. Unit tests sit in `__tests__/`. Task mapping in [`tasks.md`](../../specs/001-meta-lead-ads/tasks.md).

| Suite | Routes and paths covered |
|-------|--------------------------|
| TC-META-001-webhook | `GET webhook` (challenge, wrong token 403); `POST webhook` (bad signature 401, oversize 413, rate limit 429) |
| TC-META-002-ingestion | `POST webhook` (multi-entry, duplicate, unrouted); `POST forms/[id]/test-lead`; `GET lead-events` ids; person, interaction, company creation |
| TC-META-003-dedup | `POST webhook` + `GET lead-events` (`matchType`); `PUT settings` (`defaultCountry`); email/phone dedup, fill-empty-only, no cross-org match |
| TC-META-004-deals | `POST pages/[id]/sync-forms`; `GET forms`; `PUT forms` (mapping, stale lock 409, `acknowledgeAttention`); deal and round-robin; consents; notifications; `GET people/[personId]/submissions` |
| TC-META-005-isolation | scoping and 404 for `GET pages`, `GET forms`, `GET lead-events`, `GET lead-events/[id]`, `GET sync-runs`, `GET people/[personId]/submissions`, `GET settings`; cross-org `POST pages` 409 |
| TC-META-006-retry | `GET lead-events`, `GET lead-events/[id]`, `POST lead-events/retry` (manage vs view_logs 403); backoff, dead-letter, alerts |
| TC-META-007-backfill | `POST backfill` (range > 90 days 400); `GET sync-runs`; nightly reconcile; stuck-event sweep |
| TC-META-008-privacy | `POST data-deletion` (valid and invalid `signed_request`); `GET data-deletion/[code]`; `GET/PUT settings` (stale lock 409); person-deleted purge; retention purge |
| TC-META-009-connection | `GET oauth/initiate`; `GET oauth/callback` (invalid and reused state); `GET connections`; `GET connections/[id]/available-pages`; `GET/POST pages` (`active`, `no_leads_access`, 409 `page_already_assigned`); `POST pages/[id]/check`; `DELETE pages/[id]`; `DELETE connections/[id]` (stale lock 409, tokens removed); no secrets in responses |

Key UI paths (connection wizard, forms mapping, recent leads, person tab) are exercised by the same suites through the backend pages.

## Risks & Impact Review

| Risk | Scenario | Severity | Area | Mitigation | Residual |
|------|----------|----------|------|-----------|----------|
| Meta Graph API changes | Version sunset breaks lead fetch | High | Process worker | Single version constant, env override, deprecation alert (FR-046), contract fixtures | Low |
| Lost leads | Webhook missed or worker down | High | Ingestion | Persist before ack, retry/dead-letter, nightly 48 h reconcile, manual backfill | Low |
| Token expiry or revoked access | Leads stop silently | High | Connections | Daily token health, alerts, Page status, instructions | Low |
| Cross-tenant leakage | Page routing or dedup crosses organizations | Critical | Webhook, dedup | Page assigned to one org, org-scoped hashes, 404 on foreign records, TC-META-005 | Low |
| PII in logs, events, SSE | Contact data exposed | High | Events, logging | PII-free event payloads, `createLogger`, encrypted payloads, no secrets in responses | Low |
| Wrong dedup merge | Shared phone or email merges distinct people | Medium | CRM data | Email first, phone fallback, fill-empty-only, conflict noted in activity | Medium |
| Webhook abuse | Forged or flooded POSTs | Medium | Public routes | HMAC check, 413 size cap, rate limit (fails open only when limiter absent) | Low |
| Duplicate processing | Concurrent redelivery | Medium | Worker | Unique key on Meta lead id, `coalesceBy` | Low |
| Deal step failure | Deleted stage or owner | Low | Deals | Event stays `processed` with `deal_step_failed`, person still created | Low |

## Final Compliance Report

- Tenant and organization scoping: every authenticated query filtered; only webhook routing reads cross tenants (read-only routing column).
- Encryption: `findWithDecryption` for encrypted entities; tokens and payloads encrypted.
- CRM writes via `commandBus` only; no cross-module ORM relations.
- Optimistic locking on connections, pages, forms, settings; lock-exempt rows documented.
- i18n for all user-facing strings (`en`, `pl`); internal errors prefixed `[internal]`.
- Pending verification against the implementation at merge: `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn test`, TC-META integration suites, `yarn build:app`.

## Migration & Backward Compatibility

All surfaces are additive: a new package and module, new tables (new migration and snapshot, no existing table touched), new routes under `/api/meta_lead_ads/`, new event ids, ACL features, notification types, queue names, scheduler ids, widget ids, DI keys and CLI commands. No existing contract surface listed in `BACKWARD_COMPATIBILITY.md` is modified or removed, and no deprecation bridge is needed.

Once released, the new ids become part of the contract: event ids, ACL feature ids, notification type ids and widget ids are FROZEN; event, job and notification payloads are ADDITIVE-ONLY; queue names and scheduler ids are STABLE (persisted in queued records and `scheduler_jobs`); API routes follow the additive-only rule. Any later rename or removal must follow the deprecation protocol (`@deprecated`, bridge for at least one minor version, `UPGRADE_NOTES.md`, spec reference). Rollout needs `yarn generate`, the module migration, and `yarn mercato auth sync-role-acls` (or tenant setup) for default grants.

## Changelog

- 2026-11-04: Initial spec summarizing `specs/001-meta-lead-ads` (design phase: spec, plan, data model, HTTP and event contracts).
