import { expect, test } from '@playwright/test'
import { openReparentingSpec } from './helpers/reparentingSpec'

/**
 * REP-INT-011 — the new routes are documented.
 *
 * Every reparenting URL, command id, event id and ACL id becomes a public
 * contract surface at first release. The generated OpenAPI bundle is where a
 * third-party module developer discovers the HTTP half of that, so a route that
 * ships undocumented is a contract nobody can depend on deliberately.
 */
test.describe('TC-CONNECT-REP-011: OpenAPI documents the reparenting surface', () => {
  // The served document carries a server base path, so its keys omit `/api`.
  const EXPECTED_PATHS = [
    '/connect/cases/{id}/split',
    '/connect/cases/{id}/merge',
    '/connect/cases/{id}/lineage',
    '/connect/case-reparentings',
    '/connect/case-reparentings/{id}',
  ]

  test('exposes every reparenting route with its documented statuses', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const response = await request.get('/api/docs/openapi', { headers: ctx.authHeaders })
    expect(response.status()).toBe(200)
    const spec = await response.json()
    const paths = spec.paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>

    for (const path of EXPECTED_PATHS) {
      expect(Object.keys(paths)).toContain(path)
    }

    // The action routes must document the conflict and validation answers a
    // client has to handle, not just the happy path.
    for (const path of ['/connect/cases/{id}/split', '/connect/cases/{id}/merge']) {
      const statuses = Object.keys(paths[path].post?.responses ?? {})
      for (const status of ['201', '404', '409', '422']) {
        expect(statuses).toContain(status)
      }
    }

    for (const path of ['/connect/case-reparentings', '/connect/case-reparentings/{id}']) {
      expect(Object.keys(paths[path].get?.responses ?? {})).toContain('200')
    }

    // Undo deliberately reuses the stable audit-log URL rather than introducing
    // a Connect-specific one; assert the Connect variant does NOT exist.
    expect(Object.keys(paths)).toContain('/audit_logs/audit-logs/actions/undo')
    expect(Object.keys(paths)).not.toContain('/connect/case-reparentings/{id}/undo')
  })
})
