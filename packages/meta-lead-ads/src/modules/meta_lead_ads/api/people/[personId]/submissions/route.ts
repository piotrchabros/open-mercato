import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { MetaConsent, MetaForm, MetaLeadEvent } from '../../../../data/entities'
import { submissionsQuerySchema } from '../../../../data/validators'
import { errorResponse, handleRouteError, jsonResponse, parseQuery, resolveRouteContext } from '../../../../lib/http'
import { errorBodySchema, submissionsResponseSchema, type SubmissionsResponse } from '../../../openapi'

const personIdSchema = z.string().uuid()

type RouteParams = { params: Promise<{ personId: string }> }

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
}

function toNullableIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export async function GET(req: Request, context: RouteParams) {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const query = parseQuery(req, submissionsQuerySchema)
    const { personId: rawPersonId } = await context.params
    const notFound = () =>
      errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    const parsedPersonId = personIdSchema.safeParse(rawPersonId)
    if (!parsedPersonId.success) return notFound()
    const personId = parsedPersonId.data
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }

    const person = await findOneWithDecryption(
      ctx.em,
      CustomerEntity,
      { id: personId, kind: 'person', tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      undefined,
      scope,
    )
    if (!person) return notFound()

    const events = await findWithDecryption(
      ctx.em,
      MetaLeadEvent,
      { personId, tenantId: ctx.tenantId, organizationId: ctx.organizationId, deletedAt: null },
      { orderBy: { submittedAt: 'desc', createdAt: 'desc' }, limit: query.limit },
      scope,
    )

    const formIds = Array.from(
      new Set(events.map((event) => event.formId).filter((formId): formId is string => Boolean(formId))),
    )
    const forms = formIds.length
      ? await findWithDecryption(
          ctx.em,
          MetaForm,
          { id: { $in: formIds }, tenantId: ctx.tenantId, organizationId: ctx.organizationId },
          undefined,
          scope,
        )
      : []
    const formNames = new Map(forms.map((form) => [form.id, form.name]))

    const eventIds = events.map((event) => event.id)
    const consents = eventIds.length
      ? await findWithDecryption(
          ctx.em,
          MetaConsent,
          {
            personId,
            leadEventId: { $in: eventIds },
            tenantId: ctx.tenantId,
            organizationId: ctx.organizationId,
            deletedAt: null,
          },
          { orderBy: { givenAt: 'desc' } },
          scope,
        )
      : []

    const body: SubmissionsResponse = {
      items: events.map((event) => ({
        leadEventId: event.id,
        submittedAt: toNullableIso(event.submittedAt),
        formId: event.formId ?? null,
        formName: event.formId ? formNames.get(event.formId) ?? null : null,
        campaignName: event.campaignName ?? null,
        adsetName: event.adsetName ?? null,
        adName: event.adName ?? null,
        platform: event.platform ?? null,
        isOrganic: event.isOrganic ?? null,
        status: event.status,
        matchType: event.matchType ?? null,
        interactionId: event.interactionId ?? null,
        dealId: event.dealId ?? null,
      })),
      consents: consents.map((consent) => ({
        leadEventId: consent.leadEventId,
        consentKey: consent.consentKey,
        consentText: consent.consentText ?? null,
        isChecked: consent.isChecked,
        givenAt: toNullableIso(consent.givenAt),
      })),
    }
    return jsonResponse(body)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta lead form submissions of a person',
  methods: {
    GET: {
      summary: 'List Meta lead submissions and consents of a person',
      description: 'Returns the lead events linked to the person in the active organization, with form names, decrypted campaign names and recorded consents.',
      pathParams: z.object({ personId: z.string().uuid() }),
      query: submissionsQuerySchema,
      responses: [{ status: 200, description: 'Submissions and consents', schema: submissionsResponseSchema }],
      errors: [
        { status: 400, description: 'Validation error or organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 404, description: 'Person not found in the active organization', schema: errorBodySchema },
      ],
    },
  },
}
