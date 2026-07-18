import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveManufacturingActionContext } from '../../actionRouteContext.js'
import { stockBatchesListQuerySchema } from '../../../data/validators.js'
import type { ManufacturingStockProvider } from '../../../lib/stockProvider.js'
import { defaultOkResponseSchema } from '../../openapi.js'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['manufacturing.stock.view'] },
}

/** Batches for a product, via the `manufacturingStockProvider` DI seam (task 2.2). */
export async function GET(req: NextRequest) {
  const { translate } = await resolveTranslations()
  try {
    const { ctx } = await resolveManufacturingActionContext(req)
    const query = stockBatchesListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()))

    const tenantId = ctx.auth?.tenantId
    const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId
    if (!tenantId || !organizationId) {
      return NextResponse.json({ error: translate('manufacturing.errors.organization_required', 'Organization context is required') }, { status: 400 })
    }

    const provider = ctx.container.resolve<ManufacturingStockProvider>('manufacturingStockProvider')
    const batches = await provider.findBatches({ tenantId, organizationId }, query.productId)

    return NextResponse.json({
      items: batches.map((batch) => ({
        id: batch.id,
        batchNumber: batch.batchNumber,
        onHand: batch.onHand,
        expiresAt: batch.expiresAt ? batch.expiresAt.toISOString() : null,
      })),
    })
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json(err.body, { status: err.status })
    }
    return NextResponse.json(
      { error: translate('manufacturing.errors.stock_batches_failed', 'Failed to load stock batches.') },
      { status: 400 },
    )
  }
}

const batchSchema = z.object({
  id: z.string().uuid(),
  batchNumber: z.string(),
  onHand: z.number(),
  expiresAt: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Manufacturing',
  summary: 'List batches for a manufacturing stock item',
  methods: {
    GET: {
      operationId: 'listManufacturingStockBatches',
      summary: 'List batches for a product',
      responses: [{ status: 200, description: 'Batches', schema: z.object({ items: z.array(batchSchema) }) }],
      errors: [
        { status: 400, description: 'Invalid request', schema: z.object({ error: z.string() }) },
        { status: 401, description: 'Unauthorized', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}

export { defaultOkResponseSchema }
