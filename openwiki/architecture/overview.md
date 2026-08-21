# Architecture Overview

## Monorepo Structure

Open Mercato is a Yarn 4 workspace monorepo orchestrated by TurboRepo (32-way concurrency). Workspaces: `apps/*`, `packages/*`, `external/official-modules/packages/*`.

```
apps/
├── mercato/       — Next.js application (the main app)
└── docs/          — Documentation site (Fumadocs)

packages/
├── core/          — 40 business modules + platform bootstrap
├── shared/        — Cross-cutting utilities, DI, CRUD, encryption, RBAC, ratelimit, OpenAPI
├── cli/           — `mercato` CLI: generators, db, server, queue, test, deploy
├── create-app/    — `create-mercato-app` scaffolder + agentic harness
├── ui/            — Shared React components, DataTable, CrudForm, design system
├── events/        — Event bus + DOM Event Bridge (SSE)
├── queue/         — BullMQ queue infrastructure
├── search/        — Hybrid search (Meilisearch + vector + token)
├── checkout/      — Public checkout/payment flow
├── ai-assistant/  — MCP server + AI agent infrastructure
├── webhooks/      — Outbound/inbound webhook delivery (Standard Webhooks signing)
├── cache/         — Caching service (global singleton)
├── scheduler/     — Job scheduler
├── telemetry/     — OpenTelemetry instrumentation
├── gateway-stripe/ — Stripe payment gateway adapter
├── storage-s3/    — S3 storage adapter
├── sync-akeneo/   — Akeneo PIM sync adapter
├── channel-gmail/ — Gmail channel integration
├── channel-imap/  — IMAP channel integration
├── content/       — Content management
├── manufacturing/ — Manufacturing domain
├── onboarding/    — Self-service onboarding
├── enterprise/    — Commercial/proprietary enterprise features
└── eslint-plugin-ds/ — Design system ESLint rules
```

## Module System

Each feature lives under `packages/core/src/modules/<module>/` with auto-discovered:

- **Frontend pages:** `frontend/<path>.tsx` → `/<path>`
- **Backend pages:** `backend/<path>.tsx` → `/backend/<path>` (special: `backend/page.tsx` → `/backend/<module>`)
- **API routes:** `api/<method>/<path>.ts` → `/api/<path>` dispatched by method
- **Subscribers:** `subscribers/*.ts` — export `metadata` with `{ event, persistent?, id? }`
- **Workers:** `workers/*.ts` — export `metadata` with `{ queue, id?, concurrency? }`
- **Setup, events, custom entities, encryption maps** — auto-discovered convention files

The `customers` module is the **reference CRUD module** — copy its structure when building new modules. See [Module Anatomy](module-anatomy.md).

## Code Generation

`yarn generate` runs a suite of deterministic generators (`packages/cli/src/lib/generators/`) that scan module convention files and write `.generated.ts` / `.generated.json` registries to `apps/mercato/.mercato/generated/`:

| Generator | Output | Purpose |
|-----------|--------|---------|
| `module-registry` | `modules.*.generated.ts` | Import statements + registration arrays for the module graph |
| `module-entities` | `entities.generated.ts` | Combined MikroORM entity list |
| `entity-ids` | `entity-ids.generated.ts` + per-entity files | Stable entity ID constants |
| `module-di` | `di.generated.ts` | DI container wiring |
| `module-facts` | `module-facts.generated.ts` | Static facts: routes, pages, events, features, commands, workers, subscribers, enrichers, guards, interceptors, AI agents |
| `module-extension-facts` | Extension facts | Correlates extensions against host surfaces |
| `openapi` | `openapi.generated.json` | Static OpenAPI spec from route files |
| 20+ sub-generators in `extensions/` | Per-surface extension generators | ai-agents, ai-tools, analytics, command-interceptors, component-overrides, dashboard-widgets, enrichers, events, guards, inbox-actions, injection-widgets, interceptors, messages, notifications, page-middleware, search, translatable-fields, workflows |

**Never hand-edit generated files.** `yarn generate watch` runs an in-process poller for live regeneration.

## Dependency Injection

**Framework:** Awilix (proxy-based DI container)

- Container type: `AppContainer` from `@open-mercato/shared/lib/di/container`
- Each module exposes a `register(container)` function in `di.ts`
- Entities registered as values (`asValue`)
- Container is constructed **per request**
- Cross-module resolution uses `container.resolve()` — optional peers wrapped in `tryResolve()` (returns `undefined` when absent)
- Platform-wide: `crudMutationGuardService`, cache service (singleton via `globalThis`), event bus, KMS service, `TenantDataEncryptionService`, rate limiter — registered in `packages/core/src/bootstrap.ts`
- Generated `di.generated.ts` aggregates all module registrars

## ORM (MikroORM v7)

