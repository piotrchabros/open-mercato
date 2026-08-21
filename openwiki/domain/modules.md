# Module Anatomy and Domain Concepts

## Standard Module Structure

Every module lives under `packages/core/src/modules/<module>/` and follows a strict convention-based structure. The `customers` module is the **reference CRUD module** — copy it first when building new modules.

### Core Files (auto-discovered by generators)

| File | Purpose |
|------|---------|
| `index.ts` | Module barrel — exports `ModuleInfo` metadata + `features` (RBAC) |
| `acl.ts` | RBAC feature declarations (array of `{ id, title, module, dependsOn? }`) |
| `setup.ts` | `ModuleSetupConfig` — `seedDefaults`, `seedExamples`, `defaultRoleFeatures` |
| `di.ts` | DI registrar — registers entities + optimistic lock readers into Awilix container |
| `events.ts` | Event declarations via `createModuleEvents()` |
| `ce.ts` | Custom entities (EAV fields) |
| `encryption.ts` | Tenant data encryption maps (PII fields) |
| `extension-points.ts` | Module extension point hosts (DataTable, CrudForm, detail) |
| `search.ts` | Search configuration (indexed fields, filters, ACL features) |
| `api/openapi.ts` | OpenAPI factory helper |

### Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | API route definitions (`<resource>/route.ts`) |
| `backend/` | Backend (admin) pages (`<path>.tsx` → `/backend/<path>`) |
| `commands/` | Undoable domain commands (Command pattern) |
| `components/` | React components |
| `data/` | ORM layer: `entities.ts`, `enrichers.ts`, `extensions.ts`, `guards.ts`, `validators.ts` |
| `lib/` | Module business logic (35+ files in customers) |
| `migrations/` | MikroORM migrations + `.snapshot-open-mercato.json` |
| `subscribers/` | Event subscribers — export `metadata: { event, persistent?, id? }` |
| `workers/` | Background job workers — export `metadata: { queue, id?, concurrency? }` |
| `widgets/` | Widget injection table + definitions |
| `i18n/` | Translation files (`en`, `de`, `es`, `ko`, `pl`) |
| `__tests__/` | Unit tests (`.test.ts`/`.test.tsx`) |
| `__integration__/` | Integration tests (`.spec.ts` — TC naming convention) |

## RBAC Feature Model

Features follow `<module>.<entity>.<action>` naming (e.g., `customers.people.manage`).

```typescript
// acl.ts
export const features = [
  { id: 'customers.people.view', title: 'View people', module: 'customers' },
  { id: 'customers.people.manage', title: 'Manage people', module: 'customers', dependsOn: ['customers.people.view'] },
]
```

### Default Role Grants

```typescript
// setup.ts
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['customers.*'],           // wildcard grants all
    employee: ['customers.people.view', 'customers.people.manage'],
  },
}
```

### Policy Order

1. Invalid scope → deny first
2. Nulled/disabled features → deny
3. `isSuperAdmin` → grants all active features
4. Wildcard grants (e.g., `customers.*` matches `customers.people.view`)
5. **Never** compare raw feature arrays with exact string checks when wildcard grants apply

Sync command: `yarn mercato auth sync-role-acls` (idempotent — propagates new grants to existing tenants).

## Command Pattern (Undoable Domain Commands)

Commands in `commands/<entity>.ts` wrap mutating operations with:

- **Audit logging** — every command is logged
- **Undo/redo** — commands are reversible via the command history
- **Transaction safety** — `withAtomicFlush(em, phases, { transaction: true })` from `@open-mercato/shared/lib/commands/flush`
- **Side effects** — `emitCrudSideEffects` fires **AFTER** `withAtomicFlush` commits, never inside it
- **Preferred:** `runCrudCommandWrite` for commands combining entity writes + custom fields + side effects

### Critical: MikroORM Identity-Map Safety

**Never** run `em.find`/`em.findOne` between scalar mutations and `em.flush()` on the same `EntityManager` — MikroORM's identity-map can silently discard pending changes. Use `withAtomicFlush` for multi-phase mutations.

## Optimistic Locking

**Default ON** for every `makeCrudRoute` entity. Opt out with `OM_OPTIMISTIC_LOCK=off`.

### Requirements for New Entities

1. Give the entity an `updated_at` column (with `onCreate` + `onUpdate`)
2. Return `updatedAt` in list/detail API responses
3. `CrudForm` auto-derives the header from `initialValues.updatedAt` (covers update + delete)
4. For custom non-`CrudForm` handlers: wrap mutating call with `withScopedApiRequestHeaders(buildOptimisticLockHeader(record.updatedAt), …)` and surface conflicts via `surfaceRecordConflict(err, t)`
5. When a form's `onSubmit` mutates OTHER entities, override the parent header per child with that child's own version (avoid false 409s)

### Command-Pattern Writes

- `enforceCommandOptimisticLock` — command-level optimistic lock guard
- `createCommandOptimisticLockGuardService` — DI-overridable guard service
- Shared helpers: `packages/shared/src/lib/crud/optimistic-lock{,-command}.ts`
- Conflict UI: `packages/ui/src/backend/conflicts/`

## Cross-Module Patterns

### Allowed Coupling Patterns

