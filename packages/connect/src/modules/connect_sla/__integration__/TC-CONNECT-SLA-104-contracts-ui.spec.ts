import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { fixtureName, openSlaSpec } from './helpers/slaSpec'

test.describe('TC-CONNECT-SLA-104: contracts, isolation, and UI', () => {
  test('documents the API surface and enforces management ACLs', async ({ request }) => {
    const ctx = await openSlaSpec(request)
    const openApi = await request.get('/api/docs/openapi', { headers: ctx.authHeaders })
    expect(openApi.status()).toBe(200)
    const paths = (await openApi.json()).paths as Record<string, unknown>
    for (const path of [
      '/connect-sla/calendars',
      '/connect-sla/calendars/{id}',
      '/connect-sla/calendars/{id}/publish',
      '/connect-sla/policies',
      '/connect-sla/policies/{id}',
      '/connect-sla/policies/{id}/publish',
      '/connect-sla/clocks',
      '/connect-sla/clocks/rebuild',
    ]) expect(Object.keys(paths)).toContain(path)

    const employeeToken = await getAuthToken(request, 'employee')
    const denied = await request.post('/api/connect-sla/calendars', {
      headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
      data: { name: fixtureName('forbidden-calendar'), isDefault: false },
    })
    expect([401, 403]).toContain(denied.status())
  })

  test('hides a sibling-organization calendar as not found', async ({ request }) => {
    const ctx = await openSlaSpec(request)
    const id = randomUUID()
    const foreignOrganizationId = randomUUID()
    try {
      await ctx.em.getConnection().execute(
        `insert into connect_sla_business_calendars
          (id, tenant_id, organization_id, name, is_default, created_at, updated_at)
         values (?, ?, ?, ?, false, now(), now())`,
        [id, ctx.scope.tenantId, foreignOrganizationId, fixtureName('foreign-calendar')],
      )
      const response = await request.get(`/api/connect-sla/calendars/${id}`, { headers: ctx.authHeaders })
      expect(response.status()).toBe(404)
    } finally {
      await ctx.em.getConnection().execute(
        'delete from connect_sla_business_calendars where id = ? and tenant_id = ? and organization_id = ?',
        [id, ctx.scope.tenantId, foreignOrganizationId],
      )
    }
  })

  test('renders accessible administration tables and actions', async ({ page }) => {
    await login(page, 'admin')
    for (const [url, heading] of [
      ['/backend/connect/sla/calendars', 'SLA calendars'],
      ['/backend/connect/sla/policies', 'SLA policies'],
      ['/backend/connect/sla/clocks', 'SLA clocks'],
    ] as const) {
      await page.goto(url)
      await expect(page.getByText(heading, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('main')).toBeVisible()
      await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true')
    }
    await page.goto('/backend/connect/sla/calendars')
    await expect(page.getByRole('link', { name: /create/i }).first()).toBeVisible()
  })
})
