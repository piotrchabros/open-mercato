# Module Anatomy

Every module in Open Mercato follows a convention-over-configuration structure. The **customers** module (`packages/core/src/modules/customers/`) is the reference implementation — copy from it when building new CRUD features.

## Standard Module Structure

```
src/modules/<module>/
├── index.ts              # Module barrel — exports ModuleInfo metadata + features
├── acl.ts                # RBAC feature declarations
├── setup.ts              # ModuleSetupConfig: seedDefaults, seedExamples, defaultRoleFeatures
├── di.ts                 # DI registrar: registers entities + optimistic lock readers
├── events.ts             # Event declarations via createModuleEvents()
├── ce.ts                 # Custom entities (EAV custom fields)
├── encryption.ts         # Tenant data encryption maps (PII fields)
├── extension-points.ts   # Module extension point hosts
├── search.ts             # Search configuration
├── analytics.ts          # Analytics endpoints
├── notifications.ts      # Notification type definitions
├── ai-agents.ts          # AI agent definitions
├── ai-tools.ts           # AI tool definitions
├── cli.ts                # CLI commands
│
├── api/                  # API route definitions
│   ├── openapi.ts        # OpenAPI factory helper
│   ├── utils.ts          # Shared API utilities
│   └── <resource>/       # CRUD routes per resource (e.g., people/, companies/)
│       └── route.ts      # Route handler
│
├── backend/              # Backend (admin) pages
├── commands/             # Undoable domain commands (Command pattern)
├── components/            # React components
├── data/                  # ORM layer
│   ├── entities.ts       # MikroORM v7 entities
│   ├── enrichers.ts      # Response enrichers
│   ├── extensions.ts     # Entity extensions
│   ├── guards.ts         # Data guards/validators
│   └── validators.ts     # Field validators
├── lib/                   # Module business logic
├── migrations/            # MikroORM migrations + .snapshot-open-mercato.json
├── subscribers/           # Event subscribers
├── workers/               # Background job workers
├── widgets/               # Widget injection (slot-to-widget mapping)
├── i18n/                  # Translation files (en, de, es, ko, pl)
├── __tests__/             # Unit tests
└── __integration__/       # Integration test specs (TC-*.spec.ts)
```

## Reference Module: `customers`

`customers` is explicitly designated as **the reference CRUD module**. Copy its structure first when building new modules.

Key files:
- `packages/core/src/modules/customers/AGENTS.md` — module-specific agent guidelines
- `packages/core/src/modules/customers/api/people/` — reference CRUD route
- `packages/core/src/modules/customers/commands/people.ts` — reference command implementation
- `packages/core/src/modules/customers/data/entities.ts` — reference entity definitions
- `packages/core/src/modules/customers/data/validators.ts` — reference validators

## Naming Conventions

- Module folders and IDs: plural, snake_case (e.g., `customer_accounts`). Special cases: `auth`, `example`
- Event IDs: `module.entity.action` (singular entity, past tense, e.g., `pos.cart.completed`)
- JS/TS fields: camelCase
- Database tables/columns: snake_case; table names plural
- Common columns: `id`, `created_at`, `updated_at`, `deleted_at`, `is_active`, `organization_id`, `tenant_id`
- UUID PKs, explicit FKs, junction tables for many-to-many

## CRUD Route Factory

**Source:** `packages/shared/src/lib/crud/factory.ts` (the largest file in the system)

`makeCrudRoute(opts: CrudFactoryOptions)` generates complete HTTP route handlers (GET/POST/PUT/DELETE) from a declarative config:

```typescript
makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['customers.people.view'] },
    POST: { requireAuth: true, requireFeatures: ['customers.people.manage'] },
  },
  orm: {
    entity: CustomerEntity,
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  enrichers: { entityId: 'customers.person' },
  indexer: { entityType: E.customers.customer_entity },
  list: {
    schema: listSchema,
    entityId: E.customers.customer_entity,
    fields: [...],
    sortFieldMap: { name: 'display_name' },
    buildFilters: async (query, ctx) => { ... },
    transformItem: (item) => { ... },
  },
  actions: {
    create: { commandId: 'customers.people.create', schema, mapInput, response, status: 201 },
    update: { commandId: 'customers.people.update', schema, mapInput, response },
    delete: { commandId: 'customers.people.delete', schema, mapInput, response },
  },
  hooks: { afterList, beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete },
  events: { ... },
})
```

### Factory Internals

