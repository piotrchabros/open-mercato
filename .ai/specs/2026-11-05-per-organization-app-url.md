# Per-Organization Application Address

**Status**: Draft (in implementation)
**Date**: 2026-11-05
**Full spec**: [`specs/002-per-organization-app-url/`](../../specs/002-per-organization-app-url/spec.md) (spec, plan, research, data model, contracts, tasks)

## TLDR

Each organization may have its own public address (`organizations.app_url`). It is optional, superadmin-only, unique, and must be in the operator's allowed origins (`APP_URL`, `NEXT_PUBLIC_APP_URL`, `APP_ALLOWED_ORIGINS`). Organization-scoped user-facing links use it:
- password reset, invitations
- message, notification, form and quote emails
- OAuth redirect URIs (communication channels, Meta Lead Ads)

Without it, behaviour is unchanged (`APP_URL`). Internal URLs (workflow CALL_API SSRF guard, documents lookup, portal and checkout) stay on `APP_URL`.

## Related specs

- [2026-09-27 App Spec: OAuth2 grant lifecycle](./2026-09-27-app-spec-oauth2-grant-lifecycle.md). Q9 ("`resolveOAuthRedirectUri` uses `APP_URL` only, never the request origin") is preserved: the redirect URI now uses the *configured* address of the connecting organization, still never the request origin.

## Migration & Backward Compatibility

The changes are additive only:
- nullable column `organizations.app_url` with a partial unique index
- the optional `appUrl` field in the organizations API
- the ACL feature `directory.organizations.manage_app_url`
- the DI key `organizationAppUrlResolver`
- the shared helpers `resolveOrganizationAppUrl`, `resolveAppBaseUrl` and `toAppUrl`
- `resolveOAuthRedirectUriForOrganization` in the integrations module
- the OAuth state field `redirectOrigin`

Existing exports and signatures are unchanged. States issued before the deploy (without `redirectOrigin`) keep today's validation.

## Decisions taken during implementation

- `appUrl` is not part of the organization undo snapshot. A plain admin's undo or redo could otherwise change a superadmin-only setting, so undoing an address change does not revert the address.
- Onboarding (a new organization has no address) and the integrations grant service (it has no callback or state) are out of scope.
- In v1 the return address to register with the provider is shown for Meta Lead Ads only.

## Changelog

- 2026-11-05: created; implementation tracked in `specs/002-per-organization-app-url/tasks.md`.
