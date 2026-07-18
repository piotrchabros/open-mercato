import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveManufacturingActionContext } from '../../../actionRouteContext.js'
import { mrpSuggestionsBulkActionSchema } from '../../../../data/validators.js'
import type { AcceptSuggestionsResult } from '../../../../commands/mrp.js'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.mrp.manage'],
}

/**
 * Bulk accept (task 5.2). `make` suggestions create a draft manufacturing
 * order; `buy` suggestions emit the purchasing-seam event (notification via
 * `subscribers/mrp-suggestion-accepted-notification.ts`); `reschedule`/
 * `cancel` are marked accepted without auto-modifying existing orders
 * (documented MVP limitation, see `commands/mrp.ts`).
 */
export async function POST(req: NextRequest) {
  const { translate } = await resolveTranslations()
  try {
    const { ctx } = await resolveManufacturingActionContext(req)
    const body = await req.json()
    const input = mrpSuggestionsBulkActionSchema.parse(body)

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<typeof input, AcceptSuggestionsResult>(
      'manufacturing.mrp.acceptSuggestions',
      { input, ctx },
    )

    return NextResponse.json(result)
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json(err.body, { status: err.status })
    }
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
    }
    return NextResponse.json(
      { error: translate('manufacturing.errors.mrp_accept_failed', 'Failed to accept MRP suggestions.') },
      { status: 400 },
    )
  }
}

const acceptResponseSchema = z.object({
  acceptedIds: z.array(z.string().uuid()),
  createdOrderIds: z.array(z.string().uuid()),
  skippedIds: z.array(z.string().uuid()),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Manufacturing',
  summary: 'Accept MRP suggestions',
  methods: {
    POST: {
      operationId: 'acceptMrpSuggestions',
      summary: 'Bulk accept MRP suggestions',
      description: 'Accepts open suggestions: `make` creates a draft manufacturing order, `buy`/`reschedule`/`cancel` emit the purchasing-seam event.',
      requestBody: { schema: mrpSuggestionsBulkActionSchema },
      responses: [{ status: 200, description: 'Accept result', schema: acceptResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid request', schema: z.object({ error: z.string() }) },
        { status: 401, description: 'Unauthorized', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