1. **ORM config normalization** — resolves `idField`, `orgField`, `tenantField`, `softDeleteField` with defaults
2. **Optimistic lock auto-registration** — creates a generic `OptimisticLockCurrentReader` for the entity; hand-wired readers from module DI always win
3. **Custom field decoration** — loads `CustomFieldDefinitionIndex`, decorates list items with `customValues` + `customFields`
4. **Filter building** — `buildFilters(query, ctx)` returns a MikroORM `Where` object; supports search tokens, custom field filters, advanced filter trees, tag filters
5. **Query Engine integration** — routes through `BasicQueryEngine` or `HybridQueryEngine` for SQL-based filtering, pagination, sorting
6. **Cache layer** — `CrudCache` with tag-based invalidation (`resource:<kind>`, `resource:<kind>:<id>`)
7. **Mutation guards** — runs `runMutationGuards(...)` before write operations
8. **Sync subscribers** — collects sync subscribers, runs `runSyncBeforeEvent`/`runSyncAfterEvent` around mutations
9. **Side effects** — `emitCrudSideEffects` / `emitCrudUndoSideEffects` fire after commit (outside `withAtomicFlush`), refreshing query index and caches

## Command Pattern

**Source:** `packages/core/src/modules/customers/commands/people.ts`

Domain writes go through **commands** (not direct ORM mutation in route handlers). Commands provide:

- **Undo/redo** via `extractUndoPayload(logEntry)` snapshots
- **Audit logging** via `CommandBus` → `ActionLog`
- **Cache invalidation** via `emitCrudSideEffects` / `emitCrudUndoSideEffects`
- **Custom field snapshots** in `before`/`after` payloads
- **Transaction safety** via `withAtomicFlush(em, phases, { transaction: true })` — wraps multi-phase mutations in a single atomic flush
- **Side effects fire after commit** (outside `withAtomicFlush`)
- Prefer `runCrudCommandWrite` for new commands (composes fork → atomic flush → custom-field write → side-effect queue)

Commands are registered via `registerCommand(...)` at import time; `commands/index.ts` imports all command files to trigger registration.

**Critical:** Never run `em.find`/`em.findOne` between scalar mutations and `em.flush()` on the same `EntityManager` — MikroORM's identity-map can silently discard pending changes.

## OpenAPI Generation

**Source:** `packages/shared/src/lib/openapi/crud.ts`, `packages/cli/src/lib/generators/openapi.ts`

Each module's `api/openapi.ts` exports a factory:

```typescript
const buildCustomersCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: 'Customers',
  defaultCreateResponseSchema,
  defaultOkResponseSchema,
  makeListDescription: ({ pluralLower }) => `Retrieve a paginated list of ${pluralLower}`,
})
```

Each route file exports `openApi = createCustomersCrudOpenApi({ resourceName, querySchema, listResponseSchema, create, update, del })`.

The CLI `openapi.ts` generator assembles all module OpenAPI specs into a static `openapi.generated.json` at build time, consumed by the MCP dev server and AI Code Mode `search` tool for dynamic API discovery without a running app.

## DI Registration

```typescript
import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'

export function register(container: AppContainer) {
  container.register({
    CustomerEntity: asValue(CustomerEntity),
    CustomerAddress: asValue(CustomerAddress),
  })
}
```

- Each module exposes a `register(container)` function
- Entities registered as values (`asValue`)
- Platform-wide services registered in `packages/core/src/bootstrap.ts`
- Generated `di.generated.ts` aggregates all module registrars
- Cross-module resolution uses `container.resolve()`; for optional peers, wrap in `tryResolve()` (try/catch returning `undefined`)

## Cross-Module Coupling

Modules must remain independent — **no direct ORM relationships between modules**. When coupling is needed:

| Pattern | When to use |
|---------|-------------|
| Events + widget injection + enrichers | Loose, optional coupling |
| FK-id + snapshot | Read-optimized denormalization |
| Soft-optional `tryResolve` | Optional integration that may not be present |
| Entity extensions (`data/extensions.ts`) | Extending another module's data model |

Cross-module decoupling is enforced by `packages/core/src/__tests__/module-decoupling.test.ts`.

## Custom Entities (EAV)

Dynamic fields via the `entities` module DSL:

- `ce.ts` declares custom entities and fields per module
- DSL helpers: `defineLink`, `entityId`, `linkable`, `defineFields`, `cf.*`
- `customFieldDefaults.ts` — default custom field definitions
- `data/validators.ts` — field-level validators

## Widget Injection

`widgets/injection-table.ts` — maps UI slots to widget definitions:

