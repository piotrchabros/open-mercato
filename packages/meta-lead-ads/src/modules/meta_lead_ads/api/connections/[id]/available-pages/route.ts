import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaConnection, MetaPage } from '../../../../data/entities'
import { getMetaGraphClient, MetaGraphError, type GraphPageAccount, type MetaGraphClient } from '../../../../lib/graph-client'
import { errorResponse, handleRouteError, jsonResponse, resolveRouteContext, tryResolve } from '../../../../lib/http'
import { applyConnectionStatus, describeGraphError } from '../../../../lib/page-service'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../../../../lib/preset'
import { availablePageDtoSchema, errorBodySchema, type AvailablePageDto } from '../../../openapi'

const idSchema = z.string().uuid()

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

export async function GET(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const { id } = await routeCtx.params
    const parsedId = idSchema.safeParse(id)
    if (!parsedId.success) {
      return errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    }

    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const connection = await findOneWithDecryption(
      ctx.em,
      MetaConnection,
      { id: parsedId.data, tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (!connection) {
      return errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    }
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

    const graph = tryResolve<MetaGraphClient>(ctx.container, 'metaGraphClient') ?? getMetaGraphClient()
    const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(ctx.container, scope))
    let accounts: GraphPageAccount[]
    try {
      accounts = await graph.listUserPages(connection.userAccessToken, graphOptions)
    } catch (err) {
      if (err instanceof MetaGraphError && err.classification.connectionStatus) {
        await applyConnectionStatus(
          { resolve: <T = unknown>(name: string) => ctx.container.resolve<T>(name), em: ctx.em },
          connection,
          {
            status: err.classification.connectionStatus,
            lastError: describeGraphError(err.classification),
            reason: err.classification.tokenReason ?? null,
          },
        )
      }
      throw err
    }

    const metaPageIds = accounts.map((account) => account.id)
    const assignments = metaPageIds.length
      ? await ctx.em.find(
          MetaPage,
          { metaPageId: { $in: metaPageIds }, deletedAt: null },
          { fields: ['id', 'metaPageId', 'tenantId', 'organizationId', 'connectionId'] },
        )
      : []
    const assignmentByMetaPageId = new Map(assignments.map((assignment) => [assignment.metaPageId, assignment]))
    const isVisible = (assignment: Pick<MetaPage, 'tenantId' | 'organizationId'>) =>
      assignment.tenantId === ctx.tenantId &&
      (ctx.allowedOrganizationIds === null || ctx.allowedOrganizationIds.includes(assignment.organizationId))

    const items: AvailablePageDto[] = accounts.map((account) => {
      const assignment = assignmentByMetaPageId.get(account.id)
      if (!assignment) {
        return {
          metaPageId: account.id,
          name: account.name,
          assignedOrganizationId: null,
          assignedConnectionId: null,
          assignable: true,
        }
      }
      if (!isVisible(assignment)) {
        return {
          metaPageId: account.id,
          name: account.name,
          assignedOrganizationId: null,
          assignedConnectionId: null,
          assignable: false,
          assignedElsewhere: true,
        }
      }
      return {
        metaPageId: account.id,
        name: account.name,
        assignedOrganizationId: assignment.organizationId,
        assignedConnectionId: assignment.connectionId,
        assignable: false,
      }
    })

    return jsonResponse({ items })
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Pages available on a Meta connection',
  pathParams: z.object({ id: z.string().uuid() }),
  methods: {
    GET: {
      summary: 'List pages the connected Meta user can administer',
      description:
        'Calls Graph /me/accounts with the connection user token (not cached). Pages assigned in organizations the caller cannot see are reported as not assignable without revealing the organization.',
      responses: [
        { status: 200, description: 'Available pages', schema: z.object({ items: z.array(availablePageDtoSchema) }) },
      ],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Connection not found', schema: errorBodySchema },
        { status: 409, description: 'Connection is not usable', schema: errorBodySchema },
        { status: 502, description: 'Meta Graph API error', schema: errorBodySchema },
      ],
    },
  },
}
