// Constant-time secret comparison for header-based shared-secret authentication.
// Plain `===`/`!==` on strings short-circuits on the first mismatching byte and
// leaks the matching prefix length through CPU timing. The custom-domain
// `domain-check` and `domain-resolve` routes guard cross-tenant data with these
// header secrets, so the comparison MUST be constant-time.
//
// Moved to `@open-mercato/shared/lib/http/secretCompare` so it can be reused by
// `resolveRequestHostname` (shared has zero domain dependencies and cannot
// import from `core`). Re-exported here for existing `core` call sites.
export { secretEqual } from '@open-mercato/shared/lib/http/secretCompare'
