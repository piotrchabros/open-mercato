# Data Model: Per-Organization Application Address

## Organization (existing, directory module): additive change

| Field | Column | Type | Rules |
|---|---|---|---|
| appUrl | `app_url` | text, nullable | Origin form `scheme://host[:port]` (lower-case, no path or trailing slash). `https` in production. Must be in the operator's allowed origins (`APP_URL`, `NEXT_PUBLIC_APP_URL`, `APP_ALLOWED_ORIGINS`). Unique among non-deleted organizations. `null` means "use the installation default". |

- Index: `organizations_app_url_uniq`, a unique index on `(app_url)` where `deleted_at is null and app_url is not null`.
- Optimistic locking: unchanged. The field is edited through the existing organization update, which already versions by `updated_at`.
- Encryption: none. The value is a public address, not PII.
- Migration: one additive migration in the directory module (`yarn db:generate`), with the snapshot updated. No backfill.

## Installation default address (configuration, not stored)

- `APP_URL`. Today's single address. Used when an organization has no `app_url`, when no organization is in context, or when the stored value is no longer allowed.

## Allowed origins (configuration, not stored)

- The union of `APP_URL`, `NEXT_PUBLIC_APP_URL` and `APP_ALLOWED_ORIGINS`, as read by `readConfiguredAppOrigins`. Operator-controlled. `app_url` must be a member when saved, and is re-checked when resolved.

## OAuth state payload (existing, transient): additive field

| Field | Rules |
|---|---|
| redirectOrigin | The origin used to build `redirect_uri` at initiate. The callback must arrive on the same origin, otherwise `state_mismatch`. A missing field (states issued before the deploy) falls back to today's check. |

## State transitions

`app_url`: `null` ⇄ `<origin>`. Changed only by a superadmin (`directory.organizations.manage_app_url`). Every change is audited by the `directory.organizations.update` command log with the old and new values. The cache tag `directory:organization:<id>:app_url` is invalidated on change.
