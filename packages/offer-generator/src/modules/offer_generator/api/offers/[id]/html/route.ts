import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readOptimisticLockExpected } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  OFFER_COMMAND_IDS,
  OFFER_RESOURCE_KIND,
  type OfferHtmlCommandInput,
  type OfferHtmlCommandResult,
} from '../../../../commands/offers'
import { Offer } from '../../../../data/entities'
import { offerHtmlUpdateSchema } from '../../../../data/validators'
import {
  authenticateRequest,
  buildCommandContext,
  handleRouteError,
  noStoreJson,
  notFoundResponse,
  resolveRequestScope,
  unauthorizedResponse,
  validationErrorResponse,
} from '../../../../lib/http'
import { serializeOfferHtml } from '../../../../lib/serializers'
import {
  errorBodySchema,
  offerHtmlDtoSchema,
  offerHtmlWriteResultSchema,
  optimisticLockConflictSchema,
} from '../../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
  PUT: { requireAuth: true, requireFeatures: ['offer_generator.manage'] },
}

const logger = createLogger('offer_generator').child({ component: 'offer-html' })

const paramsSchema = z.object({ id: z.string().uuid() })

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(req: Request, routeCtx: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const notFound = () => notFoundResponse(translate('offer_generator.errors.notFound', 'Offer not found'))
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const offer = await findOneWithDecryption(
      scope.em,
      Offer,
      { id: params.data.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      { fields: ['id', 'html', 'updatedAt'] },
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
    if (!offer) return notFound()

    return noStoreJson(serializeOfferHtml(offer))
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Offer HTML read failed',
      code: 'offer_generator.html_read_failed',
    })
  }
}

export async function PUT(req: Request, routeCtx: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFoundResponse(translate('offer_generator.errors.notFound', 'Offer not found'))
    const body = offerHtmlUpdateSchema.safeParse(await readJsonSafe(req, null))
    if (!body.success) return validationErrorResponse(translate, body.error.issues)

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const guarded = await runRouteMutationGuards({
      container: scope.container,
      req,
      auth: { userId: scope.userId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      input: {
        resourceKind: OFFER_RESOURCE_KIND,
        resourceId: params.data.id,
        operation: 'update',
        mutationPayload: { html: body.data.html },
      },
    })
    if (!guarded.ok) return guarded.response

    const guardedHtml = guarded.modifiedPayload?.html
    const input: OfferHtmlCommandInput = {
      id: params.data.id,
      html: typeof guardedHtml === 'string' ? guardedHtml : body.data.html,
      source: 'manual_edit',
      expectedUpdatedAt: readOptimisticLockExpected(req),
    }
    const commandBus = scope.container.resolve<CommandBus>('commandBus')
    const { result } = await commandBus.execute<OfferHtmlCommandInput, OfferHtmlCommandResult>(
      OFFER_COMMAND_IDS.updateHtml,
      { input, ctx: buildCommandContext(scope, req) },
    )
    await guarded.runAfterSuccess()

    return noStoreJson(result)
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Offer HTML update failed',
      code: 'offer_generator.html_update_failed',
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Offer HTML content',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Get the offer HTML',
      description: 'Returns the stored (sanitized) offer HTML and the offer `updatedAt` used as the optimistic-lock token.',
      responses: [{ status: 200, description: 'Offer HTML', schema: offerHtmlDtoSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer not found', schema: errorBodySchema },
      ],
    },
    PUT: {
      summary: 'Replace the offer HTML (manual edit)',
      description:
        'Sanitizes and validates the HTML, keeps the previous HTML as a `manual_edit` revision and stores the new content. Send the optimistic-lock header with the offer `updatedAt`.',
      requestBody: { contentType: 'application/json', schema: offerHtmlUpdateSchema },
      responses: [{ status: 200, description: 'HTML stored', schema: offerHtmlWriteResultSchema }],
      errors: [
        { status: 400, description: 'Invalid body or incomplete HTML', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer not found', schema: errorBodySchema },
        { status: 409, description: 'Optimistic lock conflict', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