- Driver: `@mikro-orm/postgresql` with PostgreSQL 17 + pgvector
- Entity files: `src/modules/<module>/data/entities.ts`
- UUID primary keys, snake_case table/column names
- Module-owned tables prefixed with module name (e.g., `catalog_products`, `sales_orders`)
- Standard columns: `organization_id`, `tenant_id`, `created_at`, `updated_at`, `deleted_at` (soft delete)
- Migrations are module-scoped in `src/modules/<module>/migrations/` with a `.snapshot-open-mercato.json` snapshot
- `yarn db:generate` iterates all modules for schema diff; `yarn db:migrate` applies ordered
- **Never create direct ORM relationships between modules** — use foreign key IDs and fetch separately
- Use `withAtomicFlush(em, phases, { transaction: true })` for multi-phase mutations
- Use `runCrudCommandWrite` for commands combining entity writes + custom fields + side effects
- Use `findWithDecryption`/`findOneWithDecryption` instead of raw `em.find`/`em.findOne` for encrypted fields

## Multi-Tenancy

- Core `directory` module defines `tenants` and `organizations`
- Most entities carry `tenant_id` + `organization_id`
- Strict scoping on every entity and API — never expose cross-tenant data
- Multi-hierarchical organizations with role- and user-level visibility controls

## RBAC (Feature-Based Access Control)

Two-layered: **Role ACLs** + **User ACLs** per tenant.

- Features declared in module's `acl.ts`: `{ id: '<module>.<entity>.<action>', title, module, dependsOn?: [] }`
- Naming: `<module>.<entity>.<action>` (e.g., `customers.people.manage`)
- Default role grants in `setup.ts`: `defaultRoleFeatures: { admin: ['customers.*'], employee: [...] }`
- Wildcard grants: `customers.*` matches `customers.people.view`
- Server-side check: `rbacService.userHasAllFeatures(userId, features, { tenantId, organizationId })`
- Sync: `yarn mercato auth sync-role-acls` (idempotent)
- Portal/customer RBAC: `requireCustomerAuth` + `requireCustomerFeatures` in `page.meta.ts`

## Tenant Data Encryption

- `TenantDataEncryptionService` — AES-256-GCM encryption with per-tenant Data Encryption Keys (DEKs)
- KMS service for key management
- Encrypted fields declared in module's `encryption.ts` via `defaultEncryptionMaps`
- Use `findWithDecryption` / `findOneWithDecryption` for queries involving encrypted fields
- Query index docs and vector search result fields encrypted at rest

## Optimistic Locking

**Default ON** for every `makeCrudRoute` entity (opt out with `OM_OPTIMISTIC_LOCK=off`).

- Entity `updated_at` column with `onCreate` + `onUpdate`
- API responses return `updatedAt`
- `CrudForm` auto-derives header from `initialValues.updatedAt`
- Custom handlers: `withScopedApiRequestHeaders(buildOptimisticLockHeader(record.updatedAt), …)` + `surfaceRecordConflict(err, t)`
- Command writes: `enforceCommandOptimisticLock` + DI-overridable `createCommandOptimisticLockGuardService`

Key sources: `packages/shared/src/lib/crud/optimistic-lock{,-command}.ts`, `packages/ui/src/backend/conflicts/`.

## Event Bus

- `createEventBus()` registered as platform singleton in `bootstrap.ts`
- Modules declare events via `createModuleEvents()` in `events.ts`
- Subscribers auto-discovered from `subscribers/*.ts`
- Persistent subscribers (Redis-backed) for reliable processing
- DOM Event Bridge (SSE) pushes real-time events to browser via `useAppEvent`, `useOperationProgress`
- Cross-module coupling via events (loosest coupling option)

## Search Architecture

Hybrid search engine (`packages/search/`):

- **Full-text** via Meilisearch
- **Vector** search via pgvector
- **Token** search for exact matches
- Per-entity view features — hybrid search results filtered by ACL features (recent fix: `cbd7cc2839`)
- Search config per module in `search.ts`

## Bootstrap Pipeline

`packages/core/src/bootstrap.ts` registers platform-wide services:

1. Cache service (singleton via `globalThis`)
2. Event bus (`createEventBus`)
3. KMS service
4. `TenantDataEncryptionService`
5. Rate limiter
6. Search modules
7. Auto-registers discovered module subscribers

## Agentic Configuration

`.ai/agentic.config.json`:

```json
{
  "version": 1,
  "baseBranch": "develop",
  "tracker": "github",
  "browser": { "provider": "playwright" },
  "validation": {
    "commands": ["yarn build:packages", "yarn generate", ...]
  },
  "labels": { "enabled": true, ... },
  "qaGate": true
}
```

- Base branch: `develop`
- Validation pipeline: 8-step ordered command chain
- QA gate enabled — prevents AI agents from merging without QA
- Label system: pipeline states, categories, priorities, risk levels
