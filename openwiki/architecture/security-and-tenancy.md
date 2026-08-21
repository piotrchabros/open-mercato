# Security & Tenancy

Open Mercato is multi-tenant by default with strict tenant + organization scoping on every entity and API. Security is enforced through layered RBAC, field-level encryption, optimistic locking, and declarative route guards.

## Two-Level Tenancy

**Source:** `packages/core/src/modules/directory/data/entities.ts`

| Level | Table | Purpose |
|-------|-------|---------|
| **Tenant** | `tenants` | Top-level multi-tenant isolation boundary |
| **Organization** | `organizations` | Sub-tenant grouping with hierarchical tree support |

Organizations support multi-hierarchical trees via `parentId`, `rootId`, `treePath`, `depth`, `ancestorIds[]`, `childIds[]`, `descendantIds[]` (jsonb arrays for tree traversal). Organization slugs are unique per tenant.

Every entity carries `organizationId` + `tenantId`. The CRUD factory auto-injects these filters via `buildScopedWhere()` unless `omitAutomaticTenantOrgScope: true` is set. **Never** expose cross-tenant data or skip tenant/organization scoping.

## RBAC / Access Control

**Sources:** `packages/core/src/modules/auth/services/rbacService.ts`, `packages/shared/src/security/featurePolicy`, `packages/core/src/modules/<module>/acl.ts`

### Two-Layer RBAC

1. **Role ACLs** (`roles` + `role_acls` tables) — tenant-scoped roles with feature grants
2. **User ACLs** (`user_acls` table) — per-user overrides on top of role grants

### Feature Model

Features are declared per-module in `acl.ts` as `{ id: '<module>.<action>', title, module, dependsOn?: [] }`:
- Naming: `<module>.<entity>.<action>` (e.g., `customers.people.view`, `customers.people.manage`)
- Wildcard grants: `customers.*` grants all customers features
- `defaultRoleFeatures` in `setup.ts` maps role names to feature arrays — applied during tenant setup and via `yarn mercato auth sync-role-acls`

### RbacService

- `userHasAllFeatures(userId, features, { tenantId, organizationId })` — server-side authorization entrypoint
- Caches ACL data (`AclData: { isSuperAdmin, features[], organizations[]|null }`) via `CacheStrategy` with tag-based invalidation (`rbac:user:<id>`, `rbac:tenant:<id>`, `rbac:org:<id>`, `rbac:all`)
- `isGlobalSuperAdmin(userId)` — grants all active features
- Organization visibility: `organizations` array controls which orgs a user can see; `null` or `['__all__']` = all
- Policy order: invalid scope and nulled/disabled features deny **before** super-admin or wildcard grants

### Route-Level Guards

Prefer declarative guards in route metadata. Use `requireFeatures` (immutable feature IDs), not `requireRoles` (mutable role names can be spoofed):

```typescript
const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.people.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.people.manage'] },
}
```

For **customer portal** pages, use `requireCustomerAuth` and `requireCustomerFeatures`.

### Wildcard ACL Handling

Wildcards (`customers.*`) are handled in feature-gated runtime helpers: menus, notification handlers, mutation guards, command interceptors, AI tools. The `shared` + `ui` + `core:auth` (portal: `core:customer_accounts`) packages coordinate wildcard resolution.

## Encryption

**Sources:** `packages/shared/src/lib/encryption/`, `packages/core/src/bootstrap.ts`

### Architecture

- **`TenantDataEncryptionService`** — central service, registered in DI as `tenantEncryptionService`
- **AES-256-GCM** with per-row random IV: `encryptWithAesGcm(value, dekBase64)` → `{ value, raw, version }` payload
- **KMS** — Vault-based key management for tenant Data Encryption Keys (DEKs), 15-minute DEK cache TTL
- **Feature flag**: `TENANT_DATA_ENCRYPTION` env var (defaults to `true`)

### Encryption Maps

Each module declares `encryption.ts` exporting `ModuleEncryptionMap[]`:

```typescript
{ entityId: 'customers:customer_entity', fields: [{ field: 'display_name' }, { field: 'primary_email' }] }
```

Supports `hashField` for deterministic lookup — encrypted `email` is non-deterministic, so unique indexes key on `email_hash`.

### Querying Encrypted Data

