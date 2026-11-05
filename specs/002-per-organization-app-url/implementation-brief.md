# Implementation brief: 002 per-organization app URL

I checked every assumption against branch `002-per-organization-app-url` (= `crm` @ 5dc79ff05). All paths below are under `/srv/open-mercato-org-app-url/`. Nothing was edited.

## A. Verified facts (your questions 1–9)

### 1. Directory module

**Entity** (`packages/core/src/modules/directory/data/entities.ts`)
- `Organization` is at l.28–81. It already has `@Unique({ name: 'organizations_tenant_slug_uniq', properties: ['tenant','slug'] })`.
- Decorators come from `@mikro-orm/decorators/legacy`. `logoUrl` is the pattern to copy for a new nullable text column.
- **A partial index cannot go in the decorator.** The precedent is `auth/data/entities.ts` l.165 (`SidebarVariant`): the entity omits the index, the raw-SQL migration owns it, and the snapshot does not list it.

**Validators** (`data/validators.ts`)
- `organizationUpdateSchema` is a plain `z.object`, so unknown keys are stripped. `appUrl` must be added there or the command never sees it.

**Update command** (`commands/organizations.ts` l.645–883, id `directory.organizations.update`)
- *Input:* `rawInput: Record<string, unknown>`, parsed with `parseWithCustomFields(organizationUpdateSchema, rawInput)` in both `prepare` and `execute`.
- *Loading:* `loadAuthorizedOrganizationTarget(em, id, ctx)` returns `{ organization, tenantId }`. Superadmin is detected through `resolveIsSuperAdmin(ctx)`, imported from `@open-mercato/core/modules/auth/lib/tenantAccess`.
- *Mutation:* runs inside `withAtomicFlush(em, [...], { transaction: true })` via `de.updateOrmEntity({ apply })`. `emitCrudSideEffects` runs after the transaction.
- *Errors:* thrown as `new CrudHttpError(status, { error, code?, fieldErrors? })` from `@open-mercato/shared/lib/crud/errors`. For an example with fieldErrors, see staff `timesheets-tasks.ts` l.241.
- *Audit:*
  - `serializeOrganization()` (l.203) is the view snapshot. `captureAfter` and the `buildLog` "after" both use it.
  - `buildLog` computes `changes = buildChanges(before.view, after, ['name','slug','logoUrl','logoPreserveAspectRatio','isActive','parentId'])` (l.802).
  - The undo payload uses `OrganizationUndoSnapshot` / `captureOrganizationSnapshots`.
- *Delete* (l.885) is a soft delete.

**API** (`api/organizations/route.ts`)
- PUT/POST/DELETE come from `makeCrudRoute` with `rawBodySchema` passthrough mapped to the command. PUT requires `directory.organizations.manage` and returns `{ ok: true }`.
- **There is no detail endpoint.** The edit page calls `GET ?view=manage&ids=<id>&pageSize=1`.
- Manage-view items are built in two places: the all-tenants superadmin branch (~l.442–470) and the single-tenant branch (~l.557–584). Both use per-field Maps, e.g. `logoUrlByOrgId`.
- The response top level is `{ items, total, page, pageSize, totalPages, isSuperAdmin }`.

**OpenAPI** (`api/openapi.ts`)
- `organizationNodeSchema` (passthrough) and `organizationListResponseSchema` live here.
- The PUT doc reuses `organizationUpdateSchema`, so adding the field there documents it automatically.

**DI** (`di.ts`)
- Pattern: `container.register({ x: asFunction((cradle: {...}) => ...).scoped().proxy() })`.
- `.proxy()` is required for the cradle-object style.
- Template for lazily reading `cache`: `customer_accounts/di.ts` l.11–48 (uses `container.hasRegistration('cache')`).

**setup.ts**
- `defaultRoleFeatures: { superadmin: ['directory.tenants.*'], admin: ['directory.organizations.view','directory.organizations.manage'] }`.
- Superadmin passes feature checks because of `acl.isSuperAdmin` (unrestricted), not a wildcard. Leave setup.ts unchanged.

**i18n**
- Files: `packages/core/src/modules/directory/i18n/{en,pl,de,es,ko}.json`. Flat, alphabetically sorted keys.
- **The error namespace is `directory.organizations.errors.*`. There is no `directory.errors.*`.** Form labels use `directory.organizations.form.field.<x>`, and descriptions use `directory.organizations.form.field.<x>.description`.
- ACL feature labels are `auth.acl.features.<featureId>` in `packages/core/src/modules/auth/i18n/*.json` (e.g. l.183 in en).

**Edit page**
- **The path is `backend/directory/organizations/[id]/edit/page.tsx`, not `[id]/page.tsx`.**
- It uses `CrudForm` with a `fields: CrudField[]` memo and `groups`. `detailFields` is the list `['tenantId','name','slug','parentId','childrenInfo','isActive']`.
- Optimistic locking comes from `optimisticLockUpdatedAt` / `initialValues.updatedAt`.
- The submit path is the exported `submitUpdateOrganization()` (l.375+). It builds an explicit payload and is covered by `__tests__/edit-submit.test.ts`.
- `CrudField` supports `type: 'select'` with `options`.

### 2. Feature check inside a command

- Superadmin check first: `await resolveIsSuperAdmin(ctx)`. It is cached per ctx, and it also honours `auth.isSuperAdmin`.
- Then: `(ctx.container.resolve('rbacService') as RbacService).userHasAllFeatures(auth.sub, [feature], { tenantId: auth.tenantId ?? null, organizationId: auth.orgId ?? null })`. This is wildcard-aware and treats superadmin as unrestricted (`rbacService.ts` l.1016). Same usage as `sales/commands/settings.ts` l.19.
- `ctx.systemActor === true` means a system caller and should bypass.

### 3. Cache

- The DI key is `cache`. The API is `get / set(key, value, { ttl /*ms*/, tags }) / deleteByTags(string[])`. There is no `invalidateTag`.
- **Keys and tags are prefixed by the AsyncLocalStorage cache tenant.** Wrap every get/set/delete in `runWithCacheTenant(null, () => ...)` from `@open-mercato/cache`, as `customer_accounts/services/domainMappingService.ts` l.179/185/501 does. Otherwise an invalidation made from a superadmin request misses entries written under another tenant context.
- `cache` can be missing (bootstrap logs "Failed to create cache service"), so the resolver must tolerate `null`.
- Production uses `CACHE_STRATEGY=redis` (cross-process). The integration lane uses sqlite.

### 4. `packages/shared/src/lib/url.ts`

