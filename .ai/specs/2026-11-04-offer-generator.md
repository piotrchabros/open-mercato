# Offer generator (`offer_generator`)

## TLDR

A new workspace package `packages/offer-generator` (`@open-mercato/offer-generator`, module id `offer_generator`) ports the "auto" AI-generated HTML offers from the BlueBee Payload app (`/srv/bluebee/repo`) into Open Mercato. A user describes an offer, an AI model produces a branded, self-contained HTML proposal in a background job, the user refines or edits it, shares a public link, tracks views and engagement, exports a PDF, and links the offer to a CRM person, company or deal.

## Overview

Offers are currently produced in the BlueBee Payload app, outside the CRM, so they are not tied to customers or deals and their lifecycle is invisible to reps. The module brings the same flow into the CRM with tenant scoping, RBAC, optimistic locking and audit through commands. The "custom" TSX offers of the source app are not ported.

Scope:

- Create, list, edit and delete offers (metadata, status, value, validity, notes).
- Generate and refine offer HTML in queue workers, with progress reporting and run records.
- Manual inline HTML editing and a revision history with restore.
- A public, unauthenticated link per offer, served in an isolated document with its own CSP.
- View tracking and insights (visits, active time, scroll depth, per-section dwell time).
- PDF export via the existing `@open-mercato/documents` renderer.
- CRM tab widgets on person, company and deal detail pages.
- Tenant settings for template, company name, instructions, language, currency and models.

Non-goals: per-recipient tracked links, PostHog session replay, importing existing Payload offers (see Deferred), extending `sales` quotes (a different domain: priced line items), a custom queue or custom AI client.

## Problem Statement

- Offers live outside the CRM; reps cannot see which customer or deal an offer belongs to.
- Producing an offer needs a developer-run admin in a separate app.
- No view tracking inside the CRM, so follow-up timing is guesswork.
- The source app stores raw IPs, uses an in-memory rate limiter and injects unsanitized-style HTML into the page.

## Proposed Solution

Decisions (D1 to D12):

**D1. AI through the ai-assistant model factory, not a defined agent.** Call `createModelFactory(container).resolveModel({ moduleId: 'offer_generator', ... })` and pass the model to `streamText` from `ai`. The tenant allowlist comes from `AiTenantModelAllowlistRepository`. Precedent: `warranty_claims/lib/aiAssist.ts`. `OM_AI_OFFER_GENERATOR_MODEL`, provider and base URL overrides and the global `OM_AI_*` settings work unchanged. Rejected: `runAiAgentText` (chat stream shape, wrong for one 30 to 90 KB output in a worker) and direct `@google/genai` (forbidden by the ai-assistant guide).

**D2. Long work in a queue worker with a run record and a progress job.** The generate route creates an `offer_generator_generation_runs` row and a progress job, enqueues on `offer-generator-generate` (`attempts: 1`, `concurrency: 2`) and returns 202 `{ runId, progressJobId }`. The worker streams the output, records `bytes_received` about every 2 s, validates the HTML and applies it through the `offer_generator.offers.update_html` command. Completion and failure emit `offer_generator.generation.completed|failed` (`clientBroadcast`). The UI listens with `useAppEvent` and does one `GET` on mount to recover state; no polling.

**D3. PDF reuses the documents package renderer, no new dependency.** Import `renderPdfWithChromium` and its error guards from `@open-mercato/documents/modules/documents/lib/pdfRenderer`; it shares the process-wide concurrency cap with document exports. The Chromium path resolver (about 10 lines) is copied into `lib/pdf.ts` with env order `OM_OFFER_GENERATOR_PDF_CHROMIUM_PATH`, `DOCUMENTS_PDF_CHROMIUM_PATH`, `PUPPETEER_EXECUTABLE_PATH`. The request predicate is our own: no navigation, `data:` images and fonts, https stylesheets, fonts and images only from an exact-match host list (`OM_OFFER_GENERATOR_PDF_ASSET_HOSTS`, default `fonts.googleapis.com,fonts.gstatic.com,cdnjs.cloudflare.com`). Behavior change from the source: output is paginated A4 (the renderer fixes the format) instead of one long page, which the user accepted; print styles are injected before rendering. JavaScript is disabled in the renderer, which is fine for static HTML and CSS. Without Chromium the endpoint answers 503 `offer_generator.pdf.runtimeUnavailable`.

