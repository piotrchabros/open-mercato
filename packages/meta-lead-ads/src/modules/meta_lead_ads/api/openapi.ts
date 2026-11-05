import { z } from 'zod'
import {
  ATTENTION_REASONS,
  CONNECTION_STATUSES,
  LEAD_ERROR_CODES,
  LEAD_EVENT_SOURCES,
  LEAD_EVENT_STATUSES,
  MATCH_TYPES,
  OWNER_MODES,
  PAGE_SUBSCRIPTION_STATUSES,
  SYNC_RUN_KINDS,
  SYNC_RUN_STATUSES,
} from '../lib/constants'

const isoDateTime = z.string()
const nullableIsoDateTime = z.string().nullable()

export const errorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
})
export type ErrorBody = z.infer<typeof errorBodySchema>

export const optimisticLockConflictSchema = z.object({
  error: z.literal('record_modified'),
  code: z.literal('optimistic_lock_conflict'),
  currentUpdatedAt: z.string().nullable().optional(),
  expectedUpdatedAt: z.string().nullable().optional(),
})
export type OptimisticLockConflict = z.infer<typeof optimisticLockConflictSchema>

export const pagedResponseSchema = <Item extends z.ZodTypeAny>(item: Item) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    totalPages: z.number().int(),
  })

export const connectionDtoSchema = z.object({
  id: z.string().uuid(),
  metaUserId: z.string(),
  metaUserName: z.string().nullable(),
  status: z.enum(CONNECTION_STATUSES),
  grantedScopes: z.array(z.string()),
  tokenExpiresAt: nullableIsoDateTime,
  lastHealthCheckAt: nullableIsoDateTime,
  lastError: z.string().nullable(),
  pageCount: z.number().int(),
  connectedByUserId: z.string().uuid().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type ConnectionDto = z.infer<typeof connectionDtoSchema>

export const pageDtoSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  metaPageId: z.string(),
  name: z.string(),
  subscriptionStatus: z.enum(PAGE_SUBSCRIPTION_STATUSES),
  statusCheckedAt: nullableIsoDateTime,
  lastError: z.string().nullable(),
  formCount: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type PageDto = z.infer<typeof pageDtoSchema>

export const availablePageDtoSchema = z.object({
  metaPageId: z.string(),
  name: z.string(),
  assignedOrganizationId: z.string().uuid().nullable(),
  assignedConnectionId: z.string().uuid().nullable(),
  assignable: z.boolean(),
  assignedElsewhere: z.boolean().optional(),
})
export type AvailablePageDto = z.infer<typeof availablePageDtoSchema>

export const formQuestionDtoSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  options: z.array(z.string()).optional(),
})
export type FormQuestionDto = z.infer<typeof formQuestionDtoSchema>

export const fieldMappingEntryDtoSchema = z.object({
  questionKey: z.string(),
  target: z.string(),
})
export type FieldMappingEntryDto = z.infer<typeof fieldMappingEntryDtoSchema>

