import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { asFunction, createContainer, InjectionMode } from 'awilix'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { register as registerConnectAnalyticsDi } from '../di'
import { loadOperationalReport } from '../lib/load-operational-report'
import { deleteMetricDays, insertMetricDay } from './connect-metrics-sql'

/**
 * TC-CONNECT-ANALYTICS-OPERATIONAL — AN-INT-001..009.
 *
 * The suite exists to prove the three things a reporting surface can get wrong
 * without anyone noticing: it can show another organization's traffic, it can
 * present "we could not measure" as a zero, and it can leak a person into an
 * aggregate. Everything else here supports those.
 */

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

const GENERATED_ROOT = path.join(APP_ROOT, '.mercato', 'generated')
const REPORT_PATH = '/api/connect_analytics/reports/operational'

const MS_PER_DAY = 86_400_000

function shiftUtcDate(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * MS_PER_DAY)
    .toISOString()
    .slice(0, 10)
}

const TODAY_UTC = new Date().toISOString().slice(0, 10)
const YESTERDAY_UTC = shiftUtcDate(TODAY_UTC, -1)

/** Complete days only, with a deliberate gap between DAY_B and DAY_C. */
const DAY_A = shiftUtcDate(YESTERDAY_UTC, -9)
const DAY_B = shiftUtcDate(YESTERDAY_UTC, -8)
const DAY_GAP = shiftUtcDate(YESTERDAY_UTC, -7)
const DAY_C = shiftUtcDate(YESTERDAY_UTC, -6)
const SEEDED_DAYS = [DAY_A, DAY_B, DAY_C]

type ReportDay = {
  utcDate: string
  inboundClaimed: number
  casesOpened: number
  casesAttached: number
  inboundSuppressed: number
  inboundDeadLettered: number
  unreconciled: number
  outboundAttempted: number
  outboundSent: number
  outboundFailed: number
  outboundUnknown: number
  unknownMaxAgeSeconds: number | null
  casesAssigned: number
  casesResolved: number
  casesReopened: number
  firstResponse: { p50: number | null; p90: number | null; sampleCount: number } | null
  elapsedAssignedToResolution: { p50: number | null; p90: number | null; sampleCount: number } | null
  projectionLag: Record<string, number | null> | null
  suppression: {
    observedMaxPermittedPerSender: number
    appliedCountLimit: number | null
    withinLimit: boolean | null
  }
  generatedAt: string
  stale: boolean
}

type Report = {
  from: string
  to: string
  requestedDays: number
  completeDays: number
  formulaVersion: string
  operationalMetrics: { capability: string }
  days: ReportDay[]
  totals: Record<string, number> | null
}

type SummaryDay = {
  utcDate: string
  inboundClaimed: number
  casesOpened: number
  casesAttached: number
  inboundSuppressed: number
  inboundDeadLettered: number
  unreconciled: number
  outboundAttempted: number
  outboundSent: number
  outboundFailed: number
  outboundUnknown: number
  unknownMaxAgeSeconds: number | null
  casesAssigned: number
  casesResolved: number
  casesReopened: number
  firstResponse: { p50Seconds: number | null; p90Seconds: number | null; sampleCount: number } | null
  elapsedAssignedToResolution: { p50Seconds: number | null; p90Seconds: number | null; sampleCount: number } | null
  suppression: {
    observedMaxPermittedPerSender: number
    appliedCountLimit: number | null
    withinLimit: boolean | null
  }
  generatedAt: string
  stale: boolean
}

type Summary = { from: string; to: string; completeDays: number; days: SummaryDay[] }

