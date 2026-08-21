# Architecture Overview

## Monorepo Structure

Open Mercato is a Yarn 4 workspace monorepo orchestrated by TurboRepo (32-way concurrency). Workspaces are declared in `/package.json`:

```
workspaces: ["apps/*", "packages/*", "external/official-modules/packages/*"]
```

Two apps and 20+ packages. See [Source Map](../source-map.md) for a full package inventory.

## Module System

Every feature lives under `packages/core/src/modules/<module>/` and follows a strict convention-based file structure. The CLI's `generate` command auto-discovers these files and produces import/registration code in `.mercato/generated/`.

### Auto-discovered convention files

| File | Purpose |
|------|---------|
| `index.ts` | Module barrel — exports `ModuleInfo` metadata + `features` (ACL array) |
| `di.ts` | DI registrar — registers entities + optimistic lock readers into the Awilix container |
| `setup.ts` | `ModuleSetupConfig` — `seedDefaults`, `seedExamples`, `defaultRoleFeatures` |
| `events.ts` | Event declarations via `createModuleEvents()` |
| `ce.ts` | Custom entities (EAV dynamic fields) |
| `encryption.ts` | Tenant data encryption maps (PII field declarations) |
| `acl.ts` | RBAC feature declarations — array of `{ id, title, module, dependsOn? }` |
| `search.ts` | Search configuration (full-text fields, filters, vector) |
| `extension-points.ts` | Module extension point hosts (DataTable, CrudForm, detail) |
| `api/openapi.ts` | OpenAPI factory helper for module routes |

### Auto-discovered directories

| Directory | Pattern |
|-----------|---------|
| `api/<method>/<path>.ts` | API routes — dispatched by HTTP method to `/api/<path>` |
| `backend/<path>.tsx` | Backend admin pages → `/backend/<path>` |
| `frontend/<path>.tsx` | Frontend pages → `/<path>` |
| `subscribers/*.ts` | Event subscribers — export `metadata` with `{ event, persistent?, id? }` |
| `workers/*.ts` | Background workers — export `metadata` with `{ queue, id?, concurrency? }` |
| `commands/*.ts` | Undoable domain commands (Command pattern) |
| `components/*.tsx` | React components for the module |
| `data/entities.ts` | MikroORM v7 entity classes |
| `data/validators.ts` | Field validators |
| `data/enrichers.ts` | Response enrichers |
| `data/extensions.ts` | Entity extensions (cross-module data links) |
| `migrations/` | MikroORM migrations + schema snapshot |
| `widgets/` | Widget injection table + definitions |
| `i18n/` | Translation files (en, de, es, ko, pl) |

**Generated outputs** go to `.mercato/generated/` — never hand-edit. The `customers` module is the [reference CRUD module](module-anatomy.md); copy it first when building new modules.

## Dependency Injection

**Framework:** Awilix (proxy-based DI container).

**Container type:** `AppContainer` from `@open-mercato/shared/lib/di/container`.

- Each module exposes a `register(container)` function in `di.ts`.
- Entities registered as values (`asValue`).
- Platform-wide services registered in `packages/core/src/bootstrap.ts`: cache service (singleton via `globalThis`), event bus, KMS service, `TenantDataEncryptionService`, rate limiter.
- Generated `di.generated.ts` aggregates all module registrars.
- Cross-module resolution uses `container.resolve()`. For **optional** peers, modules wrap in `tryResolve()` (try/catch returning `undefined`). Never declare a hard `requires` on an optional peer.

## ORM — MikroORM v7

- **Driver:** `@mikro-orm/postgresql` (PostgreSQL 17 + pgvector)
- **Entity file convention:** `src/modules/<module>/data/entities.ts`
- Decorators from `@mikro-orm/decorators/legacy`, types from `@mikro-orm/core`
- UUID primary keys, snake_case table/column names
- Module-owned tables prefixed with module name (e.g., `catalog_products`, `sales_orders`)
- Standard columns: `organization_id`, `tenant_id`, `created_at`, `updated_at`, `deleted_at` (soft delete)
- **Never** create direct ORM relationships between modules — use foreign key IDs and fetch separately
- Migrations are module-scoped in `src/modules/<module>/migrations/`; each module maintains a `.snapshot-open-mercato.json`
- `yarn db:generate` iterates all modules for schema diff; `yarn db:migrate` applies ordered migrations

### Transaction Safety — `withAtomicFlush`