- Exports: `AppOriginConfigurationError`, `AppOriginRejectedError`, `readConfiguredAppOrigins`, `isEquivalentLoopbackOrigin`, `assertAllowedAppOrigin`, `resolveRequestOrigin`, `getAppBaseUrl`, `toAbsoluteUrl`, `getSecurityEmailBaseUrl`, `toSecurityEmailUrl`, `isCrossSiteBrowserRequest`, `mapSecurityEmailUrlError`.
- Private helpers worth reusing in the same file: `normalizeOrigin`, `readAllowedOrigins`, `readRequestOriginCandidates`, `shouldAllowLoopbackOrigin`.
- **`resolveOAuthRedirectUri` is not in url.ts.** It is in `packages/core/src/modules/integrations/lib/oauth/redirect.ts`; the contracts doc is wrong.
- There is no shared `tryResolve`. Every module does a local try/catch around `container.resolve`. Do the same in url.ts. It needs no import from core, only the DI key string.

### 5. US1 call sites

**Password reset** (`auth/api/reset.ts`)
- `toSecurityEmailUrl(req, '/reset/__token__')` runs *before* the user lookup, so a bad origin or config fails identically for every email.
- The container `c = await createRequestContainer()` is created after that. The user (`user.organizationId`) is known only once `requestPasswordReset` returns.

**Invitation** (`auth/commands/users.ts` l.624)
- `sendInviteToUser(em, user)` takes no container. Its only caller is l.380 inside the create command, where `ctx.container` is available.
- It uses `getSecurityEmailBaseUrl()` with no req. The org is `user.organizationId`.

**Resend invite** (`auth/api/users/resend-invite/route.ts` ~l.140)
- `container` is in scope. `base = getSecurityEmailBaseUrl(req)` runs after the user is loaded, so `user.organizationId` is available.

**Message emails** (`messages/lib/email-sender.ts`)
- Local `resolveAppUrl()` reads raw `process.env.APP_URL`. When it is null, the link is omitted.
- `sendMessageEmailToRecipient({ em, message, ... })` takes no container. Its caller is `messages/workers/send-email.worker.ts` l.296, where `ctx.resolve` exists, so ctx itself fits `{ resolve(name: string): unknown }`.
- The org is `message.organizationId`. The external variant has no link and is unaffected.

**Notification emails** (`notifications/lib/deliveryConfig.ts`)
- `resolveNotificationPanelUrl(config)` returns `config.appUrl || APPLICATION_URL || NEXT_PUBLIC_APP_URL || APP_URL` plus `panelPath`.
- `config.appUrl` is filled from env (`NOTIFICATIONS_APP_URL || APPLICATION_URL || NEXT_PUBLIC_APP_URL || APP_URL`) or from the stored module config (settings page "Application URL"). **So an explicit setting cannot be told apart from the APP_URL default.**
- The only caller is `notifications/subscribers/deliver-notification.ts` l.128. There `ctx` is a resolver and `notification.organizationId` is available; `baseOrigin` is derived from `panelUrl`.

**Form invitations**
- **The link is built in `forms/commands/invitation.ts`, not in the subscriber.** See `resolveAppUrl()` l.67 and `buildPersonalLink(rawToken)` l.73, called at l.194 inside `forms.invitation.create`.
- `ctx.container` and `parsed.organizationId` are available there.
- The subscriber `forms/subscribers/invitation-email.ts` has a dead `resolveAppUrl()`. Its resend path sends no link. Leave it alone.

**Quote send** (`sales/api/quotes/send/route.ts` l.157)
- Currently `process.env.APP_URL || ''`, with a relative fallback.
- `ctx.container` and `quote.organizationId` are available.
- Not in tasks.md: `sales/api/quotes/accept/route.ts` l.151 has the same pattern for the admin email. Optional.

**Onboarding** (`onboarding/lib/ready-email.ts`)
- Uses `getSecurityEmailBaseUrl()` and `request.organizationId`.
- A freshly onboarded organization can never have an `appUrl`, so this change has no effect.

### 6. US2

**Integrations grant service**
- **`grant-service.ts` has no initiate, callback or state.** It only receives a token response in `completeConnect`.
- Its single use of the redirect helper is `isBaseUrlMissing()` at l.623, which calls `resolveOAuthRedirectUri(undefined, '/')`. That is a production APP_URL presence check.
- No OAuth grant provider in this repo has a connect route. Only `api/post/test-oauth-grants` (test-only) calls `completeConnect`.
- **T028, as written, cannot be implemented.**

**`redirect.ts`**
- Sync `resolveOAuthRedirectUri(req, path)` wraps `toSecurityEmailUrl` and maps errors to `OAuthGrantError('oauth_base_url_not_configured' | 'connect_origin_rejected')`. It keeps any APP_URL path prefix (see the tests in `__tests__/redirect.test.ts`).
- Callers:
  - meta-lead-ads `oauth/initiate` l.92
  - meta-lead-ads `oauth/callback` l.236
  - meta-lead-ads `data-deletion` l.133 (leave it)

**Communication channels**
- *State:* `lib/oauth-state.ts`. AES-GCM state in a **host-scoped HttpOnly cookie** (`om_cc_oauth_state`, path `/`).
  - `OAuthStatePayload { state, nonce, userId, tenantId, organizationId?, providerKey, returnUrl?, expiresAt, extra? }`
  - `createOAuthState(params)`
  - `verifyOAuthState({ cookie, expectedUserId, expectedProviderKey?, expectedState? })`
  - `consumeOAuthStateOnce(store, payload)`
  - `OAuthStateError.code` is a closed union.
- *Initiate:* `api/post/oauth/[provider]/initiate/route.ts`. The redirect URI is `toAbsoluteUrl(req, '/api/communication_channels/oauth/<p>/callback')`, i.e. NEXT_PUBLIC_APP_URL || APP_URL || request origin, which is **not** `resolveOAuthRedirectUri`. The org is `auth.orgId`.
- *Callback:* `api/get/oauth/[provider]/callback/route.ts`. The exchange redirect URI is recomputed with `toAbsoluteUrl` (l.191). `redirectWithFlash(req, returnUrl, flash)` uses `getAppBaseUrl(req)`.
- channel_gmail is enabled in `apps/mercato/src/modules.ts`, so this flow is live.