/** Distinct per-day shapes so a mixed-up row is visible rather than plausible. */
const HOME_SEEDS = [
  {
    utcDate: DAY_A,
    inboundClaimed: 20,
    casesOpened: 9,
    casesAttached: 6,
    inboundSuppressed: 3,
    inboundDeadLettered: 2,
    outboundAttempted: 12,
    outboundSent: 10,
    outboundFailed: 1,
    outboundUnknown: 1,
    unknownMaxAgeSeconds: 5400,
    casesAssigned: 9,
    casesResolved: 7,
    casesReopened: 1,
    firstResponseP50Seconds: 45,
    firstResponseP90Seconds: 300,
    firstResponseSampleCount: 12,
    elapsedResolutionP50Seconds: 3600,
    elapsedResolutionP90Seconds: 7200,
    elapsedResolutionSampleCount: 7,
    observedMaxPermittedPerSender: 4,
    appliedCountLimit: 5,
    stale: false,
  },
  {
    // Aggregated, but with no percentile population at all — the case that must
    // read as unavailable rather than as "instant".
    utcDate: DAY_B,
    inboundClaimed: 4,
    casesOpened: 4,
    outboundAttempted: 2,
    outboundSent: 2,
    casesAssigned: 4,
    casesResolved: 1,
    firstResponseSampleCount: 0,
    elapsedResolutionSampleCount: 0,
    observedMaxPermittedPerSender: 1,
    appliedCountLimit: 5,
    stale: true,
  },
  {
    // A day that breaches the per-sender limit and does not reconcile.
    utcDate: DAY_C,
    inboundClaimed: 11,
    casesOpened: 5,
    casesAttached: 2,
    inboundSuppressed: 1,
    inboundDeadLettered: 0,
    outboundAttempted: 8,
    outboundSent: 4,
    outboundFailed: 2,
    outboundUnknown: 2,
    unknownMaxAgeSeconds: 86_399,
    casesAssigned: 5,
    casesResolved: 3,
    casesReopened: 2,
    firstResponseP50Seconds: 90,
    firstResponseP90Seconds: 600,
    firstResponseSampleCount: 5,
    observedMaxPermittedPerSender: 9,
    appliedCountLimit: 5,
    stale: false,
  },
]

/** Deliberately loud numbers: if any of these reach the home report, it shows. */
const SIBLING_SEED = {
  utcDate: DAY_A,
  inboundClaimed: 777,
  casesOpened: 777,
  outboundAttempted: 777,
  outboundSent: 777,
  casesAssigned: 777,
  casesResolved: 777,
  observedMaxPermittedPerSender: 77,
  appliedCountLimit: 5,
}

