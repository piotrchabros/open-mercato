# `@open-mercato/offer-generator` — Agent Guidelines

AI-generated HTML offers with a public link, view tracking and PDF export. Offers are generated and refined in background jobs, edited by hand, versioned as revisions and shown to the client at `/oferta/<slug>-<token>`.

- **Package**: `@open-mercato/offer-generator` ⇒ **module id**: `offer_generator`
- Keep all offer logic here. Do NOT add it to `packages/core`.
- Spec: `.ai/specs/2026-11-04-offer-generator.md`. User guide: `apps/docs/docs/user-guide/offer-generator.mdx`.

## Layout (`src/modules/offer_generator/`)

| Path | Purpose |
|------|---------|
| `lib/` | `generation` (run start + worker logic), `ai-client` (model factory, fake generator), `prompts`, `html-validate`, `html-sanitize`, `html-utils`, `slug`, `public-offer`, `tracking`, `views-repository`, `pdf`, `settings`, `serializers`, `queue`, `constants`, `default-template`, `http` (route helpers) |
| `api/` | `offers` (CRUD), `offers/[id]/{generate,html,revisions,insights,pdf}`, `generation-runs/[id]`, `settings`, `render/offers/[id]` (backend preview), `render/public/[segment]`, `public/sessions`; `openapi.ts` |
| `commands/` | `offers.ts` (create/update/delete/`update_html`), `settings.ts` (upsert) |
| `workers/` | `generate-offer` (queue `offer-generator-generate`) |
| `frontend/oferta/[segment]/` | Public offer page (iframe + tracker) |
| `backend/offer-generator/` | List, `create`, detail/edit, `settings` pages |
| `widgets/` | `crm-offers` tab injected into person, company and deal detail |
| `components/` | Editor, preview frame, insights, status badge, `public/OfferTracker`; `types.ts` (keep in sync with `api/openapi.ts`) |
| `data/` | `entities.ts`, `validators.ts` (zod) |
| `acl.ts`, `events.ts`, `setup.ts`, `di.ts`, `encryption.ts` | Features `offer_generator.{view,manage,generate,settings.manage}`, events, defaults, encrypted fields |

## Generation Flow

1. `POST /api/offer_generator/offers/[id]/generate` (`kind: generate | refine`) calls `startGenerationRun`: validates, creates an `OfferGenerationRun`, a progress job and enqueues the job. Returns `{ runId, progressJobId }`. Errors: 409 `generation_active`, 503 `ai_not_configured`, 400 `prompt_required` / `refine_without_html` / `model_not_allowed`.
2. The `generate-offer` worker calls the model through the `ai-assistant` model factory (`OM_AI_OFFER_GENERATOR_MODEL`, tenant allowlist), validates the HTML (`html-validate`; refine must not shrink it), then writes it via the `offer_generator.offers.update_html` command, which sanitizes it and records a revision.
3. Events `offer_generator.generation.{started,completed,failed}` are emitted; the UI follows run status and progress.
4. Under `OM_INTEGRATION_TEST=true` a deterministic fake generator replaces the provider (opt back in with `OM_OFFER_GENERATOR_REAL_AI=1`).
5. The first HTML write creates no revision; later writes (`generate`, `refine`, `manual_edit`, `restore`) each add one (max 50 kept).

## Public Link and Slug Routing

`/oferta/<slug>-<token>` is unauthenticated. `resolvePublicOfferRoute` finds the offer by `slug` ONLY across tenants, then compares `accessToken` with `timingSafeEqualStrings`. That lookup is the ONLY cross-tenant read in the module; everything after it is scoped by the resolved `tenantId` + `organizationId`. Draft, deleted and HTML-less offers resolve to nothing (404). Never add other cross-tenant queries.

## Tracking

`api/public/sessions` receives `sendBeacon` batches from `OfferTracker` (visit start, heartbeats, scroll sections, idle/hidden). It is unauthenticated, same-origin checked, rate limited, bot-filtered, capped (`TRACKING` in `lib/constants.ts`); IPs are stored only as an HMAC hash (`OM_OFFER_GENERATOR_IP_HASH_SECRET`). `offer_generator_offer_views` is append/update telemetry and deliberately has NO `updated_at` — do not add one and do not put optimistic locking on it. The first view moves an offer from `sent` to `viewed`.

