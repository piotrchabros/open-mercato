import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi/types'
import { loadOperationalReport } from '../../../lib/load-operational-report'
import {
  CONNECT_ANALYTICS_MAX_RANGE_DAYS,
  apiErrorSchema,
  operationalQuerySchema,
  operationalReportSchema,
  utcToday,
  type ApiError,
} from '../../../lib/report-composer'

/**
 * The operational report.
 *
 * Analytics composes; it does not own the numbers. The aggregates arrive
 * through Connect's sanctioned read facade, so this route never sees a receipt,
 * a sender, a handle or a customer — and when Connect is absent it says so with
 * a 503 rather than serving a dataset of zeroes that reads as "a quiet week".
 *
 * Tenant and organization come from the session. Nothing in the query string
 * can widen them.
 */

export const metadata = {
  path: '/connect_analytics/reports/operational',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect_analytics.view'],
  },
}

type RbacServiceLike = {
  userHasAllFeatures: (
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>
}

const REQUIRED_FEATURES = ['connect_analytics.view']

function fail(status: number, body: ApiError): Response {
  return NextResponse.json(apiErrorSchema.parse(body), { status })
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth?.tenantId) {
    return fail(401, { error: 'Unauthorized', code: 'unauthorized' })
  }
  // Same organization derivation as Phase 1 metrics: every Connect aggregate is
  // organization-scoped, so a caller with no selected organization has no scope
  // at all. Falling back to the tenant would report a sibling organization's
  // traffic.
  const organizationId = (auth as { orgId?: string | null }).orgId ?? null
  if (!organizationId) {
    return fail(400, {
      error: 'Select an organization to read Connect analytics.',
      code: 'organization_required',
    })
  }

  const container = await createRequestContainer()

  // The API dispatcher already enforced `requireFeatures`. Re-checking here
  // keeps the guard at the layer that actually reads the data, so it does not
  // depend on one caller having configured route metadata correctly.
  let granted = false
  try {
    const rbac = container.resolve('rbacService') as RbacServiceLike
    granted = await rbac.userHasAllFeatures(auth.sub as string, REQUIRED_FEATURES, {
      tenantId: auth.tenantId as string,
      organizationId,
    })
  } catch {
    granted = false
  }
  if (!granted) return fail(403, { error: 'Forbidden', code: 'forbidden' })

  const parsedQuery = operationalQuerySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  )
  if (!parsedQuery.success) {
    return fail(422, { error: 'The range is not two ISO dates (YYYY-MM-DD).', code: 'invalid_range' })
  }

  const loaded = await loadOperationalReport({
    container,
    tenantId: auth.tenantId as string,
    organizationId,
    from: parsedQuery.data.from,
    to: parsedQuery.data.to,
    todayUtc: utcToday(),
  })

  if (loaded.status === 'invalid_range') {
    return fail(422, { error: 'The range starts after it ends.', code: 'invalid_range' })
  }
  if (loaded.status === 'range_too_large') {
    return fail(422, {
      error: `Ranges are limited to ${CONNECT_ANALYTICS_MAX_RANGE_DAYS} days.`,
      code: 'range_too_large',
    })
  }
  if (loaded.status === 'unavailable') {
    return fail(503, {
      error: 'Connect operational metrics are unavailable.',
      code: 'metrics_reader_unavailable',
    })
  }

  return NextResponse.json(operationalReportSchema.parse(loaded.report))
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Connect analytics',
  summary: 'Formula-versioned Connect operational reporting',
  methods: {
    GET: {
      summary: 'Read the formula-versioned Connect operational report',
      tags: ['Connect analytics'],
      query: operationalQuerySchema,
      responses: [
        {
          status: 200,
          description: 'Operational report for the complete UTC days in range',
          schema: operationalReportSchema,
        },
        { status: 400, description: 'No organization selected', schema: apiErrorSchema },
        { status: 401, description: 'Unauthorized', schema: apiErrorSchema },
        { status: 403, description: 'Forbidden', schema: apiErrorSchema },
        { status: 422, description: 'Invalid or oversized range', schema: apiErrorSchema },
        {
          status: 503,
          description: 'Connect operational metrics reader unavailable',
          schema: apiErrorSchema,
        },
      ],
    },
  },
}
