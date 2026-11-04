import { UniqueConstraintViolationException, type FilterQuery } from '@mikro-orm/core'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findAndCountWithDecryption, findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ActionLogService } from '@open-mercato/core/modules/audit_logs/services/actionLogService'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { MetaConnection, MetaForm, MetaPage } from '../../data/entities'
import { pageAssignSchema, pagesQuerySchema } from '../../data/validators'
import { PAGE_SUBSCRIPTION_STATUSES } from '../../lib/constants'
import { getMetaGraphClient, MetaGraphError, type GraphPageAccount, type MetaGraphClient } from '../../lib/graph-client'
import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  paged,
  parseJsonBody,
  parseQuery,
  resolveRouteContext,
  runGuards,
  tryResolve,
  type RouteContext,
} from '../../lib/http'
import {
  applyConnectionStatus,
  applyPageStatus,
  describeGraphError,
  syncPageForms,
  verifyPageSubscription,
  type PageServiceContext,
} from '../../lib/page-service'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../lib/preset'
import { serializePage } from '../../lib/serializers'
import { errorBodySchema, pageDtoSchema, pagedResponseSchema } from '../openapi'

const RESOURCE_KIND = 'meta_lead_ads.meta_page'

const logger = createLogger('meta_lead_ads').child({ component: 'pages' })

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
  POST: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

function pageServiceContext(ctx: RouteContext): PageServiceContext {
  return { resolve: <T = unknown>(name: string) => ctx.container.resolve<T>(name), em: ctx.em }
}

async function countFormsByPage(ctx: RouteContext, pageIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (pageIds.length === 0) return counts
  const forms = await ctx.em.find(
    MetaForm,
    {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      pageId: { $in: pageIds },
      deletedAt: null,
    },
    { fields: ['id', 'pageId'] },
  )
  for (const form of forms) {
    counts.set(form.pageId, (counts.get(form.pageId) ?? 0) + 1)
  }
  return counts
}

