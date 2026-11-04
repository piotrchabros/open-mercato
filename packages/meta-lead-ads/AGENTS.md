# `@open-mercato/meta-lead-ads` — Agent Guidelines

Meta (Facebook / Instagram) Lead Ads integration. Receives `leadgen` webhooks, fetches the full lead from the Graph API and writes people, companies, activities and optional deals into the CRM through the `customers` commands.

- **Package**: `@open-mercato/meta-lead-ads` ⇒ **module id**: `meta_lead_ads`
- This is an integration provider package — keep all Meta-specific logic here. Do NOT add it to `packages/core`.
- Spec: `specs/001-meta-lead-ads/` (spec, data model, HTTP/event/webhook contracts, quickstart).

## Layout (`src/modules/meta_lead_ads/`)

| Path | Purpose |
|------|---------|
| `lib/` | Graph client, OAuth, signature check, mapping, dedup, CRM writer, lead processor, retry policy, backfill, purge, notifier, settings, env preset |
| `api/` | `webhook`, `oauth/{initiate,callback}`, `connections`, `pages`, `forms`, `lead-events`, `backfill`, `sync-runs`, `settings`, `data-deletion`, `people/[personId]/submissions`; `openapi.ts` |
| `workers/` | `process-lead`, `backfill`, `reconcile`, `token-health`, `retention-purge` |
| `subscribers/` | `notify-on-lead-received`, `purge-on-person-deleted` |
| `backend/meta-lead-ads/` | Connections/Pages page, leads log, settings, form editor (`forms/[id]`) |
| `widgets/` | Integration detail widget, person-submissions injection widget, notification renderer |
| `components/` | Section components and `types.ts` (keep in sync with `api/openapi.ts`) |
| `data/` | `entities.ts`, `validators.ts` (zod) |
| `integration.ts`, `di.ts`, `setup.ts`, `acl.ts`, `events.ts`, `cli.ts` | Registration, features (`meta_lead_ads.manage`, `meta_lead_ads.view_logs`), events, CLI |

## Flow

1. `POST /api/meta_lead_ads/webhook` verifies `X-Hub-Signature-256` against the raw body, stores one `meta_lead_events` row per `leadgen` entry (`received`), enqueues `meta-lead-ads-process`, answers 200 fast. GET answers the subscription challenge with the verify token.
2. The `process-lead` worker fetches the lead from the Graph API, maps answers, dedups by email then phone, then runs customers commands (person, company, `meta_lead` interaction, optional deal) via `commandBus.execute`. Each created id is persisted on the event row so retries resume.
3. On success it emits `meta_lead_ads.lead.received`, notifies the owner and writes an audit entry. Failures go through `lib/retry-policy.ts`.
4. Backfill (max 90 days), nightly reconciliation (last 48 h), token-health and retention-purge run as separate queues/schedules.

## Retry Policy

Transient failures retry after 60 s, 5 min, 15 min, 40 min; the 5th failed attempt dead-letters the event (`dead_lettered`, notification + `lead.dead_lettered` event). Attempt 3 raises the fetch-failed alert. Admins can retry failed and dead-lettered events from the leads log.

## Tenant Routing

The webhook is unauthenticated, so the target tenant/organization is resolved from `meta_page_id`. That lookup is the ONLY cross-tenant read in the module; everything after it is scoped by `tenantId` + `organizationId`. A Page maps to exactly one organization. Unknown pages are stored as `unrouted`.

## Always

- Scope every query by `tenantId` and `organizationId`; read encrypted entities with `findWithDecryption` / `findOneWithDecryption`.
- Write CRM data only through `customers` commands via `commandBus.execute`.
- Validate input with zod in `data/validators.ts`; support optimistic locking on editable entities (pages, forms, settings).
- Use `createLogger('meta_lead_ads')`, `useT()` keys under `meta_lead_ads.*`, DS status tokens.

## Ask First

- Changing event IDs, queue names, webhook/data-deletion paths, ACL features or the default retry schedule (contract surfaces).
- Widening the Graph permission set or changing `REQUIRED_SCOPES`.

## Never

- Never log or return tokens, app secrets, raw request bodies or lead PII.
- Never honour `graphBaseUrl` / `retryDelaysMs` (or `OM_META_LEAD_ADS_GRAPH_BASE_URL` / `OM_META_LEAD_ADS_RETRY_DELAYS_MS`) unless `NODE_ENV !== 'production'` or `OM_INTEGRATION_TEST=true` (`isTestOverrideAllowed`).
- Never create ORM relations to other modules; store plain uuids and external-id mappings.
- Never write other modules' entities directly.

## Read-Only Imports From Other Modules

Allowed for reads only: `CustomerEntity`, `CustomerPersonProfile`, `CustomerInteraction`, `CustomerPipeline`, `CustomerPipelineStage`, `findPeopleByAddresses`, `loadCustomFieldValues` / `customFieldRouting`, auth `User`, directory `Organization`, notifications `Notification`. All writes go through customers commands.

## Env Vars

| Var | Purpose |
|-----|---------|
| `OM_META_LEAD_ADS_APP_ID` / `OM_META_LEAD_ADS_APP_SECRET` | Meta app credentials copied per organization by `configure-from-env` |
| `OM_META_LEAD_ADS_VERIFY_TOKEN` | Webhook subscription verify token |
| `OM_META_LEAD_ADS_LOGIN_CONFIG_ID` | Facebook Login for Business configuration ID |
| `OM_META_LEAD_ADS_GRAPH_VERSION` | Graph API version (default `v24.0`) |
| `OM_META_LEAD_ADS_GRAPH_BASE_URL` | Test only: fake Graph server URL |
| `OM_META_LEAD_ADS_RETRY_DELAYS_MS` | Test only: comma-separated backoff override |

## Tests

- Unit: `yarn workspace @open-mercato/meta-lead-ads test` (specs in `__tests__/`).
- Integration: Playwright suites `TC-META-001` … `TC-META-009` in `__integration__/`, run against the fake Graph server (`__integration__/support/fake-graph-server.ts`); see `.ai/qa/AGENTS.md`.

## After Changes

- Run `yarn generate` after adding or changing module files; `yarn db:generate` for entity changes (review SQL + snapshot).
- Run `yarn typecheck`, `yarn lint`, `yarn workspace @open-mercato/meta-lead-ads test`, `yarn build:packages`.
- Update `components/types.ts` when `api/openapi.ts` changes, and the spec when behavior changes.
