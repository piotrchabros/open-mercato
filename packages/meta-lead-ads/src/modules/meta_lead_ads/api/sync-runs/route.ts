import type { FilterQuery } from '@mikro-orm/core'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findAndCountWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaForm, MetaSyncRun } from '../../data/entities'
import { syncRunsQuerySchema } from '../../data/validators'
import { handleRouteError, jsonResponse, paged, parseQuery, resolveRouteContext } from '../../lib/http'
import { serializeSyncRun } from '../../lib/serializers'
import { errorBodySchema, pagedResponseSchema, syncRunDtoSchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const query = parseQuery(req, syncRunsQuerySchema)
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const where: FilterQuery<MetaSyncRun> = { ...scope }
    if (query.kind) where.kind = query.kind
    if (query.status) where.status = query.status
    if (query.formId) where.formId = query.formId
    const [runs, total] = await findAndCountWithDecryption(
      ctx.em,
      MetaSyncRun,
      where,
      {
        orderBy: { createdAt: 'desc' },
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      },
      scope,
    )
    const formIds = Array.from(
      new Set(runs.map((run) => run.formId).filter((formId): formId is string => Boolean(formId))),
    )
    const forms =
      formIds.length > 0
        ? await findWithDecryption(ctx.em, MetaForm, { id: { $in: formIds }, ...scope }, undefined, scope)
        : []
    const formNames = new Map(forms.map((form) => [form.id, form.name]))
    const items = runs.map((run) => serializeSyncRun(run, run.formId ? (formNames.get(run.formId) ?? null) : null))
    return jsonResponse(paged(items, total, query.page, query.pageSize))
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'List Meta lead sync runs',
  methods: {
    GET: {
      summary: 'List backfill and reconciliation runs',
      description: 'Returns a paginated list of sync runs for the active organization, newest first.',
      tags: ['Meta Lead Ads'],
      query: syncRunsQuerySchema,
      responses: [
        { status: 200, description: 'Sync runs', schema: pagedResponseSchema(syncRunDtoSchema) },
      ],
      errors: [{ status: 400, description: 'Validation failed', schema: errorBodySchema }],
    },
  },
}
