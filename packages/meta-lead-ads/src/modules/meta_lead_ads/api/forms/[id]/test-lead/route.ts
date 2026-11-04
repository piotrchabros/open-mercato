import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaForm, MetaPage, type MetaFormQuestionRow } from '../../../../data/entities'
import { testLeadSchema, type GraphLead } from '../../../../data/validators'
import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  parseJsonBody,
  resolveRouteContext,
  runGuards,
} from '../../../../lib/http'
import { insertLeadEvent } from '../../../../lib/lead-events'
import { enqueueProcessLead } from '../../../../lib/queue'
import { errorBodySchema } from '../../../openapi'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

const testLeadResponseSchema = z.object({
  leadEventId: z.string().uuid(),
})

function sampleAnswer(question: MetaFormQuestionRow, shortId: string): string {
  const type = question.type.toUpperCase()
  const key = question.key.toLowerCase()
  if (type === 'EMAIL' || key === 'email') return `test+${shortId}@example.com`
  if (type === 'PHONE' || key === 'phone_number') return '+48600100200'
  if (type === 'FULL_NAME' || key === 'full_name') return `Test Lead ${shortId}`
  if (type === 'FIRST_NAME' || key === 'first_name') return 'Test'
  if (type === 'LAST_NAME' || key === 'last_name') return `Lead ${shortId}`
  if (type === 'COMPANY_NAME' || key === 'company_name') return `Test Company ${shortId}`
  if (type === 'JOB_TITLE' || key === 'job_title') return 'Tester'
  if (type === 'CITY' || key === 'city') return 'Warszawa'
  if (question.options && question.options.length > 0) return question.options[0]
  return `Test answer ${shortId}`
}

function buildTestLead(
  form: MetaForm,
  metaLeadId: string,
  answers: Record<string, string>,
  submittedAt: Date,
): GraphLead {
  const shortId = metaLeadId.slice(5, 13)
  const questions = form.questions ?? []
  const questionKeys = new Set(questions.map((question) => question.key))
  const fieldData = questions.map((question) => ({
    name: question.key,
    values: [answers[question.key] ?? sampleAnswer(question, shortId)],
  }))
  for (const [name, value] of Object.entries(answers)) {
    if (!questionKeys.has(name)) fieldData.push({ name, values: [value] })
  }
  return {
    id: metaLeadId,
    created_time: submittedAt.toISOString().replace(/\.\d{3}Z$/, '+0000'),
    form_id: form.metaFormId,
    is_organic: true,
    field_data: fieldData,
  }
}

export async function POST(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const { id } = await routeCtx.params
    const notFound = () =>
      errorResponse(404, 'not_found', ctx.translate('meta_lead_ads.errors.not_found', 'Not found'))
    if (!z.string().uuid().safeParse(id).success) return notFound()
    const input = await parseJsonBody(req, testLeadSchema)
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const form = await findOneWithDecryption(
      ctx.em,
      MetaForm,
      { id, ...scope, deletedAt: null },
      undefined,
      scope,
    )
    if (!form) return notFound()
    const page = await findOneWithDecryption(
      ctx.em,
      MetaPage,
      { id: form.pageId, ...scope, deletedAt: null },
      undefined,
      scope,
    )
    if (!page) return notFound()
    if (!form.isEnabled) {
      return errorResponse(
        409,
        'form_disabled',
        ctx.translate('meta_lead_ads.errors.form_disabled', 'This form is disabled.'),
      )
    }
    const guard = await runGuards(ctx, req, {
      resourceKind: 'meta_lead_ads.meta_form',
      resourceId: form.id,
      operation: 'custom',
      mutationPayload: { action: 'test_lead' },
    })
    if (!guard.ok) return guard.response
    const metaLeadId = `test_${randomUUID()}`
    const submittedAt = new Date()
    const lead = buildTestLead(form, metaLeadId, input.answers ?? {}, submittedAt)
    const inserted = await insertLeadEvent(ctx.em, {
      metaLeadId,
      metaPageId: page.metaPageId,
      metaFormId: form.metaFormId,
      page,
      formId: form.id,
      source: 'test',
      rawPayload: { ...lead },
      submittedAt,
    })
    if (!inserted.leadEventId) throw new Error('[internal] test lead event was not inserted')
    await enqueueProcessLead({ leadEventId: inserted.leadEventId, tenantId: ctx.tenantId, organizationId: ctx.organizationId })
    await guard.runAfterSuccess()
    return jsonResponse({ leadEventId: inserted.leadEventId }, 202)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'Send a test lead',
  methods: {
    POST: {
      summary: 'Send a synthetic test lead through the import pipeline',
      description:
        'Builds a lead from the form questions with sample values (or the given answers), stores it as a lead event with source test and queues it for processing. No Graph API call is made.',
      tags: ['Meta Lead Ads'],
      requestBody: { contentType: 'application/json', schema: testLeadSchema },
      responses: [{ status: 202, description: 'Test lead accepted', schema: testLeadResponseSchema }],
      errors: [
        { status: 400, description: 'Validation failed', schema: errorBodySchema },
        { status: 404, description: 'Form not found', schema: errorBodySchema },
        { status: 409, description: 'The form is disabled', schema: errorBodySchema },
      ],
    },
  },
}