**D4. Public page plus a separate HTML endpoint with its own CSP.** The global CSP (`style-src 'self' 'nonce-...'`) would block the offer's inline styles in any app page. The public page `/oferta/<slug>-<token>` (path decided by the user) renders a same-origin iframe pointing at `/api/offer_generator/render/public/<segment>`, which returns the sanitized document. A route-specific header entry for `/api/offer_generator/render/:path*` sets `default-src 'none'; style-src 'unsafe-inline' https:; font-src data: https:; img-src data: https:; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, plus `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. The entry lives in `apps/mercato/next.config.ts` and is mirrored in the create-app template (approved by the user). The authenticated backend preview and inline editor use the same pattern via `render/offers/[id]`. Rejected: injecting HTML into a `div` (CSS leaks, CSP blocks it anyway), putting the nonce in offer styles, serving the page itself under `/api`.

**D5. Sanitization.** `sanitize-html` (already a repo dependency), applied on every write and again on render. Whole-document tags and `style` are allowed; `link` only for stylesheet or icon over https. `script`, `iframe`, `object`, `embed`, `form`, `input` and all `on*` attributes are removed; `data-*` is kept (including `data-user-edited`). URL schemes: `https`, `mailto`, `tel`; `data:` only on `img`. The doctype is re-added. `checkOfferHtmlComplete` and `checkRefineNotShrunk` are ported returning issue codes instead of Polish strings. The source's BlueBee-specific replacements and file-system image embedding are dropped.

**D6. CRM linking by ids only.** Offers store `customer_entity_id`, `customer_kind` (`person` or `company`) and `deal_id`, plus a `client_name` snapshot. No ORM relations. Three tab widgets are injected on `detail:customers.person:tabs`, `detail:customers.company:tabs` and `detail:customers.deal:tabs`.

**D7. Tracking.** Public `POST /api/offer_generator/public/sessions` (port of `offer-session`) with DI rate limiter instead of an in-memory map, no raw IP stored (HMAC-SHA256 `ip_hash` keyed by `OM_OFFER_GENERATOR_IP_HASH_SECRET`, falling back to `JWT_SECRET`), server-side internal-view detection via `getAuthFromRequest`, and new per-section dwell time merged into `sections` jsonb by per-key max. The first counted, non-internal view sets `viewed_at`, moves `sent` to `viewed`, bumps denormalized `view_count` and `last_viewed_at` with a native update that does not touch `updated_at` (avoids false 409s), and emits `offer_generator.offer.viewed`. The slug lookup is the single documented cross-tenant read (token compared timing-safe); everything after it is scoped to the offer's tenant and organization.

**D8. Data protection.** `prompt` and `notes` on offers and `input_text` on runs are encrypted via `encryption.ts` and read with `findWithDecryption`. `html` is not encrypted (it is the public document). The access token grows from 8 to 12 characters (`[a-z0-9]`, about 62 bits).

**D9. Optimistic locking, default on.** Offers and settings carry `updated_at`; `CrudForm` derives the header. The custom HTML PUT, revision restore and settings PUT enforce the lock inside commands with `enforceCommandOptimisticLockWithGuards`. Clients use `withScopedApiRequestHeaders(buildOptimisticLockHeader(...))` and `surfaceRecordConflict`. Worker-applied generations are system writes that skip the lock but bump `updated_at`, so a concurrent editor gets a 409.

**D10. Template and prompts are tenant settings.** `offer_generator_settings` holds company name, template HTML, extra instructions, default language and currency, default and alternate models. A neutral default template ships as a TS string (`lib/default-template.ts`; esbuild does not copy `.html`). The prompt rules from the source (sacred numbers, language lock, completeness, tables, `data-user-edited` hard lock, `__IMG_n__` placeholders) are ported with the company name parameterized.

**D11. Revisions replace Payload versions.** `offer_generator_offer_revisions` keeps previous HTML, capped at 50 per offer (oldest pruned). Command undo snapshots store revision ids, not HTML.

**D12. Fake AI generator for tests.** With `OM_INTEGRATION_TEST=true` and `OM_OFFER_GENERATOR_REAL_AI !== '1'`, `getOfferHtmlGenerator()` returns a deterministic fake: generate fills the settings template with the prompt's first line as `<h1>`; refine appends `<p data-fake-refine>` with the feedback; a prompt containing `__FAKE_INCOMPLETE__` yields HTML without `</html>` to exercise the failure path. No harness change is needed.

Decided by the user:

- **Public URL path:** `/oferta/<slug>-<token>` (kept in `PUBLIC_PATH_PREFIX`).
- **`next.config` CSP change:** approved; the route-specific header entry goes into `apps/mercato/next.config.ts` and the create-app template.
- **PDF layout:** paginated A4 accepted.