**Meta Lead Ads**
- *Initiate* (GET, 302): org from `resolveActiveOrganizationId(auth)`, container available. It sets the state cookie (path `/api/meta_lead_ads/oauth`, host-scoped).
- *Callback:* the org is `payload.organizationId`. `redirectWithResult(req, code)` targets `getAppBaseUrl(req)` + `/backend/meta-lead-ads?connect=<code>`. Codes are `CONNECT_FAILURE_CODES` in `lib/constants.ts` l.185. `lib/http.ts` exports `tryResolve`.
- **Today the post-callback redirect always goes to APP_URL.** It must follow the organization's address too.

**Request origin**
- `resolveRequestOrigin(req)` uses raw, unsplit headers. Do not use it for the check. Add a new helper built on `readRequestOriginCandidates` (see interfaces).

### 7. Integration test infrastructure

- **A mail capture exists.** `packages/core/src/helpers/integration/communicationChannelsFixtures.ts` provides:
  - `isChannelSeedingAvailable`
  - `seedSystemEmailChannel`
  - `clearCapturedSystemEmails`
  - `waitForCapturedSystemEmail(request, token, predicate)`

  Each captured item has `metadata.to`, `metadata.subject` and `content.html`. The reference spec is `auth/__integration__/TC-AUTH-EMAIL-001.spec.ts`, which already covers reset, invite and resend. Skip with `test.skip(!available, ...)` when `OM_ENABLE_TEST_CHANNEL_SEEDING` is off.
  - The reset email subject is "Reset your password".
  - "Password reset requested" is the *notification* email delivered through deliver-notification.
- Tokens: `getAuthToken(request, 'superadmin' | 'admin')` from `@open-mercato/core/helpers/integration/api`.
- Fixtures in `authFixtures.ts`:
  - `createOrganizationFixture` / `deleteOrganizationIfExists` (soft delete)
  - `createUserFixture(request, token, { email, password, organizationId, roles })` / `deleteUserIfExists`
  - `apiRequestWithSelectedOrg`
- Meta OAuth fixtures: `packages/meta-lead-ads/src/modules/meta_lead_ads/__integration__/support/fixtures.ts`. `setupMetaTestEnv` creates its own org and a fake Graph server. Initiate/callback helpers are in `TC-META-009-connection.spec.ts`.
- Audit query: `GET /api/audit_logs/audit-logs/actions?resourceKind=directory.organization&resourceId=<id>`. See `TC-UNDO-001-organizations.spec.ts` l.127.
- **Test environment constraint:** the ephemeral lane runs `NODE_ENV=production`, `APP_URL=NEXT_PUBLIC_APP_URL=http://127.0.0.1:<port>` and no `APP_ALLOWED_ORIGINS` (`packages/cli/src/lib/testing/integration.ts` ~l.2178/3537). Changing the harness is "Ask first", so don't.
  - The only usable second origin is the loopback equivalent `http://localhost:<port>`, which `assertAllowedAppOrigin` accepts in production via `isEquivalentLoopbackOrigin`, same port.
  - So the validator and resolver must use the same loopback rule, and the "https in production" rule must exempt loopback hosts.
  - Playwright uses `workers: 1` (`.ai/qa/tests/playwright.config.ts`), so specs run serially. Every spec must still clear the address in `finally`, because there is only one alternate origin.

### 8. Migration

- Folder: `packages/core/src/modules/directory/migrations/`.
- The live snapshot is `.snapshot-open-mercato.json`. `.snapshot-openmercato.json` is legacy; don't touch it.
- Naming precedent: `Migration20260626145500_directory_logo_preserve_aspect_ratio.ts`, class `Migration20260626145500DirectoryLogoPreserveAspectRatio`, written with `override up()/down()` and `this.addSql`.
- Expected SQL:
  - up:
    - `alter table "organizations" add column "app_url" text null;`
    - `create unique index if not exists "organizations_app_url_uniq" on "organizations" ("app_url") where "deleted_at" is null and "app_url" is not null;`
  - down:
    - `drop index if exists "organizations_app_url_uniq";`
    - `alter table "organizations" drop column "app_url";`
- Snapshot: add only the `app_url` column entry (copy the `logo_url` block, l.147), not the partial index, following the sidebar_variants precedent.

### 9. Where to show the return address

- **Generic integrations OAuth detail:** no in-repo provider has a callback route, so there is nothing meaningful to show. Cut it.
- **Meta:** the least-invasive option is an additive field `oauthRedirectUri: string | null` on `GET /api/meta_lead_ads/settings`.
  - Route: `meta-lead-ads/.../api/settings/route.ts`, which already has `ctx.container` and `ctx.organizationId`.
  - DTO: `api/openapi.ts` `settingsDtoSchema` l.202, plus `components/types.ts` `SettingsDto` l.220.
  - UI: render a read-only row with a copy button on `backend/meta-lead-ads/settings/page.tsx`, which already loads that DTO.
  - The integration-detail widget is static (no fetch); leave it.
- **Communication channels (gmail):** return-address UI is cut from v1 (see C).

## B. Corrections to tasks.md

| Task | Issue | Correction |
|---|---|---|
| T002 | The pointer spec `.ai/specs/2026-11-05-per-organization-app-url.md` already exists (untracked) | Only update its bullets to match this brief: grant service dropped, onboarding dropped |
| T003 | The partial index can't be expressed in the entity | Property only; the migration owns the index |
| T005 | No separate zod `organizationAppUrlSchema`; the i18n namespace is wrong | Use `directory.organizations.errors.*`. Add the loopback rule |
| T007/T009 | Missing an "own address or null" API | Needed so notifications, messages, forms and quotes keep today's exact fallback (FR-011) |
| T010 | Undo needs care | Do NOT add `appUrl` to the undo snapshot, otherwise a plain admin can change the address through undo/redo. Audit it via the view snapshot and `buildChanges` only. Also invalidate after delete |
| T011 + T035 | Same file | Merge them |
| T021 | Precedence detail | Precedence is: `NOTIFICATIONS_APP_URL` env, then the organization's own address, then the existing chain |
| T022 | Wrong file | `forms/commands/invitation.ts`, not the subscriber |
| T024 | No effect | Cut |
| T027 | Shape change | Add an async sibling returning `{ redirectUri, redirectOrigin }`. The sync function is unchanged |
| T028 | Cannot be implemented | Cut; the grant service has no state or callback |
| T031 | Generic integrations row has nothing to show | Generic row cut; Meta row moves to the settings page |
| T033 | Location | Move to meta-lead-ads as `TC-META-010-org-app-url.spec.ts` (its fixtures live there) |
| T034 | Wrong path | `[id]/edit/page.tsx` |

## C. Interfaces (exact)

### C1. `packages/shared/src/lib/url.ts` (additive)

