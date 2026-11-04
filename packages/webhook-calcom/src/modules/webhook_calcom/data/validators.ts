import { z } from 'zod'

export const calcomUnassignedTranscriptStatuses = ['pending', 'resolved', 'dismissed'] as const

export const calcomUnassignedTranscriptSources = ['booking', 'ad_hoc', 'calendar_auto_join'] as const

export const unassignedTranscriptListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(50),
  status: z.enum(calcomUnassignedTranscriptStatuses).default('pending'),
  source: z.enum(calcomUnassignedTranscriptSources).optional(),
})

export type UnassignedTranscriptListQuery = z.infer<typeof unassignedTranscriptListQuerySchema>

export const unassignedTranscriptAssignSchema = z.object({
  id: z.string().uuid(),
  personId: z.string().uuid(),
})

export type UnassignedTranscriptAssignInput = z.infer<typeof unassignedTranscriptAssignSchema>

export const unassignedTranscriptAssignBodySchema = unassignedTranscriptAssignSchema.pick({ personId: true })

export type UnassignedTranscriptAssignBody = z.infer<typeof unassignedTranscriptAssignBodySchema>

export const unassignedTranscriptDismissSchema = z.object({
  id: z.string().uuid(),
})

export type UnassignedTranscriptDismissInput = z.infer<typeof unassignedTranscriptDismissSchema>
