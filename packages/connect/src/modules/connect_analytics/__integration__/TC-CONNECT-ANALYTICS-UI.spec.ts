import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { deleteMetricDays, insertMetricDay } from './connect-metrics-sql'

/**
 * TC-CONNECT-ANALYTICS-UI — AN-UI-001 and AN-INT-010.
 *
 * The screen's job is to stay honest about what it does and does not know, so
 * this suite reads the page the way a screen reader does: exact values in a
 * semantic table, an explicit "unavailable" where nothing was measured, and a
 * visible cohort and formula version. It also proves the Connect metrics page
 * still exists with its recovery affordances — analytics coexists, it does not
 * replace.
 */

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

const MS_PER_DAY = 86_400_000

function shiftUtcDate(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * MS_PER_DAY)
    .toISOString()
    .slice(0, 10)
}

const TODAY_UTC = new Date().toISOString().slice(0, 10)
const YESTERDAY_UTC = shiftUtcDate(TODAY_UTC, -1)
/** Inside the page's default 30-day window. */
const DAY_MEASURED = shiftUtcDate(YESTERDAY_UTC, -4)
const DAY_UNMEASURED = shiftUtcDate(YESTERDAY_UTC, -3)
const SEEDED_DAYS = [DAY_MEASURED, DAY_UNMEASURED]

const MEASURED_INBOUND = 4242

test.describe.configure({ mode: 'serial' })

test.describe('TC-CONNECT-ANALYTICS-UI: read-only analytics screen', () => {
  let container: AppContainer
  let em: EntityManager
  let tenantId: string
  let organizationId: string

  test.beforeAll(async ({ request }) => {
    await bootstrapFromAppRoot(APP_ROOT)
    container = await createRequestContainer()
    em = container.resolve<EntityManager>('em')

    const token = await getAuthToken(request, 'superadmin')
    const context = getTokenContext(token)
    tenantId = context.tenantId
    organizationId = context.organizationId

    await insertMetricDay(em, { tenantId, organizationId }, {
      utcDate: DAY_MEASURED,
      inboundClaimed: MEASURED_INBOUND,
      casesOpened: MEASURED_INBOUND,
      outboundAttempted: 10,
      outboundSent: 10,
      casesAssigned: 5,
      casesResolved: 5,
      firstResponseP50Seconds: 45,
      firstResponseP90Seconds: 300,
      firstResponseSampleCount: 12,
      observedMaxPermittedPerSender: 2,
      appliedCountLimit: 5,
    })
    await insertMetricDay(em, { tenantId, organizationId }, {
      // Aggregated but with nothing measured, and mid-rebuild.
      utcDate: DAY_UNMEASURED,
      inboundClaimed: 1,
      casesOpened: 1,
      firstResponseSampleCount: 0,
      elapsedResolutionSampleCount: 0,
      observedMaxPermittedPerSender: 1,
      appliedCountLimit: 5,
      stale: true,
    })
  })

  test.afterAll(async () => {
    try {
      await deleteMetricDays(em, { tenantId, organizationId }, SEEDED_DAYS)
    } finally {
      await container.dispose()
    }
  })

  test('AN-UI-001: the report is exact text in a semantic table with visible provenance', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await login(page, 'superadmin')
    await page.goto('/backend/connect/analytics')

    await expect(page.getByRole('heading', { name: 'Connect analytics' })).toBeVisible()

    // Provenance: cohort, aggregated day count and formula version are on screen,
    // not buried in a tooltip.
    await expect(page.getByText('connect_analytics.operational.v1')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Report provenance' })).toBeVisible()

    // A real table, with a caption and a row header per day.
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    await expect(table.getByRole('rowheader', { name: new RegExp(DAY_MEASURED) })).toBeVisible()
    await expect(table.getByRole('cell', { name: String(MEASURED_INBOUND), exact: true })).toBeVisible()

    // The day nothing was measured on says so, and says it is mid-rebuild.
    const unmeasuredRow = table.getByRole('row', { name: new RegExp(DAY_UNMEASURED) })
    await expect(unmeasuredRow).toContainText('unavailable')
    await expect(unmeasuredRow).toContainText('(rebuilding)')

    // Read-only: no rebuild affordance anywhere on this screen.
    await expect(page.getByRole('button', { name: /rebuild/i })).toHaveCount(0)

    // Keyboard reachability of the only interactive controls.
    await expect(page.getByLabel('From (UTC)')).toBeEnabled()
    await expect(page.getByLabel('To (UTC)')).toBeEnabled()
    const refresh = page.getByRole('button', { name: 'Refresh' })
    await refresh.focus()
    await expect(refresh).toBeFocused()

    const hydrationErrors = consoleErrors.filter((text) => /hydrat|did not match/i.test(text))
    expect(hydrationErrors, hydrationErrors.join('\n')).toEqual([])
  })

  test('AN-UI-001: a range with nothing aggregated renders an empty state, not zeros', async ({ page }) => {
    await login(page, 'superadmin')
    // Far enough back that no fixture or seed can have produced aggregates.
    const from = shiftUtcDate(YESTERDAY_UTC, -3650)
    const to = shiftUtcDate(from, 5)
    await page.goto(`/backend/connect/analytics`)

    await page.getByLabel('From (UTC)').fill(from)
    await page.getByLabel('To (UTC)').fill(to)

    await expect(page.getByText('No aggregated days in this range')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
  })

  test('AN-INT-010: the Connect metrics page keeps its recovery surface alongside analytics', async ({ page }) => {
    await login(page, 'superadmin')

    await page.goto('/backend/connect/metrics')
    await expect(page.getByRole('button', { name: 'Rebuild this range' })).toBeVisible()

    const manifest = fs.readFileSync(
      path.join(APP_ROOT, '.mercato', 'generated', 'backend-route-metadata.generated.ts'),
      'utf8',
    )
    const metricsEntry = manifest.split('\n').find((line) => line.includes('"/backend/connect/metrics"'))
    const analyticsEntry = manifest.split('\n').find((line) => line.includes('"/backend/connect/analytics"'))
    expect(metricsEntry, 'metrics page must stay in the manifest').toBeTruthy()
    expect(analyticsEntry, 'analytics page must be in the manifest').toBeTruthy()
    // Distinct orders: neither aliases or replaces the other in navigation.
    expect(metricsEntry).toContain('"pageOrder":30')
    expect(analyticsEntry).toContain('"pageOrder":31')
    expect(metricsEntry).toContain('connect.metrics.view')
    expect(analyticsEntry).toContain('connect_analytics.view')
  })
})
