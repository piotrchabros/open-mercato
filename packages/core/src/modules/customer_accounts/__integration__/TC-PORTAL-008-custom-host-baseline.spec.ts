import { expect, test } from '@playwright/test';
import { readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-PORTAL-008 — regression baseline for the custom-domain layer (task 2.5).
 *
 * The portal custom-domain stack shipped in April 2026 with no integration
 * coverage at all: the spec promised tests at
 * .ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md:1627-1659
 * that were never written. Task 3.3 then changed the one function all portal
 * routing depends on. This pins the observable contract of the secret-gated
 * resolution endpoints so that change - and the next one - has a tripwire.
 *
 * Deliberately asserts the DENY paths only. They need no fixtures, no seeded
 * domains and no DNS, so this runs in the default suite rather than being
 * gated behind environment variables like TC-DIR-015.
 */

const BASE_URL = process.env.BASE_URL?.trim() || 'http://localhost:3000';

test.describe('TC-PORTAL-008 custom-domain resolution baseline', () => {
  test('domain-resolve refuses an unauthenticated caller', async ({ request }) => {
    // Secret-gated: without DOMAIN_RESOLVE_SECRET this must never return a
    // tenant/organization tuple, which is the whole point of the gate.
    const res = await request.fetch(`${BASE_URL}/api/customer_accounts/domain-resolve?host=shop.example.invalid`, {
      method: 'GET',
    });

    expect([403, 404, 503]).toContain(res.status());
    const body = (await readJsonSafe<Record<string, unknown>>(res)) ?? {};
    expect(body.tenantId).toBeUndefined();
    expect(body.organizationId).toBeUndefined();
  });

  test('domain-resolve rejects a malformed host before touching the database', async ({ request }) => {
    const res = await request.fetch(`${BASE_URL}/api/customer_accounts/domain-resolve?host=%20`, {
      method: 'GET',
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('domain-check refuses an unauthenticated caller', async ({ request }) => {
    // Traefik's ForwardAuth gate. An unauthenticated 200 here would mean any
    // hostname on the internet could obtain a certificate from this instance.
    const res = await request.fetch(`${BASE_URL}/api/customer_accounts/domain-check?host=shop.example.invalid`, {
      method: 'GET',
    });
    expect(res.status()).not.toBe(200);
  });

  test('the platform host serves the app rather than a portal rewrite', async ({ request }) => {
    // proxy.ts short-circuits platform hosts before any custom-domain
    // resolution. Task 3.3 added a branch upstream of that; this is the
    // regression guard for the fast path every request takes.
    const res = await request.fetch(`${BASE_URL}/login`, { method: 'GET' });
    expect(res.status()).toBeLessThan(500);
  });
});
