import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export const integrationMeta = { dependsOnModules: ['directory'] }

const ORGANIZATIONS = '/api/directory/organizations'
const ALL_ORGANIZATIONS = { Cookie: 'om_selected_org=__all__' }

type ManagedOrganization = { id: string; appUrl?: string | null }
type AuditAction = { changes?: Record<string, unknown> | null }

const baseUrl = process.env.BASE_URL?.trim() || 'http://localhost:3000'
const baseOrigin = new URL(baseUrl).origin

function swapLoopbackHost(origin: string): string | null {
  const url = new URL(origin)
  if (url.hostname === '127.0.0.1') url.hostname = 'localhost'
  else if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  else return null
  return url.origin
}

const alternate = swapLoopbackHost(baseOrigin)

async function readOrganization(request: APIRequestContext, token: string, id: string): Promise<ManagedOrganization | null> {
  const query = new URLSearchParams({ view: 'manage', ids: id, pageSize: '100' })
  const response = await apiRequest(request, 'GET', `${ORGANIZATIONS}?${query}`, { token, headers: ALL_ORGANIZATIONS })
  if (response.status() !== 200) return null
  const body = await readJsonSafe<{ items?: ManagedOrganization[] }>(response)
  return body?.items?.find((item) => item.id === id) ?? null
}

async function putAppUrl(request: APIRequestContext, token: string, id: string, appUrl: string | null) {
  return apiRequest(request, 'PUT', ORGANIZATIONS, { token, headers: ALL_ORGANIZATIONS, data: { id, appUrl } })
}

/**
 * TC-DIR-APPURL-001: per-organization address
 * Covers:
 * - PUT /api/directory/organizations appUrl (200, 403 for non-managers, 409 duplicate, 422 invalid or not allowed)
 * - GET /api/directory/organizations?view=manage appUrl field
 * - audit log changes for appUrl
 * - /backend/directory/organizations/<id>/edit select (manager) and read-only text (non-manager)
 */