```ts
export const ORGANIZATION_APP_URL_RESOLVER_DI_KEY = 'organizationAppUrlResolver'
export type OrganizationAppUrlResolver = {
  resolveOwn(organizationId: string | null | undefined): Promise<string | null>
  resolve(organizationId: string | null | undefined): Promise<string>
  invalidate(organizationId: string): Promise<void>
}
export type AppUrlScope = { container?: { resolve(name: string): unknown } | null; organizationId?: string | null }
export function normalizeAppOrigin(raw: unknown): string | null
export function isAllowedAppOrigin(origin: string, env?: EnvLike): boolean
export function readAllowedRequestOrigin(req: Request, env?: EnvLike): string | null
export async function resolveOrganizationAppUrl(scope: AppUrlScope): Promise<string | null>
export async function resolveAppBaseUrl(scope: AppUrlScope & { req?: RequestInput; env?: EnvLike }): Promise<string>
export async function toAppUrl(scope: AppUrlScope & { req?: RequestInput; env?: EnvLike }, path: string): Promise<string>
```

- `normalizeAppOrigin`
  - Trims the input and parses it as a URL.
  - Accepts only `http:` and `https:`, with no credentials, a pathname of `/` or empty, and no search or hash.
  - Returns `url.origin`, so the host is lower-cased and the default port dropped.
- `isAllowedAppOrigin` returns true when the origin is in `readAllowedOrigins(env)` or when `shouldAllowLoopbackOrigin(origin, allowed, env)` passes.
- `readAllowedRequestOrigin`
  - Takes a single candidate, in order: the x-forwarded-host origin, then the host origin, then the URL origin.
  - Protocol logic is as in `readRequestOriginCandidates`.
  - Returns the candidate only if `isAllowedAppOrigin`, otherwise null.
- `resolveOrganizationAppUrl`
  - Returns null when there is no container or organizationId.
  - Otherwise does a try/catch resolve of the DI key. If the result is not an object with a `resolveOwn` function, it returns null.
  - Calls `resolveOwn` and catches errors to null. It never throws.
- `resolveAppBaseUrl`:
  - First `const fallback = getSecurityEmailBaseUrl(req, env)`. This keeps the config and origin errors exactly as today.
  - Then returns `(await resolveOrganizationAppUrl(scope)) ?? fallback`.
- `toAppUrl` builds `${base}/${path.replace(/^\/+/, '')}`.

### C2. `directory/data/validators.ts`

- Add `appUrl: z.string().trim().max(2048).nullable().optional()` to `organizationUpdateSchema`. Create is unchanged.
- Add:

```ts
export type OrganizationAppUrlCheck = { ok: true; value: string | null } | { ok: false; reason: 'invalid' | 'notAllowed' }
export function normalizeOrganizationAppUrl(value: string | null, env: Record<string, string | undefined> = process.env): OrganizationAppUrlCheck
```

Rules:
- `null` or `''` gives `{ ok: true, value: null }`.
- If `normalizeAppOrigin` returns null, the reason is `invalid`.
- `NODE_ENV==='production'` with `http:` and a non-loopback host (localhost, 127.0.0.1) is `invalid`.
- If `!isAllowedAppOrigin`, the reason is `notAllowed`.

### C3. `directory/constants.ts`

`export const ORGANIZATION_MANAGE_APP_URL_FEATURE = 'directory.organizations.manage_app_url'`

### C4. `directory/lib/organizationAppUrl.ts`

```ts
export const ORGANIZATION_APP_URL_CACHE_TTL_MS = 60_000
export function organizationAppUrlCacheTag(organizationId: string): string   // `directory:organization:${id}:app_url`
export function organizationAppUrlCacheKey(organizationId: string): string   // `directory:organization-app-url:${id}`
export type OrganizationAppUrlCache = { get(key: string): Promise<unknown>; set(key: string, value: unknown, options?: { ttl?: number; tags?: string[] }): Promise<void>; deleteByTags(tags: string[]): Promise<number> }
export function createOrganizationAppUrlResolver(deps: { em: EntityManager; cache?: OrganizationAppUrlCache | null; env?: Record<string, string | undefined> }): OrganizationAppUrlResolver
export async function canManageOrganizationAppUrl(input: { container: { resolve<T = unknown>(name: string): T }; auth: { sub?: string | null; tenantId?: string | null; orgId?: string | null; isSuperAdmin?: boolean } | null; systemActor?: boolean }): Promise<boolean>
```

**Resolver**
- An id that is not a UUID gives null.
- Cache value: `{ appUrl: string | null }`. Treat anything else as a miss.
- Every cache call goes through `runWithCacheTenant(null, ...)` inside a try/catch.
- On a miss: `findOneWithDecryption(deps.em.fork(), Organization, { id, deletedAt: null }, undefined, { tenantId: null, organizationId: id })`, then cache the result with the TTL and tag.
- `resolveOwn`:
  - Stored value present and `isAllowedAppOrigin` → return it.
  - Stored value present but not allowed → log a warning once per (process, orgId) through a module-level `Set` and `createLogger('directory')`, then return null.
- `resolve` returns `(await resolveOwn(id)) ?? getSecurityEmailBaseUrl(undefined, env)`. It throws only the existing production config error.
- `invalidate` calls `deleteByTags([tag])`, swallowing errors.

**`canManageOrganizationAppUrl`**
1. `systemActor` → true.
2. `resolveIsSuperAdmin` → true.
3. Otherwise `rbacService.userHasAllFeatures(auth.sub, [FEATURE], { tenantId, organizationId: orgId })`.
4. false on any error.

### C5. `integrations/lib/oauth/redirect.ts` (additive)

```ts
export type OrganizationOAuthRedirect = { redirectUri: string; redirectOrigin: string | null }
export async function resolveOAuthRedirectUriForOrganization(req: Request | undefined, path: string, scope: AppUrlScope): Promise<OrganizationOAuthRedirect>
```

1. Validate the path exactly as the sync version does.
2. `own = await resolveOrganizationAppUrl(scope)`.
3. If `own`:
   - When `req` is given, run `assertAllowedAppOrigin(req)` and map the errors as in the sync version.
   - Return `{ redirectUri: own + path, redirectOrigin: own }`.
4. Else return `{ redirectUri: resolveOAuthRedirectUri(req, path), redirectOrigin: null }`.

`redirectOrigin` is non-null only when an organization address was used. That keeps today's behaviour byte-for-byte when nothing is configured, and also keeps spec Q9: the redirect URI is never built from the request origin.

### C6. `communication_channels/lib/oauth-state.ts` (additive)