function graphErrorCodes(err: unknown): Record<string, unknown> {
  return {
    status: err instanceof MetaGraphError ? err.status : null,
    graphCode: err instanceof MetaGraphError ? err.code : null,
    graphSubcode: err instanceof MetaGraphError ? err.subcode : null,
    errorClass: err instanceof MetaGraphError ? err.classification.errorClass : 'unknown',
  }
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const query = parseQuery(req, pagesQuerySchema)
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const where: FilterQuery<MetaPage> = { ...scope, deletedAt: null }
    if (query.connectionId) where.connectionId = query.connectionId
    if (query.subscriptionStatus) {
      const subscriptionStatus = PAGE_SUBSCRIPTION_STATUSES.find((status) => status === query.subscriptionStatus)
      if (!subscriptionStatus) return jsonResponse(paged([], 0, query.page, query.pageSize))
      where.subscriptionStatus = subscriptionStatus
    }
    const search = query.search?.trim()
    if (search) {
      const pattern = `%${escapeLikePattern(search)}%`
      where.$or = [{ name: { $ilike: pattern } }, { metaPageId: { $ilike: pattern } }]
    }
    const [pages, total] = await findAndCountWithDecryption(
      ctx.em,
      MetaPage,
      where,
      {
        orderBy: { name: 'asc', id: 'asc' },
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      },
      scope,
    )
    const formCounts = await countFormsByPage(
      ctx,
      pages.map((page) => page.id),
    )
    const items = pages.map((page) => serializePage(page, formCounts.get(page.id) ?? 0))
    return jsonResponse(paged(items, total, query.page, query.pageSize))
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

async function isOrganizationAssignable(ctx: RouteContext, organizationId: string): Promise<boolean> {
  if (ctx.allowedOrganizationIds !== null && !ctx.allowedOrganizationIds.includes(organizationId)) return false
  const organization = await ctx.em.findOne(
    Organization,
    { id: organizationId, tenant: ctx.tenantId, deletedAt: null },
    { fields: ['id'] },
  )
  return organization !== null
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const input = await parseJsonBody(req, pageAssignSchema)
    const notFound = () =>
      errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    const alreadyAssigned = () =>
      errorResponse(
        409,
        'page_already_assigned',
        ctx.translate('meta_lead_ads.errors.page_already_assigned', 'This page is already assigned to an organization.'),
      )

    if (!(await isOrganizationAssignable(ctx, input.organizationId))) {
      return errorResponse(
        403,
        'organization_not_visible',
        ctx.translate(
          'meta_lead_ads.errors.organization_not_visible',
          'You cannot assign pages to this organization.',
        ),
      )
    }

    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const connection = await findOneWithDecryption(
      ctx.em,
      MetaConnection,
      { id: input.connectionId, tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (!connection) return notFound()

    const existing = await ctx.em.findOne(
      MetaPage,
      { metaPageId: input.metaPageId, deletedAt: null },
      { fields: ['id'] },
    )
    if (existing) return alreadyAssigned()

    if (connection.status !== 'active' || !connection.userAccessToken) {
      return errorResponse(
        409,
        'connection_unusable',
        ctx.translate(
          'meta_lead_ads.errors.connection_unusable',
          'This Meta connection cannot be used. Reconnect the account.',
        ),
      )
    }

    const guard = await runGuards(ctx, req, {
      resourceKind: RESOURCE_KIND,
      operation: 'create',
      mutationPayload: input,
    })
    if (!guard.ok) return guard.response

    const serviceCtx = pageServiceContext(ctx)
    const graph = tryResolve<MetaGraphClient>(ctx.container, 'metaGraphClient') ?? getMetaGraphClient()
    const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(ctx.container, scope))

    let accounts: GraphPageAccount[]
    try {
      accounts = await graph.listUserPages(connection.userAccessToken, graphOptions)
    } catch (err) {
      if (err instanceof MetaGraphError && err.classification.connectionStatus) {
        await applyConnectionStatus(serviceCtx, connection, {
          status: err.classification.connectionStatus,
          lastError: describeGraphError(err.classification),
          reason: err.classification.tokenReason ?? null,
        })
      }
      throw err
    }
    const account = accounts.find((candidate) => candidate.id === input.metaPageId)
    if (!account) return notFound()

    const pageToken = account.accessToken?.trim() || null
    if (pageToken) {
      try {
        await graph.subscribePage(account.id, pageToken, graphOptions)
      } catch (err) {
        if (!(err instanceof MetaGraphError) || !err.classification.pageStatus) throw err
        logger.warn('Page subscribe failed during assignment', graphErrorCodes(err))
      }
    }
    const verified = await verifyPageSubscription(
      graph,
      { metaPageId: account.id, pageAccessToken: pageToken },
      graphOptions,
    )

    const page = ctx.em.create(MetaPage, {
      tenantId: connection.tenantId,
      organizationId: input.organizationId,
      connectionId: connection.id,
      metaPageId: account.id,
      name: account.name,
      pageAccessToken: pageToken,
      subscriptionStatus: 'unsubscribed',
    })
    ctx.em.persist(page)
    try {
      await ctx.em.flush()
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) return alreadyAssigned()
      throw err
    }
    await applyPageStatus(serviceCtx, page, verified)

    let formCount = 0
    if (page.subscriptionStatus === 'active') {
      try {
        const synced = await syncPageForms({ em: ctx.em, graph, graphOptions }, page)
        formCount = synced.total
      } catch (err) {
        logger.warn('Initial form sync failed after page assignment', { pageId: page.id, ...graphErrorCodes(err) })
      }
    }

    const actionLogService = tryResolve<ActionLogService>(ctx.container, 'actionLogService')
    if (actionLogService) {
      try {
        await actionLogService.log({
          tenantId: page.tenantId,
          organizationId: page.organizationId,
          actorUserId: ctx.userId,
          commandId: 'meta_lead_ads.page.assign',
          actionLabel: ctx.translate('meta_lead_ads.pages.audit.assign', 'Assign Facebook page'),
          resourceKind: RESOURCE_KIND,
          resourceId: page.id,
          context: { connectionId: connection.id, subscriptionStatus: page.subscriptionStatus },
        })
      } catch (err) {
        logger.warn('Audit log write failed for page assignment', {
          errorName: err instanceof Error ? err.name : 'unknown',
        })
      }
    }

    await guard.runAfterSuccess()
    return jsonResponse(serializePage(page, formCount), 201)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta pages',
  methods: {
    GET: {
      summary: 'List assigned Facebook pages',
      description:
        'Returns a paginated list of the pages assigned to the active organization with their subscription status and form count. Tokens are never returned.',
      query: pagesQuerySchema,
      responses: [{ status: 200, description: 'Pages', schema: pagedResponseSchema(pageDtoSchema) }],
      errors: [
        { status: 400, description: 'Validation failed or organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
      ],
    },
    POST: {
      summary: 'Assign a Facebook page to an organization',
      description:
        'Takes the page token from the connection, subscribes the page to leadgen webhooks, verifies the subscription and Leads Access, and stores the page. The returned status reflects the verification, so a page can be created in a non-active status.',
      requestBody: { contentType: 'application/json', schema: pageAssignSchema },
      responses: [{ status: 201, description: 'Page assigned', schema: pageDtoSchema }],
      errors: [
        { status: 400, description: 'Validation failed', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 403, description: 'Target organization is not visible', schema: errorBodySchema },
        { status: 404, description: 'Connection unknown or page not available to it', schema: errorBodySchema },
        {
          status: 409,
          description: 'Page already assigned anywhere in the installation, or connection unusable',
          schema: errorBodySchema,
        },
        { status: 502, description: 'Meta returned an error', schema: errorBodySchema },
      ],
    },
  },
}