- **DataTable extension**: columns, row actions, bulk actions, filters
- **CrudForm field widgets**: `crud-form:<entityId>:fields`
- **Detail view widgets**: custom panels/tabs
- **Menu items**: main/settings/profile sidebars, topbar dropdown
- **Dashboard widgets**: KPI strips, charts, tables

Injection positions: `InjectionPosition` enum from `@open-mercato/shared`.

## Optimistic Locking

**Default ON** for every `makeCrudRoute` entity. Opt out with `OM_OPTIMISTIC_LOCK=off`.

| Aspect | Implementation |
|--------|---------------|
| Version column | `updated_at` with `onCreate` + `onUpdate` |
| API responses | Return `updatedAt` |
| Client (CrudForm) | Auto-derives header from `initialValues.updatedAt` |
| Custom handlers | `withScopedApiRequestHeaders(buildOptimisticLockHeader(record.updatedAt), …)` |
| Conflict surfacing | `surfaceRecordConflict(err, t)` — unified conflict bar |
| Command writes | `enforceCommandOptimisticLock` + `createCommandOptimisticLockGuardService` |
| Opt out | `OM_OPTIMISTIC_LOCK=off` |

When a form's `onSubmit` mutates OTHER entities, override the parent header per child with that child's own version (avoid false 409s).

Key sources: `packages/shared/src/lib/crud/optimistic-lock{,-command}.ts`, `packages/ui/src/backend/conflicts/`, `.ai/specs/implemented/2026-05-25-oss-optimistic-locking.md`.

## API Interceptors

`api/interceptors.ts` — before/after hooks on API routes:

- Body/query rewriting before handler
- Response modification after handler
- ID narrowing: filter CRUD list APIs by multiple IDs (`?ids=uuid1,uuid2`)
- Used by search, ACL, and enrichment pipelines

## i18n Convention

- Translation files in `i18n/` — `en.json`, `de.json`, `es.json`, `ko.json`, `pl.json`
- **Never hard-code user-facing strings**
- Use `useT` / `resolveTranslations` from `@open-mercato/shared`
- Validation: `yarn i18n:check` (sync + usage + hardcoded + values)

## AI Integration

Modules can declare:

- `ai-agents.ts` — AI agent definitions with tool packs
- `ai-tools.ts` / `ai-tools/` — AI tool implementations
- `ai-agents-context.ts` — context for AI agents
- Mutation approval via `prepareMutation`
- Per-tenant agent settings, provider/model selection
- Loop controls: `loop.stopWhen`, `loop.prepareStep`, `loop.budget`
- Overrides: per-tenant replacing/disabling agents/tools

## Domain Areas Summary

| Module | Key entities / scope |
|--------|---------------------|
| `customers` | People, companies, deals, activities, interactions, todos, comments, tags, labels, pipelines, pipeline stages, dictionaries, addresses |
| `sales` | Sales orders, quotes, invoices, dashboard widgets |
| `catalog` | Products, pricing |
| `staff` | Staff, timesheets, duration entry parsing |
| `customer_accounts` | Customer portal accounts, encrypted `display_name` via managed entity |
| `workflows` | Workflow automation, lifecycle orchestration |
| `dashboards` | Dashboard widgets, widget scope (tenant/organization authorization) |
| `directory` | Tenants, organizations, users — multi-tenancy foundation |
| `auth` | Authentication, RBAC service, JWT sessions |
| `entities` | Custom entities, dynamic fields (EAV) |
| `integrations` | Integration foundation layer (adapters, health checks, credentials) |
| `data_sync` | Data synchronization hub |
| `progress` | Bulk operation progress tracking |
| `search` (package) | Hybrid search engine with per-entity ACL view filtering |
| `checkout` (package) | Public payment flow, rate limiting (fail-closed), password verification |

## Key Source References

| Area | Source Path |
|------|------------|
| CRUD route factory | `packages/shared/src/lib/crud/factory.ts` |
| CRUD errors | `packages/shared/src/lib/crud/errors.ts` |
| Optimistic lock | `packages/shared/src/lib/crud/optimistic-lock.ts` |
| Atomic flush | `packages/shared/src/lib/commands/flush.ts` |
| OpenAPI CRUD factory | `packages/shared/src/lib/openapi/crud.ts` |
| Reference module | `packages/core/src/modules/customers/` |
| Customers commands | `packages/core/src/modules/customers/commands/people.ts` |
| Module development guide | `.ai/docs/module-development.md` |
| Backward compatibility | `BACKWARD_COMPATIBILITY.md` |