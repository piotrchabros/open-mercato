import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
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
import { Offer, OfferRevision } from '../../../../data/entities'
import { offerRevisionSourceSchema, revisionRestoreSchema } from '../../../../data/validators'
import { MAX_REVISIONS_PER_OFFER } from '../../../../lib/constants'
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
import { serializeRevision, type RevisionDto } from '../../../../lib/serializers'
import {
  errorBodySchema,
  offerHtmlWriteResultSchema,
  optimisticLockConflictSchema,
  revisionListResponseSchema,
} from '../../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
  POST: { requireAuth: true, requireFeatures: ['offer_generator.manage'] },
}

const logger = createLogger('offer_generator').child({ component: 'offer-revisions' })

const paramsSchema = z.object({ id: z.string().uuid() })

type RouteContext = { params: Promise<{ id: string }> }

type Scope = { tenantId: string; organizationId: string }

const revisionRowSchema = z.object({
  id: z.string(),
  source: offerRevisionSourceSchema,
  feedback: z.string().nullable().optional(),
  generation_run_id: z.string().nullable().optional(),
  created_by_user_id: z.string().nullable().optional(),
  created_at: z.union([z.string(), z.date()]).nullable().optional(),
  size_bytes: z.coerce.number().nullable().optional(),
})

async function listRevisionDtos(em: EntityManager, scope: Scope, offerId: string): Promise<RevisionDto[]> {
  const rows: unknown[] = await em
    .getConnection()
    .execute(
      'select id, source, feedback, generation_run_id, created_by_user_id, created_at, octet_length(html) as size_bytes from offer_generator_offer_revisions where offer_id = ? and tenant_id = ? and organization_id = ? order by created_at desc, id desc limit ?',
      [offerId, scope.tenantId, scope.organizationId, MAX_REVISIONS_PER_OFFER],
    )
  return rows.flatMap((row) => {
    const parsed = revisionRowSchema.safeParse(row)
    if (!parsed.success) return []
    return [
      serializeRevision(
        {
          id: parsed.data.id,
          source: parsed.data.source,
          feedback: parsed.data.feedback ?? null,
          generationRunId: parsed.data.generation_run_id ?? null,
          createdByUserId: parsed.data.created_by_user_id ?? null,
          createdAt: parsed.data.created_at ?? null,
        },
        Number(parsed.data.size_bytes ?? 0),
      ),
    ]
  })
}

export async function GET(req: Request, routeCtx: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const notFoundMessage = translate('offer_generator.errors.notFound', 'Offer not found')
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFoundResponse(notFoundMessage)

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }
    const offer = await findOneWithDecryption(
      scope.em,
      Offer,
      { id: params.data.id, ...tenantScope, deletedAt: null },
      { fields: ['id'] },
      tenantScope,
    )
    if (!offer) return notFoundResponse(notFoundMessage)

    const items = await listRevisionDtos(scope.em, tenantScope, offer.id)
    return noStoreJson({ items })
  } catch (error) {
    return handleRouteError(error, translate, {
      logger,
      message: 'Offer revisions request failed',
      code: 'offer_generator.revisions_list_failed',
    })
  }
}

export async function POST(req: Request, routeCtx: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFoundResponse(translate('offer_generator.errors.notFound', 'Offer not found'))
    const body = revisionRestoreSchema.safeParse(await readJsonSafe(req, null))
    if (!body.success) return validationErrorResponse(translate, body.error.issues)

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()
    const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }

    const revision = await findOneWithDecryption(
      scope.em,
      OfferRevision,
      { id: body.data.revisionId, offerId: params.data.id, ...tenantScope },
      undefined,
      tenantScope,
    )
    if (!revision) {
      return notFoundResponse(translate('offer_generator.errors.revisionNotFound', 'Revision not found'))
    }

    const guarded = await runRouteMutationGuards({
      container: scope.container,
      req,
      auth: { userId: scope.userId, ...tenantScope },
      input: {
        resourceKind: OFFER_RESOURCE_KIND,
        resourceId: params.data.id,
        operation: 'update',
        mutationPayload: { revisionId: revision.id },
      },
    })
    if (!guarded.ok) return guarded.response

    const input: OfferHtmlCommandInput = {
      id: params.data.id,
      html: revision.html,
      source: 'restore',
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
      message: 'Offer revisions request failed',
      code: 'offer_generator.revision_restore_failed',
    })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Offer HTML revisions',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'List offer revisions',
      description: `Returns up to ${MAX_REVISIONS_PER_OFFER} previous HTML versions of the offer, newest first, without the HTML itself.`,
      responses: [{ status: 200, description: 'Revisions', schema: revisionListResponseSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer not found', schema: errorBodySchema },
      ],
    },
    POST: {
      summary: 'Restore an offer revision',
      description:
        'Makes the HTML of the given revision the current offer HTML. The HTML being replaced is kept as a `restore` revision. Send the optimistic-lock header with the offer `updatedAt`.',
      requestBody: { contentType: 'application/json', schema: revisionRestoreSchema },
      responses: [{ status: 200, description: 'Revision restored', schema: offerHtmlWriteResultSchema }],
      errors: [
        { status: 400, description: 'Invalid body or incomplete HTML', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Offer or revision not found', schema: errorBodySchema },
        { status: 409, description: 'Optimistic lock conflict', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
