# Module Anatomy

Every module in Open Mercato follows a convention-over-configuration structure. The **customers** module (`packages/core/src/modules/customers/`) is the reference implementation — copy from it when building new CRUD features.

## Standard Module Files

| File | Purpose |
|------|---------|
| `index.ts` | Module metadata (`ModuleInfo`): name, title, version, description, `ejectable` flag. Re-exports `features` from `acl.ts` |
| `acl.ts` | Declarative RBAC feature list (`{ id, title, module, dependsOn? }`). Naming: `<module>.<entity>.<action>` |
| `setup.ts` | `ModuleSetupConfig` — `seedDefaults`, `seedExamples`, `defaultRoleFeatures` per role (admin/employee/superadmin) |
| `di.ts` | Awilix DI registrar — `export function register(container: AppContainer)` |
| `ce.ts` | Custom entities declaration — array of `{ id, label, fields }` referencing generated entity IDs |
| `encryption.ts` | `ModuleEncryptionMap[]` declaring which entity fields are encrypted at rest |
| `events.ts` | Event declarations via `createModuleEvents({ moduleId, events })` — typed `as const` |
| `data/entities.ts` | MikroORM v7 entity classes (`@Entity`, `@Property`, etc.) |
| `data/validators.ts` | Zod schemas for create/update |
| `data/extensions.ts` | Cross-module entity extensions (links to other modules' entities) |
| `api/<resource>/route.ts` | CRUD route via `makeCrudRoute(...)` |
| `api/openapi.ts` | OpenAPI factory via `createCrudOpenApiFactory(...)` |
| `commands/<entity>.ts` | Command pattern handlers (undoable, audit-logged writes) |
| `migrations/` | Per-module MikroORM migration files + `.snapshot-open-mercato.json` |
| `i18n/<locale>.json` | Per-module locale files (en, de, es, ko, pl) |

### Naming Conventions

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
    orgField: 'organizationId',   // default; null to disable
    tenantField: 'tenantId',      // default; null to disable
    softDeleteField: 'deletedAt',  // default; null to disable
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

## Cross-Module Coupling

Modules must remain independent — **no direct ORM relationships between modules**. When coupling is needed:

| Pattern | When to use |
|---------|-------------|
| Events + widget injection + enrichers | Loose, optional coupling |
| FK-id + snapshot | Read-optimized denormalization |
| Soft-optional `tryResolve` | Optional integration that may not be present |
| Entity extensions (`data/extensions.ts`) | Extending another module's data model |

Cross-module decoupling is enforced by `packages/core/src/__tests__/module-decoupling.test.ts`.

## Module Setup & Seeding

**Source:** `packages/core/src/modules/customers/setup.ts`

`setup.ts` declares `ModuleSetupConfig` with:
- `seedDefaults` — essential records created on tenant init
- `seedExamples` — demo data for development
- `defaultRoleFeatures` — maps role names (admin/employee/superadmin) to feature arrays

The `onTenantCreated` hook and `seedDefaults` run during tenant setup. Role features sync to roles via `yarn mercato auth sync-role-acls`.

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
