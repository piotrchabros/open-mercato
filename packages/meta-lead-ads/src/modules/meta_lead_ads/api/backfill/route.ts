import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { backfillSchema } from '../../data/validators'
import { startBackfill } from '../../lib/backfill'
import {
  handleRouteError,
  jsonResponse,
  parseJsonBody,
  resolveRouteContext,
  runGuards,
} from '../../lib/http'
import { errorBodySchema } from '../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

const backfillResponseSchema = z.object({
  runId: z.string().uuid(),
  progressJobId: z.string().uuid().nullable(),
})

export async function POST(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const input = await parseJsonBody(req, backfillSchema)
    const guard = await runGuards(ctx, req, {
      resourceKind: 'meta_lead_ads.sync_run',
      operation: 'custom',
      mutationPayload: input,
    })
    if (!guard.ok) return guard.response
    const result = await startBackfill(
      {
        container: ctx.container,
        em: ctx.em,
        scope: { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
        userId: ctx.userId,
      },
      input,
    )
    await guard.runAfterSuccess()
    return jsonResponse(result, 202)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'Start a Meta lead backfill',
  methods: {
    POST: {
      summary: 'Start a backfill of leads for one form over a date range',
      description:
        'Creates a sync run and a progress job, then enqueues the first backfill job. The range is limited to 90 days and cannot end in the future.',
      tags: ['Meta Lead Ads'],
      requestBody: { contentType: 'application/json', schema: backfillSchema },
      responses: [{ status: 202, description: 'Backfill accepted', schema: backfillResponseSchema }],
      errors: [
        { status: 400, description: 'Validation failed', schema: errorBodySchema },
        { status: 404, description: 'Form not found', schema: errorBodySchema },
        {
          status: 409,
          description: 'A backfill is already running for the form, or the page is not active',
          schema: errorBodySchema,
        },
      ],
    },
  },
}