Still open:

- **Template and branding default.** The user will provide a new Astro website template. Until then the package ships a neutral placeholder template (`lib/default-template.ts`); an admin can paste a template and company name into Settings, with optional seeding from `OM_OFFER_GENERATOR_TEMPLATE_PATH`. Swapping in the Astro-derived template later is a content change only.

## Architecture

- Package `packages/offer-generator` follows the `packages/meta-lead-ads` precedent. Module `offer_generator` requires `customers`, `ai_assistant` and `progress`. Discovery files: `index.ts`, `acl.ts`, `events.ts`, `encryption.ts`, `setup.ts`, `di.ts`, `commands/`, `api/`, `backend/`, `frontend/`, `workers/`, `widgets/`, `i18n/`, `migrations/`.
- Flow: create offer (command generates slug and token) -> generate route -> run row + progress job + queue -> worker -> model factory -> `update_html` command (sanitize, validate, revision) -> events -> UI.
- Coupling to other modules is by ids, events, widget injection and package-level library imports (`documents` renderer) only.
- Public surface is two routes (render, sessions) plus the public page; all other routes are authenticated and scoped by tenant and organization.

## Data Models

All tables are prefixed `offer_generator_`, UUID primary keys, tenant and organization scoped. Entity ids are `offer_generator:<entity>`.

| Entity | Table | Lock |
|--------|-------|------|
| Offer | `offer_generator_offers` | yes |
| OfferRevision | `offer_generator_offer_revisions` | exempt (append-only) |
| OfferGenerationRun | `offer_generator_generation_runs` | exempt (status machine) |
| OfferView | `offer_generator_offer_views` | exempt (telemetry) |
| OfferGeneratorSettings | `offer_generator_settings` | yes |

- **Offer:** `owner_user_id`, `title`, `client_name`, `language` (`pl`|`en`), `status` (`draft`|`sent`|`viewed`|`accepted`|`rejected`), `customer_entity_id`, `customer_kind`, `deal_id`, `slug` (globally unique, not partial, so soft-deleted slugs are never reused), `access_token` (12 chars, immutable), `prompt` and `notes` (encrypted), `html` (sanitized, at most 5,000,000 chars) and `html_updated_at`, `value_amount` numeric(14,2), `currency_code`, `valid_until`, `sent_at`, `viewed_at`, `responded_at`, system columns `view_count`, `last_viewed_at`, `generation_status` (`idle`|`queued`|`running`|`failed`), `last_generation_run_id`, `created_at`, `updated_at`, `deleted_at`. Indexes on `(tenant_id, organization_id, created_at | customer_entity_id | deal_id | status)`.
- **OfferRevision:** `offer_id`, `html`, `source` (`generate`|`refine`|`manual_edit`|`restore`), `feedback`, `generation_run_id`, `created_by_user_id`, `created_at`; index `(offer_id, created_at desc)`.
- **OfferGenerationRun:** `offer_id`, `kind` (`generate`|`refine`), `input_text` (encrypted), `language`, `status` (`queued`|`running`|`completed`|`failed`), `progress_job_id`, `provider_id`, `model_id`, `bytes_received`, `chunks`, `error_code`, `result_revision_id`, `started_at`, `finished_at`, `created_by_user_id`, timestamps.
- **OfferView:** unique client-generated `view_key`, `offer_id`, `visitor_id`, `ip_hash`, `country`, `device`, `browser`, `os`, `referrer`, `is_internal`, `started_at`, `last_seen_at`, `active_ms`, `max_scroll_pct`, `beats`, `sections` jsonb; indexes on `(offer_id, started_at desc)` and `(offer_id, ip_hash, started_at)`.
- **OfferGeneratorSettings:** one row per organization: `company_name`, `template_html`, `extra_instructions`, `default_language`, `default_currency`, `default_model`, `alternate_models` jsonb, timestamps.

Migration and snapshot are hand-authored following the meta-lead-ads precedent (new tables, no backfill, never `db:migrate`).

## API Contracts

All under `/api/offer_generator/`, with `openApi` exported per route. Authenticated routes answer 404 for foreign records and use the standard optimistic-lock 409.

