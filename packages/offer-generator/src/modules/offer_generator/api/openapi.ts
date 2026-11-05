import { z } from 'zod'
import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'
import {
  offerCustomerKindSchema,
  offerGenerationErrorCodeSchema,
  offerGenerationRunKindSchema,
  offerGenerationRunStatusSchema,
  offerGenerationStatusSchema,
  offerLanguageSchema,
  offerRevisionSourceSchema,
  offerStatusSchema,
} from '../data/validators'

export const buildOfferGeneratorCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: 'Offer Generator',
  makeListDescription: ({ pluralLower }) =>
    `Returns a paginated collection of ${pluralLower} scoped to the authenticated organization.`,
})

const nullableIsoDateTime = z.string().nullable()

export const errorBodySchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  issue: z.string().optional(),
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

export const offerDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  clientName: z.string(),
  customerEntityId: z.string().uuid().nullable(),
  customerKind: offerCustomerKindSchema.nullable(),
  dealId: z.string().uuid().nullable(),
  ownerUserId: z.string().uuid().nullable(),
  language: offerLanguageSchema,
  status: offerStatusSchema,
  slug: z.string(),
  publicUrl: z.string(),
  valueAmount: z.string().nullable(),
  currencyCode: z.string().nullable(),
  validUntil: z.string().nullable(),
  sentAt: nullableIsoDateTime,
  viewedAt: nullableIsoDateTime,
  respondedAt: nullableIsoDateTime,
  viewCount: z.number().int(),
  lastViewedAt: nullableIsoDateTime,
  hasHtml: z.boolean(),
  htmlUpdatedAt: nullableIsoDateTime,
  generationStatus: offerGenerationStatusSchema,
  lastGenerationRunId: z.string().uuid().nullable(),
  createdAt: nullableIsoDateTime,
  updatedAt: nullableIsoDateTime,
  prompt: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

export const offerHtmlDtoSchema = z.object({
  html: z.string().nullable(),
  updatedAt: nullableIsoDateTime,
})

export const offerHtmlWriteResultSchema = z.object({
  offerId: z.string().uuid(),
  revisionId: z.string().uuid().nullable(),
  htmlUpdatedAt: z.string(),
  updatedAt: z.string(),
})

export const revisionDtoSchema = z.object({
  id: z.string().uuid(),
  source: offerRevisionSourceSchema,
  feedback: z.string().nullable(),
  generationRunId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: nullableIsoDateTime,
  sizeBytes: z.number().int(),
})

export const revisionListResponseSchema = z.object({
  items: z.array(revisionDtoSchema),
})

export const generationRunDtoSchema = z.object({
  id: z.string().uuid(),
  offerId: z.string().uuid(),
  kind: offerGenerationRunKindSchema,
  status: offerGenerationRunStatusSchema,
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  language: offerLanguageSchema,
  bytesReceived: z.number().int(),
  errorCode: z
    .string()
    .nullable()
    .describe(`One of: ${offerGenerationErrorCodeSchema.options.join(', ')}`),
  progressJobId: z.string().uuid().nullable(),
  resultRevisionId: z.string().uuid().nullable(),
  startedAt: nullableIsoDateTime,
  finishedAt: nullableIsoDateTime,
  createdAt: nullableIsoDateTime,
})

export const generationStartResponseSchema = z.object({
  runId: z.string().uuid(),
  progressJobId: z.string().uuid().nullable(),
})

export const settingsDtoSchema = z.object({
  companyName: z.string(),
  templateHtml: z.string(),
  extraInstructions: z.string().nullable(),
  defaultLanguage: offerLanguageSchema,
  defaultCurrency: z.string(),
  defaultModel: z.string().nullable(),
  alternateModels: z.array(z.string()),
  updatedAt: nullableIsoDateTime,
})

export const offerInsightsStatsSchema = z.object({
  views: z.number().int(),
  uniqueVisitors: z.number().int(),
  totalActiveMs: z.number(),
  avgActiveMs: z.number(),
  internalViews: z.number().int(),
  firstViewedAt: nullableIsoDateTime,
  lastViewAt: nullableIsoDateTime,
  avgMaxScrollPct: z.number(),
})

export const offerViewRowSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  visitorNo: z.number().int(),
  country: z.string().nullable(),
  device: z.string(),
  browser: z.string(),
  os: z.string(),
  referrer: z.string().nullable(),
  isInternal: z.boolean(),
  activeMs: z.number(),
  maxScrollPct: z.number(),
  sectionsSeen: z.number().int(),
})

export const offerSectionInsightSchema = z.object({
  key: z.string(),
  label: z.string(),
  viewers: z.number().int(),
  totalMs: z.number(),
  avgMs: z.number(),
})

export const offerInsightsSchema = z.object({
  stats: offerInsightsStatsSchema,
  views: z.array(offerViewRowSchema),
  truncated: z.boolean(),
  sections: z.array(offerSectionInsightSchema),
})

export const pdfFileResponseSchema = z.string().describe('Binary PDF file attachment')

export const htmlDocumentResponseSchema = z.string().describe('Sanitized offer HTML document')