async function getReport(
  request: APIRequestContext,
  token: string,
  from: string,
  to: string,
): Promise<{ status: number; body: Report | null; raw: string }> {
  const response = await apiRequest(
    request,
    'GET',
    `${REPORT_PATH}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { token },
  )
  const raw = await response.text()
  let body: Report | null = null
  try {
    body = JSON.parse(raw) as Report
  } catch {
    body = null
  }
  return { status: response.status(), body, raw }
}

test.describe.configure({ mode: 'serial' })

test.describe('TC-CONNECT-ANALYTICS-OPERATIONAL: aggregate operational reporting', () => {
  let container: AppContainer
  let em: EntityManager
  let adminToken: string
  let tenantId: string
  let homeOrgId: string
  let siblingOrgId: string | null = null
  let viewerRoleId: string | null = null
  let viewerUserId: string | null = null
  let viewerToken: string
  let deniedRoleId: string | null = null
  let deniedUserId: string | null = null
  let deniedToken: string
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const viewerRoleName = `connect-analytics-viewer-${suffix}`
  const deniedRoleName = `connect-analytics-denied-${suffix}`
  const viewerEmail = `connect-analytics-viewer-${suffix}@example.test`
  const deniedEmail = `connect-analytics-denied-${suffix}@example.test`
  const PASSWORD = 'Valid1!Pass'

  test.beforeAll(async ({ request }) => {
    await bootstrapFromAppRoot(APP_ROOT)
    container = await createRequestContainer()
    em = container.resolve<EntityManager>('em')

    adminToken = await getAuthToken(request)
    const context = getTokenContext(adminToken)
    tenantId = context.tenantId
    homeOrgId = context.organizationId

    siblingOrgId = await createOrganizationFixture(request, adminToken, {
      name: `Connect analytics sibling ${suffix}`,
      tenantId,
    })

    // The wildcard grant is the interesting one: `connect_analytics.*` must
    // match `connect_analytics.view` through the shared matcher.
    viewerRoleId = await createRoleFixture(request, adminToken, { name: viewerRoleName, tenantId })
    await setRoleAclFeatures(request, adminToken, {
      roleId: viewerRoleId,
      features: ['connect_analytics.*', 'connect.metrics.view'],
    })
    viewerUserId = await createUserFixture(request, adminToken, {
      email: viewerEmail,
      password: PASSWORD,
      organizationId: homeOrgId,
      roles: [viewerRoleName],
    })

    // Holds the Phase 1 metrics grant and nothing else: the analytics feature
    // is genuinely separate, not implied by it.
    deniedRoleId = await createRoleFixture(request, adminToken, { name: deniedRoleName, tenantId })
    await setRoleAclFeatures(request, adminToken, {
      roleId: deniedRoleId,
      features: ['connect.metrics.view'],
    })
    deniedUserId = await createUserFixture(request, adminToken, {
      email: deniedEmail,
      password: PASSWORD,
      organizationId: homeOrgId,
      roles: [deniedRoleName],
    })

    viewerToken = await getAuthToken(request, viewerEmail, PASSWORD)
    deniedToken = await getAuthToken(request, deniedEmail, PASSWORD)

    for (const seed of HOME_SEEDS) {
      await insertMetricDay(em, { tenantId, organizationId: homeOrgId }, seed)
    }
    await insertMetricDay(em, { tenantId, organizationId: siblingOrgId }, SIBLING_SEED)
  })

  test.afterAll(async ({ request }) => {
    try {
      await deleteMetricDays(em, { tenantId, organizationId: homeOrgId }, SEEDED_DAYS)
      if (siblingOrgId) {
        await deleteMetricDays(em, { tenantId, organizationId: siblingOrgId }, [SIBLING_SEED.utcDate])
      }
    } finally {
      await deleteUserIfExists(request, adminToken, viewerUserId)
      await deleteUserIfExists(request, adminToken, deniedUserId)
      await deleteRoleIfExists(request, adminToken, viewerRoleId)
      await deleteRoleIfExists(request, adminToken, deniedRoleId)
      await deleteOrganizationIfExists(request, adminToken, siblingOrgId)
      await container.dispose()
    }
  })

  test('AN-INT-001: a sibling organization never reaches the report', async ({ request }) => {
    const { status, body, raw } = await getReport(request, viewerToken, DAY_A, DAY_C)
    expect(status, raw).toBe(200)
    expect(body).not.toBeNull()

    const dayA = body!.days.find((day) => day.utcDate === DAY_A)
    expect(dayA?.inboundClaimed).toBe(HOME_SEEDS[0].inboundClaimed)
    expect(body!.totals?.inboundClaimed).toBe(
      HOME_SEEDS.reduce((total, seed) => total + (seed.inboundClaimed ?? 0), 0),
    )
    // The sibling's loud numbers must be absent from every field.
    expect(raw).not.toContain('777')
    expect(raw).not.toContain(siblingOrgId!)
  })

  test('AN-INT-002: complete, missing and stale days stay distinguishable', async ({ request }) => {
    const { status, body } = await getReport(request, viewerToken, DAY_A, DAY_C)
    expect(status).toBe(200)

    expect(body!.from).toBe(DAY_A)
    expect(body!.to).toBe(DAY_C)
    // Four calendar days requested, three aggregated: the gap is the signal.
    expect(body!.requestedDays).toBe(4)
    expect(body!.completeDays).toBe(3)
    expect(body!.days.map((day) => day.utcDate)).toEqual([DAY_A, DAY_B, DAY_C])
    expect(body!.days.map((day) => day.utcDate)).not.toContain(DAY_GAP)
    expect(body!.days.find((day) => day.utcDate === DAY_B)?.stale).toBe(true)
    expect(body!.days.find((day) => day.utcDate === DAY_A)?.stale).toBe(false)
    expect(body!.formulaVersion).toBe('connect_analytics.operational.v1')
    expect(body!.operationalMetrics).toEqual({ capability: 'available' })
  })

  test('AN-INT-002: today is clamped away and an empty cohort is not an error', async ({ request }) => {
    const clamped = await getReport(request, viewerToken, DAY_A, TODAY_UTC)
    expect(clamped.status).toBe(200)
    expect(clamped.body!.to).toBe(YESTERDAY_UTC)

    const empty = await getReport(request, viewerToken, TODAY_UTC, TODAY_UTC)
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({
      from: TODAY_UTC,
      to: YESTERDAY_UTC,
      requestedDays: 0,
      completeDays: 0,
      days: [],
      totals: null,
    })
  })

  test('AN-INT-003: an empty percentile population is unavailable, not zero', async ({ request }) => {
    const { body } = await getReport(request, viewerToken, DAY_A, DAY_C)
    const dayB = body!.days.find((day) => day.utcDate === DAY_B)

    expect(dayB?.firstResponse).toBeNull()
    expect(dayB?.elapsedAssignedToResolution).toBeNull()
    expect(dayB?.projectionLag).toBeNull()

    const dayA = body!.days.find((day) => day.utcDate === DAY_A)
    expect(dayA?.firstResponse).toEqual({ p50: 45, p90: 300, sampleCount: 12 })
    expect(dayA?.elapsedAssignedToResolution).toEqual({ p50: 3600, p90: 7200, sampleCount: 7 })

    // No range percentile is ever synthesised from daily ones.
    expect(Object.keys(body!.totals ?? {})).not.toContain('firstResponse')
    expect(JSON.stringify(body!.totals)).not.toContain('p50')
  })

  test('AN-INT-004: delivery, unknown age, reconciliation and suppression match the source', async ({ request }) => {
    const { body } = await getReport(request, viewerToken, DAY_A, DAY_C)
    const dayC = body!.days.find((day) => day.utcDate === DAY_C)

    expect(dayC?.outboundAttempted).toBe(8)
    expect(dayC?.outboundSent).toBe(4)
    expect(dayC?.outboundFailed).toBe(2)
    // Unknown is its own answer, never folded into sent or failed.
    expect(dayC?.outboundUnknown).toBe(2)
    expect(dayC?.unknownMaxAgeSeconds).toBe(86_399)
    // 11 - 5 - 2 - 1 - 0 = 3 receipts unaccounted for.
    expect(dayC?.unreconciled).toBe(3)
    expect(dayC?.suppression).toEqual({
      observedMaxPermittedPerSender: 9,
      appliedCountLimit: 5,
      withinLimit: false,
    })

    const dayA = body!.days.find((day) => day.utcDate === DAY_A)
    expect(dayA?.unreconciled).toBe(0)
    expect(dayA?.suppression.withinLimit).toBe(true)
    expect(body!.totals?.unreconciled).toBe(3)
  })

  test('AN-INT-005: an absent Connect reader is explicit, never an all-zero report', async () => {
    // A container with the analytics registration and no Connect reader — the
    // exact shape of a deployment that enabled analytics without Connect.
    const isolated = createContainer({ injectionMode: InjectionMode.CLASSIC })
    registerConnectAnalyticsDi(isolated as unknown as AppContainer)
    expect(isolated.resolve('connectAnalyticsMetricsSource')).toBeNull()

    const result = await loadOperationalReport({
      container: isolated as unknown as AppContainer,
      tenantId,
      organizationId: homeOrgId,
      from: DAY_A,
      to: DAY_C,
      todayUtc: TODAY_UTC,
    })
    expect(result).toEqual({ status: 'unavailable' })

    // A container whose reader throws degrades the same way.
    const broken = createContainer({ injectionMode: InjectionMode.CLASSIC })
    broken.register({
      connectOperationalMetricsReader: asFunction(() => {
        throw new Error('[internal] connect unavailable')
      }).scoped(),
    })
    registerConnectAnalyticsDi(broken as unknown as AppContainer)
    expect(broken.resolve('connectAnalyticsMetricsSource')).toBeNull()

    // And the booted app really does register the source it consumes.
    expect(container.resolve('connectOperationalMetricsReader')).toBeTruthy()
    expect(container.resolve('connectAnalyticsMetricsSource')).toBeTruthy()
  })

  test('AN-INT-006: the ACL matrix denies without the feature and honours the wildcard', async ({ request }) => {
    const anonymous = await request.fetch(`${REPORT_PATH}?from=${DAY_A}&to=${DAY_C}`, { method: 'GET' })
    expect(anonymous.status()).toBe(401)

    const denied = await getReport(request, deniedToken, DAY_A, DAY_C)
    expect(denied.status, 'connect.metrics.view alone must not open analytics').toBe(403)

    // Same caller, wildcard grant: allowed.
    const allowed = await getReport(request, viewerToken, DAY_A, DAY_C)
    expect(allowed.status).toBe(200)

    const invalid = await getReport(request, viewerToken, DAY_C, DAY_A)
    expect(invalid.status).toBe(422)
    expect((await readJsonSafe<{ code?: string }>(
      await apiRequest(request, 'GET', `${REPORT_PATH}?from=${DAY_C}&to=${DAY_A}`, { token: viewerToken }),
    ))?.code).toBe('invalid_range')

    const tooLarge = await getReport(request, viewerToken, shiftUtcDate(YESTERDAY_UTC, -200), YESTERDAY_UTC)
    expect(tooLarge.status).toBe(422)
  })

  test('AN-INT-006: server-derived organization scope follows the selected organization', async ({ request }) => {
    let superadminToken: string
    try {
      superadminToken = await getAuthToken(request, 'superadmin')
    } catch {
      test.skip(true, 'No superadmin credentials in this runtime; organization switching cannot be exercised')
      return
    }
    if (!siblingOrgId) {
      test.skip(true, 'Sibling organization fixture unavailable')
      return
    }

    const response = await apiRequestWithSelectedOrg(
      request,
      'GET',
      `${REPORT_PATH}?from=${DAY_A}&to=${DAY_C}`,
      { token: superadminToken, selectedOrgId: siblingOrgId },
    )
    expect(response.status()).toBe(200)
    const body = (await readJsonSafe<Report>(response))!
    expect(body.completeDays).toBe(1)
    expect(body.days[0]?.utcDate).toBe(DAY_A)
    expect(body.days[0]?.inboundClaimed).toBe(SIBLING_SEED.inboundClaimed)
  })

  test('AN-INT-007: the payload carries no identifier, sender or message content', async ({ request }) => {
    const { raw, body } = await getReport(request, viewerToken, DAY_A, DAY_C)

    const forbiddenKeys = [
      'senderHash', 'sender_hash', 'customerId', 'customer_id', 'caseId', 'case_id',
      'receiptId', 'receipt_id', 'conversationId', 'messageId', 'handle', 'subject',
      'body', 'tenantId', 'organizationId', 'id',
    ]
    const seen = new Set<string>()
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          seen.add(key)
          walk(child)
        }
      }
    }
    walk(body)

    for (const key of forbiddenKeys) expect(Array.from(seen)).not.toContain(key)
    expect(raw).not.toContain(tenantId)
    expect(raw).not.toContain(homeOrgId)
    expect(raw).not.toContain(viewerEmail)
  })

  test('AN-INT-008: generated manifests carry the route, page, feature and DI registration', async ({ request }) => {
    const read = (file: string) => fs.readFileSync(path.join(GENERATED_ROOT, file), 'utf8')

    expect(read('api-route-metadata.generated.ts')).toContain('/connect_analytics/reports/operational')
    const backendManifest = read('backend-route-metadata.generated.ts')
    expect(backendManifest).toContain('/backend/connect/analytics')
    expect(backendManifest).toContain('connect_analytics.view')
    expect(read('di.generated.ts')).toContain('connect_analytics/di')
    expect(read('enabled-module-ids.generated.ts')).toContain('connect_analytics')

    // No doubled module prefix: only the declared path is served.
    const declared = await apiRequest(request, 'GET', `${REPORT_PATH}?from=${DAY_A}&to=${DAY_C}`, {
      token: viewerToken,
    })
    expect(declared.status()).toBe(200)
    const doubled = await apiRequest(
      request,
      'GET',
      `/api/connect_analytics/connect_analytics/reports/operational?from=${DAY_A}&to=${DAY_C}`,
      { token: viewerToken },
    )
    expect(doubled.status()).toBe(404)
  })

  test('AN-INT-009: every shared value matches the Phase 1 summary for the same range', async ({ request }) => {
    const { body: report } = await getReport(request, viewerToken, DAY_A, DAY_C)
    const summaryResponse = await apiRequest(
      request,
      'GET',
      `/api/connect/metrics/summary?from=${DAY_A}&to=${DAY_C}`,
      { token: viewerToken },
    )
    expect(summaryResponse.status()).toBe(200)
    const summary = (await readJsonSafe<Summary>(summaryResponse))!

    expect(report!.to).toBe(summary.to)
    expect(report!.completeDays).toBe(summary.completeDays)
    expect(report!.days.map((day) => day.utcDate)).toEqual(summary.days.map((day) => day.utcDate))

    for (const summaryDay of summary.days) {
      const reportDay = report!.days.find((day) => day.utcDate === summaryDay.utcDate)!
      expect(reportDay, `missing ${summaryDay.utcDate}`).toBeTruthy()
      for (const counter of [
        'inboundClaimed', 'casesOpened', 'casesAttached', 'inboundSuppressed', 'inboundDeadLettered',
        'unreconciled', 'outboundAttempted', 'outboundSent', 'outboundFailed', 'outboundUnknown',
        'casesAssigned', 'casesResolved', 'casesReopened',
      ] as const) {
        expect(reportDay[counter], `${summaryDay.utcDate}.${counter}`).toBe(summaryDay[counter])
      }
      expect(reportDay.unknownMaxAgeSeconds).toBe(summaryDay.unknownMaxAgeSeconds)
      expect(reportDay.stale).toBe(summaryDay.stale)
      expect(reportDay.generatedAt).toBe(summaryDay.generatedAt)
      expect(reportDay.suppression).toEqual(summaryDay.suppression)

      // Same population and same values; only the field names differ, because
      // the analytics DTO is unit-agnostic.
      expect(reportDay.firstResponse === null).toBe(summaryDay.firstResponse === null)
      if (reportDay.firstResponse && summaryDay.firstResponse) {
        expect(reportDay.firstResponse.p50).toBe(summaryDay.firstResponse.p50Seconds)
        expect(reportDay.firstResponse.p90).toBe(summaryDay.firstResponse.p90Seconds)
        expect(reportDay.firstResponse.sampleCount).toBe(summaryDay.firstResponse.sampleCount)
      }
      expect(reportDay.elapsedAssignedToResolution === null).toBe(
        summaryDay.elapsedAssignedToResolution === null,
      )
      if (reportDay.elapsedAssignedToResolution && summaryDay.elapsedAssignedToResolution) {
        expect(reportDay.elapsedAssignedToResolution.p50).toBe(summaryDay.elapsedAssignedToResolution.p50Seconds)
        expect(reportDay.elapsedAssignedToResolution.p90).toBe(summaryDay.elapsedAssignedToResolution.p90Seconds)
        expect(reportDay.elapsedAssignedToResolution.sampleCount).toBe(
          summaryDay.elapsedAssignedToResolution.sampleCount,
        )
      }
    }
  })

  test('AN-UI-002: a maximum range stays inside the published response budget', async ({ request }) => {
    const from = shiftUtcDate(YESTERDAY_UTC, -91)
    const started = Date.now()
    const { status, raw } = await getReport(request, viewerToken, from, YESTERDAY_UTC)
    const elapsedMs = Date.now() - started

    expect(status).toBe(200)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(250_000)
    expect(elapsedMs).toBeLessThan(5_000)
  })
})
