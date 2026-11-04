import { z } from 'zod'
import type { FilterQuery } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findAndCountWithDecryption, findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { CustomerPipeline, CustomerPipelineStage } from '@open-mercato/core/modules/customers/data/entities'
import { MetaForm } from '../../data/entities'
import { formUpdateSchema, formsQuerySchema, type FormUpdateInput } from '../../data/validators'
import { handleRouteError, jsonResponse, paged, parseJsonBody, parseQuery, resolveRouteContext } from '../../lib/http'
import { serializeForm } from '../../lib/serializers'
import { errorBodySchema, formDtoSchema, optimisticLockConflictSchema, pagedResponseSchema } from '../openapi'

const formsListQuerySchema = formsQuerySchema.extend({
  id: z.string().uuid().optional(),
})
type FormsListQuery = z.infer<typeof formsListQuerySchema>

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
  PUT: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

type FieldErrors = Record<string, string>

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)))
}

function collectMappingErrors(form: MetaForm, input: FormUpdateInput, fieldErrors: FieldErrors): void {
  if (!input.fieldMapping) return
  const questionKeys = new Set((form.questions ?? []).map((question) => question.key))
  if (questionKeys.size === 0) return
  const storedPairs = new Set((form.fieldMapping ?? []).map((entry) => `${entry.questionKey}\u0000${entry.target}`))
  input.fieldMapping.forEach((entry, index) => {
    if (questionKeys.has(entry.questionKey)) return
    if (storedPairs.has(`${entry.questionKey}\u0000${entry.target}`)) return
    fieldErrors[`fieldMapping.${index}.questionKey`] = 'questionKey is not a question of this form'
  })
}

async function collectDealErrors(
  em: EntityManager,
  form: MetaForm,
  input: FormUpdateInput,
  fieldErrors: FieldErrors,
): Promise<void> {
  const scope = { tenantId: form.tenantId, organizationId: form.organizationId }
  const createDeal = input.createDeal ?? form.createDeal
  const pipelineId = input.pipelineId !== undefined ? input.pipelineId : (form.pipelineId ?? null)
  const pipelineStageId = input.pipelineStageId !== undefined ? input.pipelineStageId : (form.pipelineStageId ?? null)
  if (createDeal && !pipelineId) fieldErrors.pipelineId = 'pipelineId is required when createDeal is true'
  if (createDeal && !pipelineStageId) fieldErrors.pipelineStageId = 'pipelineStageId is required when createDeal is true'
  if (!pipelineId && !pipelineStageId) return
  if (pipelineId) {
    const pipeline = await findOneWithDecryption(em, CustomerPipeline, { id: pipelineId, ...scope }, undefined, scope)
    if (!pipeline) {
      fieldErrors.pipelineId = 'pipeline not found in this organization'
      return
    }
  }
  if (pipelineStageId) {
    const stage = await findOneWithDecryption(em, CustomerPipelineStage, { id: pipelineStageId, ...scope }, undefined, scope)
    if (!stage || (pipelineId && stage.pipelineId !== pipelineId)) {
      fieldErrors.pipelineStageId = 'pipeline stage not found in the selected pipeline'
    }
  }
}

async function collectOwnerErrors(
  em: EntityManager,
  form: MetaForm,
  input: FormUpdateInput,
  fieldErrors: FieldErrors,
): Promise<void> {
  const scope = { tenantId: form.tenantId, organizationId: form.organizationId }
  const requested =
    input.ownerMode === 'fixed'
      ? uniqueIds([input.ownerUserId !== undefined ? input.ownerUserId : form.ownerUserId])
      : input.ownerMode === 'round_robin'
        ? uniqueIds(input.ownerUserIds ?? form.ownerUserIds ?? [])
        : []
  if (requested.length === 0) return
  const users = await findWithDecryption(
    em,
    User,
    { id: { $in: requested }, tenantId: form.tenantId, deletedAt: null },
    { fields: ['id'] },
    scope,
  )
  const activeIds = new Set(users.map((user) => user.id))
  const missing = requested.filter((userId) => !activeIds.has(userId))
  if (missing.length === 0) return
  const field = input.ownerMode === 'fixed' ? 'ownerUserId' : 'ownerUserIds'
  fieldErrors[field] = 'owner user not found or deleted'
}