- `OAuthStatePayload.redirectOrigin?: string | null`.
- `createOAuthState` params gain `redirectOrigin?: string | null`, copied into the payload.
- `OAuthStateError` code union gains `'origin_mismatch'`.
- New function:

```ts
export function assertOAuthStateRedirectOrigin(payload: Pick<OAuthStatePayload, 'redirectOrigin'>, req: Request): void
```

It does nothing when `!payload.redirectOrigin`. It throws `OAuthStateError('[internal] OAuth callback origin mismatch', 'origin_mismatch')` when `readAllowedRequestOrigin(req) !== payload.redirectOrigin`.

### C7. Directory API response (manage view)

- Each item gains `appUrl: string | null`.
- The top level gains `canManageAppUrl: boolean` and `appUrlOptions: string[]`. `appUrlOptions` is `readConfiguredAppOrigins()` when the caller can manage the address, else `[]`.

### C8. i18n keys

**Directory** (all five locales)
- `directory.organizations.form.field.appUrl` = "Organization address"
- `directory.organizations.form.field.appUrl.description` = "Email links and service connections for this organization use this address."
- `directory.organizations.form.field.appUrl.default` = "Use installation default"
- `directory.organizations.errors.appUrlInvalid`
- `directory.organizations.errors.appUrlNotAllowed`
- `directory.organizations.errors.appUrlTaken`
- `directory.organizations.errors.appUrlForbidden`

**Auth**: `auth.acl.features.directory.organizations.manage_app_url` = "Manage organization address".

**Meta**:
- `meta_lead_ads.settings.oauthRedirectUri.label`
- `meta_lead_ads.settings.oauthRedirectUri.description`
- `meta_lead_ads.settings.oauthRedirectUri.copy`
- `meta_lead_ads.settings.oauthRedirectUri.copied`
- `meta_lead_ads.connect.errors.wrong_origin`

**Communication channels**: `communication_channels.oauth.errors.originMismatch`, in `packages/core/src/modules/communication_channels/i18n/*.json`.

## D. Per-task instructions

**T002 (docs)**
- Edit `.ai/specs/2026-11-05-per-organization-app-url.md`: remove "integrations grant service" and "onboarding" from the TLDR, and add the `resolveOrganizationAppUrl` / `resolveOAuthRedirectUriForOrganization` helpers to the BC list.
- `specs/002-.../tasks.md` can be updated the same way (optional).

**T003** (`directory/data/entities.ts`)
- Add after `logoPreserveAspectRatio`: `@Property({ name: 'app_url', type: 'text', nullable: true }) appUrl?: string | null`.
- Add no decorator index. Do not copy the sidebar_variants comment (the project bans inline comments).

**T004** — hand-write the migration and snapshot per A8.
- File: `migrations/Migration20261105120000_directory_organization_app_url.ts`, class `Migration20261105120000DirectoryOrganizationAppUrl`.
- `yarn db:generate` may be used to check. Discard unrelated output.

**T005** (`directory/data/validators.ts`) — C2. Depends on T009 (imports `normalizeAppOrigin` / `isAllowedAppOrigin`).

**T006**
- `acl.ts`: add `{ id: 'directory.organizations.manage_app_url', title: 'Manage organization address', module: 'directory', dependsOn: ['directory.organizations.manage'] }`.
- `constants.ts`: C3.
- `auth/i18n/{en,pl,de,es,ko}.json`: the feature label.
- `directory/__tests__/acl.test.ts` already validates `dependsOn`; it must stay green.

**T007** (`directory/lib/organizationAppUrl.ts`) — C4. Depends on T003, T009, T006 (constant).

**T008** (`directory/di.ts`)
- Register `organizationAppUrlResolver`:

  ```ts
  asFunction(function organizationAppUrlResolverFactory(cradle: { em: EntityManager }) { ... }).scoped().proxy()
  ```

- Resolve `cache` lazily with `container.hasRegistration('cache')` and shape-check `get`/`set`/`deleteByTags`, copying `customer_accounts/di.ts`.

**T009** (`packages/shared/src/lib/url.ts`) — C1. Don't change existing exports.

**T010** (`directory/commands/organizations.ts`)

1. Add `appUrl: entity.appUrl ?? null` to `serializeOrganization`. Add `'appUrl'` to the `buildChanges` key list (l.802).
2. In `execute`, before `withAtomicFlush`, after `loadAuthorizedOrganizationTarget` (change it to also take `organization: current`):
   - If `parsed.appUrl !== undefined`:
     - Run `normalizeOrganizationAppUrl(parsed.appUrl)`.
     - On failure, `throw new CrudHttpError(422, { error: msg, fieldErrors: { appUrl: msg }, code: key })`. `msg` is `translate('directory.organizations.errors.appUrlInvalid' | '...appUrlNotAllowed', fallback)` via `resolveTranslations()`.
   - `appUrlChanged = requested !== undefined && requested !== (current.appUrl ?? null)`.
   - If changed and `!(await canManageOrganizationAppUrl({ container: ctx.container, auth: ctx.auth, systemActor: ctx.systemActor }))`, throw 403 `{ error, code: 'directory.organizations.errors.appUrlForbidden' }`. Nothing has been written at this point.
   - If changed and the new value is non-null: `findOneWithDecryption(em, Organization, { appUrl: requested, deletedAt: null, id: { $ne: parsed.id } }, undefined, { tenantId: null, organizationId: null })`. This lookup is global across tenants. On a hit, throw 409 `{ error, fieldErrors: { appUrl }, code: '...appUrlTaken' }`.
3. In `apply`: `if (requestedAppUrl !== undefined) entity.appUrl = requestedAppUrl`.
4. Wrap `withAtomicFlush` in a try/catch that maps a unique violation on `organizations_app_url_uniq` to the same 409. Detection: `UniqueConstraintViolationException`, or code `23505` with the constraint name in the message (pattern: `isUniqueViolation` in `auth/commands/users.ts`).
5. After `emitCrudSideEffects`, if changed: soft-resolve `organizationAppUrlResolver` and `await invalidate(id)` in a try/catch. Do the same unconditionally in the delete command after its side effects.
6. Do NOT touch `OrganizationUndoSnapshot`, `captureOrganizationSnapshots().undo`, the undo/redo handlers, or the create command.

Depends on T003, T005, T006, T007.

**T011 (merged with T035)**

`api/organizations/route.ts`:
- Add an `appUrlByOrgId` Map in both manage branches and put `appUrl` on the items.
- Once per manage response:
  - `const canManageAppUrl = await canManageOrganizationAppUrl({ container, auth })`
  - `appUrlOptions = canManageAppUrl ? readConfiguredAppOrigins() : []`
  - Add both to both `NextResponse.json` calls of the manage view.