## PDF

`api/offers/[id]/pdf` renders sanitized HTML through headless Chromium (`lib/pdf.ts`, paginated A4). Requires `INSTALL_CHROMIUM=1` at build/deploy or `OM_OFFER_GENERATOR_PDF_CHROMIUM_PATH`. Network requests during rendering are limited to `OM_OFFER_GENERATOR_PDF_ASSET_HOSTS`.

## HTML Sanitization

Offer HTML is untrusted (AI output and manual edits). `sanitizeOfferHtml` strips scripts, iframes, forms, event handlers and non-https stylesheets; it runs in `update_html`, in both render routes and in the PDF renderer. Any new path that stores or serves offer HTML MUST sanitize it. The public page and the backend preview embed the HTML in plain iframes (`PublicOfferView.tsx`, `OfferPreviewFrame.tsx`) WITHOUT a `sandbox` attribute; script execution is prevented by sanitization plus the route-specific CSP (`script-src 'none'`) on `/api/offer_generator/render/:path*` in `apps/mercato/next.config.ts` and the create-app template.

## Always

- Scope every query by `tenantId` and `organizationId`; use `findWithDecryption` / `findOneWithDecryption`.
- Write offers and settings through commands (`commandBus`); HTML only via `update_html`. Support optimistic locking (`expectedUpdatedAt` / `updatedAt`) on offers and settings.
- Validate input with zod in `data/validators.ts`; use the `lib/http.ts` helpers (`resolveRequestScope`, `noStoreJson`, `handleRouteError`, …) in routes and define `openApi` for each.
- Use `createLogger('offer_generator')`, `useT()` keys under `offer_generator.*`, DS status tokens.

## Ask First

- Changing the public path prefix, event IDs, the queue name, ACL features or the sanitizer allowlist (contract/security surfaces).
- Adding per-recipient links, session replay or other tracking beyond the current view telemetry.

## Never

- Never log or return access tokens, raw prompts with client data, viewer IPs or AI provider keys.
- Never add cross-tenant reads other than the slug lookup, or expose `accessToken` outside the offer detail API.
- Never serve or store offer HTML unsanitized; never add `updated_at` to `offer_views`.
- Never create ORM relations to other modules; store plain uuids (`customerEntityId`, `dealId`).
- Never call a provider SDK directly; use the model factory in `lib/ai-client.ts`.

## Env Vars

| Var | Purpose |
|-----|---------|
| `OM_AI_OFFER_GENERATOR_MODEL` | Model override (`provider/model`); otherwise the global `OM_AI_*` defaults apply |
| `OM_OFFER_GENERATOR_AI_TIMEOUT_MS` / `OM_OFFER_GENERATOR_MAX_OUTPUT_TOKENS` | Per-request AI timeout (default 300000) and output token cap (default 65536) |
| `OM_OFFER_GENERATOR_IP_HASH_SECRET` | HMAC secret for viewer IP hashes |
| `OM_OFFER_GENERATOR_TEMPLATE_PATH` | Custom default template file |
| `OM_OFFER_GENERATOR_PDF_CHROMIUM_PATH` / `OM_OFFER_GENERATOR_PDF_ASSET_HOSTS` | Chromium binary; allowed asset hosts for PDF |
| `OM_OFFER_GENERATOR_REAL_AI` | Test only: use the real provider under `OM_INTEGRATION_TEST` |

## Tests

- Unit: `yarn workspace @open-mercato/offer-generator test` (specs in `__tests__/`).
- Integration: Playwright suites in `__integration__/` — `TC-OFFER-001` CRUD/lock/isolation, `002` AI generation, `003` HTML revisions, `004` public render, `005` tracking/insights, `006` PDF, `007` CRM widget UI, `008` settings lock. Generation runs against the fake generator under `OM_INTEGRATION_TEST` (no real provider unless `OM_OFFER_GENERATOR_REAL_AI`); see `.ai/qa/AGENTS.md`.

## After Changes

- Run `yarn generate` after adding or changing module files; `yarn db:generate` for entity changes (review SQL + snapshot).
- Run `yarn typecheck`, `yarn lint`, `yarn workspace @open-mercato/offer-generator test`, `yarn build:packages`.
- Update `components/types.ts` when `api/openapi.ts` changes, and the spec when behavior changes.
