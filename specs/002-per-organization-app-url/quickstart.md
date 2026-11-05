# Quickstart: validate per-organization addresses

## Prerequisites
- Dev or staging stack with two organizations (A and B) in one tenant, created by the test fixtures.
- `APP_URL=http://localhost:3000`, and `APP_ALLOWED_ORIGINS=http://a.localhost:3000,http://b.localhost:3000`. Both hosts resolve to the app; `*.localhost` resolves to loopback in browsers and curl.
- The test mail capture enabled (as used by the existing auth integration tests).

## Scenario 1: set the address (US3, FR-006/007/010)
1. As superadmin: `PUT /api/directory/organizations` with `{ id: A, appUrl: "http://a.localhost:3000" }` returns 200. GET shows `appUrl`.
2. As a tenant admin (no `manage_app_url`): the same PUT returns 403, and the value is unchanged.
3. Set B to `http://a.localhost:3000`: 409 `appUrlTaken`.
4. Set B to `https://evil.example`: 422 `appUrlNotAllowed`.
5. Audit log: one `directory.organizations.update` entry with the old and new `appUrl`.

## Scenario 2: email links (US1, FR-003)
1. Create a user in A and a user in B (B has no address).
2. Request a password reset for each.
3. The captured email for A's user links to `http://a.localhost:3000/reset/...`. B's links to `http://localhost:3000/reset/...`. Both links complete a reset.
4. Change A's address to `http://b.localhost:3000` and request again: within 60 s the link uses the new address, with no restart.

## Scenario 3: OAuth return address (US2, FR-004/005/009)
1. Signed in on `http://a.localhost:3000` as A's admin, call the integration OAuth initiate: the provider URL's `redirect_uri` starts with `http://a.localhost:3000`.
2. Call the callback with that state on `http://b.localhost:3000`: the result is `state_mismatch`, and no connection is stored.
3. The integration detail page shows the return address `http://a.localhost:3000/<callback path>`.

## Scenario 4: no configuration (FR-011, SC-005)
- With no organization addresses set, run the existing auth, notifications, messages, and OAuth unit and integration suites. They pass unchanged.

## Commands
- `yarn generate && yarn db:generate` (review the directory migration and snapshot only)
- `yarn typecheck && yarn lint && yarn test`
- `yarn test:integration -g "TC-DIR-APPURL"`