**MUST use** `findWithDecryption` / `findOneWithDecryption` / `findAndCountWithDecryption` from `@open-mercato/shared/lib/encryption/find` instead of raw `em.find`. These accept a `DecryptionScope: { tenantId, organizationId, encryptionService? }`.

For **search** on encrypted columns, use `findEntityIdsBySearchTokens` from `@open-mercato/shared/lib/search/tokenLookup` — the token index stores hashes of plaintext, so `$ilike` on encrypted columns matches nothing.

### Bootstrap Flow

`bootstrap()` in `packages/core/src/bootstrap.ts`:
1. Creates `KmsService`
2. If encryption enabled, loads `defaultEncryptionMaps` from all registered modules
3. Creates `TenantDataEncryptionService(em, { cache, kms, defaultEncryptionMaps })`
4. Registers it in container
5. If KMS healthy, calls `registerTenantEncryptionSubscriber` — hooks into MikroORM's `onFlush`/`onPopulate` cycle to transparently encrypt on write and decrypt on read

## Optimistic Locking

**Sources:** `packages/shared/src/lib/crud/optimistic-lock.ts`, `packages/shared/src/lib/crud/optimistic-lock-command.ts`, `packages/ui/src/backend/conflicts/`

Optimistic locking is **default ON** for every `makeCrudRoute` entity (opt out with `OM_OPTIMISTIC_LOCK=off`). It prevents lost updates from concurrent edits:

- Entity must have an `updated_at` column
- API responses return `updatedAt` in list/detail responses
- `CrudForm` auto-derives the optimistic lock header from `initialValues.updatedAt` (covers update **and** delete)
- For custom non-`CrudForm` handlers: wrap the mutating call with `withScopedApiRequestHeaders(buildOptimisticLockHeader(record.updatedAt), …)` and surface conflicts via `surfaceRecordConflict(err, t)`
- When a form's `onSubmit` mutates OTHER entities, override the parent header per child with that child's own version (avoid false 409s)
- Command pattern: `enforceCommandOptimisticLock`, DI-overridable `createCommandOptimisticLockGuardService`

Full spec: `.ai/specs/implemented/2026-05-25-oss-optimistic-locking.md`

## Rate Limiting

**Sources:** `packages/shared/src/lib/ratelimit/`, `packages/checkout/src/modules/checkout/lib/rateLimiter.ts`

`RateLimiterService` supports memory or Redis strategy via `rate-limiter-flexible`. The checkout package's public pay endpoints enforce **fail-closed** rate limiting — if the limiter is unavailable, write endpoints return 503 (not a silent allow). Read-only endpoints use fail-open (log and allow).

Three distinct outcomes:
1. Not configured → config error, skip limiting
2. Can't decide (limiter unavailable) → 503 (fail-closed) or log (fail-open)
3. Quota exhausted → 429

Keyed by client IP + namespace. Full docs: `apps/docs/docs/framework/security/rate-limiting.mdx`.

## Dashboard Widget Scope Authorization

**Source:** `packages/core/src/modules/dashboards/lib/widgetScope.ts`

Dashboard widgets authorize tenant/organization scope overrides to prevent scope forgery attacks. Each widget route validates that the requesting user's organization scope includes the widget's target tenant/organization. Test coverage: `scope-forgery.test.ts` in both `customers` and `sales` dashboard widget test suites.

## Key Source References

| Area | Source Path |
|------|------------|
| RBAC service | `packages/core/src/modules/auth/services/rbacService.ts` |
| Feature policy | `packages/shared/src/security/featurePolicy` |
| Encryption service | `packages/shared/src/lib/encryption/tenantDataEncryptionService.ts` |
| Encrypted find helpers | `packages/shared/src/lib/encryption/find.ts` |
| Optimistic lock | `packages/shared/src/lib/crud/optimistic-lock.ts` |
| Rate limiting | `packages/shared/src/lib/ratelimit/service.ts` |
| Dashboard scope | `packages/core/src/modules/dashboards/lib/widgetScope.ts` |
| Tenancy entities | `packages/core/src/modules/directory/data/entities.ts` |
| Security docs | `apps/docs/docs/framework/security/` |
| Concurrency/locking docs | `apps/docs/docs/framework/data-integrity/concurrency-locking.mdx` |