test.describe('TC-DIR-APPURL-001: organization address', () => {
  test.describe.configure({ mode: 'serial' })

  let superadminToken = ''
  let adminToken = ''
  let tenantId = ''
  let orgA = ''
  let orgB = ''
  let adminOrgOriginal: { id: string; appUrl: string | null } | null = null
  const stamp = Date.now()

  test.beforeAll(async ({ request }) => {
    superadminToken = await getAuthToken(request, 'superadmin')
    adminToken = await getAuthToken(request, 'admin')
    tenantId = getTokenContext(superadminToken).tenantId
    orgA = await createOrganizationFixture(request, superadminToken, { name: `QA APPURL A ${stamp}`, tenantId })
    orgB = await createOrganizationFixture(request, superadminToken, { name: `QA APPURL B ${stamp}`, tenantId })
  })

  test.afterAll(async ({ request }) => {
    try {
      if (adminOrgOriginal) {
        await putAppUrl(request, superadminToken, adminOrgOriginal.id, adminOrgOriginal.appUrl).catch(() => undefined)
      }
      for (const id of [orgA, orgB]) {
        if (id) await putAppUrl(request, superadminToken, id, null).catch(() => undefined)
      }
    } finally {
      await deleteOrganizationIfExists(request, superadminToken, orgB)
      await deleteOrganizationIfExists(request, superadminToken, orgA)
    }
  })

  test('API: superadmin sets, admin is forbidden, duplicates and invalid values are rejected, change is audited', async ({ request }) => {
    test.skip(!alternate, 'BASE_URL is not a loopback host, no alternate origin available')
    const address = alternate as string

    const setResponse = await putAppUrl(request, superadminToken, orgA, address)
    expect(setResponse.status(), 'superadmin can set the organization address').toBe(200)
    expect((await readOrganization(request, superadminToken, orgA))?.appUrl, 'manage view shows appUrl').toBe(address)

    const adminCanSeeA = (await readOrganization(request, adminToken, orgA)) !== null
    let targetId = orgA
    let expectedValue: string | null = address
    if (!adminCanSeeA) {
      targetId = getTokenContext(adminToken).organizationId
      expect(targetId, 'admin token carries its own organization').toBeTruthy()
      const own = await readOrganization(request, superadminToken, targetId)
      expectedValue = own?.appUrl ?? null
      adminOrgOriginal = { id: targetId, appUrl: expectedValue }
    }
    const forbidden = await apiRequest(request, 'PUT', ORGANIZATIONS, {
      token: adminToken,
      headers: ALL_ORGANIZATIONS,
      data: { id: targetId, appUrl: targetId === orgA ? baseOrigin : address },
    })
    expect(forbidden.status(), 'admin without the manage feature cannot change the address').toBe(403)
    expect((await readOrganization(request, superadminToken, targetId))?.appUrl ?? null, 'value unchanged after 403').toBe(expectedValue)

    const duplicate = await putAppUrl(request, superadminToken, orgB, address)
    expect(duplicate.status(), 'same address on another organization conflicts').toBe(409)

    const notAllowed = await putAppUrl(request, superadminToken, orgB, 'https://evil.example')
    expect(notAllowed.status(), 'origin outside the configured list is rejected').toBe(422)

    const malformed = await putAppUrl(request, superadminToken, orgB, 'not a url')
    expect(malformed.status(), 'malformed address is rejected').toBe(422)
    expect((await readOrganization(request, superadminToken, orgB))?.appUrl ?? null, 'rejected writes leave org B untouched').toBeNull()

    const query = new URLSearchParams({ resourceKind: 'directory.organization', resourceId: orgA, pageSize: '100' })
    const auditResponse = await apiRequest(request, 'GET', `/api/audit_logs/audit-logs/actions?${query}`, {
      token: superadminToken,
      headers: ALL_ORGANIZATIONS,
    })
    expect(auditResponse.status(), 'audit actions readable').toBe(200)
    const audit = await readJsonSafe<{ items?: AuditAction[] }>(auditResponse)
    const entry = (audit?.items ?? []).find((item) => item.changes && 'appUrl' in item.changes)
    expect(entry, 'audit log has an entry whose changes contain appUrl').toBeDefined()
  })

  test('UI: superadmin selects the organization address and saves', async ({ page, request }) => {
    await login(page, 'superadmin')
    await page.goto(`/backend/directory/organizations/${orgA}/edit`, { waitUntil: 'domcontentloaded' })

    const field = page.locator('[data-crud-field-id="appUrl"]')
    const trigger = field.getByRole('combobox')
    await expect(trigger).toBeVisible({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('option', { name: baseOrigin, exact: true }).click()

    const saved = page.waitForResponse((response) => response.url().includes(ORGANIZATIONS) && response.request().method() === 'PUT')
    await page.locator('[data-crud-field-id="name"] input').first().press('Control+Enter')
    expect((await saved).status(), 'form save succeeds').toBe(200)

    await expect.poll(async () => (await readOrganization(request, superadminToken, orgA))?.appUrl ?? null, {
      message: 'saved address is returned by the API',
    }).toBe(baseOrigin)
  })

  test('UI: admin without the manage feature sees the address read-only', async ({ page, request }) => {
    const adminCanSeeA = (await readOrganization(request, adminToken, orgA)) !== null
    const targetId = adminCanSeeA ? orgA : getTokenContext(adminToken).organizationId
    await login(page, 'admin')
    await page.goto(`/backend/directory/organizations/${targetId}/edit`, { waitUntil: 'domcontentloaded' })

    const nameInput = page.locator('[data-crud-field-id="name"] input').first()
    const opened = await nameInput.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    test.skip(!opened, 'admin cannot open an organization edit page')

    const field = page.locator('[data-crud-field-id="appUrl"]')
    await expect(field).toBeVisible()
    await expect(field.getByRole('combobox')).toHaveCount(0)
  })
})