| Route | Guard |
|-------|-------|
| `GET/POST/PUT/DELETE offers` (`makeCrudRoute`; filters `search`, `status`, `customerEntityId`, `dealId`; `html` never returned; `prompt`/`notes` only on detail) | view (GET) / manage |
| `GET/PUT offers/[id]/html` | view / manage (lock, mutation guards) |
| `GET/POST offers/[id]/revisions` (list without HTML; POST restores) | view / manage |
| `POST offers/[id]/generate` (202, 400, 404, 409, 503) | generate |
| `GET generation-runs/[id]` | view |
| `GET offers/[id]/pdf` (503 `offer_generator.pdf.{overloaded,renderTimeout,runtimeUnavailable}`, 413 too large) | view |
| `GET offers/[id]/insights` | view |
| `GET/PUT settings` | settings.manage (lock) |
| `GET render/offers/[id]` (sanitized `text/html`, `private, no-store`, `noindex`) | view |
| `GET render/public/[segment]` | public, rate limited |
| `POST public/sessions` (same-origin check 403, body at most 4096 bytes 413, rate limit 429, `text/plain` JSON for `sendBeacon`) | public; no mutation guards (unauthenticated system telemetry, documented in `openApi`) |

Frontend: public page `frontend/oferta/[segment]` (`requireAuth: false`, `noindex`). Generation error codes: `ai_not_configured`, `empty_response`, `incomplete_html`, `refine_shrunk`, `max_tokens`, `timeout`, `provider_error`.

## Events, ACL, Commands

- Events: `offer_generator.offer.created|updated|deleted` (CRUD), `offer_generator.offer.viewed` (lifecycle, `clientBroadcast`), `offer_generator.generation.started|completed|failed` (lifecycle, `clientBroadcast`; payload `{ offerId, runId, kind, tenantId, organizationId }`, PII-free).
- ACL features: `offer_generator.view`, `.manage`, `.generate`, `.settings.manage`. Defaults: `superadmin` and `admin` get `offer_generator.*`; `employee` gets view, manage, generate.
- Commands: `offer_generator.offers.create|update|delete`, `offer_generator.offers.update_html`, `offer_generator.settings.upsert`.
- Queue `offer-generator-generate`, worker `offer_generator.generate`, progress job type `offer_generator.offers.generate`.
- Widgets: `offer_generator.injection.crm-offers` on the three customer detail tab spots (feature-gated on `offer_generator.view`).

## UI

Backend pages: offer list (`DataTable`), create (`CrudForm`, customer and deal comboboxes, prefill from query params, optional "Generate now"), detail with tabs (Content: preview frame, inline editor, generation panel, revisions; Details: `CrudForm`; Insights: stat tiles, views table, sections table) and settings. Header actions: copy or open public link, download PDF, delete. Public page: full-width iframe with auto height, privacy note, print button, tracker (visibility, idle, heartbeat, per-section dwell, skipped for `navigator.webdriver`). CRM widgets list linked offers with a "New offer" link carrying `customerEntityId`, `customerKind` and `dealId`. All strings via i18n (`en`, `pl`, `de`, `es`, `ko`); design-system tokens only.

## Integration Coverage

Suites live in `packages/offer-generator/src/modules/offer_generator/__integration__/`, self-contained with API fixtures and `finally` cleanup. Unit tests sit in `__tests__/`.

| Suite | Routes and paths covered |
|-------|--------------------------|
| TC-OFFER-001-crud-lock-isolation | `offers` create, update, stale `updatedAt` 409, delete; another organization cannot read |
| TC-OFFER-002-generation | `POST offers/[id]/generate` with fake AI: generate, refine, `GET generation-runs/[id]`, revision and progress job, `__FAKE_INCOMPLETE__` failure leaves HTML unchanged, concurrent start 409 |
| TC-OFFER-003-html-revisions | `PUT offers/[id]/html` (incomplete 400, script and `on*` stripped, stale lock 409); `GET/POST revisions` restore |
| TC-OFFER-004-public-render | `GET render/public/[segment]` (draft 404, sent 200 with CSP `script-src 'none'`, wrong token 404); `/oferta/<segment>` page 200 |
| TC-OFFER-005-tracking-insights | `POST public/sessions` (counted start, beat with sections 204, bot not counted, foreign origin 403, authenticated start internal); `GET offers/[id]/insights`; `viewed_at` and status `viewed` |
| TC-OFFER-006-pdf | `GET offers/[id]/pdf`: 200 `application/pdf` when Chromium is available, otherwise 503 `runtimeUnavailable` |
| TC-OFFER-007-crm-widget-ui | Playwright: person detail offers tab lists a linked offer; "New offer" prefills the create page |
| TC-OFFER-008-settings-lock | `GET/PUT settings`: defaults, update, stale lock 409 |

## Risks & Impact Review

