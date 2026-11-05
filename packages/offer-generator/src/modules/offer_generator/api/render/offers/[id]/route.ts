import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { Offer } from '../../../../data/entities'
import { sanitizeOfferHtml } from '../../../../lib/html-sanitize'
import { authenticateRequest, reportRouteError, resolveRequestScope } from '../../../../lib/http'
import { htmlDocumentResponseSchema } from '../../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

const logger = createLogger('offer_generator').child({ component: 'render' })

const paramsSchema = z.object({ id: z.string().uuid() })

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: HTML_HEADERS })
}

function messagePage(status: number, message: string): Response {
  const safe = escapeHtml(message)
  return htmlResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${safe}</title></head><body><p>${safe}</p></body></html>`,
    status,
  )
}

export async function GET(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { translate } = await resolveTranslations()
  const notFound = () => messagePage(404, translate('offer_generator.render.noContent', 'This offer has no content yet.'))
  try {
    const auth = await authenticateRequest(req)
    if (!auth) {
      return messagePage(401, translate('offer_generator.errors.unauthorized', 'Unauthorized'))
    }
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()

    const scope = await resolveRequestScope(req, auth)
    if (!scope) {
      return messagePage(
        400,
        translate('offer_generator.errors.organizationRequired', 'Organization context is required'),
      )
    }

    const offer = await findOneWithDecryption(
      scope.em,
      Offer,
      { id: params.data.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      { fields: ['id', 'html'] },
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    if (!offer?.html) return notFound()

    return htmlResponse(sanitizeOfferHtml(offer.html), 200)
  } catch (error) {
    if (isCrudHttpError(error) && error.status === 403) {
      return messagePage(403, translate('offer_generator.errors.forbidden', 'Forbidden'))
    }
    reportRouteError(error, { logger, message: 'Offer preview render failed', code: 'offer_generator.render_failed' })
    return messagePage(500, translate('offer_generator.errors.internal', 'Something went wrong.'))
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Offer preview document',
  description:
    'Serves the sanitized offer HTML for the backend preview and inline editor iframe. Any offer status is rendered, drafts included.',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Render an offer for authenticated preview',
      description:
        'Returns the sanitized offer HTML as text/html with private no-store caching and noindex. Offers without HTML answer a plain 404 page.',
      responses: [{ status: 200, description: 'Offer HTML document', schema: htmlDocumentResponseSchema, mediaType: 'text/html' }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: z.string(), mediaType: 'text/html' },
        { status: 401, description: 'Unauthorized', schema: z.string(), mediaType: 'text/html' },
        { status: 404, description: 'Offer not found or without HTML', schema: z.string(), mediaType: 'text/html' },
      ],
    },
  },
}
