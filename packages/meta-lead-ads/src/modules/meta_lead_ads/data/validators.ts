import { z } from 'zod'
import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import {
  LEAD_EVENT_SOURCES,
  LEAD_EVENT_STATUSES,
  OWNER_MODES,
  PLATFORMS,
  SYNC_RUN_KINDS,
  SYNC_RUN_STATUSES,
  type MetaLeadEventStatus,
} from '../lib/constants'

const MAX_BACKFILL_RANGE_MS = 90 * 24 * 60 * 60 * 1000
const BACKFILL_FUTURE_TOLERANCE_MS = 60 * 1000

export const FIELD_MAPPING_TARGET_PATTERN =
  /^(person\.(firstName|lastName|fullName|displayName|primaryEmail|primaryPhone|jobTitle|city)|company\.(displayName|domain)|(person|company)\.cf:[A-Za-z0-9_\-]{1,100}|note|consent|ignore)$/

const uuid = () => z.string().uuid()

const queryBoolean = z.preprocess(
  (value) => (typeof value === 'string' ? (parseBooleanToken(value) ?? value) : value),
  z.boolean(),
)

export const pageAssignSchema = z.object({
  connectionId: uuid(),
  metaPageId: z.string().min(1),
  organizationId: uuid(),
})
export type PageAssignInput = z.infer<typeof pageAssignSchema>

export const fieldMappingEntrySchema = z.object({
  questionKey: z.string().min(1),
  target: z.string().regex(FIELD_MAPPING_TARGET_PATTERN),
})
export type FieldMappingEntry = z.infer<typeof fieldMappingEntrySchema>

export const formUpdateSchema = z
  .object({
    id: uuid(),
    isEnabled: z.boolean().optional(),
    fieldMapping: z.array(fieldMappingEntrySchema).max(200).optional(),
    createDeal: z.boolean().optional(),
    pipelineId: uuid().nullable().optional(),
    pipelineStageId: uuid().nullable().optional(),
    ownerMode: z.enum(OWNER_MODES),
    ownerUserId: uuid().nullable().optional(),
    ownerUserIds: z.array(uuid()).max(50).optional(),
    acknowledgeAttention: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.createDeal === true) {
      if (!value.pipelineId) {
        ctx.addIssue({ code: 'custom', path: ['pipelineId'], message: 'pipelineId is required when createDeal is true' })
      }
      if (!value.pipelineStageId) {
        ctx.addIssue({ code: 'custom', path: ['pipelineStageId'], message: 'pipelineStageId is required when createDeal is true' })
      }
    }
    if (value.ownerMode === 'fixed' && !value.ownerUserId) {
      ctx.addIssue({ code: 'custom', path: ['ownerUserId'], message: 'ownerUserId is required when ownerMode is fixed' })
    }
    if (value.ownerMode === 'round_robin' && (value.ownerUserIds?.length ?? 0) < 1) {
      ctx.addIssue({ code: 'custom', path: ['ownerUserIds'], message: 'ownerUserIds needs at least one user when ownerMode is round_robin' })
    }
  })
export type FormUpdateInput = z.infer<typeof formUpdateSchema>

export const settingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(365),
  defaultCountry: z.string().regex(/^[A-Z]{2}$/),
})
export type SettingsInput = z.infer<typeof settingsSchema>

export const backfillSchema = z
  .object({
    formId: uuid(),
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    const fromMs = Date.parse(value.from)
    const toMs = Date.parse(value.to)
    if (!(fromMs < toMs)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must be after from' })
      return
    }
    if (toMs - fromMs > MAX_BACKFILL_RANGE_MS) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'range must not exceed 90 days' })
    }
    if (toMs > Date.now() + BACKFILL_FUTURE_TOLERANCE_MS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not be in the future' })
    }
  })
export type BackfillInput = z.infer<typeof backfillSchema>

export const retrySchema = z.object({
  ids: z.array(uuid()).min(1).max(100),
})
export type RetryInput = z.infer<typeof retrySchema>

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

const statusListSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.enum(LEAD_EVENT_STATUSES)).min(1))
  .transform((statuses): MetaLeadEventStatus[] => statuses)

export const leadEventsQuerySchema = paginationQuerySchema.extend({
  status: statusListSchema.optional(),
  pageId: uuid().optional(),
  formId: uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  personId: uuid().optional(),
  source: z.enum(LEAD_EVENT_SOURCES).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
})
export type LeadEventsQuery = z.infer<typeof leadEventsQuerySchema>

export const pagesQuerySchema = paginationQuerySchema.extend({
  connectionId: uuid().optional(),
  subscriptionStatus: z.string().min(1).optional(),
  search: z.string().optional(),
})
export type PagesQuery = z.infer<typeof pagesQuerySchema>

export const formsQuerySchema = paginationQuerySchema.extend({
  pageId: uuid().optional(),
  isEnabled: queryBoolean.optional(),
  needsAttention: queryBoolean.optional(),
  search: z.string().optional(),
})
export type FormsQuery = z.infer<typeof formsQuerySchema>

export const syncRunsQuerySchema = paginationQuerySchema.extend({
  kind: z.enum(SYNC_RUN_KINDS).optional(),
  formId: uuid().optional(),
  status: z.enum(SYNC_RUN_STATUSES).optional(),
})
export type SyncRunsQuery = z.infer<typeof syncRunsQuerySchema>

export const submissionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type SubmissionsQuery = z.infer<typeof submissionsQuerySchema>

export const webhookVerifyQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
})
export type WebhookVerifyQuery = z.infer<typeof webhookVerifyQuerySchema>

export const webhookPayloadSchema = z
  .object({
    object: z.literal('page'),
    entry: z
      .array(
        z.looseObject({
          id: z.string(),
          time: z.number(),
          changes: z.array(
            z.looseObject({
              field: z.string(),
              value: z.record(z.string(), z.unknown()),
            }),
          ),
        }),
      )
      .min(1)
      .max(100),
  })
  .passthrough()
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>

export const leadgenChangeValueSchema = z.strictObject({
  leadgen_id: z.string().min(1),
  page_id: z.string().min(1),
  form_id: z.string().min(1),
  ad_id: z.string().optional(),
  adgroup_id: z.string().optional(),
  created_time: z.number(),
})
export type LeadgenChangeValue = z.infer<typeof leadgenChangeValueSchema>

export const graphFormQuestionSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  type: z.string(),
  options: z.array(z.string()).optional(),
})
export type GraphFormQuestion = z.infer<typeof graphFormQuestionSchema>

const platformSchema = z.preprocess(
  (value) => (typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value) ? value : undefined),
  z.enum(PLATFORMS).optional(),
)

export const graphLeadSchema = z
  .object({
    id: z.string(),
    created_time: z.string(),
    ad_id: z.string().optional(),
    adset_id: z.string().optional(),
    campaign_id: z.string().optional(),
    form_id: z.string(),
    platform: platformSchema,
    is_organic: z.boolean().optional(),
    field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).default([]),
  })
  .passthrough()
export type GraphLead = z.infer<typeof graphLeadSchema>

export const testLeadSchema = z.object({
  answers: z.record(z.string(), z.string()).optional(),
})
export type TestLeadInput = z.infer<typeof testLeadSchema>

export const dataDeletionFormSchema = z.object({
  signed_request: z.string().min(1),
})
export type DataDeletionForm = z.infer<typeof dataDeletionFormSchema>