| Pattern | When to Use | Example |
|---------|-------------|---------|
| Events | Fire-and-forget notifications | Customer created → notification subscriber |
| Widget injection + enrichers | UI extension in another module's pages | Sales widget on customer detail |
| FK-id + snapshot | Reference another module's entity | `deal.customer_id` + cached customer snapshot |
| Soft-optional `tryResolve` | Depend on an OPTIONAL integration | `tryResolve('IntegrationService')` returns `undefined` if absent |

### Prohibited

- **Never** create direct ORM relationships between modules (no FK constraints across module boundaries)
- **Never** `container.resolve()` an optional peer unconditionally — wrap in `tryResolve()`
- **Never** declare a hard `requires` on an optional peer

### Module Decoupling Test

`packages/core/src/__tests__/module-decoupling.test.ts` — enforces module boundary rules.

## Core Modules (40 total)

### CRM / Sales

| Module | Path | Description |
|--------|------|-------------|
| `customers` | `src/modules/customers/` | CRM: people, companies, deals, activities, interactions, calendar, todos |
| `sales` | `src/modules/sales/` | Sales orders, quotes, invoices |
| `catalog` | `src/modules/catalog/` | Product catalog and pricing |
| `currencies` | `src/modules/currencies/` | Multi-currency support |
| `planner` | `src/modules/planner/` | Planning module |

### Operations / ERP

| Module | Path | Description |
|--------|------|-------------|
| `wms` | `src/modules/wms/` | Warehouse management |
| `staff` | `src/modules/staff/` | Staff management, timesheets |
| `workflows` | `src/modules/workflows/` | Workflow automation engine |
| `resources` | `src/modules/resources/` | Resource management |
| `progress` | `src/modules/progress/` | Bulk operation progress tracking |

### Platform / Infrastructure

| Module | Path | Description |
|--------|------|-------------|
| `auth` | `src/modules/auth/` | Authentication and authorization |
| `directory` | `src/modules/directory/` | Tenants, organizations, users |
| `entities` | `src/modules/entities/` | Custom entities and fields (EAV) |
| `dictionaries` | `src/modules/dictionaries/` | Lookup tables and enumerations |
| `feature_toggles` | `src/modules/feature_toggles/` | Feature flag management |
| `configs` | `src/modules/configs/` | System configuration |
| `query_index` | `src/modules/query_index/` | JSONB indexing and caching |
| `audit_logs` | `src/modules/audit_logs/` | Activity and change logging |
| `attachments` | `src/modules/attachments/` | File attachments and uploads |
| `dashboards` | `src/modules/dashboards/` | Dashboard widgets |
| `perspectives` | `src/modules/perspectives/` | Data perspectives and views |
| `business_rules` | `src/modules/business_rules/` | Business rule engine |
| `api_docs` | `src/modules/api_docs/` | API documentation generation |
| `api_keys` | `src/modules/api_keys/` | API key management |
| `notifications` | `src/modules/notifications/` | Notification system |
| `messages` | `src/modules/messages/` | Messaging |
| `translations` | `src/modules/translations/` | Translation manager |
| `design_system` | `src/modules/design_system/` | Design system tokens |

### Integration / Communication

| Module | Path | Description |
|--------|------|-------------|
| `integrations` | `src/modules/integrations/` | Integration foundation layer |
| `data_sync` | `src/modules/data_sync/` | Data synchronization hub |
| `communication_channels` | `src/modules/communication_channels/` | Channel comms |
| `payment_gateways` | `src/modules/payment_gateways/` | Payment gateway integrations |
| `shipping_carriers` | `src/modules/shipping_carriers/` | Shipping carrier integrations |
| `sync_excel` | `src/modules/sync_excel/` | Excel sync |
| `inbox_ops` | `src/modules/inbox_ops/` | Inbox operations |
| `portal` | `src/modules/portal/` | Customer portal |
| `customer_accounts` | `src/modules/customer_accounts/` | Customer portal accounts |
| `eudr` | `src/modules/eudr/` | EUDR compliance |
| `widgets` | `src/modules/widgets/` | Widget infrastructure |
| `core` | `src/modules/core/` | Meta-core |

## Widget Injection

Modules can inject UI into other modules via extension points:

- **Injection positions** — `InjectionPosition` enum (e.g., detail sidebar, list toolbar)
- **DataTable extension widgets** — columns, row actions, bulk actions, filters
- **CrudForm field widgets** — `crud-form:<entityId>:fields`
- **Menu items** — main/settings/profile sidebars or topbar dropdown (`useInjectedMenuItems`, `mergeMenuItems`)
- **Component replacement** — `widgets/components.ts` (`replace`/`wrapper`/`props`)

## Custom Fields and Entities (EAV)

- **DSL helpers** — `defineLink`, `entityId`, `linkable`, `defineFields`, `cf.*`
- **Declaration** — `ce.ts` per module
- **Custom field defaults** — `customFieldDefaults.ts`
- **Entity extensions** — `data/extensions.ts` (cross-module data links)
- **Routing** — `customFieldRouting.ts` in `lib/`

## Encryption

- **Service:** `TenantDataEncryptionService` (AES-256-GCM, KMS-managed DEKs)
- **Declaration:** `encryption.ts` per module via `defaultEncryptionMaps`
- **Querying:** Use `findWithDecryption`/`findOneWithDecryption` instead of raw `em.find`/`em.findOne`
- **Scope:** Query index docs and vector search result fields are encrypted at rest
