import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  isPdfRenderOverloadedError,
  isPdfRenderOutputTooLargeError,
  isPdfRenderTimeoutError,
} from '@open-mercato/documents/modules/documents/lib/pdfRenderer'
import { Offer } from '../../../../data/entities'
import {
  authenticateRequest,
  errorResponse,
  handleRouteError,
  notFoundResponse,
  resolveRequestScope,
  unauthorizedResponse,
} from '../../../../lib/http'
import { buildOfferPdfFilename, renderOfferPdf, resolveOfferPdfChromiumPath } from '../../../../lib/pdf'
import { pdfFileResponseSchema } from '../../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
}

const logger = createLogger('offer_generator').child({ component: 'pdf' })

const paramsSchema = z.object({ id: z.string().uuid() })

const errorBodySchema = z.object({ error: z.string(), code: z.string().optional() })

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export async function GET(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const notFound = () => notFoundResponse(translate('offer_generator.errors.notFound', 'Not found'))
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
    const offer = await findOneWithDecryption(
      scope.em,
      Offer,
      { id: params.data.id, ...tenantScope, deletedAt: null },
      { fields: ['id', 'slug', 'html'] },
      tenantScope,
    )
    if (!offer || !offer.html) return notFound()

    const executablePath = resolveOfferPdfChromiumPath()
    if (!executablePath) {
      return errorResponse(503, translate('offer_generator.pdf.runtimeUnavailable', 'PDF export is unavailable.'), 'pdf_runtime_unavailable')
    }

    let pdf: Uint8Array
    try {
      pdf = await renderOfferPdf(offer.html, executablePath)
    } catch (error) {
      if (isPdfRenderOverloadedError(error)) {
        return errorResponse(503, translate('offer_generator.pdf.overloaded', 'PDF export is busy. Try again shortly.'), 'pdf_overloaded')
      }
      if (isPdfRenderTimeoutError(error)) {
        return errorResponse(503, translate('offer_generator.pdf.renderTimeout', 'PDF export timed out.'), 'pdf_render_timeout')
      }
      if (isPdfRenderOutputTooLargeError(error)) {
        return errorResponse(413, translate('offer_generator.pdf.outputTooLarge', 'The generated PDF is too large.'), 'pdf_output_too_large')
      }
      const errorName = error instanceof Error ? error.name : 'unknown'
      logger.error('Offer PDF render failed', { errorName })
      return errorResponse(503, translate('offer_generator.pdf.runtimeUnavailable', 'PDF export is unavailable.'), 'pdf_runtime_unavailable')
    }

    return new Response(toArrayBuffer(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${buildOfferPdfFilename({ slug: offer.slug })}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Offer PDF request failed',
      code: 'offer_generator.pdf_failed',
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Offer PDF export',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Download an offer as PDF',
      description: 'Renders the stored offer HTML to a paginated A4 PDF with the shared Chromium renderer and returns it as an attachment.',
      responses: [{ status: 200, description: 'Offer PDF', schema: pdfFileResponseSchema, mediaType: 'application/pdf' }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer not found or has no HTML', schema: errorBodySchema },
        { status: 413, description: 'Generated PDF exceeds the safe size bound', schema: errorBodySchema },
        { status: 503, description: 'PDF runtime is unavailable, overloaded, or timed out', schema: errorBodySchema },
      ],
    },
  },
}