When a command mutates entities across multiple phases that include queries, use `withAtomicFlush(em, phases, { transaction: true })` from `@open-mercato/shared/lib/commands/flush`. **Never** run `em.find`/`em.findOne` between scalar mutations and `em.flush()` on the same `EntityManager` — MikroORM's identity-map can silently discard pending changes. Side effects (`emitCrudSideEffects`) and cache invalidation fire **after** `withAtomicFlush` commits. Preferred: `runCrudCommandWrite` for commands combining entity writes + custom fields + side effects.

## RBAC — Feature-Based Access Control

Two-layered: role ACLs + user ACLs per tenant.

**Feature declaration** (`acl.ts`):
```typescript
export const features = [
  { id: 'customers.people.view', title: 'View people', module: 'customers' },
  { id: 'customers.people.manage', title: 'Manage people', module: 'customers', dependsOn: ['customers.people.view'] },
]
```

**Naming convention:** `<module>.<entity>.<action>`

**Default role grants** (`setup.ts`): `admin` gets wildcards (`customers.*`), `employee` gets explicit feature lists.

**Policy order:**
1. Invalid scope → deny first
2. Nulled/disabled features → deny
3. `isSuperAdmin` → grants all active features
4. Wildcard grants (e.g., `customers.*` matches `customers.people.view`)
5. Never compare raw feature arrays with exact string checks when wildcard grants apply

**Sync command:** `yarn mercato auth sync-role-acls` (idempotent — propagates new grants to existing tenants).

**Portal/customer RBAC:** Portal pages declare `requireCustomerAuth` and `requireCustomerFeatures` in `page.meta.ts`, enforced server-side by `CustomerRbacService`.

See [Security & Tenancy](security-and-tenancy.md) for full details.

## Multi-Tenancy

Core `directory` module defines `tenants` and `organizations`. Most entities carry `tenant_id` + `organization_id`. Multi-hierarchical organization trees with role- and user-level visibility controls. **Never expose cross-tenant data or skip tenant/organization scoping.**

## Encryption

`TenantDataEncryptionService` handles all AES/KMS encryption. Use `findWithDecryption`/`findOneWithDecryption` instead of raw `em.find`/`em.findOne`. Encrypted fields declared in module's `encryption.ts` via `defaultEncryptionMaps`. Query index docs and vector search result fields encrypted at rest.

## Code Generation

The CLI `generate` command runs a suite of deterministic code generators (`packages/cli/src/lib/generators/`). Each reads enabled modules from `src/modules.ts`, scans their source files (AST via `ts-morph`), and writes `.generated.ts` / `.generated.json` files to `.mercato/generated/`.

Key generators:

| Generator | Output | Purpose |
|-----------|--------|---------|
| `module-registry.ts` | `modules.*.generated.ts` | Central registry: import statements + registration arrays |
| `module-facts.ts` | `module-facts.generated.ts` | Static facts per module: entity IDs, API routes, pages, events, features, commands, workers, subscribers |
| `module-di.ts` | `di.generated.ts` | DI container wiring |
| `module-entities.ts` | `entities.generated.ts` | Combined MikroORM entity list |
| `entity-ids.ts` | `entity-ids.generated.ts` | Per-entity ID constants |
| `openapi.ts` | `openapi.generated.json` | Static OpenAPI spec from route files |
| `module-extension-facts.ts` | Extension facts | Enrichers, guards, interceptors, widgets, overrides |

Generation uses checksum-based change detection so unchanged files are skipped. `yarn generate watch` runs an in-process poller that re-runs generators on file changes. Structural invalidation can trigger re-generation when module structure changes.

## Optimistic Locking

**Default ON** for every `makeCrudRoute` entity (opt out with `OM_OPTIMISTIC_LOCK=off`). User-editable entities must include an `updated_at` column with `onCreate` + `onUpdate`. `CrudForm` auto-derives the optimistic lock header from `initialValues.updatedAt` (covers update and delete). For custom non-`CrudForm` handlers, wrap mutating calls with `withScopedApiRequestHeaders(buildOptimisticLockHeader(record.updatedAt), …)` and surface conflicts via `surfaceRecordConflict(err, t)`.

See: `packages/shared/src/lib/crud/optimistic-lock{,-command}.ts`, `packages/ui/src/backend/conflicts/`.

## Bootstrap Pipeline

`packages/core/src/bootstrap.ts` is the platform-wide DI bootstrap. It:

1. Registers cache service as singleton via `globalThis`
2. Creates and registers the event bus (`createEventBus`)
3. Registers KMS service
4. Registers `TenantDataEncryptionService`
5. Registers rate limiter
6. Registers search modules
7. Auto-registers discovered module subscribers

The app entrypoint in `apps/mercato` calls this bootstrap, then resolves the per-request container for each incoming HTTP request.