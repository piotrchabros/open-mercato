import { z } from 'zod'
import { MAX_OFFER_HTML_CHARS, TRACKING } from '../lib/constants'

const uuid = () => z.string().uuid()

const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/

export const offerStatusSchema = z.enum(['draft', 'sent', 'viewed', 'accepted', 'rejected'])
export type OfferStatus = z.infer<typeof offerStatusSchema>

export const offerLanguageSchema = z.enum(['pl', 'en'])
export type OfferLanguage = z.infer<typeof offerLanguageSchema>

export const offerCustomerKindSchema = z.enum(['person', 'company'])
export type OfferCustomerKind = z.infer<typeof offerCustomerKindSchema>

export const offerGenerationStatusSchema = z.enum(['idle', 'queued', 'running', 'failed'])
export type OfferGenerationStatus = z.infer<typeof offerGenerationStatusSchema>

export const offerRevisionSourceSchema = z.enum(['generate', 'refine', 'manual_edit', 'restore'])
export type OfferRevisionSource = z.infer<typeof offerRevisionSourceSchema>

export const offerGenerationRunKindSchema = z.enum(['generate', 'refine'])
export type OfferGenerationRunKind = z.infer<typeof offerGenerationRunKindSchema>

export const offerGenerationRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed'])
export type OfferGenerationRunStatus = z.infer<typeof offerGenerationRunStatusSchema>

export const offerGenerationErrorCodeSchema = z.enum([
  'ai_not_configured',
  'empty_response',
  'incomplete_html',
  'refine_shrunk',
  'max_tokens',
  'timeout',
  'provider_error',
])
export type OfferGenerationErrorCode = z.infer<typeof offerGenerationErrorCodeSchema>

const currencyCodeSchema = z.string().trim().toUpperCase().regex(CURRENCY_CODE_PATTERN)

export const offerCreateSchema = z.object({
  tenantId: uuid(),
  organizationId: uuid(),
  title: z.string().trim().min(2).max(200),
  clientName: z.string().trim().min(2).max(200),
  customerEntityId: uuid().nullable().optional(),
  customerKind: offerCustomerKindSchema.nullable().optional(),
  dealId: uuid().nullable().optional(),
  language: offerLanguageSchema,
  prompt: z.string().max(50000).nullable().optional(),
  valueAmount: z.number().finite().nonnegative().max(999_999_999_999.99).nullable().optional(),
  currencyCode: currencyCodeSchema.nullable().optional(),
  validUntil: z.string().regex(ISO_DATE_PATTERN).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  status: offerStatusSchema.optional(),
})
export type OfferCreateInput = z.infer<typeof offerCreateSchema>

export const offerUpdateSchema = offerCreateSchema.partial().extend({
  id: uuid(),
  status: offerStatusSchema.optional(),
  sentAt: z.coerce.date().nullable().optional(),
  respondedAt: z.coerce.date().nullable().optional(),
})
export type OfferUpdateInput = z.infer<typeof offerUpdateSchema>

export const settingsUpsertSchema = z.object({
  tenantId: uuid(),
  organizationId: uuid(),
  companyName: z.string().trim().max(200),
  templateHtml: z.string().min(1).max(MAX_OFFER_HTML_CHARS),
  extraInstructions: z.string().max(20000).nullable().optional(),
  defaultLanguage: offerLanguageSchema,
  defaultCurrency: currencyCodeSchema,
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  alternateModels: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
})
export type SettingsUpsertInput = z.infer<typeof settingsUpsertSchema>

export const offerHtmlUpdateSchema = z.object({
  html: z.string().min(200).max(MAX_OFFER_HTML_CHARS),
})
export type OfferHtmlUpdateInput = z.infer<typeof offerHtmlUpdateSchema>

export const generationStartSchema = z
  .object({
    kind: offerGenerationRunKindSchema,
    prompt: z.string().min(10).max(50000).optional(),
    feedback: z.string().min(5).max(10000).optional(),
    language: offerLanguageSchema.optional(),
    model: z.string().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'refine' && !value.feedback) {
      ctx.addIssue({ code: 'custom', path: ['feedback'], message: 'feedback is required when kind is refine' })
    }
  })
export type GenerationStartInput = z.infer<typeof generationStartSchema>

export const revisionRestoreSchema = z.object({ revisionId: uuid() })
export type RevisionRestoreInput = z.infer<typeof revisionRestoreSchema>

const trackingSegmentSchema = z.string().min(3).max(200)

export const trackingStartSchema = z.object({
  t: z.literal('start'),
  seg: trackingSegmentSchema,
  key: uuid(),
  ref: z.string().max(300).nullable().optional(),
})
export type TrackingStartInput = z.infer<typeof trackingStartSchema>

export const trackingBeatSchema = z.object({
  t: z.literal('beat'),
  seg: trackingSegmentSchema,
  key: uuid(),
  ms: z.number().finite().min(0).max(TRACKING.MAX_ACTIVE_MS),
  sc: z.number().finite().min(0).max(100),
  sx: z
    .array(
      z.object({
        k: z.string().max(64),
        l: z.string().max(120),
        ms: z.number().finite().min(0).max(TRACKING.MAX_ACTIVE_MS),
      }),
    )
    .max(60)
    .optional(),
})
export type TrackingBeatInput = z.infer<typeof trackingBeatSchema>

export const trackingBodySchema = z.discriminatedUnion('t', [trackingStartSchema, trackingBeatSchema])
export type TrackingBody = z.infer<typeof trackingBodySchema>

export type GenerateOfferJob = {
  runId: string
  tenantId: string
  organizationId: string
  userId: string | null
}