- PUT doc errors: add 403 (manage_app_url), 409 and 422.

`api/openapi.ts`:
- `organizationNodeSchema` gains `appUrl: z.string().nullable().optional()`.
- `organizationListResponseSchema` gains `canManageAppUrl: z.boolean().optional()` and `appUrlOptions: z.array(z.string()).optional()`.

Depends on T005, T007.

**T012** — `directory/__tests__/organizationAppUrl.test.ts`. Use a mocked em: mock `findOneWithDecryption` via `jest.mock('@open-mercato/shared/lib/encryption/find')`. Cover:
- set
- unset
- disallowed (fallback plus exactly one warning)
- cache hit (no second DB read)
- invalidate forces a reread
- a non-UUID or missing organization gives the default
- `cache` null works

Also cover `canManageOrganizationAppUrl`: systemActor, superadmin, rbac true/false, and a thrown error giving false.

**T013** — `directory/__tests__/appUrlValidator.test.ts`, passing an explicit `env`. Cover:
- a trailing slash and upper case are normalized
- a path, query or credentials give `invalid`
- `http` with production and a non-loopback host gives `invalid`
- `http://localhost:<port>` with `APP_URL=http://127.0.0.1:<port>` in production is ok
- an origin not in the list gives `notAllowed`
- `''` and null clear

**T014** — `packages/shared/src/lib/__tests__/url.appBaseUrl.test.ts`. Cover:
- `normalizeAppOrigin`
- `isAllowedAppOrigin` (including loopback)
- `readAllowedRequestOrigin` (forwarded-host precedence, disallowed gives null)
- `resolveOrganizationAppUrl`: no container, a resolve that throws, wrong shape, own value
- `resolveAppBaseUrl`: falls back to exactly `getSecurityEmailBaseUrl`; still throws `AppOriginRejectedError` for a disallowed `req` even when the resolver returns a value

**T015** — `directory/commands/__tests__/organizations.appUrl.test.ts`. Mirror the harness in `updateOrganization.partial-hierarchy.test.ts`. Cover:
- an admin without the feature changing the value gets 403 and `updateOrmEntity` is not called
- an admin sending the *same* value is ok (no 403)
- superadmin ok
- a duplicate gets 409
- an invalid value gets 422 with fieldErrors
- `buildLog` changes include `appUrl` before/after
- undo leaves `appUrl` untouched
- invalidate is called on change and on delete

**T016** — gate: `yarn generate`, the tests for directory, shared and validators, `yarn typecheck`.

**T017** (`auth/api/reset.ts`)
- Keep the up-front `toSecurityEmailUrl(req, ...)` and its error mapping unchanged. It runs for all emails before any DB access.
- After the user is found:

  ```ts
  const own = await resolveOrganizationAppUrl({ container: c, organizationId: user.organizationId ? String(user.organizationId) : null })
  const template = own ? `${own}/reset/__token__` : resetUrlTemplate
  ```

  Then `withTenantHintUrl(template.replace(...), user.tenantId)`.
- The unknown-user branch is unchanged.

**T018** (`auth/commands/users.ts`)
- Change the signature to `sendInviteToUser(em, user, container: { resolve(name: string): unknown })`. The caller at l.380 passes `ctx.container`.
- `base = (await resolveOrganizationAppUrl({ container, organizationId: user.organizationId ? String(user.organizationId) : null })) ?? getSecurityEmailBaseUrl()`.

**T019** (resend-invite route)
- Keep `getSecurityEmailBaseUrl(req)` in its try/catch.
- Then `base = (await resolveOrganizationAppUrl({ container, organizationId: user.organizationId ? String(user.organizationId) : null })) ?? base`.

**T020** (`messages/lib/email-sender.ts` plus the worker)
- Add an optional param `container?: { resolve(name: string): unknown } | null` to `sendMessageEmailToRecipient`.
- `appUrl = resolveAppUrl() ? ((await resolveOrganizationAppUrl({ container, organizationId: message.organizationId ?? null })) ?? resolveAppUrl()) : null`. This keeps "no APP_URL means link omitted".
- The worker l.296 passes `container: ctx`.

**T021** (`notifications/lib/deliveryConfig.ts` plus `subscribers/deliver-notification.ts`)
- Add:

  ```ts
  export async function resolveNotificationPanelUrlForOrganization(config: NotificationDeliveryConfig, scope: AppUrlScope): Promise<string | null>
  ```

  1. If `envString(process.env.NOTIFICATIONS_APP_URL)` is set, return `resolveNotificationPanelUrl(config)`.
  2. Else `own = await resolveOrganizationAppUrl(scope)`; if set, return `${own}${config.panelPath}`.
  3. Else return `resolveNotificationPanelUrl(config)`.
- Keep the sync export.
- Subscriber l.128: `await resolveNotificationPanelUrlForOrganization(deliveryConfig, { container: ctx, organizationId: notification.organizationId ?? null })`.

**T022** (`forms/commands/invitation.ts`)
- Make it `async function buildPersonalLink(rawToken, scope: AppUrlScope)`:
  - `base = resolveAppUrl()`; if null, return null.
  - Else `${(await resolveOrganizationAppUrl(scope)) ?? base}/i/${rawToken}`.
- The l.194 call passes `{ container: ctx.container, organizationId: parsed.organizationId }`.

**T023** (`sales/api/quotes/send/route.ts`)
- `const own = await resolveOrganizationAppUrl({ container: ctx.container, organizationId: quote.organizationId })`
- `appUrl = own ?? (process.env.APP_URL || '')`; the rest is unchanged.
- Optional: the same in `quotes/accept/route.ts` l.151.

**T024** — CUT (no effect).

**T025** — unit tests, extending the existing files:

| File | Assert |
|---|---|
| `auth/api/__tests__/reset.test.ts` | Org link when the resolver returns a value. Default otherwise. Unknown email: identical `{ok:true}`, and the resolver is not called |
| `auth/api/__tests__/resend-invite.route.test.ts` | Org link when set, default otherwise |
| `auth/commands/__tests__/users.invite-app-url.test.ts` (new) | Invite link uses the org address |
| `messages/lib/__tests__/email-sender.test.ts` | Org address used; link omitted without APP_URL |
| `notifications/lib/__tests__/deliveryConfig.test.ts` | Precedence, including `NOTIFICATIONS_APP_URL` winning |
| `notifications/__tests__/deliver-notification.test.ts` | Panel link uses the org address |
| `forms/commands/__tests__/invitation.app-url.test.ts` (new) | Personal link uses the org address |
| `sales/api/__tests__/quotes.send-app-url.test.ts` (new) | Quote link uses the org address |

