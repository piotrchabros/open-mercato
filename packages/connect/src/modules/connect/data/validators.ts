import { z } from 'zod'

/**
 * Connect request validation.
 *
 * The window relationship is validated here rather than only in the database,
 * so an operator gets a field error naming the offending setting instead of a
 * constraint violation. The constraint stays as the backstop.
 */

export const connectSettingsSchema = z
  .object({
    attachWindowHours: z.number().int().min(0).max(24 * 365),
    reopenWindowDays: z.number().int().min(0).max(365),
    autoCloseAfterDays: z.number().int().min(0).max(365),
    identityMatchThreshold: z.number().int().min(0).max(100),
    suppressionCount: z.number().int().min(1).max(1000),
    suppressionWindowMinutes: z.number().int().min(1).max(24 * 60),
  })
  .refine((value) => value.reopenWindowDays <= value.autoCloseAfterDays, {
    // A reopen window longer than the auto-close window is unreachable: the Case
    // closes while it is still meant to be reopenable, so a customer's reply
    // opens a successor even though the operator intended a reopen.
    path: ['reopenWindowDays'],
    message: 'reopenWindowDays must be less than or equal to autoCloseAfterDays',
  })

export type ConnectSettingsInput = z.infer<typeof connectSettingsSchema>

export const receiptRemediationSchema = z.object({
  reason: z.string().min(1).max(500),
})

export type ReceiptRemediationInput = z.infer<typeof receiptRemediationSchema>
