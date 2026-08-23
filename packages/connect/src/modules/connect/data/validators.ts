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

// ── Case reparenting ──────────────────────────────────────────

/**
 * A command key is a client-chosen idempotency token, so it is bounded and
 * character-restricted: it lands in a unique index and in log context, and an
 * unbounded free-text key would be both an index hazard and a log-injection one.
 */
const clientCommandKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'clientCommandKey may contain only letters, digits, dot, dash, colon and underscore')

/** Non-empty AFTER trimming — a reason of spaces is not an audit reason. */
const reparentReasonSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim().length > 0, { message: 'reason must not be blank' })

const reparentActorSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  features: z.array(z.string()),
})

export const splitCaseRequestSchema = z.object({
  conversationIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'conversationIds must be unique' }),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  clientCommandKey: clientCommandKeySchema,
  reason: reparentReasonSchema,
})

export type SplitCaseRequestInput = z.infer<typeof splitCaseRequestSchema>

export const mergeCaseRequestSchema = z.object({
  targetCaseId: z.string().uuid(),
  expectedSourceUpdatedAt: z.string().datetime({ offset: true }),
  expectedTargetUpdatedAt: z.string().datetime({ offset: true }),
  clientCommandKey: clientCommandKeySchema,
  reason: reparentReasonSchema,
  /**
   * Only meaningful on merge, and only honoured for a caller holding
   * `connect.cases.reparent.override`. A split child always inherits the
   * source's customer, so there is nothing for it to override.
   */
  allowCustomerMismatch: z.boolean().default(false),
})

export type MergeCaseRequestInput = z.infer<typeof mergeCaseRequestSchema>

export const reparentCaseInputSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('split'),
    sourceCaseId: z.string().uuid(),
    conversationIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'conversationIds must be unique' }),
    expectedSourceUpdatedAt: z.string().datetime({ offset: true }),
    clientCommandKey: clientCommandKeySchema,
    reason: reparentReasonSchema,
    actor: reparentActorSchema,
  }),
  z.object({
    operation: z.literal('merge'),
    sourceCaseId: z.string().uuid(),
    targetCaseId: z.string().uuid(),
    expectedSourceUpdatedAt: z.string().datetime({ offset: true }),
    expectedTargetUpdatedAt: z.string().datetime({ offset: true }),
    clientCommandKey: clientCommandKeySchema,
    reason: reparentReasonSchema,
    allowCustomerMismatch: z.boolean().default(false),
    actor: reparentActorSchema,
  }),
])

export type ReparentCaseInput = z.infer<typeof reparentCaseInputSchema>

/** Base64url-encoded `{ occurredAt, id }`, decoded before it reaches this schema. */
export const reparentingCursorSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
})

export type ReparentingCursorInput = z.infer<typeof reparentingCursorSchema>
