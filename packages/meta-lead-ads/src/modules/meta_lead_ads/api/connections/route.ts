import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaConnection, MetaPage } from '../../data/entities'
import { handleRouteError, jsonResponse, resolveRouteContext } from '../../lib/http'
import { serializeConnection } from '../../lib/serializers'
import { connectionDtoSchema, errorBodySchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const connections = await findWithDecryption(
      ctx.em,
      MetaConnection,
      { tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      { orderBy: { createdAt: 'asc' } },
      scope,
    )
    const connectionIds = connections.map((connection) => connection.id)
    const pages = connectionIds.length
      ? await ctx.em.find(
          MetaPage,
          {
            tenantId: ctx.tenantId,
            organizationId: ctx.organizationId,
            connectionId: { $in: connectionIds },
            deletedAt: null,
          },
          { fields: ['id', 'connectionId'] },
        )
      : []
    const pageCounts = new Map<string, number>()
    for (const page of pages) {
      pageCounts.set(page.connectionId, (pageCounts.get(page.connectionId) ?? 0) + 1)
    }
    return jsonResponse({
      items: connections.map((connection) => serializeConnection(connection, pageCounts.get(connection.id) ?? 0)),
    })
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta connections',
  methods: {
    GET: {
      summary: 'List Meta connections of the active organization',
      description: 'Returns the connected Meta accounts with their status and page count. Tokens are never returned.',
      responses: [
        { status: 200, description: 'Connections', schema: z.object({ items: z.array(connectionDtoSchema) }) },
      ],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
      ],
    },
  },
}
