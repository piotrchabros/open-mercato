import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { fixtureName, openSlaSpec } from './helpers/slaSpec'

test.describe('TC-CONNECT-SLA-104: contracts, isolation, and UI', () => {
  test('documents the API surface and enforces management ACLs', async ({ request }) => {
    test.setTimeout(45_000)
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

  test('opens and deletes a calendar from its row actions', async ({ page, request }) => {
    test.setTimeout(60_000)
    const ctx = await openSlaSpec(request)
    const name = fixtureName('sla-row-actions')
    try {
      const create = await request.post('/api/connect-sla/calendars', {
        headers: ctx.authHeaders,
        data: { name, isDefault: false },
      })
      expect(create.status()).toBe(201)
      const calendar = await create.json()
      ctx.ledger.calendarIds.add(calendar.id)

      await login(page, 'admin')
      await page.goto('/backend/connect/sla/calendars')
      const row = page.getByRole('row').filter({ hasText: name })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: /open actions/i }).click()
      const editAction = page.getByRole('menuitem', { name: /edit/i })
      await expect(editAction).toHaveAttribute('href', `/backend/connect/sla/calendars/${calendar.id}`)
      const [detailResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`/api/connect-sla/calendars/${calendar.id}`) && response.request().method() === 'GET'),
        editAction.click(),
      ])
      expect(detailResponse.status()).toBe(200)
      await expect(page).toHaveURL(new RegExp(`/backend/connect/sla/calendars/${calendar.id}$`))
      await expect(page.getByRole('main').getByRole('textbox').first()).toHaveValue(name)

      await page.getByRole('checkbox', { name: /publish this version/i }).click()
      await page.getByPlaceholder('Europe/Berlin').fill('UTC')
      await page.getByRole('main').getByRole('textbox').nth(2).fill('1,09:00,17:00')
      const [updateResponse, publishResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`/api/connect-sla/calendars/${calendar.id}`) && response.request().method() === 'PUT'),
        page.waitForResponse((response) => response.url().endsWith(`/api/connect-sla/calendars/${calendar.id}/publish`) && response.request().method() === 'POST'),
        page.getByRole('button', { name: /^Save$/ }).first().click(),
      ])
      expect(updateResponse.status()).toBe(200)
      expect(publishResponse.status()).toBe(200)
      await expect(page).toHaveURL(/\/backend\/connect\/sla\/calendars$/)

      const refreshedRow = page.getByRole('row').filter({ hasText: name })
      await refreshedRow.getByRole('button', { name: /open actions/i }).click()
      const [deleteResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`/api/connect-sla/calendars/${calendar.id}`) && response.request().method() === 'DELETE'),
        page.getByRole('menuitem', { name: /delete/i }).click(),
      ])
      expect(deleteResponse.status()).toBe(200)
      await expect(refreshedRow).not.toBeVisible()
    } finally {
      await ctx.ledger.cleanup(ctx.em, ctx.scope)
    }
  })

  test('validates publication before creating a calendar', async ({ page, request }) => {
    test.setTimeout(60_000)
    const ctx = await openSlaSpec(request)
    const name = fixtureName('sla-create-publish')
    let createRequests = 0
    const countCreates = (pendingRequest: { url: () => string; method: () => string }) => {
      if (pendingRequest.url().endsWith('/api/connect-sla/calendars') && pendingRequest.method() === 'POST') createRequests += 1
    }
    page.on('request', countCreates)
    try {
      await login(page, 'admin')
      await page.goto('/backend/connect/sla/calendars/create')
      await page.getByRole('main').getByRole('textbox').first().fill(name)
      await page.getByRole('checkbox', { name: /publish this version/i }).click()
      await page.getByPlaceholder('Europe/Berlin').fill('UTC')
      await page.getByRole('button', { name: /^Save$/ }).first().click()
      await expect(page.getByText('This field is required.').first()).toBeVisible()
      expect(createRequests).toBe(0)

      await page.getByRole('main').getByRole('textbox').nth(2).fill('1,09:00,17:00')
      const [createResponse, publishResponse] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/connect-sla/calendars') && response.request().method() === 'POST'),
        page.waitForResponse((response) => response.url().endsWith('/publish') && response.request().method() === 'POST'),
        page.getByRole('button', { name: /^Save$/ }).first().click(),
      ])
      expect(createResponse.status()).toBe(201)
      expect(publishResponse.status()).toBe(200)
      const calendar = await createResponse.json()
      ctx.ledger.calendarIds.add(calendar.id)
      expect(createRequests).toBe(1)
      await expect(page).toHaveURL(/\/backend\/connect\/sla\/calendars$/)
    } finally {
      page.off('request', countCreates)
      await ctx.ledger.cleanup(ctx.em, ctx.scope)
    }
  })
})
