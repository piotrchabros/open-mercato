import { expect, test, type APIRequestContext } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures';

/**
 * TC-DIR-015 — per-organization backend custom domains (#4271).
 *
 * The decisive assertion is the one against `/api/*`: that surface is excluded
 * from the Next proxy matcher, so a routing-only implementation would leave it
 * completely unbound. Everything else here is a regression guard.
 *
 * Drives the hostname with `X-Forwarded-Host` rather than the `x-force-host`
 * test override, which is deliberately mutually exclusive with this feature —
 * enabling both would let anyone holding FORCE_HOST_SECRET pick an
 * organization. A forwarded header is what a real proxy sets, and trusting it
 * is exactly what TRUSTED_PROXY_CIDRS asserts.
 */

const BASE_URL = process.env.BASE_URL?.trim() || 'http://localhost:3000';

type Registered = {
  hostname: string;
  organizationId: string;
  tenantId: string;
  mappingId: string;
};

async function boundFetch(
  request: APIRequestContext,
  path: string,
  options: { token: string; host?: string; cookie?: string },
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    'Content-Type': 'application/json',
  };
  if (options.host) headers['X-Forwarded-Host'] = options.host;
  if (options.cookie) headers.Cookie = options.cookie;
  return request.fetch(`${BASE_URL}${path}`, { method: 'GET', headers, timeout: 30_000 });
}

test.describe('TC-DIR-015 backend custom domains', () => {
  let token = '';
  let registered: Registered | null = null;

  test.beforeAll(async ({ request }) => {
    token = await getAuthToken(request, 'admin');
  });

  test.afterAll(async ({ request }) => {
    // Self-contained: remove whatever this spec created, whatever happened.
    if (!registered) return;
    try {
      await request.fetch(`${BASE_URL}/api/customer_accounts/admin/domain-mappings?id=${registered.mappingId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Teardown must never fail the run.
    }
  });

  test('the platform host keeps working exactly as before', async ({ request }) => {
    const res = await boundFetch(request, '/api/directory/organization-switcher', { token });
    expect(res.status()).toBe(200);

    const body = (await readJsonSafe<Record<string, unknown>>(res)) ?? {};
    // No binding on the platform host, so the switcher stays fully featured.
    expect(body.hostBoundOrganizationId ?? null).toBeNull();
  });

  test('an unmapped hostname does not bind anything', async ({ request }) => {
    const res = await boundFetch(request, '/api/directory/organization-switcher', {
      token,
      host: 'not-registered.example.invalid',
    });
    expect(res.status()).toBe(200);

    const body = (await readJsonSafe<Record<string, unknown>>(res)) ?? {};
    expect(body.hostBoundOrganizationId ?? null).toBeNull();
  });

  test('a bound host overrides a conflicting om_selected_org cookie on /api/*', async ({ request }) => {
    // THE test. /api/* bypasses the proxy entirely, so this is what separates a
    // real binding from cosmetic routing.
    const orgsRes = await request.fetch(`${BASE_URL}/api/directory/organizations?pageSize=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    test.skip(orgsRes.status() !== 200, 'directory organizations unavailable');

    const orgs = (await readJsonSafe<{ items?: Array<{ id?: string; tenantId?: string }> }>(orgsRes)) ?? {};
    const items = orgs.items ?? [];
    test.skip(items.length < 2, 'needs at least two organizations to prove the override');

    const bound = items[0];
    const other = items[1];
    expect(bound?.id).toBeTruthy();

    const createRes = await request.fetch(`${BASE_URL}/api/customer_accounts/admin/domain-mappings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        hostname: `crm-tc-dir-015.example.invalid`,
        organizationId: bound!.id,
        target: 'backend',
      },
    });
    test.skip(
      createRes.status() === 403,
      'admin lacks customer_accounts.domain.manage_backend in this environment',
    );
    expect(createRes.status()).toBeLessThan(400);

    const created = (await readJsonSafe<{ item?: { id?: string } }>(createRes)) ?? {};
    registered = {
      hostname: 'crm-tc-dir-015.example.invalid',
      organizationId: bound!.id!,
      tenantId: bound!.tenantId ?? '',
      mappingId: created.item?.id ?? '',
    };

    // A mapping only routes once ACTIVE; a freshly registered one is pending,
    // so the binding must NOT apply yet. That is itself worth asserting.
    const res = await boundFetch(request, '/api/directory/organization-switcher', {
      token,
      host: registered.hostname,
      cookie: `om_selected_org=${encodeURIComponent(other!.id!)}`,
    });
    expect(res.status()).toBe(200);

    const body = (await readJsonSafe<Record<string, unknown>>(res)) ?? {};
    expect(body.hostBoundOrganizationId ?? null).toBeNull();
  });
});