| Risk | Scenario | Severity | Mitigation | Residual |
|------|----------|----------|-----------|----------|
| XSS via AI or edited HTML | Script or handler reaches public visitors | Critical | Sanitize on write and render, isolated endpoint, CSP `script-src 'none'` | Low |
| Cross-tenant leakage | Public slug lookup or tracking crosses organizations | High | Single documented global read, 12-char token with timing-safe compare, everything else scoped, TC-OFFER-001/004 | Low |
| Public CSP not applied | `next.config` entry missing or overridden | High | Required header entry (approved), asserted in TC-OFFER-004 | Low |
| PDF fidelity | Webfonts not loaded before `load`, paginated A4 differs from source | Medium | Asset host allowlist, print styles, documented behavior change | Medium |
| AI cost and failure | Timeouts, truncation, shrinking refines | Medium | Output cap, timeout, completeness and shrink checks, run records, single active run per offer | Low |
| Tracking abuse and privacy | Flooded sessions, IP retention | Medium | DI rate limits, per-offer and per-IP caps, hashed IP only | Low |
| False 409 for editors | View counters bump `updated_at` | Low | Native update that leaves `updated_at` untouched | Low |
| Missing Chromium or AI key | Feature unavailable in a deployment | Low | 503 with translated codes, deploy notes | Low |

## Final Compliance Report

- Tenant and organization scoping on every authenticated query; the only cross-tenant read is the public slug lookup.
- `findWithDecryption` for encrypted fields; no cross-module ORM relations.
- Writes through commands and `runCrudCommandWrite`; mutation guards on authenticated mutations.
- Optimistic locking on offers and settings; exempt entities documented.
- i18n for all user-facing strings; internal errors prefixed `[internal]`.
- Pending verification at merge: `yarn generate`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn template:sync:fix`, `yarn agents:check-budget`, `yarn build:app`, TC-OFFER integration suites.

## Migration & Backward Compatibility

Purely additive: a new package and module, new tables (new migration and snapshot, no existing table touched), new routes under `/api/offer_generator/` and a new public page, new event ids, ACL features, queue name, worker id, progress job type, widget ids, DI keys and env variables. The package is registered in `apps/mercato` and the create-app template (`modules.ts`, `package.json`), the Dockerfile and the peer-deps allowlist. The only app-config change is a route-specific CSP header entry for `/api/offer_generator/render/:path*` in `apps/mercato/next.config.ts` (mirrored in the template); it scopes to new routes and leaves the global CSP and existing header entries untouched. No existing contract surface in `BACKWARD_COMPATIBILITY.md` is modified or removed, so no deprecation bridge is needed.

Once released, event ids, ACL feature ids and widget ids are FROZEN; payloads are ADDITIVE-ONLY; queue names and the progress job type are STABLE. Rollout needs `yarn generate`, the module migration, and `yarn mercato auth sync-role-acls` (or tenant setup) for default grants, then `yarn mercato configs cache structural --all-tenants`.

## Deferred

- Per-recipient tracked links (`offer_recipients`, `?r=` codes).
- PostHog session replay.
- Importing existing Payload offers.
- "Custom" TSX offers.
- Single long-page PDF (would need an additive optional `pdfOptions` in the documents renderer).

## Deploy Notes

- Production image needs `INSTALL_CHROMIUM=1` for PDF; otherwise the endpoint returns 503 (same as documents). Optional overrides: `OM_OFFER_GENERATOR_PDF_CHROMIUM_PATH`, `OM_OFFER_GENERATOR_PDF_ASSET_HOSTS`.
- The worker process needs an AI provider key (for example `GOOGLE_GENERATIVE_AI_API_KEY`). Optional `OM_AI_OFFER_GENERATOR_MODEL` (for example `google/gemini-3.1-pro-preview`), `OM_OFFER_GENERATOR_AI_TIMEOUT_MS`, `OM_OFFER_GENERATOR_MAX_OUTPUT_TOKENS`.
- Set `OM_OFFER_GENERATOR_IP_HASH_SECRET` (falls back to `JWT_SECRET`); optional `OM_OFFER_GENERATOR_TEMPLATE_PATH` to seed the template.
- `docker-compose.fullapp.yml` in the live checkout has uncommitted local changes; apply these as a deploy step, not a code change.

## Changelog

- 2026-11-04: Initial spec (design phase): decisions D1 to D12, data model, API and event contracts, integration coverage TC-OFFER-001..008. Decided: public path `/oferta`, CSP header change approved, paginated A4 accepted. Open: template default (Astro template to be supplied; neutral placeholder meanwhile).