async function assertFormSaveIsValid(ctx: CrudCtx, form: MetaForm, input: FormUpdateInput): Promise<void> {
  const em = ctx.container.resolve<EntityManager>('em').fork()
  const fieldErrors: FieldErrors = {}
  collectMappingErrors(form, input, fieldErrors)
  await collectDealErrors(em, form, input, fieldErrors)
  await collectOwnerErrors(em, form, input, fieldErrors)
  if (Object.keys(fieldErrors).length === 0) return
  throw new CrudHttpError(400, {
    error: 'meta_lead_ads.errors.validation_error',
    code: 'validation_error',
    fieldErrors,
  })
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const crud = makeCrudRoute<never, FormUpdateInput, FormsListQuery>({
  metadata,
  orm: {
    entity: MetaForm,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  update: {
    schema: formUpdateSchema,
    applyToEntity: async (entity: MetaForm, input, ctx) => {
      await assertFormSaveIsValid(ctx, entity, input)
      if (input.isEnabled !== undefined) entity.isEnabled = input.isEnabled
      if (input.fieldMapping !== undefined) {
        entity.fieldMapping = input.fieldMapping.map((entry) => ({ questionKey: entry.questionKey, target: entry.target }))
      }
      if (input.createDeal !== undefined) entity.createDeal = input.createDeal
      if (input.pipelineId !== undefined) entity.pipelineId = input.pipelineId
      if (input.pipelineStageId !== undefined) entity.pipelineStageId = input.pipelineStageId
      entity.ownerMode = input.ownerMode
      if (input.ownerUserId !== undefined) entity.ownerUserId = input.ownerUserId
      if (input.ownerUserIds !== undefined) {
        const nextOwnerUserIds = uniqueIds(input.ownerUserIds)
        if (!sameIds(entity.ownerUserIds ?? [], nextOwnerUserIds)) entity.roundRobinCursor = 0
        entity.ownerUserIds = nextOwnerUserIds
      }
      if (input.fieldMapping !== undefined || input.acknowledgeAttention === true) {
        entity.needsAttention = false
        entity.attentionReason = null
      }
    },
    response: (entity: MetaForm) => serializeForm(entity),
  },
})

export async function GET(req: Request): Promise<Response> {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const query = parseQuery(req, formsListQuerySchema)
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const where: FilterQuery<MetaForm> = { ...scope, deletedAt: null }
    if (query.id) where.id = query.id
    if (query.pageId) where.pageId = query.pageId
    if (query.isEnabled !== undefined) where.isEnabled = query.isEnabled
    if (query.needsAttention !== undefined) where.needsAttention = query.needsAttention
    const search = query.search?.trim()
    if (search) where.name = { $ilike: `%${escapeLikePattern(search)}%` }
    const [forms, total] = await findAndCountWithDecryption(
      ctx.em,
      MetaForm,
      where,
      {
        orderBy: { name: 'asc', createdAt: 'desc' },
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      },
      scope,
    )
    return jsonResponse(paged(forms.map(serializeForm), total, query.page, query.pageSize))
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    await parseJsonBody(req.clone(), formUpdateSchema)
  } catch (err) {
    const { translate } = await resolveTranslations()
    return handleRouteError(err, translate)
  }
  return crud.PUT(req)
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Meta Lead Ads',
  summary: 'Meta lead forms',
  methods: {
    GET: {
      summary: 'List Meta lead forms',
      description:
        'Returns a paginated list of lead forms of the assigned Pages in the active organization. Filter by id to load one form.',
      tags: ['Meta Lead Ads'],
      query: formsListQuerySchema,
      responses: [{ status: 200, description: 'Lead forms', schema: pagedResponseSchema(formDtoSchema) }],
      errors: [{ status: 400, description: 'Validation failed', schema: errorBodySchema }],
    },
    PUT: {
      summary: 'Update the field mapping and deal rules of a lead form',
      description:
        'Saves the mapping, deal and owner settings. Pipeline, stage and owners must exist in the organization. Saving the mapping, or sending acknowledgeAttention, clears the needs-attention flag. Send the optimistic-lock header with the last known updatedAt.',
      tags: ['Meta Lead Ads'],
      requestBody: { contentType: 'application/json', schema: formUpdateSchema },
      responses: [{ status: 200, description: 'Updated form', schema: formDtoSchema }],
      errors: [
        { status: 400, description: 'Validation failed', schema: errorBodySchema },
        { status: 404, description: 'Form not found', schema: errorBodySchema },
        { status: 409, description: 'The form was changed by someone else', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
