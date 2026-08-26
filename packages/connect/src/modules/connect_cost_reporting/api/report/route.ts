import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi/types'
import { apiErrorSchema, reportQuerySchema, reportResponseSchema, type ApiError } from '../../data/validators'
import { loadCostPerContactReport } from '../../lib/load-report'

export const metadata = {
  path: '/connect_cost_reporting/report',
  GET: { requireAuth: true, requireFeatures: ['connect_cost_reporting.view'] },
}

type RbacServiceLike = {
  userHasAllFeatures: (
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>
}

function fail(status: number, error: string, code: ApiError['code']) {
  return NextResponse.json(apiErrorSchema.parse({ error, code }), { status })
}

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) return fail(401, 'Unauthorized', 'unauthorized')
  const organizationId = (auth as { orgId?: string | null }).orgId ?? null
  if (!organizationId) return fail(400, 'Select an organization.', 'organization_required')

  const parsed = reportQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) {
    const currencyInvalid = parsed.error.issues.some((issue) => issue.path[0] === 'currency')
    return fail(422, currencyInvalid ? 'Invalid currency.' : 'Invalid range.', currencyInvalid ? 'invalid_currency' : 'invalid_range')
  }
  const from = new Date(parsed.data.from)
  const to = new Date(parsed.data.to)
  if (from >= to) return fail(422, 'Invalid range.', 'invalid_range')
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1_000) {
    return fail(422, 'Range is limited to 366 days.', 'range_too_large')
  }

  const container = await createRequestContainer()
  let adapterAuthorized = false
  let financialAuthorized = false
  try {
    const rbac = container.resolve('rbacService') as RbacServiceLike
    const scope = { tenantId: auth.tenantId as string, organizationId }
    adapterAuthorized = await rbac.userHasAllFeatures(auth.sub as string, ['connect_cost_reporting.view'], scope)
    if (adapterAuthorized) {
      financialAuthorized = await rbac.userHasAllFeatures(auth.sub as string, ['connect_analytics.cost_inputs.view'], scope)
    }
  } catch {
    adapterAuthorized = false
  }
  if (!adapterAuthorized) return fail(403, 'Forbidden', 'forbidden')

  const report = await loadCostPerContactReport({
    container,
    tenantId: auth.tenantId as string,
    organizationId,
    from: parsed.data.from,
    to: parsed.data.to,
    currencyCode: parsed.data.currency,
    financialAuthorized,
  })
  return NextResponse.json(reportResponseSchema.parse(report))
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Connect cost reporting',
  summary: 'Exact cost-per-contact reporting',
  methods: {
    GET: {
      summary: 'Read exact allocated cost per canonical contact',
      tags: ['Connect cost reporting'],
      query: reportQuerySchema,
      responses: [
        { status: 200, description: 'Available report or explicit source capability state', schema: reportResponseSchema },
        { status: 400, description: 'No organization selected', schema: apiErrorSchema },
        { status: 401, description: 'Unauthorized', schema: apiErrorSchema },
        { status: 403, description: 'Forbidden', schema: apiErrorSchema },
        { status: 422, description: 'Invalid range or currency', schema: apiErrorSchema },
      ],
    },
  },
}