Mock via a container whose `resolve('organizationAppUrlResolver')` returns `{ resolveOwn }`.

**T026** — `directory/__integration__/TC-DIR-APPURL-002.spec.ts`
- Skip unless channel seeding is available.
- `alternate = BASE_URL` with the host swapped between 127.0.0.1 and localhost. Skip if BASE_URL is not loopback.
- Superadmin creates org A and org B and an employee in each, then PUTs `{ id: A, appUrl: alternate }`.
- Reset A's user, wait for subject "Reset your password" with `to` equal to A's email, and check that `content.html` contains `${alternate}/reset/`.
- Reset B's user and check for `${BASE_URL}/reset/`.
- Optionally assert the invite or resend email for A.
- PUT `appUrl: null` on A, reset again, and check for `${BASE_URL}/reset/` (invalidation, no restart).
- `finally`: clear the address, delete the users and orgs.
- `integrationMeta` with `dependsOnModules: ['directory','auth','communication_channels']`.

**T027** (`integrations/lib/oauth/redirect.ts`) — C5, plus tests in `lib/oauth/__tests__/redirect.test.ts`. Depends on T009.

**T028** — CUT. `grant-service.ts` is unchanged: `isBaseUrlMissing` stays an installation check.

**T029** — communication_channels (both routes plus `lib/oauth-state.ts` per C6)

*Initiate:*
- `own = await resolveOrganizationAppUrl({ container, organizationId: auth.orgId ?? null })`.
- `redirectUri = own ? own + CALLBACK_PATH : defaultRedirectUri(req, provider)`.
- Optional (recommended): if `own && readAllowedRequestOrigin(req) !== own`, return 409 `{ error: translate('communication_channels.oauth.errors.originMismatch', ...), code: 'oauth_origin_mismatch' }`.
- Pass `redirectOrigin: own ?? null` to `createOAuthState`. This also flows through the `encryptOAuthState({...payload, extra})` re-encryption because the payload is spread.

*Callback:*
- After `verifyOAuthState`, call `assertOAuthStateRedirectOrigin(statePayload, req)` in the same catch, mapping to flash code `origin_mismatch`.
- Exchange `redirectUri = statePayload.redirectOrigin ? statePayload.redirectOrigin + path : toAbsoluteUrl(req, path)`.
- `redirectWithFlash(req, returnUrl, flash, baseOrigin?: string | null)`: use `baseOrigin ?? getAppBaseUrl(req)`, and pass `statePayload.redirectOrigin` once it is known.

*Tests:* `lib/__tests__/oauth-state.test.ts` and `api/get/oauth/[provider]/callback/__tests__/callback.route.test.ts`.

**T030** — Meta Lead Ads

*Initiate:*
- `{ redirectUri, redirectOrigin } = await resolveOAuthRedirectUriForOrganization(req, OAUTH_CALLBACK_PATH, { container, organizationId })`.
- If `redirectOrigin && readAllowedRequestOrigin(req) !== redirectOrigin`, return 302 to `${redirectOrigin}${BACKEND_PATH}?connect=wrong_origin`.
- Add `'wrong_origin'` to `CONNECT_FAILURE_CODES` and `meta_lead_ads.connect.errors.wrong_origin` to the five locales.
- Pass `redirectOrigin` into `createOAuthState`.

*Callback:*
- After verify, call `assertOAuthStateRedirectOrigin(payload, req)`; on failure, `state_mismatch`.
- The redirect URI for the exchange is `payload.redirectOrigin ? payload.redirectOrigin + OAUTH_CALLBACK_PATH : resolveOAuthRedirectUri(req, OAUTH_CALLBACK_PATH)`.
- `redirectWithResult(req, result, baseOrigin?: string | null)`: use `baseOrigin ?? getAppBaseUrl(req)`, passing `payload.redirectOrigin` on every return after verify.

`api/data-deletion` is untouched.

**T031** (narrowed: Meta settings only)
- `api/settings/route.ts` GET adds `oauthRedirectUri`, computed with `resolveOAuthRedirectUriForOrganization(undefined, OAUTH_CALLBACK_PATH, { container: ctx.container, organizationId: ctx.organizationId })` in a try/catch that falls back to null.
- Add it to `settingsDtoSchema` (`api/openapi.ts`) and to `SettingsDto` (`components/types.ts`). The PUT response shape is untouched.
- `backend/meta-lead-ads/settings/page.tsx`: above the `CrudForm`, a read-only block with `Label`, the value in `font-mono text-sm`, and `Button variant="outline"` that copies via `navigator.clipboard.writeText` and then calls `flash(t(...copied), 'success')`. DS tokens only.
- Meta i18n: the four keys in five locales.

**T032** — unit tests:
- `meta_lead_ads/__tests__/oauth-org-origin.test.ts`: route-level, if feasible with the existing mocks. Otherwise rely on C5/C6 unit tests plus T033.
- C5 cases: own address, then fallback, then `redirectOrigin` null.
- C6 cases: legacy state without `redirectOrigin` passes; a mismatch throws.

**T033** — `packages/meta-lead-ads/src/modules/meta_lead_ads/__integration__/TC-META-010-org-app-url.spec.ts`
- Use `setupMetaTestEnv`, and skip if BASE_URL is not loopback.
- Superadmin PUTs `{ id: env.orgId, appUrl: alternate }`.
- Initiate on `${alternate}/api/meta_lead_ads/oauth/initiate` (Bearer plus `om_selected_org`). Expect 302 with `redirect_uri` starting `${alternate}/api/meta_lead_ads/oauth/callback`.
- Call the callback on `${BASE_URL}` with that state and cookie. Expect `connect=state_mismatch`, and the connections list stays empty.
- Initiate on `${BASE_URL}`. Expect a 302 to `${alternate}/backend/meta-lead-ads?connect=wrong_origin`.
- `GET /api/meta_lead_ads/settings` returns `oauthRedirectUri === alternate + OAUTH_CALLBACK_PATH`.
- Optionally run a full `connectFakeMetaAccount`-style success on `alternate`.
- `finally`: clear `appUrl`, then `env.cleanup()`.

