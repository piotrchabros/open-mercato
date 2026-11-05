# Contracts: Per-Organization Application Address

All changes are additive (BACKWARD_COMPATIBILITY.md: API responses and DB schema are additive-only; new ACL feature ids are additive).

## 1. Organizations API (`/api/directory/organizations`): additive field

**GET (list and detail)**: each item gains
```json
{ "appUrl": "https://crm.bluebee.marketing" }
```
`appUrl` is `null` when unset. Visible to callers with `directory.organizations.view`.

**PUT (update)**: optional body field
```json
{ "id": "<uuid>", "appUrl": "https://crm.bluebee.marketing" }
```
- Omitted: the value is unchanged. `null` or `""` clears it.
- Requires `directory.organizations.manage_app_url` (superadmin bypass applies). Without it, a request that changes `appUrl` gets `403 { "error": "<t('directory.errors.appUrlForbidden')>" }`. Other fields in the same request are not applied (the request is rejected as a whole).
- `422 { "error": ..., "fieldErrors": { "appUrl": "<t('directory.errors.appUrlInvalid')>" } }`: not an origin, or `http` in production.
- `422 ... "appUrl": "<t('directory.errors.appUrlNotAllowed')>"`: not in the allowed origins.
- `409 ... "appUrl": "<t('directory.errors.appUrlTaken')>"`: already used by another organization.
- The optimistic-lock header is honoured as today.

OpenAPI: `appUrl` is added to the organization schema and the update schema in `packages/core/src/modules/directory/api/openapi.ts`.

## 2. ACL feature (directory `acl.ts`)

```ts
{ id: 'directory.organizations.manage_app_url', title: 'Manage organization address', module: 'directory', dependsOn: ['directory.organizations.manage'] }
```
Not added to any default role in `setup.ts` (superadmin-only by default).

## 3. DI service (directory `di.ts`)

```ts
organizationAppUrlResolver: {
  resolve(organizationId: string | null | undefined): Promise<string>
  invalidate(organizationId: string): Promise<void>
}
```
- `resolve` returns the organization's `appUrl` when set and allowed, otherwise the installation default (`getSecurityEmailBaseUrl()`).
- `resolve` never throws for a missing organization: it falls back to the default.

## 4. Shared helper (`@open-mercato/shared/lib/url`)

```ts
export async function resolveAppBaseUrl(input: {
  container?: { resolve(name: string): unknown } | null
  organizationId?: string | null
  req?: RequestInput
}): Promise<string>

export async function toAppUrl(input: Parameters<typeof resolveAppBaseUrl>[0], path: string): Promise<string>
```
- The helper soft-resolves `organizationAppUrlResolver` from `container`. When the service is missing, or no `organizationId` is given, it behaves exactly like `getSecurityEmailBaseUrl(req)`, including the origin assertion when `req` is passed.
- Existing exports (`getSecurityEmailBaseUrl`, `toSecurityEmailUrl`, `resolveOAuthRedirectUri`) keep their signatures and behaviour.
- `resolveOAuthRedirectUri` gains an optional third parameter, `{ container, organizationId }` (additive).

## 5. OAuth state (integrations and communication_channels)

- The state payload gains `redirectOrigin` (additive).
- The callback rejects a request whose origin differs from `redirectOrigin` (`state_mismatch`).
- The connection screens show the "Return address to register with the provider": `<org address><callback path>`.

## 6. UI

- **Organization edit form** (`/backend/directory/organizations/[id]`): a new "Organization address" field (`directory.organizations.form.appUrl`).
  - The field is a select with the allowed origins plus "Use installation default".
  - It is editable only with `directory.organizations.manage_app_url`. Everyone else sees it read-only.
  - The help text explains that email links and service connections use this address.
- **Meta Lead Ads and OAuth integration detail pages**: a read-only "Return address to register with the provider" row with a copy button.
