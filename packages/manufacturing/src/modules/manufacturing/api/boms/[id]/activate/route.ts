import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveManufacturingActionContext } from '../../../actionRouteContext.js'
import { defaultOkResponseSchema } from '../../../openapi.js'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.technology.manage'],
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> | { id: string } }) {
  const { translate } = await resolveTranslations()
  try {
    const { ctx } = await resolveManufacturingActionContext(req)

    const resolvedParams = await params
    const id = resolvedParams?.id
    if (!id) {
      return NextResponse.json({ error: translate('manufacturing.errors.id_required', 'Record id is required') }, { status: 400 })
    }

    const commandBus = ctx.container.resolve('commandBus') as CommandBus
    await commandBus.execute('manufacturing.boms.activate', { input: { id }, ctx })

    return NextResponse.json({ ok: true })
  } catch (err) {
    if (isCrudHttpError(err)) {
      return NextResponse.json(err.body, { status: err.status })
    }
    return NextResponse.json(
      { error: translate('manufacturing.errors.bom_activate_failed', 'Failed to activate BOM version.') },
      { status: 400 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Manufacturing',
  summary: 'Activate a BOM version',
  methods: {
    POST: {
      operationId: 'activateManufacturingBom',
      summary: 'Activate a BOM version',
      description:
        'Promotes a draft BOM version to active after validating there is no circular bill-of-materials reference. Archives any other currently active version for the same product/variant scope.',
      responses: [
        { status: 200, description: 'BOM version activated', schema: defaultOkResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Invalid request', schema: z.object({ error: z.string() }) },
        { status: 401, description: 'Unauthorized', schema: z.object({ error: z.string() }) },
        { status: 404, description: 'BOM not found', schema: z.object({ error: z.string() }) },
        {
          status: 422,
          description: 'Activation would create a circular bill of materials',
          schema: z.object({ error: z.string(), cycle: z.array(z.string()) }),
        },
      ],
    },
  },
}