**T034** (`[id]/edit/page.tsx`)
- Read `canManageAppUrl` and `appUrlOptions` from the response top level; extend the `OrganizationResponse` type.
- `initialValues.appUrl = record.appUrl ?? ''`.
- Field `appUrl`:
  - Can manage: `type: 'select'`, options `[{ value: '', label: t(...default) }, ...appUrlOptions (+ the current value if it is missing)]`, plus a description.
  - Cannot manage: a `type: 'custom'` read-only display (value or the default label) plus the description, same pattern as the `tenantId` field.
- Insert `'appUrl'` after `'slug'` in both `detailFields` variants.
- `submitUpdateOrganization`: add the option `includeAppUrl?: boolean`. When true, set `payload.appUrl = trimmed || null`. Add `appUrl?: string | null` to `UpdateOrganizationPayload`. Pass `includeAppUrl: canManageAppUrl`.
- Add a case to `__tests__/edit-submit.test.ts`.

Depends on T011 and T036.

**T035** — merged into T011.

**T036** — the directory i18n keys (C8) in five locales. Run `yarn i18n:check-sync` and `yarn i18n:check-hardcoded`. The meta, auth and communication_channels keys belong to their own tasks.

**T037** — `directory/__integration__/TC-DIR-APPURL-001.spec.ts`

*API:*
- Superadmin sets `alternate` (200) and GET manage shows `appUrl`.
- The admin token (`getAuthToken('admin')`) PUTs a change: 403, and the value is unchanged.
- A second org set to the same `alternate`: 409.
- `https://evil.example`: 422.
- `not a url`: 422.
- The audit actions query has an entry whose `changes.appUrl` holds the old and new values.

*UI:*
- Superadmin opens `/backend/directory/organizations/<id>/edit` and selects the option equal to BASE_URL's origin. That is APP_URL, which is in `appUrlOptions`.
- Save, then verify through the API.
- The admin sees read-only text.

*Cleanup:* clear the address in `finally` and delete the orgs.

**T038** — docs: `apps/docs/docs/deployment/production-readiness.mdx` (it holds the APP_URL checklist, ~l.31) and `apps/docs/docs/framework/security/cross-site-login.mdx` (APP_ALLOWED_ORIGINS). No `.env.example` change is needed.

**T039** — directory has no AGENTS.md. Add the "user-facing links use `resolveOrganizationAppUrl` / `resolveAppBaseUrl`; internal URLs stay on APP_URL" note to `packages/core/src/modules/integrations/AGENTS.md` (OAuth section), then run `yarn agents:check-budget`.

**T040 / T041** — as written. Before the T041 rollout, also check the stored notifications `delivery_strategies.appUrl` module config. It does not override the organization address under the agreed precedence, but it does stay the fallback.

## E. Builder batches (no two parallel tasks touch the same file)

| Batch | Tasks | Mode |
|---|---|---|
| B1 | T003+T004 (entity, migration, snapshot) · T006 (acl.ts, constants.ts, auth i18n) · T009+T014 (shared url.ts + test) · T002 (docs) | parallel |
| B2 | T005+T013 (validators + test) · T007+T008+T012 (lib/organizationAppUrl.ts, di.ts, test) | parallel; after B1 |
| B3 | T010+T015 (commands/organizations.ts + test) · T011/T035 (route.ts, openapi.ts) · T036 (directory i18n) · T027 (redirect.ts + test) · C6 part of T029 (oauth-state.ts + its test) | parallel; after B2. The oauth-state change has no dependency on T010 |
| B4 | T016 gate | sequential |
| B5 (US1) | T017 · T018 · T019 · T020 · T021 · T022 · T023, each with its own T025 test | parallel; distinct files |
| B5 (US2) | T029 routes · T030 (+ meta constants and i18n `wrong_origin`) · T031 (meta settings route, DTOs, page, i18n) | B5 runs in parallel with the US1 tasks. T030 and T031 both edit meta i18n files, so run them sequentially or give one builder both |
| B5 (US3) | T034 | in parallel with the US1 and US2 tasks |
| B6 | T026 · T033 · T037 | parallel authoring; serial execution (workers=1) |
| B7 | T038 · T039, then T040 | T038 and T039 in parallel, then T040 |
| — | T041 | user-confirmed production steps only |

## F. Risks, contradictions, cuts

1. **Undo bypass (security).** If `appUrl` goes into the undo snapshot, any admin with undo rights can revert a superadmin's change, and redo can re-apply it, with no feature check. The brief excludes it from undo.
   - The cost: undoing an address change does not revert the address. Say so in the spec.
2. **Reset-password enumeration.** The response body and status stay identical. A small timing difference is added for known emails only (one cached query), on top of the existing email send. That is acceptable. Do not move the origin assertion after the lookup.
3. **Legacy OAuth states and existing deployments.** `redirectOrigin` is written and enforced only when an organization address was used, so in-flight and legacy states and all unconfigured installs behave exactly as today (FR-011, SC-005).
   - The callback check depends on the proxy forwarding `Host` / `X-Forwarded-Host` and `X-Forwarded-Proto`. Caddy does.
4. **Single shared callback URL.**
   - Meta: each organization's `https://<org-host>/api/meta_lead_ads/oauth/callback` must be registered in the Meta app (manual step, T041).
   - Gmail: the same applies in the Google OAuth client.
   - Organizations without an address keep using the APP_URL callback.
5. **Superadmin on `admin.*` hosts.** Connecting Meta for an organization that has an address now needs the organization's own host (`wrong_origin` redirect), because cookies are host-scoped. This is intentional; document it.
6. **The organization address is origin-only.** APP_URL path prefixes (`/mercato`, supported by `resolveOAuthRedirectUri`) are not supported per organization.
7. **Notifications precedence.**
   - An explicit `NOTIFICATIONS_APP_URL` env still wins and would mask the feature. Production doesn't set it.
   - The stored settings `appUrl` (UI) is now below the organization address. That is a minor behaviour change, but only for organizations with an address.
8. **`readConfiguredAppOrigins` drops wildcard entries** (e.g. `*.preview.x`). Such entries can't be chosen as an organization address. That's fine.
9. **Cuts recommended for v1:**
   - T024 (onboarding, no effect)
   - T028 (grant service, nothing to change)
   - the generic integrations return-address row and the Meta integration-detail widget row (T031 is reduced to the Meta settings page)
   - a communication_channels return-address UI (FR-005 is met only for Meta in v1; flag this to the user)
10. **Multi-module scope.** This touches directory, auth, messages, notifications, forms, sales, integrations, communication_channels, meta_lead_ads and shared. The plan notes this needs maintainer confirmation (AGENTS.md "Ask first"). Confirm with the user before building.
11. **Validation runner.** Use a throwaway `node:24-bookworm` container (`--network none`) per tasks.md. Never the production compose.
