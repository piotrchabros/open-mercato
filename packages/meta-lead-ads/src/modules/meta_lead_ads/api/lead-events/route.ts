import type { FilterQuery } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findAndCountWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaForm, MetaLeadEvent, MetaPage } from '../../data/entities'
import { leadEventsQuerySchema, type LeadEventsQuery } from '../../data/validators'
import { serializeLeadEventSummary } from '../../lib/serializers'
import type { MetaScope } from '../../lib/constants'
import { handleRouteError, jsonResponse, paged, parseQuery, resolveRouteContext } from '../../lib/http'
import { errorBodySchema, leadEventSummarySchema, pagedResponseSchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
}

function buildDateRange(query: LeadEventsQuery): { $gte?: Date; $lte?: Date } | null {
  if (!query.from && !query.to) return null
  return {
    ...(query.from ? { $gte: new Date(query.from) } : {}),
    ...(query.to ? { $lte: new Date(query.to) } : {}),
  }
}

function buildWhere(query: LeadEventsQuery, scope: MetaScope): FilterQuery<MetaLeadEvent> {
  const range = buildDateRange(query)
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    ...(query.status ? { status: { $in: query.status } } : {}),
    ...(query.pageId ? { pageId: query.pageId } : {}),
    ...(query.formId ? { formId: query.formId } : {}),
    ...(query.personId ? { personId: query.personId } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(range ? { $or: [{ submittedAt: range }, { submittedAt: null, createdAt: range }] } : {}),
  }
}

async function loadLeadEventNames(
  em: EntityManager,
  events: MetaLeadEvent[],
  scope: MetaScope,
): Promise<{ pageNames: Map<string, string>; formNames: Map<string, string> }> {
  const pageIds = [...new Set(events.map((event) => event.pageId).filter((id): id is string => !!id))]
  const formIds = [...new Set(events.map((event) => event.formId).filter((id): id is string => !!id))]
  const scopeWhere = { tenantId: scope.tenantId, organizationId: scope.organizationId }
  const [pages, forms] = await Promise.all([
    pageIds.length > 0
      ? findWithDecryption(em, MetaPage, { ...scopeWhere, id: { $in: pageIds } }, { fields: ['id', 'name'] }, scope)
      : Promise.resolve([]),
    formIds.length > 0
      ? findWithDecryption(em, MetaForm, { ...scopeWhere, id: { $in: formIds } }, { fields: ['id', 'name'] }, scope)
      : Promise.resolve([]),
  ])
  return {
    pageNames: new Map(pages.map((page) => [page.id, page.name])),
    formNames: new Map(forms.map((form) => [form.id, form.name])),
  }
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const query = parseQuery(req, leadEventsQuerySchema)
    const scope: MetaScope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const [events, total] = await findAndCountWithDecryption(
      ctx.em,
      MetaLeadEvent,
      buildWhere(query, scope),
      {
        exclude: ['rawNotification', 'rawPayload'],
        orderBy: { createdAt: query.sortDir, id: query.sortDir },
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      },
      scope,
    )
    const { pageNames, formNames } = await loadLeadEventNames(ctx.em, events, scope)
    const items = events.map((event) =>
      serializeLeadEventSummary(event, {
        pageName: event.pageId ? pageNames.get(event.pageId) ?? null : null,
        formName: event.formId ? formNames.get(event.formId) ?? null : null,
      }),
    )
    return jsonResponse(paged(items, total, query.page, query.pageSize))
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta lead events',
  methods: {
    GET: {
      summary: 'List received Meta lead events for the active organization',
      query: leadEventsQuerySchema,
      responses: [
        { status: 200, description: 'Paged lead events', schema: pagedResponseSchema(leadEventSummarySchema) },
      ],
      errors: [
        { status: 400, description: 'Invalid query or missing organization scope', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 403, description: 'Missing meta_lead_ads.view_logs', schema: errorBodySchema },
      ],
    },
  },
}
