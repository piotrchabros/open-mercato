import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaConsent, MetaForm, MetaLeadEvent, MetaPage } from '../../../data/entities'
import { serializeLeadEventSummary } from '../../../lib/serializers'
import type { MetaScope } from '../../../lib/constants'
import {
  callerHasFeature,
  errorResponse,
  handleRouteError,
  jsonResponse,
  resolveRouteContext,
} from '../../../lib/http'
import { errorBodySchema, leadEventDetailSchema, type LeadEventDetailDto } from '../../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

const storedFieldDataSchema = z.object({
  field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([]),
})

type LeadAnswerDto = NonNullable<LeadEventDetailDto['answers']>[number]
type LeadConsentDto = NonNullable<LeadEventDetailDto['consents']>[number]

function buildAnswers(event: MetaLeadEvent, form: MetaForm | null): LeadAnswerDto[] {
  const parsed = storedFieldDataSchema.safeParse(event.rawPayload ?? {})
  if (!parsed.success) return []
  const targetByKey = new Map((form?.fieldMapping ?? []).map((entry) => [entry.questionKey, entry.target]))
  return parsed.data.field_data.map((field) => ({
    name: field.name,
    values: field.values,
    target: targetByKey.get(field.name) ?? null,
  }))
}

async function loadConsents(
  em: EntityManager,
  event: MetaLeadEvent,
  scope: MetaScope,
): Promise<LeadConsentDto[]> {
  const consents = await findWithDecryption(
    em,
    MetaConsent,
    { leadEventId: event.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    { orderBy: { consentKey: 'asc' } },
    scope,
  )
  return consents.map((consent) => ({
    consentKey: consent.consentKey,
    consentText: consent.consentText ?? null,
    isChecked: consent.isChecked,
    givenAt: consent.givenAt ? consent.givenAt.toISOString() : null,
  }))
}

export async function GET(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const notFound = () =>
      errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    const params = paramsSchema.safeParse(await routeCtx.params)
    if (!params.success) return notFound()
    const scope: MetaScope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const canManage = await callerHasFeature(ctx, 'meta_lead_ads.manage')
    const event = await findOneWithDecryption(
      ctx.em,
      MetaLeadEvent,
      { id: params.data.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      canManage ? { exclude: ['rawNotification'] } : { exclude: ['rawNotification', 'rawPayload'] },
      scope,
    )
    if (!event) return notFound()

    const scopeWhere = { tenantId: scope.tenantId, organizationId: scope.organizationId }
    const [page, form] = await Promise.all([
      event.pageId
        ? findOneWithDecryption(ctx.em, MetaPage, { ...scopeWhere, id: event.pageId }, { fields: ['id', 'name'] }, scope)
        : Promise.resolve(null),
      event.formId
        ? findOneWithDecryption(
            ctx.em,
            MetaForm,
            { ...scopeWhere, id: event.formId },
            { fields: ['id', 'name', 'fieldMapping'] },
            scope,
          )
        : Promise.resolve(null),
    ])

    const payloadPurged = !!event.payloadPurgedAt
    const body: LeadEventDetailDto = {
      ...serializeLeadEventSummary(event, { pageName: page?.name ?? null, formName: form?.name ?? null }),
      adId: event.adId ?? null,
      adsetId: event.adsetId ?? null,
      campaignId: event.campaignId ?? null,
      adName: event.adName ?? null,
      adsetName: event.adsetName ?? null,
      metaFormId: event.metaFormId ?? null,
      metaPageId: event.metaPageId ?? null,
      ...(payloadPurged ? { payloadPurged: true } : {}),
      attempts:
        event.lastErrorCode || event.lastError
          ? [{ at: event.updatedAt.toISOString(), errorCode: event.lastErrorCode ?? null, error: event.lastError ?? null }]
          : [],
    }
    if (canManage) {
      body.answers = payloadPurged ? null : buildAnswers(event, form)
      body.consents = await loadConsents(ctx.em, event, scope)
    }
    return jsonResponse(body)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta lead event detail',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Get one Meta lead event; answers and consents only for meta_lead_ads.manage',
      responses: [{ status: 200, description: 'Lead event detail', schema: leadEventDetailSchema }],
      errors: [
        { status: 400, description: 'Missing organization scope', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 403, description: 'Missing meta_lead_ads.view_logs', schema: errorBodySchema },
        { status: 404, description: 'Lead event not found in the active organization', schema: errorBodySchema },
      ],
    },
  },
}