export const formDtoSchema = z.object({
  id: z.string().uuid(),
  pageId: z.string().uuid(),
  metaFormId: z.string(),
  name: z.string(),
  locale: z.string().nullable(),
  isEnabled: z.boolean(),
  questions: z.array(formQuestionDtoSchema),
  questionsFingerprint: z.string().nullable(),
  needsAttention: z.boolean(),
  attentionReason: z.enum(ATTENTION_REASONS).nullable(),
  fieldMapping: z.array(fieldMappingEntryDtoSchema),
  createDeal: z.boolean(),
  pipelineId: z.string().uuid().nullable(),
  pipelineStageId: z.string().uuid().nullable(),
  ownerMode: z.enum(OWNER_MODES),
  ownerUserId: z.string().uuid().nullable(),
  ownerUserIds: z.array(z.string().uuid()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})
export type FormDto = z.infer<typeof formDtoSchema>

export const leadEventSummarySchema = z.object({
  id: z.string().uuid(),
  metaLeadId: z.string(),
  pageId: z.string().uuid().nullable(),
  pageName: z.string().nullable(),
  formId: z.string().uuid().nullable(),
  formName: z.string().nullable(),
  source: z.enum(LEAD_EVENT_SOURCES),
  status: z.enum(LEAD_EVENT_STATUSES),
  platform: z.string().nullable(),
  isOrganic: z.boolean().nullable(),
  campaignName: z.string().nullable(),
  submittedAt: nullableIsoDateTime,
  receivedAt: isoDateTime,
  processedAt: nullableIsoDateTime,
  attemptCount: z.number().int(),
  manualRetryCount: z.number().int(),
  nextAttemptAt: nullableIsoDateTime,
  lastErrorCode: z.enum(LEAD_ERROR_CODES).nullable(),
  lastError: z.string().nullable(),
  personId: z.string().uuid().nullable(),
  companyId: z.string().uuid().nullable(),
  interactionId: z.string().uuid().nullable(),
  dealId: z.string().uuid().nullable(),
  matchType: z.enum(MATCH_TYPES).nullable(),
  payloadPurgedAt: nullableIsoDateTime,
})
export type LeadEventSummaryDto = z.infer<typeof leadEventSummarySchema>

export const leadAnswerDtoSchema = z.object({
  name: z.string(),
  values: z.array(z.string()),
  target: z.string().nullable(),
})

export const leadConsentDtoSchema = z.object({
  consentKey: z.string(),
  consentText: z.string().nullable(),
  isChecked: z.boolean(),
  givenAt: nullableIsoDateTime,
})

export const leadAttemptDtoSchema = z.object({
  at: isoDateTime,
  errorCode: z.enum(LEAD_ERROR_CODES).nullable(),
  error: z.string().nullable(),
})

export const leadEventDetailSchema = leadEventSummarySchema.extend({
  adId: z.string().nullable(),
  adsetId: z.string().nullable(),
  campaignId: z.string().nullable(),
  adName: z.string().nullable(),
  adsetName: z.string().nullable(),
  metaFormId: z.string().nullable(),
  metaPageId: z.string().nullable(),
  answers: z.array(leadAnswerDtoSchema).nullable().optional(),
  consents: z.array(leadConsentDtoSchema).optional(),
  payloadPurged: z.boolean().optional(),
  attempts: z.array(leadAttemptDtoSchema),
})
export type LeadEventDetailDto = z.infer<typeof leadEventDetailSchema>

export const syncRunDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(SYNC_RUN_KINDS),
  formId: z.string().uuid().nullable(),
  formName: z.string().nullable(),
  rangeFrom: nullableIsoDateTime,
  rangeTo: nullableIsoDateTime,
  status: z.enum(SYNC_RUN_STATUSES),
  checked: z.number().int(),
  imported: z.number().int(),
  duplicates: z.number().int(),
  failed: z.number().int(),
  progressJobId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  startedAt: isoDateTime,
  finishedAt: nullableIsoDateTime,
  createdAt: isoDateTime,
})
export type SyncRunDto = z.infer<typeof syncRunDtoSchema>

export const settingsDtoSchema = z.object({
  id: z.string().uuid().nullable(),
  retentionDays: z.number().int(),
  defaultCountry: z.string(),
  updatedAt: nullableIsoDateTime,
  oauthRedirectUri: z.string().nullable().optional(),
})
export type SettingsDto = z.infer<typeof settingsDtoSchema>

export const personSubmissionDtoSchema = z.object({
  leadEventId: z.string().uuid(),
  submittedAt: nullableIsoDateTime,
  formId: z.string().uuid().nullable(),
  formName: z.string().nullable(),
  campaignName: z.string().nullable(),
  adsetName: z.string().nullable(),
  adName: z.string().nullable(),
  platform: z.string().nullable(),
  isOrganic: z.boolean().nullable(),
  status: z.enum(LEAD_EVENT_STATUSES),
  matchType: z.enum(MATCH_TYPES).nullable(),
  interactionId: z.string().uuid().nullable(),
  dealId: z.string().uuid().nullable(),
})

export const personConsentDtoSchema = leadConsentDtoSchema.extend({
  leadEventId: z.string().uuid(),
})

export const submissionsResponseSchema = z.object({
  items: z.array(personSubmissionDtoSchema),
  consents: z.array(personConsentDtoSchema),
})
export type SubmissionsResponse = z.infer<typeof submissionsResponseSchema>
