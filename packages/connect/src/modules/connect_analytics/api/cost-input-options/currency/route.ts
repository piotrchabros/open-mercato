import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { costInputErrorBody } from '../../../commands/cost-input-errors'
import type { CostInputCurrencyResolver } from '../../../lib/cost-input-currency'

/**
 * Singleton currency selector for the cost form.
 *
 * A *singleton*, not a list: Phase 2 cost rows are restricted to the
 * organization's resolved base currency, so offering a picker would imply a
 * choice the write path will reject. Returning the one sanctioned code keeps
 * the form and the server telling the same story.
 *
 * It is guarded by `cost_inputs.manage` rather than `currencies.view` on
 * purpose. The caller is not being granted access to the currencies module —
 * they are being told which code their own cost rows must carry, which is
 * strictly less than what `currencies.view` would expose. Granting
 * `currencies.view` implicitly to every cost recorder would widen access as a
 * side effect of a form field.
 */

export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['connect_analytics.cost_inputs.manage'],
  },
}

const responseSchema = z.object({
  item: z.object({ code: z.string().regex(/^[A-Z]{3}$/) }),
})

const errorSchema = z.object({ error: z.string(), code: z.string() })

export async function GET(request: Request): Promise<Response> {
  const { translate } = await resolveTranslations()

  const auth = await getAuthFromRequest(request)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 })
  }
  const organizationId = resolveActiveOrganizationId(auth)
  if (!organizationId) {
    return NextResponse.json(costInputErrorBody('organization_scope_required', translate), { status: 400 })
  }

  const container = await createRequestContainer()
  let resolver: CostInputCurrencyResolver | null = null
  try {
    resolver = container.resolve('costInputCurrencyResolver') as CostInputCurrencyResolver
  } catch {
    resolver = null
  }

  const resolution = resolver && typeof resolver.resolve === 'function'
    ? await resolver.resolve({ tenantId: auth.tenantId, organizationId })
    : { status: 'unavailable' as const }

  // Never an empty success: a form that renders "no currency" and lets the user
  // submit anyway would produce a 422 they cannot act on.
  if (resolution.status !== 'resolved') {
    return NextResponse.json(costInputErrorBody('currency_dependency_unavailable', translate), { status: 503 })
  }

  return NextResponse.json({ item: { code: resolution.code } })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Connect Analytics',
  summary: 'Resolved base currency for cost inputs',
  methods: {
    GET: {
      summary: 'Returns the single currency code cost inputs must use in the active organization.',
      description:
        'Server-derived dual scope; takes no query parameters. Guarded by connect_analytics.cost_inputs.manage and never grants or requires currencies.view.',
      responses: [
        { status: 200, description: 'The resolved base currency code.', schema: responseSchema },
        { status: 400, description: 'No organization is selected.', schema: errorSchema },
        { status: 401, description: 'Unauthenticated.', schema: errorSchema },
        { status: 403, description: 'Missing connect_analytics.cost_inputs.manage.', schema: errorSchema },
        {
          status: 503,
          description: 'The base currency is missing, ambiguous, or its source is unavailable.',
          schema: errorSchema,
        },
      ],
    },
  },
}
